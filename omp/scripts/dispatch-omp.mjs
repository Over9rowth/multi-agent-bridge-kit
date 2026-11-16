#!/usr/bin/env node
/**
 * Oh My Pi (OMP) Local Bridge - 跨项目通用适配器
 *
 * 目标：通过原生 `bun.exe` 驱动本机 `@oh-my-pi/pi-coding-agent` (`dist/cli.js --mode=json -p`)，
 *       写入隔离 `PI_CODING_AGENT_DIR/models.yml`（只写环境变量名，磁盘零明文 Key），
 *       直连智谱 GLM（`https://open.bigmodel.cn/api/coding/paas/v4`），支持 `--resume <sessionId>` 复用与终态验收。
 *
 * 注意：OMP `dist/cli.js` 使用 ES2025 `using` 语法，不可用 Node 22 直接运行，必须调用原生 `bun.exe`（非 `.cmd`）。
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
    thinking: "",
    write: false,
    timeout: DEFAULT_TIMEOUT_SEC,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const valueFlags = new Set([
    "--file", "--prompt", "--cwd", "--cwd-file", "--state", "--session",
    "--provider", "--model", "--base-url", "--api-key-env", "--thinking", "--timeout",
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
      else if (a === "--thinking") opts.thinking = val;
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

export function findBunBin(env = process.env) {
  const isWin = process.platform === "win32";
  if (env.BUN_BIN) {
    const p = path.resolve(env.BUN_BIN);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`BUN_BIN not found: ${p}`);
    return p;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const exe = isWin ? "bun.exe" : "bun";
  const candidates = [
    path.join(appData, "npm", "node_modules", "bun", "bin", exe),
    path.join(os.homedir(), ".bun", "bin", exe),
  ];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
  }
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate native bun.exe. Install `npm i -g bun` or set BUN_BIN.");
}

export function findOmpCli(env = process.env) {
  if (env.OMP_CLI_ENTRY) {
    const p = path.resolve(env.OMP_CLI_ENTRY);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`OMP_CLI_ENTRY not found: ${p}`);
    return p;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
    "/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate @oh-my-pi/pi-coding-agent/dist/cli.js. Install `npm i -g @oh-my-pi/pi-coding-agent`.");
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

export function buildModelsYml({ provider, baseUrl, keyEnvVar, model }) {
  const list = ["glm-4.7", "glm-5.3", "glm-5.2", "glm-5-turbo"];
  if (model && !list.includes(model)) list.unshift(model);
  const modelEntries = list.map((id) => `      - id: ${id}`).join("\n");
  return `providers:
  ${provider}:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: ${keyEnvVar}
    compat:
      supportsDeveloperRole: false
    models:
${modelEntries}
`;
}

export function buildChildEnv(opts, agentDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const baseUrl = (opts.baseUrl || DEFAULT_GLM_BASE_URL).trim();
  const model = opts.model || DEFAULT_GLM_MODEL;
  const keyEnvVar = cred.sourceVar || "ZAI_API_KEY";

  env.PI_CODING_AGENT_DIR = agentDir;
  if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, keyEnvVar, baseUrl, resolvedModel: model };
}

export function buildExecArgs(opts, sessionDir, targetSessionId, resolvedModel, promptText) {
  const args = [
    opts.cliPath,
    "--model", `${opts.provider}/${resolvedModel}`,
    "--session-dir", sessionDir,
    "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
    "--offline",
    "--mode=json",
    "-p",
  ];
  if (opts.thinking) args.push("--thinking", opts.thinking);
  args.push("--tools", opts.write ? "read,bash,edit,write,grep,glob" : "read,grep,glob");
  if (targetSessionId) args.push("--resume", targetSessionId);
  args.push(promptText);
  return args;
}

export function consumeJsonlLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (verbose) console.log(`[omp-jsonl] ${line.slice(0, 500)}`);

  if (ev.type === "session" && ev.id) {
    ctx.sessionId = ev.id;
    return;
  }
  if (ev.type === "message_end" && ev.message && ev.message.role === "assistant") {
    const m = ev.message;
    if (m.model) ctx.observedModel = `${m.provider ? m.provider + "/" : ""}${m.model}`;
    if (m.stopReason) ctx.stopReason = m.stopReason;
    if (m.errorMessage) ctx.errors.push(m.errorMessage);
    if (m.usage) ctx.usage = m.usage;
    for (const part of m.content || []) {
      if (part.type === "toolCall") {
        ctx.toolsCalled.push(part.name || "tool");
        console.log(`  -> [tool] ${part.name}`);
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        ctx.lastAssistantText = part.text;
      }
    }
    return;
  }
  if (ev.type === "agent_end") {
    ctx.agentEnded = true;
    ctx.isTerminal = ev.isTerminal ?? true;
    const msgs = Array.isArray(ev.messages) ? ev.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role === "assistant") {
        if (m.model && !ctx.observedModel) ctx.observedModel = `${m.provider ? m.provider + "/" : ""}${m.model}`;
        if (m.errorMessage) ctx.errors.push(m.errorMessage);
        const texts = (m.content || []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
        if (texts.trim() && !ctx.lastAssistantText) ctx.lastAssistantText = texts;
        break;
      }
    }
  }
}

export function evaluateTerminalState({ exitCode, timedOut, ctx }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for Oh My Pi (omp)" };
  if (ctx.errors.length > 0) return { ok: false, reason: `OMP error: ${ctx.errors[ctx.errors.length - 1]}` };
  if (exitCode !== 0) return { ok: false, reason: `OMP exited with code ${exitCode}` };
  if (!ctx.agentEnded) return { ok: false, reason: "OMP JSON stream ended without agent_end event" };
  if (ctx.stopReason && ctx.stopReason !== "stop") {
    return { ok: false, reason: `Unexpected OMP stopReason=${ctx.stopReason}` };
  }
  if (!ctx.lastAssistantText || !ctx.lastAssistantText.trim()) {
    return { ok: false, reason: "OMP finished with empty assistant response" };
  }
  return { ok: true, reason: "ok", finalText: ctx.lastAssistantText };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[OMP Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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
  console.log(`Oh My Pi (omp) Local Bridge (@oh-my-pi/pi-coding-agent via bun.exe)

  --status                Check bun.exe, cli.js, version, agentDir & state
  --models                List configured GLM models
  --file <path>           Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>         Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>             Working directory (default: process.cwd())
  --cwd-file <path>       Read UTF-8 working directory from file
  --state <path>          Override state JSON path
  --reuse                 Resume last completed session in same cwd
  --session <id>          Explicit session ID to resume
  --provider <id>         Provider ID in isolated models.yml (default: bigmodel)
  --model <id>            Model ID (default: ${DEFAULT_GLM_MODEL})
  --base-url <url>        Override OpenAI-compat base URL (default: ${DEFAULT_GLM_BASE_URL})
  --api-key-env <VAR>     Explicit env var name holding API key
  --thinking <level>      off | minimal | low | medium | high | xhigh | max | auto
  --write                 Enable read,bash,edit,write,grep,find,ls (default read-only)
  --timeout <sec>         Timeout seconds (1..86400, default 600)
  --dry-run               Validate inputs and print args without executing
  --verbose               Print raw JSONL events
  -h, --help              Show help
`);
}

function cmdStatus(bunBin, cliPath, opts, root, stateFile, agentDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(cliPath), "..", "package.json"), "utf8"));
  const bunVer = spawnSync(bunBin, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts, agentDir);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "bun.exe cli.js --mode=json -p (isolated PI_CODING_AGENT_DIR/models.yml)",
    bunBin,
    bunVersion: (bunVer.stdout || "").trim() || null,
    cliPath,
    version: pkg.version,
    agentDir,
    provider: opts.provider,
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

function cmdModels(opts) {
  console.log(JSON.stringify({
    provider: opts.provider,
    baseUrl: opts.baseUrl || DEFAULT_GLM_BASE_URL,
    models: ["glm-4.7", "glm-5.3", "glm-5.2", "glm-5-turbo"].map((id) => ({ id: `${opts.provider}/${id}` })),
  }, null, 2));
}

async function dispatch(bunBin, cliPath, opts, root, stateFile, agentDir, sessionDir) {
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

  const { env, hasKey, keySourceVar, keyEnvVar, baseUrl, resolvedModel } = buildChildEnv(opts, agentDir);
  if (!hasKey) throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / OPENAI_API_KEY.");

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    targetSessionId = state.lastSessionId;
  }

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.yml"), buildModelsYml({
    provider: opts.provider,
    baseUrl,
    keyEnvVar,
    model: resolvedModel,
  }), "utf8");

  let effectivePrompt = task.text;
  let stagedTaskPath = "";
  if (task.text.length > 8000) {
    stagedTaskPath = path.join(path.dirname(stateFile), "active-task.md");
    fs.writeFileSync(stagedTaskPath, task.text, "utf8");
    effectivePrompt = `Read and execute every requirement in the UTF-8 task file at: ${stagedTaskPath}`;
  }

  const args = buildExecArgs({ ...opts, cliPath }, sessionDir, targetSessionId, resolvedModel, effectivePrompt);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[OMP Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[OMP Bridge] cwd=${root} keyVar=${keySourceVar} model=${opts.provider}/${resolvedModel} write=${opts.write} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[OMP Bridge] dry-run args=${JSON.stringify(args.slice(1, -1))}`);
    console.log(`[OMP Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const ctx = {
    sessionId: targetSessionId || "",
    observedModel: null,
    stopReason: null,
    agentEnded: false,
    isTerminal: false,
    lastAssistantText: "",
    toolsCalled: [],
    errors: [],
    usage: null,
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

    const child = spawn(bunBin, args, {
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

    if (buf.trim()) consumeJsonlLine(buf, ctx, opts.verbose);

    const verdict = evaluateTerminalState({ exitCode, timedOut, ctx });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    if (ctx.sessionId) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: ctx.sessionId,
        lastCwd: root,
        observedModel: ctx.observedModel || `${opts.provider}/${resolvedModel}`,
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
      observedModel: ctx.observedModel || null,
      stopReason: ctx.stopReason,
      elapsedSec: elapsed,
      usage: ctx.usage,
      toolsCalled: ctx.toolsCalled,
      taskSha256: task.sha256,
      reply: verdict.finalText || ctx.lastAssistantText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[OMP Bridge] session=${ctx.sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} observedModel=${ctx.observedModel || "none"} tools=${ctx.toolsCalled.length}`);
    console.log(`\n=== [Oh My Pi Reply] ===\n${verdict.finalText || ctx.lastAssistantText || "(no reply)"}\n`);

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
    : path.join(root, "private", "omp-bridge", "state.json");
  const baseDir = path.dirname(stateFile);
  const agentDir = path.join(baseDir, "omp-agent");
  const sessionDir = path.join(baseDir, "sessions");
  const bunBin = findBunBin();
  const cliPath = findOmpCli();

  if (opts.status) return cmdStatus(bunBin, cliPath, opts, root, stateFile, agentDir);
  if (opts.models) return cmdModels(opts);

  return dispatch(bunBin, cliPath, opts, root, stateFile, agentDir, sessionDir);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[OMP Bridge Error]", e.message || e);
    process.exit(1);
  });
}
