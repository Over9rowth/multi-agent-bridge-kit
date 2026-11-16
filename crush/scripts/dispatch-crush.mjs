#!/usr/bin/env node
/**
 * Crush CLI Local Bridge - 跨项目通用适配器
 *
 * 目标：驱动本机 `@charmland/crush` (原生 Go 二进制 `crush.exe`)，
 *       通过 `CRUSH_GLOBAL_CONFIG` + `-D <data-dir>` 隔离配置与会话库（不污染目标工作区），
 *       在 `crush.json` 中使用 `$<ENV_VAR>` 引用环境变量（磁盘零明文密钥），
 *       免登录直连智谱 GLM（`https://open.bigmodel.cn/api/coding/paas/v4`），并通过 `crush session last --json` 复核终态与工具调用。
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
const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
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
    provider: "bigmodel",
    model: "",
    baseUrl: "",
    apiKeyEnv: "",
    reasoningEffort: "",
    write: false,
    timeout: DEFAULT_TIMEOUT_SEC,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const valueFlags = new Set([
    "--file", "--prompt", "--cwd", "--cwd-file", "--state", "--session",
    "--provider", "--model", "--base-url", "--api-key-env", "--reasoning-effort", "--timeout",
  ]);
  const seen = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (seen.has(a) && a !== "--verbose") throw new Error(`Duplicate flag: ${a}`);
    seen.add(a);

    if (valueFlags.has(a)) {
      const val = argv[++i];
      if (val === undefined || (val.startsWith("--") && val.length > 2)) throw new Error(`Missing value for flag: ${a}`);
      if (a === "--file") opts.file = val;
      else if (a === "--prompt") opts.prompt = val;
      else if (a === "--cwd") opts.cwd = val;
      else if (a === "--cwd-file") opts.cwdFile = val;
      else if (a === "--state") opts.state = val;
      else if (a === "--session") opts.session = val;
      else if (a === "--provider") opts.provider = val;
      else if (a === "--model") opts.model = val;
      else if (a === "--base-url") opts.baseUrl = val;
      else if (a === "--api-key-env") opts.apiKeyEnv = val;
      else if (a === "--reasoning-effort") opts.reasoningEffort = val;
      else if (a === "--timeout") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 86400) throw new Error(`Invalid --timeout (1..86400): ${val}`);
        opts.timeout = n;
      }
      continue;
    }

    switch (a) {
      case "--status": opts.status = true; break;
      case "--models": opts.models = true; break;
      case "--reuse": opts.reuse = true; break;
      case "--write": opts.write = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (opts.file && opts.prompt) throw new Error("Cannot pass both --file and --prompt");
  if (opts.cwd && opts.cwdFile) throw new Error("Cannot pass both --cwd and --cwd-file");
  if (opts.reuse && opts.session) throw new Error("Cannot pass both --reuse and --session");
  return opts;
}

export function validateShortAsciiPrompt(text) {
  if (!text || !text.trim()) throw new Error("Empty --prompt");
  if (text.length >= MAX_ASCII_PROMPT_LEN) throw new Error(`--prompt length (${text.length}) >= ${MAX_ASCII_PROMPT_LEN}; use UTF-8 --file instead`);
  if (/[\r\n]/.test(text)) throw new Error("--prompt must be single-line ASCII; use --file instead");
  if (/[^\x20-\x7E]/.test(text)) throw new Error("--prompt only accepts pure ASCII (< 80 chars); use --file for Chinese/UTF-8 tasks");
}

export function readUtf8TaskFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) throw new Error(`Task file is empty: ${filePath}`);
  if (buf.length > MAX_TASK_BYTES) throw new Error(`Task file exceeds 1 MiB (${buf.length} bytes): ${filePath}`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = decoder.decode(buf);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (!text.trim()) throw new Error(`Task file contains only whitespace: ${filePath}`);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  return { text, bytes: buf.length, sha256 };
}

export function resolveCwd(opts, baseDir = process.cwd()) {
  let raw = opts.cwd;
  if (opts.cwdFile) raw = readUtf8TaskFile(path.resolve(baseDir, opts.cwdFile)).text.trim();
  const target = path.resolve(baseDir, raw || ".");
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Working directory does not exist or is not a directory: ${target}`);
  }
  return fs.realpathSync(target);
}

export function findCrushBin(env = process.env) {
  const isWin = process.platform === "win32";
  if (env.CRUSH_BIN) {
    const p = path.resolve(env.CRUSH_BIN);
    if (isWin && /\.(cmd|bat|ps1)$/i.test(p)) throw new Error(`Refusing wrapper script (${p}); native crush.exe is required`);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`CRUSH_BIN not found: ${p}`);
    return p;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const exe = isWin ? "crush.exe" : "crush";
  const candidates = [
    path.join(appData, "npm", "node_modules", "@charmland", "crush", "bin", exe),
    path.join(os.homedir(), ".local", "bin", exe),
  ];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
  }
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate native crush binary. Install `npm i -g @charmland/crush` or set CRUSH_BIN.");
}

export function resolveByokCredential(opts, baseEnv = process.env) {
  if (opts.apiKeyEnv) {
    const val = (baseEnv[opts.apiKeyEnv] || "").trim();
    return { key: val, sourceVar: val ? opts.apiKeyEnv : null };
  }
  for (const name of ["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const val = (baseEnv[name] || "").trim();
    if (val) return { key: val, sourceVar: name };
  }
  return { key: "", sourceVar: null };
}

export function buildCrushConfig({ provider, baseUrl, keyEnvVar, model }) {
  const catalog = [
    { id: "glm-4.7", name: "GLM-4.7", context_window: 200000, default_max_tokens: 16384 },
    { id: "glm-5.3", name: "GLM-5.3", context_window: 200000, default_max_tokens: 32768 },
    { id: "glm-5.2", name: "GLM-5.2", context_window: 200000, default_max_tokens: 32768 },
    { id: "glm-5-turbo", name: "GLM-5-Turbo", context_window: 200000, default_max_tokens: 16384 },
  ];
  if (model && !catalog.some((m) => m.id === model)) {
    catalog.unshift({ id: model, name: model, context_window: 200000, default_max_tokens: 16384 });
  }
  const active = model || DEFAULT_GLM_MODEL;
  return {
    providers: {
      [provider]: {
        name: "BigModel GLM",
        type: "openai-compat",
        base_url: baseUrl,
        api_key: `$${keyEnvVar}`, // Env var reference ONLY, zero plaintext key on disk
        models: catalog,
      },
    },
    models: {
      large: { provider, model: active },
      small: { provider, model: active },
    },
  };
}

export function buildChildEnv(opts, configDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const baseUrl = (opts.baseUrl || DEFAULT_GLM_BASE_URL).trim();
  const model = opts.model || DEFAULT_GLM_MODEL;
  const keyEnvVar = cred.sourceVar || "ZAI_API_KEY";

  env.CRUSH_GLOBAL_CONFIG = configDir;
  if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, keyEnvVar, baseUrl, resolvedModel: model };
}

export function buildRunArgs(opts, root, dataDir, targetSessionId, resolvedModel) {
  const args = ["run", "-c", root, "-D", dataDir, "-m", `${opts.provider}/${resolvedModel}`, "-q"];
  if (opts.write) args.push("-y");
  if (opts.reasoningEffort) args.push("--reasoning-effort", opts.reasoningEffort);
  if (targetSessionId) args.push("-s", targetSessionId);
  return args;
}

export function parseSessionDetail(jsonText) {
  if (!jsonText || !jsonText.trim()) return null;
  let data;
  try { data = JSON.parse(jsonText); } catch { return null; }
  const meta = data.meta || {};
  const messages = Array.isArray(data.messages) ? data.messages : [];
  let observedModel = null;
  const toolsCalled = [];
  let lastFinishReason = null;
  let lastAssistantText = "";

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (msg.model) observedModel = `${msg.provider ? msg.provider + "/" : ""}${msg.model}`;
      for (const p of msg.parts || []) {
        if (p.type === "tool_call") toolsCalled.push(p.name || "tool");
        else if (p.type === "text" && typeof p.text === "string" && p.text.trim()) lastAssistantText = p.text;
        else if (p.type === "finish") lastFinishReason = p.reason || null;
      }
    }
  }
  return {
    sessionId: meta.id || null,
    observedModel,
    toolsCalled,
    lastFinishReason,
    lastAssistantText,
    usage: {
      promptTokens: meta.prompt_tokens ?? null,
      completionTokens: meta.completion_tokens ?? null,
      totalTokens: meta.total_tokens ?? null,
    },
  };
}

export function evaluateTerminalState({ exitCode, timedOut, stdoutText, sessionDetail }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for Crush CLI" };
  if (exitCode !== 0) return { ok: false, reason: `crush exited with code ${exitCode}` };
  const reply = (stdoutText || "").trim() || sessionDetail?.lastAssistantText?.trim() || "";
  if (!reply) return { ok: false, reason: "Crush finished with empty output" };
  if (sessionDetail?.lastFinishReason && sessionDetail.lastFinishReason !== "end_turn") {
    return { ok: false, reason: `Unexpected Crush finish reason=${sessionDetail.lastFinishReason}` };
  }
  return { ok: true, reason: "ok", finalText: reply };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[Crush Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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

function releaseLock(lockFile) { try { fs.unlinkSync(lockFile); } catch { /* ignore */ } }

function printHelp() {
  console.log(`Crush CLI Local Bridge (@charmland/crush native crush.exe adapter)

  --status                    Check crush.exe, version, CRUSH_GLOBAL_CONFIG & state
  --models                    List configured GLM models
  --file <path>               Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>             Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>                 Working directory (default: process.cwd())
  --cwd-file <path>           Read UTF-8 working directory from file
  --state <path>              Override state JSON path
  --reuse                     Resume last completed session in same cwd
  --session <id>              Explicit session ID to resume
  --provider <id>             Provider key in isolated crush.json (default: bigmodel)
  --model <id>                Model ID (default: ${DEFAULT_GLM_MODEL})
  --base-url <url>            Override OpenAI-compat base_url (default: ${DEFAULT_GLM_BASE_URL})
  --api-key-env <VAR>         Explicit env var name holding API key
  --reasoning-effort <lvl>    Optional reasoning effort (low | medium | high)
  --write                     Pass -y (yolo auto-approve)
  --timeout <sec>             Timeout seconds (1..86400, default 600)
  --dry-run                   Validate inputs and print args without executing
  --verbose                   Print session JSON summary
  -h, --help                  Show help
`);
}

function cmdStatus(binPath, opts, root, stateFile, configDir, dataDir) {
  const ver = spawnSync(binPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts, configDir);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "crush.exe run -c <cwd> -D <dataDir> -q + crush session last --json",
    binary: binPath,
    version: (ver.stdout || "").trim() || null,
    configDir,
    dataDir,
    provider: opts.provider,
    baseUrl,
    defaultModel: `${opts.provider}/${resolvedModel}`,
    keySourceVar,
    hasCredentials: hasKey,
    cwd: root,
    stateFile,
    bridgeState: state.phase ? {
      phase: state.phase,
      lastSessionId: state.lastSessionId || null,
      lastCwd: state.lastCwd || null,
      observedModel: state.observedModel || null,
      updatedAt: state.updatedAt || null,
    } : null,
  }, null, 2));
}

function cmdModels(opts) {
  const cfg = buildCrushConfig({
    provider: opts.provider,
    baseUrl: opts.baseUrl || DEFAULT_GLM_BASE_URL,
    keyEnvVar: opts.apiKeyEnv || "ZAI_API_KEY",
    model: opts.model,
  });
  console.log(JSON.stringify({ provider: opts.provider, models: cfg.providers[opts.provider].models }, null, 2));
}

async function dispatch(binPath, opts, root, stateFile, configDir, dataDir) {
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

  const { env, hasKey, keySourceVar, keyEnvVar, baseUrl, resolvedModel } = buildChildEnv(opts, configDir);
  if (!hasKey) throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / OPENAI_API_KEY.");

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    targetSessionId = state.lastSessionId;
  }

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "crush.json"), JSON.stringify(buildCrushConfig({
    provider: opts.provider,
    baseUrl,
    keyEnvVar,
    model: resolvedModel,
  }), null, 2), "utf8");

  const args = buildRunArgs(opts, root, dataDir, targetSessionId, resolvedModel);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[Crush Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[Crush Bridge] cwd=${root} keyVar=${keySourceVar} model=${opts.provider}/${resolvedModel} yolo=${opts.write} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Crush Bridge] dry-run args=${JSON.stringify(args)}`);
    console.log(`[Crush Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
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
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdoutText = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdoutText += c; });
    child.stderr.on("data", (c) => { stderr += c; });

    child.stdin.on("error", () => {});
    child.stdin.write(task.text, "utf8");
    child.stdin.end();

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
          for (const s of [child.stdout, child.stderr, child.stdin]) { try { s.destroy(); } catch { /* ignore */ } }
          try { child.unref(); } catch { /* ignore */ }
          finish(-1);
        }, 3000);
      }, opts.timeout * 1000);
    });

    const inspectArgs = targetSessionId
      ? ["session", "show", targetSessionId, "-c", root, "-D", dataDir, "--json"]
      : ["session", "last", "-c", root, "-D", dataDir, "--json"];
    const inspect = spawnSync(binPath, inspectArgs, { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 15000 });
    const sessionDetail = inspect.status === 0 ? parseSessionDetail(inspect.stdout) : null;
    if (opts.verbose && sessionDetail) {
      console.log(`[Crush Session] ${JSON.stringify(sessionDetail)}`);
    }
    for (const t of sessionDetail?.toolsCalled || []) {
      console.log(`  -> [tool] ${t}`);
    }

    const sessionId = targetSessionId || sessionDetail?.sessionId || "";
    const verdict = evaluateTerminalState({ exitCode, timedOut, stdoutText, sessionDetail });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    if (sessionId) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: sessionId,
        lastCwd: root,
        observedModel: sessionDetail?.observedModel || `${opts.provider}/${resolvedModel}`,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId: sessionId || null,
      cwd: root,
      requestedModel: `${opts.provider}/${resolvedModel}`,
      observedModel: sessionDetail?.observedModel || null,
      lastFinishReason: sessionDetail?.lastFinishReason || null,
      elapsedSec: elapsed,
      usage: sessionDetail?.usage || null,
      toolsCalled: sessionDetail?.toolsCalled || [],
      taskSha256: task.sha256,
      reply: verdict.finalText || stdoutText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Crush Bridge] session=${sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} observedModel=${sessionDetail?.observedModel || "none"} tools=${sessionDetail?.toolsCalled?.length || 0}`);
    console.log(`\n=== [Crush CLI Reply] ===\n${verdict.finalText || stdoutText.trim() || "(no reply)"}\n`);

    if (!verdict.ok) {
      const errTail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`${verdict.reason}${errTail ? " | stderr: " + errTail : ""}`);
    }
  } finally {
    releaseLock(lockFile);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const root = resolveCwd(opts, process.cwd());
  const stateFile = opts.state
    ? path.resolve(process.cwd(), opts.state)
    : path.join(root, "private", "crush-bridge", "state.json");
  const baseDir = path.dirname(stateFile);
  const configDir = path.join(baseDir, "crush-config");
  const dataDir = path.join(baseDir, "crush-data");
  const binPath = findCrushBin();

  if (opts.status) return cmdStatus(binPath, opts, root, stateFile, configDir, dataDir);
  if (opts.models) return cmdModels(opts);

  return dispatch(binPath, opts, root, stateFile, configDir, dataDir);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Crush Bridge Error]", e.message || e);
    process.exit(1);
  });
}
