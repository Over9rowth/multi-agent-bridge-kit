#!/usr/bin/env node
/**
 * Aider Local Bridge - 跨项目通用适配器 (Python aider-chat 0.86+)
 *
 * 目标：驱动本机独立 Python 虚拟环境安装的 `aider.exe`，
 *       通过 `OPENAI_API_BASE` + `OPENAI_API_KEY` + 隔离 `aider.model.metadata.json`（磁盘零密钥）
 *       免登录直连智谱 GLM（`openai/glm-4.7`、`openai/glm-5.3` 等），
 *       支持 `--target` 指定编辑文件、`--write` (`--yes-always`) vs 默认 `--chat-mode ask` 只读问答，
 *       以及 `--restore-chat-history` 会话复用。
 *
 * 零第三方 Node 依赖，仅使用 Node.js >= 22 内置模块。
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
    model: "",
    baseUrl: "",
    apiKeyEnv: "",
    targets: [],
    reads: [],
    noGit: true,
    write: false,
    timeout: DEFAULT_TIMEOUT_SEC,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const valueFlags = new Set([
    "--file", "--prompt", "--cwd", "--cwd-file", "--state",
    "--model", "--base-url", "--api-key-env", "--target", "--read", "--timeout",
  ]);
  const seen = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (seen.has(a) && !["--verbose", "--target", "--read"].includes(a)) {
      throw new Error(`Duplicate flag: ${a}`);
    }
    seen.add(a);

    if (valueFlags.has(a)) {
      const val = argv[++i];
      if (val === undefined || (val.startsWith("--") && val.length > 2)) throw new Error(`Missing value for flag: ${a}`);
      if (a === "--file") opts.file = val;
      else if (a === "--prompt") opts.prompt = val;
      else if (a === "--cwd") opts.cwd = val;
      else if (a === "--cwd-file") opts.cwdFile = val;
      else if (a === "--state") opts.state = val;
      else if (a === "--model") opts.model = val;
      else if (a === "--base-url") opts.baseUrl = val;
      else if (a === "--api-key-env") opts.apiKeyEnv = val;
      else if (a === "--target") opts.targets.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
      else if (a === "--read") opts.reads.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
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
      case "--git": opts.noGit = false; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (opts.file && opts.prompt) throw new Error("Cannot pass both --file and --prompt");
  if (opts.cwd && opts.cwdFile) throw new Error("Cannot pass both --cwd and --cwd-file");
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

export function findAiderBin(env = process.env) {
  const isWin = process.platform === "win32";
  if (env.AIDER_BIN) {
    const p = path.resolve(env.AIDER_BIN);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`AIDER_BIN not found: ${p}`);
    return p;
  }
  const exe = isWin ? "aider.exe" : "aider";
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "aider-venv", "Scripts", exe),
    path.join(home, ".local", "aider-venv", "bin", exe),
    path.join(home, ".local", "bin", exe),
  ];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
  }
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate aider binary. Install into ~/.local/aider-venv or set AIDER_BIN.");
}

export function resolveByokCredential(opts, baseEnv = process.env) {
  if (opts.apiKeyEnv) {
    const val = (baseEnv[opts.apiKeyEnv] || "").trim();
    return { key: val, sourceVar: val ? opts.apiKeyEnv : null };
  }
  for (const name of ["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY", "OPENAI_API_KEY"]) {
    const val = (baseEnv[name] || "").trim();
    if (val) return { key: val, sourceVar: name };
  }
  return { key: "", sourceVar: null };
}

export function buildModelMetadata(modelSpec) {
  const key = modelSpec.includes("/") ? modelSpec : `openai/${modelSpec}`;
  return {
    [key]: {
      max_tokens: 16384,
      max_input_tokens: 200000,
      max_output_tokens: 16384,
      input_cost_per_token: 0,
      output_cost_per_token: 0,
      litellm_provider: "openai",
      mode: "chat",
    },
  };
}

export function buildChildEnv(opts, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const baseUrl = (opts.baseUrl || DEFAULT_GLM_BASE_URL).trim();
  const rawModel = opts.model || DEFAULT_GLM_MODEL;
  const modelSpec = rawModel.includes("/") ? rawModel : `openai/${rawModel}`;

  if (cred.key) env.OPENAI_API_KEY = cred.key;
  env.OPENAI_API_BASE = baseUrl;
  env.PYTHONIOENCODING = "utf-8";
  if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, baseUrl, modelSpec };
}

export function buildExecArgs(opts, { modelSpec, metaFile, chatHistoryFile, llmHistoryFile, msgFile, restore }) {
  const args = [
    "--model", modelSpec,
    "--model-metadata-file", metaFile,
    "--no-auto-commits",
    "--no-dirty-commits",
    "--no-gitignore",
    "--no-check-update",
    "--no-stream",
    "--no-analytics",
    "--no-show-model-warnings",
    "--chat-history-file", chatHistoryFile,
    "--llm-history-file", llmHistoryFile,
  ];
  if (opts.noGit) args.push("--no-git");
  if (opts.write) {
    args.push("--yes-always");
  } else {
    args.push("--yes-always", "--chat-mode", "ask");
  }
  if (restore) args.push("--restore-chat-history");
  for (const r of opts.reads) args.push("--read", r);
  args.push("--message-file", msgFile);
  for (const t of opts.targets) args.push(t);
  return args;
}

export function parseAiderOutput(stdoutText) {
  const raw = (stdoutText || "").trim();
  const lines = raw.split(/\r?\n/);
  const applied = [];
  let tokenLine = null;
  for (const l of lines) {
    const m = l.match(/^Applied edit to (.+)$/);
    if (m) applied.push(m[1].trim());
    if (/^Tokens:\s+/i.test(l)) tokenLine = l.trim();
  }
  return { raw, applied, tokenLine };
}

export function evaluateTerminalState({ exitCode, timedOut, parsed }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for Aider CLI" };
  if (exitCode !== 0) return { ok: false, reason: `aider exited with code ${exitCode}` };
  if (!parsed.raw) return { ok: false, reason: "Aider finished with empty output" };
  return { ok: true, reason: "ok", finalText: parsed.raw };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[Aider Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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
  console.log(`Aider Local Bridge (aider-chat Python venv adapter)

  --status                Check aider.exe, version, env & state
  --models                List GLM presets (openai/<id>)
  --file <path>           Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>         Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>             Working directory (default: process.cwd())
  --cwd-file <path>       Read UTF-8 working directory from file
  --state <path>          Override state JSON path
  --reuse                 Restore previous chat-history in same cwd
  --target <files>        Editable target file(s) (repeatable or comma-separated)
  --read <files>          Read-only context file(s) (repeatable or comma-separated)
  --model <id>            Model ID (default: openai/${DEFAULT_GLM_MODEL})
  --base-url <url>        Override OPENAI_API_BASE (default: ${DEFAULT_GLM_BASE_URL})
  --api-key-env <VAR>     Explicit env var name holding API key
  --write                 Allow file edits (default: --chat-mode ask read-only)
  --git                   Allow git discovery/repo-map (default passes --no-git)
  --timeout <sec>         Timeout seconds (1..86400, default 600)
  --dry-run               Validate inputs and print args without executing
  --verbose               Print raw stderr/logs
  -h, --help              Show help
`);
}

function cmdStatus(binPath, opts, root, stateFile) {
  const ver = spawnSync(binPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  const { hasKey, keySourceVar, baseUrl, modelSpec } = buildChildEnv(opts);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "aider.exe --model openai/<id> --message-file <task> (isolated chat history)",
    binary: binPath,
    version: (ver.stdout || "").trim() || null,
    baseUrl,
    defaultModel: modelSpec,
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

function cmdModels(opts) {
  console.log(JSON.stringify({
    provider: "openai-compatible (LiteLLM)",
    baseUrl: opts.baseUrl || DEFAULT_GLM_BASE_URL,
    models: ["openai/glm-4.7", "openai/glm-5.3", "openai/glm-5.2", "openai/glm-5-turbo"].map((id) => ({ id })),
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

  const { env, hasKey, keySourceVar, baseUrl, modelSpec } = buildChildEnv(opts);
  if (!hasKey) throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / OPENAI_API_KEY.");

  const state = readState(stateFile);
  const baseDir = path.dirname(stateFile);
  fs.mkdirSync(baseDir, { recursive: true });
  const chatHistoryFile = path.join(baseDir, "aider.chat.history.md");
  const llmHistoryFile = path.join(baseDir, "aider.llm.history.txt");
  const metaFile = path.join(baseDir, "aider.model.metadata.json");
  const msgFile = path.join(baseDir, "active-message.md");
  const resultFile = path.join(baseDir, "last-result.json");
  const lockFile = `${stateFile}.lock`;

  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    if (!fs.existsSync(chatHistoryFile)) throw new Error(`--reuse history file missing: ${chatHistoryFile}`);
  } else {
    // Fresh session starts with clean chat history
    try { fs.unlinkSync(chatHistoryFile); } catch { /* ignore */ }
  }

  fs.writeFileSync(metaFile, JSON.stringify(buildModelMetadata(modelSpec), null, 2), "utf8");
  fs.writeFileSync(msgFile, task.text, "utf8");

  const sessionId = opts.reuse ? state.lastSessionId : `aider-${crypto.randomUUID().slice(0, 12)}`;
  const args = buildExecArgs(opts, { modelSpec, metaFile, chatHistoryFile, llmHistoryFile, msgFile, restore: opts.reuse });

  console.log(`[Aider Bridge] ${opts.reuse ? "Reuse session: " + sessionId : "New session: " + sessionId}`);
  console.log(`[Aider Bridge] cwd=${root} keyVar=${keySourceVar} model=${modelSpec} write=${opts.write} targets=${opts.targets.length} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Aider Bridge] dry-run args=${JSON.stringify(args)}`);
    console.log(`[Aider Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    try { fs.unlinkSync(msgFile); } catch { /* ignore */ }
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  let timedOut = false;

  try {
    writeAtomicJson(stateFile, {
      phase: "dispatching",
      lastSessionId: sessionId,
      lastCwd: root,
      model: modelSpec,
      taskSha256: task.sha256,
      updatedAt: new Date().toISOString(),
    });

    const child = spawn(binPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdoutText = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdoutText += c; });
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

    if (opts.verbose && stderr.trim()) console.log(`[Aider stderr]\n${stderr.trim()}`);
    const parsed = parseAiderOutput(stdoutText);
    for (const f of parsed.applied) console.log(`  -> [applied] ${f}`);

    const verdict = evaluateTerminalState({ exitCode, timedOut, parsed });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    writeAtomicJson(stateFile, {
      phase: verdict.ok ? "completed" : "uncertain",
      lastSessionId: sessionId,
      lastCwd: root,
      model: modelSpec,
      taskSha256: task.sha256,
      updatedAt: new Date().toISOString(),
    });

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId,
      cwd: root,
      requestedModel: modelSpec,
      appliedEdits: parsed.applied,
      tokenLine: parsed.tokenLine,
      elapsedSec: elapsed,
      taskSha256: task.sha256,
      reply: verdict.finalText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Aider Bridge] session=${sessionId} elapsed=${elapsed}s exit=${exitCode} edits=${parsed.applied.length}`);
    console.log(`\n=== [Aider CLI Reply] ===\n${verdict.finalText || "(no reply)"}\n`);

    if (!verdict.ok) {
      const errTail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`${verdict.reason}${errTail ? " | stderr: " + errTail : ""}`);
    }
  } finally {
    try { fs.unlinkSync(msgFile); } catch { /* ignore */ }
    releaseLock(lockFile);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const root = resolveCwd(opts, process.cwd());
  const stateFile = opts.state
    ? path.resolve(process.cwd(), opts.state)
    : path.join(root, "private", "aider-bridge", "state.json");
  const binPath = findAiderBin();

  if (opts.status) return cmdStatus(binPath, opts, root, stateFile);
  if (opts.models) return cmdModels(opts);

  return dispatch(binPath, opts, root, stateFile);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Aider Bridge Error]", e.message || e);
    process.exit(1);
  });
}
