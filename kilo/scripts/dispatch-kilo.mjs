#!/usr/bin/env node
/**
 * Kilo CLI Local Bridge - 跨项目通用适配器
 *
 * 目标：驱动本机 `@kilocode/cli` (原生 `kilo.exe run --format json`)，
 *       通过 `KILO_CONFIG_CONTENT` 内存环境变量动态注入自定义 Provider
 *       （引用 `{env:ZAI_API_KEY}` 等，磁盘零明文密钥），
 *       免 Kilo 账号登录直连智谱 GLM（`https://open.bigmodel.cn/api/coding/paas/v4`）。
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
    variant: "",
    write: false,
    pure: true,
    timeout: DEFAULT_TIMEOUT_SEC,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const valueFlags = new Set([
    "--file", "--prompt", "--cwd", "--cwd-file", "--state", "--session",
    "--provider", "--model", "--base-url", "--api-key-env", "--variant", "--timeout",
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
      else if (a === "--variant") opts.variant = val;
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
      case "--with-plugins": opts.pure = false; break;
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

export function findKiloBin(env = process.env) {
  const isWin = process.platform === "win32";
  if (env.KILO_BIN) {
    const p = path.resolve(env.KILO_BIN);
    if (isWin && /\.(cmd|bat|ps1)$/i.test(p)) throw new Error(`Refusing wrapper script (${p}); native kilo.exe is required`);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`KILO_BIN not found: ${p}`);
    return p;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const exe = isWin ? "kilo.exe" : "kilo";
  const candidates = [
    path.join(appData, "npm", "node_modules", "@kilocode", "cli", "node_modules", "@kilocode", "cli-windows-x64", "bin", exe),
    path.join(appData, "npm", "node_modules", "@kilocode", "cli", "node_modules", "@kilocode", "cli-windows-x64-baseline", "bin", exe),
    path.join(appData, "npm", "node_modules", "@kilocode", "cli", "bin", exe),
  ];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
  }
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate native kilo binary. Install `npm i -g @kilocode/cli` or set KILO_BIN.");
}

export function resolveByokCredential(opts, baseEnv = process.env) {
  if (opts.apiKeyEnv) {
    const val = (baseEnv[opts.apiKeyEnv] || "").trim();
    return { key: val, sourceVar: val ? opts.apiKeyEnv : null };
  }
  for (const name of ["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY", "OPENAI_API_KEY", "KILO_API_KEY"]) {
    const val = (baseEnv[name] || "").trim();
    if (val) return { key: val, sourceVar: name };
  }
  return { key: "", sourceVar: null };
}

export function buildKiloConfigContent({ provider, baseUrl, keyEnvVar, model }) {
  const models = {
    "glm-4.7": { name: "GLM-4.7" },
    "glm-5.3": { name: "GLM-5.3" },
    "glm-5.2": { name: "GLM-5.2" },
    "glm-5-turbo": { name: "GLM-5-Turbo" },
  };
  if (model && !models[model]) models[model] = { name: model };
  return JSON.stringify({
    provider: {
      [provider]: {
        npm: "@ai-sdk/openai-compatible",
        name: "BigModel GLM",
        options: {
          baseURL: baseUrl,
          apiKey: `{env:${keyEnvVar}}`,
        },
        models,
      },
    },
  });
}

export function buildChildEnv(opts, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const baseUrl = (opts.baseUrl || DEFAULT_GLM_BASE_URL).trim();
  const model = opts.model || DEFAULT_GLM_MODEL;
  const keyEnvVar = cred.sourceVar || "ZAI_API_KEY";

  env.KILO_CONFIG_CONTENT = buildKiloConfigContent({ provider: opts.provider, baseUrl, keyEnvVar, model });
  if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, keyEnvVar, baseUrl, resolvedModel: model };
}

export function buildRunArgs(opts, root, targetSessionId, resolvedModel) {
  const args = ["run", "--format", "json", "--dir", root];
  if (opts.pure) args.push("--pure");
  if (opts.write) args.push("--auto");
  const modelRef = resolvedModel.includes("/") ? resolvedModel : `${opts.provider}/${resolvedModel}`;
  args.push("--model", modelRef);
  if (opts.variant) args.push("--variant", opts.variant);
  if (targetSessionId) args.push("-s", targetSessionId);
  return args;
}

export function consumeJsonlLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (verbose) console.log(`[kilo-jsonl] ${line.slice(0, 500)}`);

  if (ev.sessionID && !ctx.sessionId) ctx.sessionId = ev.sessionID;

  switch (ev.type) {
    case "step_start":
      ctx.stepCount += 1;
      break;
    case "tool_use": {
      const part = ev.part || {};
      const name = part.tool || "tool";
      ctx.toolsCalled.push(name);
      console.log(`  -> [tool] ${name} (${part.state?.status || "done"})`);
      break;
    }
    case "text": {
      const txt = ev.part?.text;
      if (typeof txt === "string" && txt.trim()) ctx.lastText = txt;
      break;
    }
    case "step_finish": {
      const part = ev.part || {};
      ctx.lastFinishReason = part.reason || null;
      if (part.tokens) ctx.tokens = part.tokens;
      break;
    }
    case "error":
      ctx.errors.push(ev.error?.message || ev.message || JSON.stringify(ev.error || ev));
      break;
    default:
      break;
  }
}

export function evaluateTerminalState({ exitCode, timedOut, ctx }) {
  if (ctx.errors.length > 0) return { ok: false, reason: `Kilo error: ${ctx.errors[ctx.errors.length - 1]}` };
  if (timedOut) return { ok: false, reason: "Timeout waiting for Kilo CLI" };
  if (exitCode !== 0) return { ok: false, reason: `kilo exited with code ${exitCode}` };
  if (ctx.lastFinishReason !== "stop") {
    return { ok: false, reason: `Incomplete stream terminal state (last step_finish reason=${ctx.lastFinishReason ?? "none"})` };
  }
  if (!ctx.lastText || !ctx.lastText.trim()) return { ok: false, reason: "Kilo finished with empty assistant text" };
  return { ok: true, reason: "ok", finalText: ctx.lastText };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[Kilo Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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
  console.log(`Kilo CLI Local Bridge (@kilocode/cli native kilo.exe adapter)

  --status                Check kilo.exe, version, KILO_CONFIG_CONTENT readiness & state
  --models                List native Kilo models (filtering glm/zai) + BYOK GLM catalog
  --file <path>           Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>         Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>             Working directory (default: process.cwd())
  --cwd-file <path>       Read UTF-8 working directory from file
  --state <path>          Override state JSON path
  --reuse                 Resume last completed session in same cwd
  --session <id>          Explicit session ID to resume
  --provider <id>         Custom provider key in KILO_CONFIG_CONTENT (default: bigmodel)
  --model <id>            Model ID (default: ${DEFAULT_GLM_MODEL})
  --base-url <url>        Override OpenAI-compat baseURL (default: ${DEFAULT_GLM_BASE_URL})
  --api-key-env <VAR>     Explicit env var name holding API key
  --variant <name>        Optional reasoning effort variant
  --write                 Pass --auto (auto-approve permissions)
  --with-plugins          Do not pass --pure
  --timeout <sec>         Timeout seconds (1..86400, default 600)
  --dry-run               Validate inputs and print args without executing
  --verbose               Print raw JSONL events
  -h, --help              Show help
`);
}

function cmdStatus(binPath, opts, root, stateFile) {
  const ver = spawnSync(binPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "kilo.exe run --format json (KILO_CONFIG_CONTENT env injection)",
    binary: binPath,
    version: (ver.stdout || "").trim() || null,
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
      model: state.model || null,
      updatedAt: state.updatedAt || null,
    } : null,
  }, null, 2));
}

function cmdModels(binPath, opts) {
  const res = spawnSync(binPath, ["models"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const nativeGlm = (res.stdout || "").split(/\r?\n/).filter((l) => /glm|zai|zhipu/i.test(l));
  console.log(JSON.stringify({
    byokProvider: opts.provider,
    byokModels: ["glm-4.7", "glm-5.3", "glm-5.2", "glm-5-turbo"].map((m) => `${opts.provider}/${m}`),
    nativeGlmMatches: nativeGlm.slice(0, 30),
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
  if (!hasKey) throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / OPENAI_API_KEY.");

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    targetSessionId = state.lastSessionId;
  }

  const args = buildRunArgs(opts, root, targetSessionId, resolvedModel);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[Kilo Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[Kilo Bridge] cwd=${root} keyVar=${keySourceVar} baseUrl=${baseUrl} model=${opts.provider}/${resolvedModel} auto=${opts.write} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Kilo Bridge] dry-run args=${JSON.stringify(args)}`);
    console.log(`[Kilo Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const ctx = {
    sessionId: targetSessionId || "",
    stepCount: 0,
    toolsCalled: [],
    lastText: "",
    lastFinishReason: null,
    tokens: null,
    errors: [],
  };
  let saved = Boolean(targetSessionId);
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
      if (!ctx.sessionId || saved) return;
      saved = true;
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
        model: `${opts.provider}/${resolvedModel}`,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId: ctx.sessionId || null,
      cwd: root,
      requestedModel: `${opts.provider}/${resolvedModel}`,
      lastFinishReason: ctx.lastFinishReason,
      elapsedSec: elapsed,
      tokens: ctx.tokens,
      toolsCalled: ctx.toolsCalled,
      taskSha256: task.sha256,
      reply: verdict.finalText || ctx.lastText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Kilo Bridge] session=${ctx.sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} finish=${ctx.lastFinishReason || "none"} tools=${ctx.toolsCalled.length}`);
    console.log(`\n=== [Kilo CLI Reply] ===\n${verdict.finalText || ctx.lastText || "(no reply)"}\n`);

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
    : path.join(root, "private", "kilo-bridge", "state.json");
  const binPath = findKiloBin();

  if (opts.status) return cmdStatus(binPath, opts, root, stateFile);
  if (opts.models) return cmdModels(binPath, opts);

  return dispatch(binPath, opts, root, stateFile);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Kilo Bridge Error]", e.message || e);
    process.exit(1);
  });
}
