#!/usr/bin/env node
/**
 * Goose CLI Local Bridge - 跨项目通用适配器 (aaif-goose/goose)
 *
 * 目标：驱动本机 Rust 原生 `goose.exe` (`goose run --output-format stream-json`)，
 *       通过隔离 `GOOSE_PATH_ROOT` / `XDG_*` / `APPDATA` + `GOOSE_DISABLE_KEYRING=true`，
 *       免交互直连智谱 GLM（`GOOSE_PROVIDER=openai` + `OPENAI_HOST` + `OPENAI_BASE_PATH=chat/completions`），
 *       支持按消息 ID 累加流式文本、工具调用追踪、`--resume --session-id` 复用与 `goose session list --json` 复核。
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
const DEFAULT_GLM_HOST = "https://open.bigmodel.cn/api/coding/paas/v4";
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
    provider: "openai",
    model: "",
    baseUrl: "",
    apiKeyEnv: "",
    write: false,
    timeout: DEFAULT_TIMEOUT_SEC,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const valueFlags = new Set([
    "--file", "--prompt", "--cwd", "--cwd-file", "--state", "--session",
    "--provider", "--model", "--base-url", "--api-key-env", "--timeout",
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

export function findGooseBin(env = process.env) {
  const isWin = process.platform === "win32";
  if (env.GOOSE_BIN) {
    const p = path.resolve(env.GOOSE_BIN);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`GOOSE_BIN not found: ${p}`);
    return p;
  }
  const exe = isWin ? "goose.exe" : "goose";
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "goose", "goose-package", exe),
    path.join(home, ".local", "goose", exe),
    path.join(home, ".local", "bin", exe),
  ];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
  }
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate goose binary. Install aaif-goose/goose or set GOOSE_BIN.");
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

export function buildChildEnv(opts, gooseHome, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const hostUrl = (opts.baseUrl || DEFAULT_GLM_HOST).trim();
  const model = opts.model || DEFAULT_GLM_MODEL;

  env.GOOSE_PATH_ROOT = gooseHome;
  env.XDG_CONFIG_HOME = path.join(gooseHome, "xdg-cfg");
  env.XDG_DATA_HOME = path.join(gooseHome, "xdg-data");
  env.APPDATA = path.join(gooseHome, "appdata");
  env.LOCALAPPDATA = path.join(gooseHome, "localappdata");
  env.GOOSE_DISABLE_KEYRING = "true";
  env.GOOSE_PROVIDER = opts.provider;
  env.GOOSE_MODEL = model;
  env.GOOSE_MODE = opts.write ? "auto" : "smart_approve";

  if (opts.provider === "anthropic") {
    if (cred.key) env.ANTHROPIC_API_KEY = cred.key;
    env.ANTHROPIC_HOST = hostUrl;
  } else {
    if (cred.key) env.OPENAI_API_KEY = cred.key;
    env.OPENAI_HOST = hostUrl;
    env.OPENAI_BASE_PATH = "chat/completions";
  }

  if (hostUrl.includes("bigmodel.cn") || hostUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, hostUrl, resolvedModel: model };
}

export function buildRunArgs(opts, targetSessionId, resolvedModel) {
  const args = [
    "run",
    "--output-format", "stream-json",
    "--provider", opts.provider,
    "--model", resolvedModel,
    "--no-profile",
  ];
  if (opts.write) args.push("--with-builtin", "developer");
  if (targetSessionId) args.push("--resume", "--session-id", targetSessionId);
  args.push("-i", "-");
  return args;
}

export function consumeStreamJsonLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (verbose) console.log(`[goose-jsonl] ${line.slice(0, 500)}`);

  if (ev.type === "error") {
    ctx.errors.push(ev.error || ev.message || JSON.stringify(ev));
    return;
  }

  if (ev.type === "complete") {
    ctx.completed = true;
    ctx.usage = {
      totalTokens: ev.total_tokens ?? null,
      inputTokens: ev.input_tokens ?? null,
      outputTokens: ev.output_tokens ?? null,
      costUsd: ev.cost_usd ?? null,
    };
    return;
  }

  if (ev.type === "message" && ev.message) {
    const msg = ev.message;
    const reqModel = msg.metadata?.inference?.requestedModel;
    if (reqModel) ctx.observedModel = `${msg.metadata?.inference?.provider || optsProviderFallback(msg)}/${reqModel}`;
    if (msg.role === "assistant") {
      const msgId = msg.id || "default";
      for (const c of msg.content || []) {
        if (c.type === "text" && typeof c.text === "string") {
          const prev = ctx.msgTexts.get(msgId) || "";
          ctx.msgTexts.set(msgId, prev + c.text);
          ctx.lastMsgId = msgId;
        } else if (c.type === "toolRequest" || c.type === "tool_use") {
          const name = c.toolCall?.value?.name || c.name || "tool";
          ctx.toolsCalled.push(name);
          console.log(`  -> [tool] ${name}`);
        }
      }
    }
  }
}

function optsProviderFallback(msg) {
  return msg.metadata?.inference?.provider || "openai";
}

export function evaluateTerminalState({ exitCode, timedOut, ctx }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for Goose CLI" };
  if (ctx.errors.length > 0) return { ok: false, reason: `Goose error: ${ctx.errors[ctx.errors.length - 1]}` };
  if (exitCode !== 0) return { ok: false, reason: `goose exited with code ${exitCode}` };
  if (!ctx.completed) return { ok: false, reason: "Goose stream ended without complete event" };
  const reply = (ctx.lastMsgId ? ctx.msgTexts.get(ctx.lastMsgId) : "") || "";
  if (!reply.trim()) return { ok: false, reason: "Goose finished with empty assistant response" };
  return { ok: true, reason: "ok", finalText: reply };
}

function listGooseSessions(binPath, env, root) {
  const res = spawnSync(binPath, ["session", "list", "--format", "json"], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (res.status !== 0) return [];
  try {
    const list = JSON.parse((res.stdout || "").trim() || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[Goose Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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
  console.log(`Goose CLI Local Bridge (aaif-goose/goose native goose.exe adapter)

  --status                Check goose.exe, version, isolated GOOSE_PATH_ROOT & state
  --models                List GLM presets
  --file <path>           Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>         Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>             Working directory (default: process.cwd())
  --cwd-file <path>       Read UTF-8 working directory from file
  --state <path>          Override state JSON path
  --reuse                 Resume last completed session in same cwd
  --session <id>          Explicit session ID to resume
  --provider <name>       openai (default) | anthropic
  --model <id>            Model ID (default: ${DEFAULT_GLM_MODEL})
  --base-url <url>        Override OPENAI_HOST (default: ${DEFAULT_GLM_HOST})
  --api-key-env <VAR>     Explicit env var name holding API key
  --write                 Enable GOOSE_MODE=auto + --with-builtin developer
  --timeout <sec>         Timeout seconds (1..86400, default 600)
  --dry-run               Validate inputs and print args without executing
  --verbose               Print raw stream-json events
  -h, --help              Show help
`);
}

function cmdStatus(binPath, opts, root, stateFile, gooseHome) {
  const ver = spawnSync(binPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const { hasKey, keySourceVar, hostUrl, resolvedModel } = buildChildEnv(opts, gooseHome);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "goose.exe run --output-format stream-json -i - (isolated GOOSE_PATH_ROOT)",
    binary: binPath,
    version: (ver.stdout || "").trim() || null,
    gooseHome,
    provider: opts.provider,
    hostUrl,
    defaultModel: resolvedModel,
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
  console.log(JSON.stringify({
    provider: opts.provider,
    hostUrl: opts.baseUrl || DEFAULT_GLM_HOST,
    models: ["glm-4.7", "glm-5.3", "glm-5.2", "glm-5-turbo"].map((id) => ({ id })),
  }, null, 2));
}

async function dispatch(binPath, opts, root, stateFile, gooseHome) {
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

  const { env, hasKey, keySourceVar, hostUrl, resolvedModel } = buildChildEnv(opts, gooseHome);
  if (!hasKey) throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / OPENAI_API_KEY.");

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    targetSessionId = state.lastSessionId;
  }

  for (const sub of ["config", "xdg-cfg", "xdg-data", "appdata", "localappdata"]) {
    fs.mkdirSync(path.join(gooseHome, sub), { recursive: true });
  }

  const args = buildRunArgs(opts, targetSessionId, resolvedModel);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[Goose Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[Goose Bridge] cwd=${root} keyVar=${keySourceVar} host=${hostUrl} model=${resolvedModel} write=${opts.write} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Goose Bridge] dry-run args=${JSON.stringify(args)}`);
    console.log(`[Goose Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const ctx = {
    observedModel: null,
    msgTexts: new Map(),
    lastMsgId: "",
    toolsCalled: [],
    errors: [],
    completed: false,
    usage: null,
  };
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
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        consumeStreamJsonLine(line, ctx, opts.verbose);
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

    if (buf.trim()) consumeStreamJsonLine(buf, ctx, opts.verbose);

    const sessions = listGooseSessions(binPath, env, root);
    const matched = sessions.find((s) => s.working_dir === root) || sessions[0];
    const sessionId = targetSessionId || matched?.id || "";

    const verdict = evaluateTerminalState({ exitCode, timedOut, ctx });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    if (sessionId) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: sessionId,
        lastCwd: root,
        observedModel: ctx.observedModel || `${opts.provider}/${resolvedModel}`,
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
      observedModel: ctx.observedModel || null,
      elapsedSec: elapsed,
      usage: ctx.usage,
      toolsCalled: ctx.toolsCalled,
      taskSha256: task.sha256,
      reply: verdict.finalText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Goose Bridge] session=${sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} observedModel=${ctx.observedModel || "none"} tools=${ctx.toolsCalled.length}`);
    console.log(`\n=== [Goose CLI Reply] ===\n${verdict.finalText || "(no reply)"}\n`);

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
    : path.join(root, "private", "goose-bridge", "state.json");
  const gooseHome = path.join(path.dirname(stateFile), "goose-home");
  const binPath = findGooseBin();

  if (opts.status) return cmdStatus(binPath, opts, root, stateFile, gooseHome);
  if (opts.models) return cmdModels(opts);

  return dispatch(binPath, opts, root, stateFile, gooseHome);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Goose Bridge Error]", e.message || e);
    process.exit(1);
  });
}
