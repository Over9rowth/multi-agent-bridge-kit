#!/usr/bin/env node
/**
 * Kimi Code CLI Local Bridge - 跨项目通用适配器 (BYO-Key 跳过 Kimi 会员登录)
 *
 * 目标：让外部「主 Agent」通过一条纯 ASCII 短命令，
 *       驱动本机 `@moonshot-ai/kimi-code` (`dist/main.mjs`) 无头 CLI，
 *       以隔离 `.kimi-code/config.toml` + `api_key_env`（磁盘零明文 Key）
 *       直连智谱 GLM（`https://open.bigmodel.cn/api/coding/paas/v4`）或 Kimi/OpenAI 兼容端点，
 *       支持 `-S <session_id>` 会话复用与 JSONL 终态验收。
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
    model: "",
    providerType: "openai", // openai | anthropic | kimi
    baseUrl: "",
    apiKeyEnv: "",
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
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
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
        if (!["openai", "anthropic", "kimi"].includes(val)) throw new Error(`Invalid --provider-type: ${val}`);
        opts.providerType = val;
      } else if (a === "--timeout") {
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

export function findKimiCli(env = process.env) {
  if (env.KIMI_CLI_ENTRY) {
    const p = path.resolve(env.KIMI_CLI_ENTRY);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`KIMI_CLI_ENTRY not found: ${p}`);
    return p;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs"),
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs"),
    "/usr/local/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate @moonshot-ai/kimi-code/dist/main.mjs. Install `npm i -g @moonshot-ai/kimi-code` or set KIMI_CLI_ENTRY.");
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
    { name: "KIMI_API_KEY", glm: false },
    { name: "OPENAI_API_KEY", glm: false },
  ];
  for (const item of order) {
    const val = (baseEnv[item.name] || "").trim();
    if (val) return { key: val, sourceVar: item.name, isGlmLike: item.glm || /^[0-9a-f]{32}\.[A-Za-z0-9]+$/.test(val) };
  }
  return { key: "", sourceVar: null, isGlmLike: false };
}

export function buildConfigToml({ providerType, baseUrl, keyEnvVar, model }) {
  const alias = `custom/${model}`;
  return `default_model = ${JSON.stringify(alias)}

[providers.custom]
type = ${JSON.stringify(providerType)}
base_url = ${JSON.stringify(baseUrl)}
api_key_env = ${JSON.stringify(keyEnvVar)}

[models.${JSON.stringify(alias)}]
provider = "custom"
model = ${JSON.stringify(model)}
max_context_size = 200000
`;
}

export function buildChildEnv(opts, kimiHomeDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const baseUrl = (opts.baseUrl || (cred.isGlmLike ? DEFAULT_GLM_BASE_URL : "https://api.kimi.com/coding/v1")).trim();
  const model = opts.model || (cred.isGlmLike || baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai") ? DEFAULT_GLM_MODEL : "kimi-for-coding");
  const keyEnvVar = cred.sourceVar || "ZAI_API_KEY";

  env.HOME = kimiHomeDir;
  env.USERPROFILE = kimiHomeDir;
  env.KIMI_SHARE_DIR = path.join(kimiHomeDir, ".kimi-code");
  if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, keyEnvVar, baseUrl, resolvedModel: model };
}

export function buildExecArgs(opts, targetSessionId, promptText) {
  // Note: Kimi Code CLI v2.6.2 forbids combining -p/--prompt with --yolo/--auto/--plan
  const args = [opts.cliPath, "--output-format", "stream-json"];
  if (targetSessionId) args.push("-S", targetSessionId);
  args.push("-p", promptText);
  return args;
}

export function consumeStreamJsonLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (verbose) console.log(`[kimi-jsonl] ${line.slice(0, 500)}`);

  if (ev.role === "meta") {
    if (ev.type === "system.version") ctx.cliVersion = ev.version || null;
    if (ev.type === "session.resume_hint" && ev.session_id) ctx.sessionId = ev.session_id;
    return;
  }
  if (ev.role === "assistant") {
    if (Array.isArray(ev.tool_calls)) {
      for (const tc of ev.tool_calls) {
        const name = tc.function?.name || tc.name || "tool";
        ctx.toolsCalled.push(name);
        console.log(`  -> [tool] ${name}`);
      }
    }
    if (typeof ev.content === "string" && ev.content.trim()) {
      ctx.lastAssistantText = ev.content;
    }
    return;
  }
  if (ev.role === "error" || ev.type === "error") {
    ctx.errors.push(ev.message || ev.content || JSON.stringify(ev));
  }
}

export function evaluateTerminalState({ exitCode, timedOut, ctx }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for Kimi Code CLI" };
  if (ctx.errors.length > 0) return { ok: false, reason: `Kimi stream error: ${ctx.errors[ctx.errors.length - 1]}` };
  if (exitCode !== 0) return { ok: false, reason: `Kimi Code CLI exited with code ${exitCode}` };
  if (!ctx.lastAssistantText || !ctx.lastAssistantText.trim()) {
    return { ok: false, reason: "Kimi Code CLI finished with empty assistant response" };
  }
  return { ok: true, reason: "ok", finalText: ctx.lastAssistantText };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[Kimi Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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
  console.log(`Kimi Code CLI Local Bridge (@moonshot-ai/kimi-code adapter, BYO-Key skip-login)

  --status                  Check main.mjs, version, config readiness & state
  --models                  List verified GLM & OpenAI-compatible model presets
  --file <path>             Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>           Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>               Working directory (default: process.cwd())
  --cwd-file <path>         Read UTF-8 working directory from file
  --state <path>            Override state JSON path
  --reuse                   Resume last completed session in same cwd
  --session <id>            Explicit session ID to resume
  --model <id>              Model ID (default: ${DEFAULT_GLM_MODEL})
  --provider-type <type>    openai (default) | anthropic | kimi
  --base-url <url>          Override provider base URL (default: ${DEFAULT_GLM_BASE_URL})
  --api-key-env <VAR>       Explicit env var name holding API key
  --write                   Acknowledge write intent (note: kimi -p runs tools directly; -y conflicts with -p)
  --timeout <sec>           Timeout seconds (1..86400, default 600)
  --dry-run                 Validate inputs and print args without executing
  --verbose                 Print raw stream-json events
  -h, --help                Show help
`);
}

function cmdStatus(cliPath, opts, root, stateFile, kimiHomeDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(cliPath), "..", "package.json"), "utf8"));
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts, kimiHomeDir);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "node main.mjs --output-format stream-json -p",
    cliPath,
    version: pkg.version,
    kimiHomeDir,
    providerType: opts.providerType,
    baseUrl,
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

function cmdModels() {
  console.log(JSON.stringify({
    endpointDefault: DEFAULT_GLM_BASE_URL,
    models: [
      { id: "glm-4.7", providerType: "openai" },
      { id: "glm-5.3", providerType: "openai" },
      { id: "glm-5.2", providerType: "openai" },
      { id: "kimi-for-coding", providerType: "kimi" },
    ],
  }, null, 2));
}

async function dispatch(cliPath, opts, root, stateFile, kimiHomeDir) {
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

  const { env, hasKey, keySourceVar, keyEnvVar, baseUrl, resolvedModel } = buildChildEnv(opts, kimiHomeDir);
  if (!hasKey) {
    throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / KIMI_API_KEY / OPENAI_API_KEY.");
  }

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded in state file");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    targetSessionId = state.lastSessionId;
  }

  // Write isolated .kimi-code/config.toml with env var reference ONLY (zero plaintext secret on disk)
  const cfgDir = path.join(kimiHomeDir, ".kimi-code");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.toml"), buildConfigToml({
    providerType: opts.providerType,
    baseUrl,
    keyEnvVar,
    model: resolvedModel,
  }), "utf8");

  let effectivePrompt = task.text;
  let stagedTaskPath = "";
  if (task.text.length > 8000) {
    stagedTaskPath = path.join(path.dirname(stateFile), "active-task.md");
    fs.mkdirSync(path.dirname(stagedTaskPath), { recursive: true });
    fs.writeFileSync(stagedTaskPath, task.text, "utf8");
    effectivePrompt = `Read and execute every requirement in the UTF-8 task file at: ${stagedTaskPath}`;
  }

  const args = buildExecArgs({ ...opts, cliPath }, targetSessionId, effectivePrompt);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[Kimi Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[Kimi Bridge] cwd=${root} keyVar=${keySourceVar} baseUrl=${baseUrl} model=${resolvedModel} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Kimi Bridge] dry-run args=${JSON.stringify(args.slice(0, -1))}`);
    console.log(`[Kimi Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const ctx = {
    sessionId: targetSessionId || "",
    cliVersion: null,
    lastAssistantText: "",
    toolsCalled: [],
    errors: [],
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

    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
          for (const s of [child.stdout, child.stderr]) { try { s.destroy(); } catch { /* ignore */ } }
          try { child.unref(); } catch { /* ignore */ }
          finish(-1);
        }, 3000);
      }, opts.timeout * 1000);
    });

    if (buf.trim()) consumeStreamJsonLine(buf, ctx, opts.verbose);

    const verdict = evaluateTerminalState({ exitCode, timedOut, ctx });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    if (ctx.sessionId) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: ctx.sessionId,
        lastCwd: root,
        observedModel: resolvedModel,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId: ctx.sessionId || null,
      cwd: root,
      requestedModel: resolvedModel,
      cliVersion: ctx.cliVersion,
      elapsedSec: elapsed,
      toolsCalled: ctx.toolsCalled,
      taskSha256: task.sha256,
      reply: verdict.finalText || ctx.lastAssistantText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Kimi Bridge] session=${ctx.sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} tools=${ctx.toolsCalled.length}`);
    console.log(`\n=== [Kimi Code Reply] ===\n${verdict.finalText || ctx.lastAssistantText || "(no reply)"}\n`);

    if (!verdict.ok) {
      const errTail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`${verdict.reason}${errTail ? " | stderr: " + errTail : ""}`);
    }
  } finally {
    if (stagedTaskPath) { try { fs.unlinkSync(stagedTaskPath); } catch { /* ignore */ } }
    releaseLock(lockFile);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const root = resolveCwd(opts, process.cwd());
  const stateFile = opts.state
    ? path.resolve(process.cwd(), opts.state)
    : path.join(root, "private", "kimi-bridge", "state.json");
  const kimiHomeDir = path.join(path.dirname(stateFile), "kimi-home");
  const cliPath = findKimiCli();

  if (opts.status) return cmdStatus(cliPath, opts, root, stateFile, kimiHomeDir);
  if (opts.models) return cmdModels();

  return dispatch(cliPath, opts, root, stateFile, kimiHomeDir);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Kimi Bridge Error]", e.message || e);
    process.exit(1);
  });
}
