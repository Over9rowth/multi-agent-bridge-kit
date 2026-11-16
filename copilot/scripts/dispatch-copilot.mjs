#!/usr/bin/env node
/**
 * GitHub Copilot CLI Local Bridge - 跨项目通用适配器 (BYOK 跳过 GitHub 登录)
 *
 * 目标：让外部「主 Agent」通过一条纯 ASCII 短命令，
 *       以 BYOK + Offline 模式驱动本机 `@github/copilot` (copilot.exe)，
 *       无需 GitHub Copilot 订阅即可直连智谱 GLM（推荐 `anthropic` 协议分支规避 reasoning_content 400）。
 *
 * 零第三方依赖，仅使用 Node.js >= 22 内置模块。
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_ASCII_PROMPT_LEN = 80;
const DEFAULT_GLM_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
const DEFAULT_GLM_OPENAI_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const DEFAULT_GLM_MODEL = "glm-4.7";

export function parseArgs(argv) {
  const opts = {
    status: false,
    models: false,
    file: "",
    prompt: "",
    cwd: "",
    cwdFile: "",
    state: "",
    reuse: false,
    session: "",
    model: "",
    providerType: "anthropic", // anthropic | openai | azure
    baseUrl: "",
    apiKeyEnv: "",
    offline: true,
    write: false,
    timeout: DEFAULT_TIMEOUT_SEC,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const valueFlags = new Set([
    "--file",
    "--prompt",
    "--cwd",
    "--cwd-file",
    "--state",
    "--session",
    "--model",
    "--provider-type",
    "--base-url",
    "--api-key-env",
    "--timeout",
  ]);
  const seen = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
      continue;
    }
    if (seen.has(a) && a !== "--verbose") throw new Error(`Duplicate flag: ${a}`);
    seen.add(a);

    if (valueFlags.has(a)) {
      const val = argv[++i];
      if (val === undefined || (val.startsWith("--") && val.length > 2)) {
        throw new Error(`Missing value for flag: ${a}`);
      }
      if (a === "--file") opts.file = val;
      else if (a === "--prompt") opts.prompt = val;
      else if (a === "--cwd") opts.cwd = val;
      else if (a === "--cwd-file") opts.cwdFile = val;
      else if (a === "--state") opts.state = val;
      else if (a === "--session") opts.session = val;
      else if (a === "--model") opts.model = val;
      else if (a === "--base-url") opts.baseUrl = val;
      else if (a === "--api-key-env") opts.apiKeyEnv = val;
      else if (a === "--provider-type") {
        if (!["anthropic", "openai", "azure"].includes(val)) {
          throw new Error(`Invalid --provider-type: ${val}`);
        }
        opts.providerType = val;
      } else if (a === "--timeout") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 86400) {
          throw new Error(`Invalid --timeout (1..86400): ${val}`);
        }
        opts.timeout = n;
      }
      continue;
    }

    switch (a) {
      case "--status": opts.status = true; break;
      case "--models": opts.models = true; break;
      case "--reuse": opts.reuse = true; break;
      case "--write": opts.write = true; break;
      case "--no-offline": opts.offline = false; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (opts.file && opts.prompt) throw new Error("Cannot pass both --file and --prompt");
  if (opts.cwd && opts.cwdFile) throw new Error("Cannot pass both --cwd and --cwd-file");
  if (opts.reuse && opts.session) throw new Error("Cannot pass both --reuse and --session");
  return opts;
}

export function validateShortAsciiPrompt(text) {
  if (!text || !text.trim()) throw new Error("Empty --prompt");
  if (text.length >= MAX_ASCII_PROMPT_LEN) {
    throw new Error(`--prompt length (${text.length}) >= ${MAX_ASCII_PROMPT_LEN}; use UTF-8 --file instead`);
  }
  if (/[\r\n]/.test(text)) throw new Error("--prompt must be single-line ASCII; use --file instead");
  if (/[^\x20-\x7E]/.test(text)) {
    throw new Error("--prompt only accepts pure ASCII (< 80 chars); use --file for Chinese/UTF-8 tasks");
  }
}

export function readUtf8TaskFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) throw new Error(`Task file is empty: ${filePath}`);
  if (buf.length > MAX_TASK_BYTES) {
    throw new Error(`Task file exceeds 1 MiB (${buf.length} bytes): ${filePath}`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = decoder.decode(buf);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (!text.trim()) throw new Error(`Task file contains only whitespace: ${filePath}`);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  return { text, bytes: buf.length, sha256 };
}

export function resolveCwd(opts, baseDir = process.cwd()) {
  let raw = opts.cwd;
  if (opts.cwdFile) {
    raw = readUtf8TaskFile(path.resolve(baseDir, opts.cwdFile)).text.trim();
  }
  const target = path.resolve(baseDir, raw || ".");
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Working directory does not exist or is not a directory: ${target}`);
  }
  return fs.realpathSync(target);
}

export function findCopilotBin(env = process.env) {
  if (env.COPILOT_BIN) {
    const p = path.resolve(env.COPILOT_BIN);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error(`COPILOT_BIN not found: ${p}`);
    }
    return p;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "node_modules", "@github", "copilot", "node_modules", "@github", "copilot-win32-x64", "copilot.exe"),
    path.join(appData, "npm", "node_modules", "@github", "copilot", "bin", "copilot.exe"),
  ];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    // Skip VS Code copilot-shim which prompts for installation
    if (dir.toLowerCase().includes("copilot-shim")) continue;
    candidates.push(path.join(dir, process.platform === "win32" ? "copilot.exe" : "copilot"));
  }
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* ignore */ }
  }
  throw new Error("Could not locate native copilot.exe. Install `@github/copilot` via npm or set COPILOT_BIN.");
}

export function resolveByokCredential(opts, baseEnv = process.env) {
  if (opts.apiKeyEnv) {
    const val = (baseEnv[opts.apiKeyEnv] || "").trim();
    return { key: val, sourceVar: val ? opts.apiKeyEnv : null, isGlmLike: /ZAI|ZHIPU|GLM/i.test(opts.apiKeyEnv) };
  }
  const order = [
    { name: "ZAI_API_KEY", glm: true },
    { name: "ZHIPU_API_KEY", glm: true },
    { name: "GLM_API_KEY", glm: true },
    { name: "COPILOT_PROVIDER_API_KEY", glm: false },
    { name: "ANTHROPIC_API_KEY", glm: false },
    { name: "OPENAI_API_KEY", glm: false },
  ];
  for (const item of order) {
    const val = (baseEnv[item.name] || "").trim();
    if (val) {
      return { key: val, sourceVar: item.name, isGlmLike: item.glm || /^[0-9a-f]{32}\.[A-Za-z0-9]+$/.test(val) };
    }
  }
  return { key: "", sourceVar: null, isGlmLike: false };
}

export function buildChildEnv(opts, copilotHome, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const defaultUrl = opts.providerType === "anthropic" ? DEFAULT_GLM_ANTHROPIC_BASE_URL : DEFAULT_GLM_OPENAI_BASE_URL;
  const baseUrl = (opts.baseUrl || env.COPILOT_PROVIDER_BASE_URL || (cred.isGlmLike ? defaultUrl : "")).trim();
  const model = opts.model || env.COPILOT_MODEL || (cred.isGlmLike || baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai") ? DEFAULT_GLM_MODEL : "");

  env.COPILOT_HOME = copilotHome;
  if (opts.offline) env.COPILOT_OFFLINE = "true";
  if (baseUrl) {
    env.COPILOT_PROVIDER_TYPE = opts.providerType;
    env.COPILOT_PROVIDER_BASE_URL = baseUrl;
    if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
      delete env.HTTP_PROXY;
      delete env.HTTPS_PROXY;
    }
  }
  if (cred.key) env.COPILOT_PROVIDER_API_KEY = cred.key;
  if (model) env.COPILOT_MODEL = model;

  return {
    env,
    hasKey: Boolean(cred.key),
    keySourceVar: cred.sourceVar,
    baseUrl: baseUrl || null,
    resolvedModel: model || null,
  };
}

export function buildExecArgs(opts, targetSessionId, resolvedModel, promptText) {
  const args = ["--no-auto-update", "--output-format", "json"];
  if (opts.write) {
    args.push("--allow-all");
  } else {
    args.push("--allow-tool=read");
  }
  if (resolvedModel) args.push("--model", resolvedModel);
  if (targetSessionId) args.push(`--resume=${targetSessionId}`);
  args.push("-p", promptText);
  return args;
}

export function consumeJsonlLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (verbose) console.log(`[copilot-jsonl] ${line.slice(0, 500)}`);

  if (ev.sessionId && !ctx.sessionId) ctx.sessionId = ev.sessionId;

  if (ev.type === "assistant.message" && ev.data) {
    if (ev.data.model) ctx.observedModel = ev.data.model;
    if (typeof ev.data.content === "string" && ev.data.content.trim()) {
      ctx.lastAssistantText = ev.data.content;
    }
    if (Array.isArray(ev.data.toolRequests) && ev.data.toolRequests.length > 0) {
      for (const tr of ev.data.toolRequests) {
        ctx.toolsCalled.push(tr.name || "tool");
        console.log(`  -> [tool] ${tr.name}`);
      }
    }
  } else if (ev.type === "model.call_final_result" && ev.data) {
    if (ev.data.model) ctx.observedModel = ev.data.model;
    ctx.isByok = Boolean(ev.data.isByok);
    ctx.modelResult = ev.data.result || null;
  } else if (ev.type === "session.error" && ev.data) {
    ctx.sessionErrors.push(ev.data.message || JSON.stringify(ev.data));
  } else if (ev.type === "result") {
    ctx.resultExitCode = typeof ev.exitCode === "number" ? ev.exitCode : null;
    ctx.usage = ev.usage || null;
  }
}

export function evaluateTerminalState({ exitCode, timedOut, ctx }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for GitHub Copilot CLI" };
  if (ctx.sessionErrors.length > 0) {
    return { ok: false, reason: `Copilot session.error: ${ctx.sessionErrors[ctx.sessionErrors.length - 1]}` };
  }
  if (exitCode !== 0 || (ctx.resultExitCode !== null && ctx.resultExitCode !== 0)) {
    return { ok: false, reason: `Copilot CLI exited with code ${ctx.resultExitCode ?? exitCode}` };
  }
  if (ctx.modelResult && ctx.modelResult !== "success") {
    return { ok: false, reason: `model.call_final_result=${ctx.modelResult}` };
  }
  if (!ctx.lastAssistantText || !ctx.lastAssistantText.trim()) {
    return { ok: false, reason: "Copilot CLI finished with empty assistant message" };
  }
  return { ok: true, reason: "ok", finalText: ctx.lastAssistantText };
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (e) {
    if (fs.existsSync(stateFile)) console.warn(`[Copilot Bridge] State unreadable, ignoring: ${e.message}`);
    return {};
  }
}

function writeAtomicJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`Bridge lock exists (${lockFile}); remove manually if stale.`);
    throw e;
  }
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
}

function printHelp() {
  console.log(`GitHub Copilot CLI Local Bridge (BYOK skip-login adapter)

  --status                    Check copilot.exe, version, BYOK env readiness & state
  --models                    List verified BYOK GLM models
  --file <path>               Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>             Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>                 Working directory (default: process.cwd())
  --cwd-file <path>           Read UTF-8 working directory from file
  --state <path>              Override state JSON path
  --reuse                     Resume last completed session in same cwd
  --session <id>              Explicit session UUID to resume
  --model <id>                Model ID (default: ${DEFAULT_GLM_MODEL})
  --provider-type <type>      anthropic (default, recommended for GLM) | openai | azure
  --base-url <url>            Override COPILOT_PROVIDER_BASE_URL
  --api-key-env <VAR>         Explicit env var holding API key
  --no-offline                Allow contacting GitHub endpoints (default sets COPILOT_OFFLINE=true)
  --write                     Pass --allow-all (auto-approve writes & shell)
  --timeout <sec>             Timeout seconds (1..86400, default 600)
  --dry-run                   Validate inputs and print args without executing
  --verbose                   Print raw JSONL events
  -h, --help                  Show help
`);
}

function cmdStatus(binPath, opts, root, stateFile, copilotHome) {
  const ver = spawnSync(binPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts, copilotHome);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "copilot.exe -p --output-format json (BYOK + COPILOT_OFFLINE=true)",
    binary: binPath,
    version: (ver.stdout || "").split(/\r?\n/)[0]?.trim() || null,
    copilotHome,
    providerType: opts.providerType,
    baseUrl,
    defaultModel: resolvedModel,
    keySourceVar,
    hasCredentials: hasKey,
    offline: opts.offline,
    cwd: root,
    stateFile,
    bridgeState: state.phase ? {
      phase: state.phase,
      lastSessionId: state.lastSessionId || null,
      lastCwd: state.lastCwd || null,
      observedModel: state.observedModel || null,
      isByok: state.isByok ?? null,
      updatedAt: state.updatedAt || null,
    } : null,
  }, null, 2));
}

function cmdModels() {
  console.log(JSON.stringify({
    note: "Use --provider-type anthropic (default) for reasoning GLM models to avoid OpenAI-compat reasoning_content 400s.",
    models: [
      { id: "glm-4.7", providerType: "anthropic", baseUrl: DEFAULT_GLM_ANTHROPIC_BASE_URL },
      { id: "glm-5.3", providerType: "anthropic", baseUrl: DEFAULT_GLM_ANTHROPIC_BASE_URL },
      { id: "glm-5.2", providerType: "anthropic", baseUrl: DEFAULT_GLM_ANTHROPIC_BASE_URL },
    ],
  }, null, 2));
}

async function dispatch(binPath, opts, root, stateFile, copilotHome) {
  let task;
  if (opts.file) {
    task = readUtf8TaskFile(path.resolve(root, opts.file));
  } else if (opts.prompt) {
    validateShortAsciiPrompt(opts.prompt);
    task = {
      text: opts.prompt,
      bytes: Buffer.byteLength(opts.prompt, "utf8"),
      sha256: crypto.createHash("sha256").update(opts.prompt, "utf8").digest("hex"),
    };
  } else {
    throw new Error("Missing --file or --prompt");
  }

  fs.mkdirSync(copilotHome, { recursive: true });
  const { env, hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts, copilotHome);
  if (!hasKey) {
    throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / COPILOT_PROVIDER_API_KEY.");
  }

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded in state file");
    if (state.phase !== "completed") {
      throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    }
    if (state.lastCwd !== root) {
      throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    }
    targetSessionId = state.lastSessionId;
  }

  // Note: Copilot CLI takes prompt via -p flag; to prevent Windows command-line length/CJK corruption,
  // if task came from --file and contains non-ASCII or >200 chars, write a short ASCII directive referencing a local staging prompt file or pass safe short text.
  // Actually Node's spawn() passes argv directly via CreateProcessW Unicode API (no cmd.exe/PSReadLine),
  // up to ~32KB; for huge task files (>8KB) we tell Copilot to read the task file directly!
  let effectivePrompt = task.text;
  let stagedTaskPath = "";
  if (task.text.length > 8000) {
    stagedTaskPath = path.join(path.dirname(stateFile), "active-task.md");
    fs.mkdirSync(path.dirname(stagedTaskPath), { recursive: true });
    fs.writeFileSync(stagedTaskPath, task.text, "utf8");
    effectivePrompt = `Read and execute every requirement in the UTF-8 task file at: ${stagedTaskPath}`;
  }

  const args = buildExecArgs(opts, targetSessionId, resolvedModel, effectivePrompt);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[Copilot Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[Copilot Bridge] cwd=${root} type=${opts.providerType} keyVar=${keySourceVar} baseUrl=${baseUrl} model=${resolvedModel} write=${opts.write} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Copilot Bridge] dry-run args=${JSON.stringify(args.slice(0, -1))}`);
    console.log(`[Copilot Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const ctx = {
    sessionId: targetSessionId || "",
    observedModel: null,
    isByok: null,
    modelResult: null,
    lastAssistantText: "",
    toolsCalled: [],
    sessionErrors: [],
    resultExitCode: null,
    usage: null,
  };
  let savedSession = Boolean(targetSessionId);
  let timedOut = false;

  try {
    if (targetSessionId) {
      writeAtomicJson(stateFile, {
        ...state,
        phase: "dispatching",
        lastSessionId: targetSessionId,
        lastCwd: root,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    const child = spawn(binPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let buf = "";
    let stderr = "";
    const persistSession = () => {
      if (!ctx.sessionId || savedSession) return;
      savedSession = true;
      writeAtomicJson(stateFile, {
        phase: "dispatching",
        lastSessionId: ctx.sessionId,
        lastCwd: root,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    };

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        consumeJsonlLine(line, ctx, opts.verbose);
        persistSession();
      }
    });
    child.stderr.on("data", (c) => { stderr += c; });

    let timer;
    let guard;
    const exitCode = await new Promise((resolve) => {
      let settled = false;
      const finish = (c) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(guard);
        resolve(c);
      };
      child.on("close", finish);
      child.on("error", () => finish(-1));
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === "win32" && child.pid) {
            spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 });
          } else {
            child.kill("SIGKILL");
          }
        } catch { /* ignore */ }
        try { child.kill(); } catch { /* ignore */ }
        guard = setTimeout(() => {
          for (const s of [child.stdout, child.stderr]) {
            try { s.destroy(); } catch { /* ignore */ }
          }
          try { child.unref(); } catch { /* ignore */ }
          finish(-1);
        }, 3000);
      }, opts.timeout * 1000);
    });

    if (buf.trim()) {
      consumeJsonlLine(buf, ctx, opts.verbose);
      persistSession();
    }

    const verdict = evaluateTerminalState({ exitCode, timedOut, ctx });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    if (ctx.sessionId) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: ctx.sessionId,
        lastCwd: root,
        observedModel: ctx.observedModel || resolvedModel || null,
        isByok: ctx.isByok,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId: ctx.sessionId || null,
      cwd: root,
      requestedModel: resolvedModel || null,
      observedModel: ctx.observedModel || null,
      isByok: ctx.isByok,
      elapsedSec: elapsed,
      usage: ctx.usage,
      toolsCalled: ctx.toolsCalled,
      taskSha256: task.sha256,
      reply: verdict.finalText || ctx.lastAssistantText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Copilot Bridge] session=${ctx.sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} isByok=${ctx.isByok} observedModel=${ctx.observedModel || "none"} tools=${ctx.toolsCalled.length}`);
    console.log(`\n=== [Copilot CLI Reply] ===\n${verdict.finalText || ctx.lastAssistantText || "(no reply)"}\n`);

    if (!verdict.ok) {
      const errTail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`${verdict.reason}${errTail ? " | stderr: " + errTail : ""}`);
    }
  } finally {
    if (stagedTaskPath) {
      try { fs.unlinkSync(stagedTaskPath); } catch { /* ignore */ }
    }
    releaseLock(lockFile);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const root = resolveCwd(opts, process.cwd());
  const stateFile = opts.state
    ? path.resolve(process.cwd(), opts.state)
    : path.join(root, "private", "copilot-bridge", "state.json");
  const copilotHome = path.join(path.dirname(stateFile), "copilot-home");
  const binPath = findCopilotBin();

  if (opts.status) return cmdStatus(binPath, opts, root, stateFile, copilotHome);
  if (opts.models) return cmdModels();

  return dispatch(binPath, opts, root, stateFile, copilotHome);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Copilot Bridge Error]", e.message || e);
    process.exit(1);
  });
}
