#!/usr/bin/env node
/**
 * Claude Code Local Bridge - 跨项目通用适配器
 *
 * 目标：让外部「主 Agent」通过一条纯 ASCII 短命令，
 *       驱动本机 `@anthropic-ai/claude-code` (claude.exe) 无头 CLI，
 *       支持通过 `--bare` 跳过 Claude.ai 订阅登录与首次安装引导，
 *       直连智谱 GLM Anthropic 兼容端点 (`https://open.bigmodel.cn/api/anthropic`)
 *       或任意兼容 Anthropic Messages 的 API，并执行三层验收。
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
    baseUrl: "",
    apiKeyEnv: "",
    permissionMode: "default", // default | plan | acceptEdits | dontAsk | bypassPermissions
    write: false,
    withUserConfig: false,
    effort: "",
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
    "--base-url",
    "--api-key-env",
    "--permission-mode",
    "--effort",
    "--timeout",
  ]);
  const seen = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
      continue;
    }
    if (seen.has(a) && a !== "--verbose") {
      throw new Error(`Duplicate flag: ${a}`);
    }
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
      else if (a === "--effort") opts.effort = val;
      else if (a === "--permission-mode") {
        if (!["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"].includes(val)) {
          throw new Error(`Invalid --permission-mode: ${val}`);
        }
        opts.permissionMode = val;
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
      case "--with-user-config": opts.withUserConfig = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (opts.file && opts.prompt) throw new Error("Cannot pass both --file and --prompt");
  if (opts.cwd && opts.cwdFile) throw new Error("Cannot pass both --cwd and --cwd-file");
  if (opts.reuse && opts.session) throw new Error("Cannot pass both --reuse and --session");
  if (opts.write && opts.permissionMode === "default") opts.permissionMode = "bypassPermissions";
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

export function findClaudeBin(env = process.env) {
  const isWin = process.platform === "win32";
  const rejectWrapper = (p) => {
    if (isWin && /\.(cmd|bat|ps1)$/i.test(p)) {
      throw new Error(`Refusing wrapper script (${p}); native claude.exe is required`);
    }
  };
  if (env.CLAUDE_BIN) {
    const p = path.resolve(env.CLAUDE_BIN);
    rejectWrapper(p);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error(`CLAUDE_BIN not found: ${p}`);
    }
    return p;
  }

  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const exe = isWin ? "claude.exe" : "claude";
  const candidates = [
    path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", exe),
    path.join(os.homedir(), ".local", "bin", exe),
  ];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
  }
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* ignore */ }
  }
  throw new Error("Could not locate native claude binary. Install `@anthropic-ai/claude-code` or set CLAUDE_BIN.");
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
    { name: "ANTHROPIC_API_KEY", glm: false },
    { name: "ANTHROPIC_AUTH_TOKEN", glm: false },
  ];
  for (const item of order) {
    const val = (baseEnv[item.name] || "").trim();
    if (val) {
      return { key: val, sourceVar: item.name, isGlmLike: item.glm || /^[0-9a-f]{32}\.[A-Za-z0-9]+$/.test(val) };
    }
  }
  return { key: "", sourceVar: null, isGlmLike: false };
}

export function buildChildEnv(opts, baseEnv = process.env) {
  const env = { ...baseEnv };
  // Avoid leaking parent Claude Code session locks/nest guards
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const cred = resolveByokCredential(opts, baseEnv);
  const baseUrl = (opts.baseUrl || env.ANTHROPIC_BASE_URL || (cred.isGlmLike ? DEFAULT_GLM_ANTHROPIC_BASE_URL : "")).trim();
  const model = opts.model || (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai") || cred.isGlmLike ? DEFAULT_GLM_MODEL : "");

  if (cred.key) {
    if (env.ANTHROPIC_AUTH_TOKEN && !cred.isGlmLike && cred.sourceVar === "ANTHROPIC_AUTH_TOKEN") {
      env.ANTHROPIC_AUTH_TOKEN = cred.key;
    } else {
      env.ANTHROPIC_API_KEY = cred.key;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
  }
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
    if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
      // Direct CN endpoint without stale proxy overrides unless explicitly kept
      if (!baseEnv.CLAUDE_KEEP_PROXY) {
        delete env.HTTP_PROXY;
        delete env.HTTPS_PROXY;
      }
      if (model) {
        env.ANTHROPIC_MODEL = model;
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      }
    }
  }
  return {
    env,
    hasKey: Boolean(cred.key),
    keySourceVar: cred.sourceVar,
    baseUrl: baseUrl || null,
    resolvedModel: model || null,
  };
}

export function buildExecArgs(opts, targetSessionId, resolvedModel) {
  const args = ["-p"];
  if (!opts.withUserConfig) args.push("--bare");
  if (targetSessionId) args.push("--resume", targetSessionId);
  if (resolvedModel) args.push("--model", resolvedModel);
  if (opts.effort) args.push("--effort", opts.effort);
  args.push("--permission-mode", opts.permissionMode);
  args.push("--output-format", "stream-json", "--verbose");
  return args;
}

export function consumeStreamJsonLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (verbose) console.log(`[claude-jsonl] ${line.slice(0, 500)}`);

  if (ev.session_id && !ctx.sessionId) ctx.sessionId = ev.session_id;

  if (ev.type === "system" && ev.subtype === "init") {
    ctx.initModel = ev.model || null;
    ctx.apiKeySource = ev.apiKeySource || null;
    return;
  }

  if (ev.type === "assistant" && ev.message) {
    if (ev.message.model) ctx.observedModel = ev.message.model;
    for (const part of ev.message.content || []) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        ctx.lastAssistantText = part.text;
      } else if (part.type === "tool_use") {
        ctx.toolsCalled.push(part.name || "tool");
        console.log(`  -> [tool] ${part.name}`);
      }
    }
    return;
  }

  if (ev.type === "result") {
    ctx.resultSubtype = ev.subtype || null;
    ctx.isError = Boolean(ev.is_error);
    ctx.resultText = typeof ev.result === "string" ? ev.result : "";
    ctx.resultError = Array.isArray(ev.errors) && ev.errors.length > 0
      ? ev.errors.join("; ")
      : (ev.error?.message || null);
    ctx.usage = ev.usage || null;
    ctx.modelUsage = ev.modelUsage || null;
    if (ev.modelUsage && typeof ev.modelUsage === "object") {
      const keys = Object.keys(ev.modelUsage);
      if (keys.length > 0) ctx.observedModel = keys[0];
    }
    ctx.permissionDenials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
  }
}

export function evaluateTerminalState({ exitCode, timedOut, ctx }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for Claude Code" };
  if (ctx.isError || ctx.resultError) {
    return { ok: false, reason: `Claude Code error (${ctx.resultSubtype || "error"}): ${ctx.resultError || ctx.lastAssistantText}` };
  }
  if (exitCode !== 0) return { ok: false, reason: `Claude Code exited with code ${exitCode}` };
  if (ctx.resultSubtype !== "success") {
    return { ok: false, reason: `Stream ended without result.subtype=success (got ${ctx.resultSubtype || "none"})` };
  }
  if (ctx.permissionDenials.length > 0) {
    return { ok: false, reason: `Tool permission denials (${ctx.permissionDenials.length}); pass --write to allow edits/commands` };
  }
  const finalText = ctx.resultText || ctx.lastAssistantText;
  if (!finalText || !finalText.trim()) {
    return { ok: false, reason: "Claude Code finished with empty result text" };
  }
  return { ok: true, reason: "ok", finalText };
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (e) {
    if (fs.existsSync(stateFile)) console.warn(`[Claude Bridge] State unreadable, ignoring: ${e.message}`);
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
  console.log(`Claude Code Local Bridge (@anthropic-ai/claude-code adapter, BYO-Key skip-login)

  --status                    Check claude.exe, version, BYOK credentials & state
  --models                    List verified GLM Anthropic-compatible & Claude model IDs
  --file <path>               Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>             Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>                 Working directory (default: process.cwd())
  --cwd-file <path>           Read UTF-8 working directory from file
  --state <path>              Override state JSON path
  --reuse                     Resume last completed session in same cwd
  --session <id>              Explicit session UUID to resume
  --model <id>                Model ID (e.g. glm-4.7, glm-5.3, glm-5.2)
  --base-url <url>            Override ANTHROPIC_BASE_URL (default BigModel: ${DEFAULT_GLM_ANTHROPIC_BASE_URL})
  --api-key-env <VAR>         Explicit env var holding API key (default checks ZAI_API_KEY/ZHIPU_API_KEY/ANTHROPIC_API_KEY)
  --permission-mode <mode>    default | plan | acceptEdits | dontAsk | bypassPermissions
  --write                     Shorthand for --permission-mode bypassPermissions
  --with-user-config          Disable --bare and load user ~/.claude settings/hooks
  --effort <level>            Optional reasoning effort (low | medium | high | max)
  --timeout <sec>             Timeout seconds (1..86400, default 600)
  --dry-run                   Validate inputs and print args without executing
  --verbose                   Print raw stream-json events
  -h, --help                  Show help
`);
}

function cmdStatus(binPath, opts, root, stateFile) {
  const ver = spawnSync(binPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey || opts.withUserConfig,
    transport: "claude.exe -p --bare --output-format stream-json (JSONL over stdio)",
    binary: binPath,
    version: (ver.stdout || "").trim() || null,
    skipLoginMode: !opts.withUserConfig ? "--bare + ANTHROPIC_API_KEY/BASE_URL" : "user-config (~/.claude)",
    keySourceVar,
    hasCredentials: hasKey,
    baseUrl,
    defaultModel: resolvedModel,
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

function cmdModels() {
  console.log(JSON.stringify({
    endpointDefault: DEFAULT_GLM_ANTHROPIC_BASE_URL,
    models: [
      { id: "glm-4.7", role: "fast-coding-default", note: "Verified on open.bigmodel.cn/api/anthropic" },
      { id: "glm-5.3", role: "flagship-reasoning", note: "GLM-5.3 via BigModel Anthropic-compatible endpoint" },
      { id: "glm-5.2", role: "stable-flagship", note: "GLM-5.2" },
      { id: "glm-5-turbo", role: "agent-optimized", note: "GLM-5-Turbo" },
      { id: "claude-sonnet-4-5", role: "anthropic-official", note: "Requires Anthropic or relay key" },
    ],
  }, null, 2));
}

async function dispatch(binPath, opts, root, stateFile) {
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

  const { env, hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts);
  if (!hasKey && !opts.withUserConfig) {
    throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / ANTHROPIC_API_KEY or pass --with-user-config.");
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

  const args = buildExecArgs(opts, targetSessionId, resolvedModel);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[Claude Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[Claude Bridge] cwd=${root} keyVar=${keySourceVar || "(user-auth)"} baseUrl=${baseUrl || "(official)"} model=${resolvedModel || "(default)"} perm=${opts.permissionMode} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Claude Bridge] dry-run args=${JSON.stringify(args)}`);
    console.log(`[Claude Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const ctx = {
    sessionId: targetSessionId || "",
    initModel: null,
    observedModel: null,
    apiKeySource: null,
    lastAssistantText: "",
    resultText: "",
    resultSubtype: null,
    isError: false,
    resultError: null,
    usage: null,
    modelUsage: null,
    toolsCalled: [],
    permissionDenials: [],
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
      stdio: ["pipe", "pipe", "pipe"],
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
        consumeStreamJsonLine(line, ctx, opts.verbose);
        persistSession();
      }
    });
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
          for (const s of [child.stdout, child.stderr, child.stdin]) {
            try { s.destroy(); } catch { /* ignore */ }
          }
          try { child.unref(); } catch { /* ignore */ }
          finish(-1);
        }, 3000);
      }, opts.timeout * 1000);
    });

    if (buf.trim()) {
      consumeStreamJsonLine(buf, ctx, opts.verbose);
      persistSession();
    }

    const verdict = evaluateTerminalState({ exitCode, timedOut, ctx });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    if (ctx.sessionId) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: ctx.sessionId,
        lastCwd: root,
        observedModel: ctx.observedModel || ctx.initModel || resolvedModel || null,
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
      observedModel: ctx.observedModel || ctx.initModel || null,
      resultSubtype: ctx.resultSubtype,
      elapsedSec: elapsed,
      usage: ctx.usage,
      toolsCalled: ctx.toolsCalled,
      permissionDenials: ctx.permissionDenials,
      taskSha256: task.sha256,
      reply: verdict.finalText || ctx.lastAssistantText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Claude Bridge] session=${ctx.sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} subtype=${ctx.resultSubtype || "none"} observedModel=${ctx.observedModel || "none"} tools=${ctx.toolsCalled.length}`);
    console.log(`\n=== [Claude Code Reply] ===\n${verdict.finalText || ctx.lastAssistantText || "(no reply)"}\n`);

    if (!verdict.ok) {
      const errTail = stderr.trim().split(/\r?/).slice(-3).join(" | ");
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
    : path.join(root, "private", "claude-bridge", "state.json");
  const binPath = findClaudeBin();

  if (opts.status) return cmdStatus(binPath, opts, root, stateFile);
  if (opts.models) return cmdModels();

  return dispatch(binPath, opts, root, stateFile);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Claude Bridge Error]", e.message || e);
    process.exit(1);
  });
}
