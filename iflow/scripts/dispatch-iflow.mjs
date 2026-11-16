#!/usr/bin/env node
/**
 * iFlow CLI Local Bridge - 跨项目通用适配器 (免 iFlow 登录直连 GLM / OpenAI-Compatible)
 *
 * 目标：驱动本机 `@iflow-ai/iflow-cli` (`bundle/iflow.js`)，
 *       通过隔离 `HOME`/`USERPROFILE` 下的 `.iflow/settings.json`（仅写 `selectedAuthType: "openai-compatible"`，零明文密钥），
 *       由环境变量 `IFLOW_API_KEY` + `IFLOW_BASE_URL` + `IFLOW_MODEL_NAME` 注入鉴权，
 *       结合 `-o exec-info.json` 采集会话 ID、轮次与 Token 用量，支持 `-r <session-id>` 复用。
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
    "--model", "--base-url", "--api-key-env", "--timeout",
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

export function findIflowCli(env = process.env) {
  if (env.IFLOW_CLI_ENTRY) {
    const p = path.resolve(env.IFLOW_CLI_ENTRY);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`IFLOW_CLI_ENTRY not found: ${p}`);
    return p;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "node_modules", "@iflow-ai", "iflow-cli", "bundle", "iflow.js"),
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@iflow-ai", "iflow-cli", "bundle", "iflow.js"),
    "/usr/local/lib/node_modules/@iflow-ai/iflow-cli/bundle/iflow.js",
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate @iflow-ai/iflow-cli/bundle/iflow.js. Install `npm i -g @iflow-ai/iflow-cli`.");
}

export function resolveByokCredential(opts, baseEnv = process.env) {
  if (opts.apiKeyEnv) {
    const val = (baseEnv[opts.apiKeyEnv] || "").trim();
    return { key: val, sourceVar: val ? opts.apiKeyEnv : null };
  }
  for (const name of ["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY", "IFLOW_API_KEY", "OPENAI_API_KEY"]) {
    const val = (baseEnv[name] || "").trim();
    if (val) return { key: val, sourceVar: name };
  }
  return { key: "", sourceVar: null };
}

export function buildChildEnv(opts, iflowHomeDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const baseUrl = (opts.baseUrl || DEFAULT_GLM_BASE_URL).trim();
  const model = opts.model || DEFAULT_GLM_MODEL;

  env.HOME = iflowHomeDir;
  env.USERPROFILE = iflowHomeDir;
  if (cred.key) env.IFLOW_API_KEY = cred.key;
  env.IFLOW_BASE_URL = baseUrl;
  env.IFLOW_MODEL_NAME = model;
  if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, baseUrl, resolvedModel: model };
}

export function buildExecArgs(opts, execInfoFile, targetSessionId, resolvedModel, promptText) {
  const args = [opts.cliPath];
  args.push(opts.write ? "-y" : "--plan");
  args.push("-m", resolvedModel, "-o", execInfoFile);
  if (targetSessionId) args.push("-r", targetSessionId);
  args.push("-p", promptText);
  return args;
}

export function stripExecutionInfo(stderrText) {
  return (stderrText || "").replace(/<Execution Info>[\s\S]*?<\/Execution Info>/g, "").trim();
}

export function evaluateTerminalState({ exitCode, timedOut, stdoutText, execInfo }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for iFlow CLI" };
  if (exitCode !== 0) return { ok: false, reason: `iflow exited with code ${exitCode}` };
  const reply = (stdoutText || "").trim();
  if (!reply) return { ok: false, reason: "iFlow CLI finished with empty output" };
  if (execInfo && execInfo["session-id"] === "") {
    return { ok: false, reason: "iFlow returned empty session-id" };
  }
  return { ok: true, reason: "ok", finalText: reply };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[iFlow Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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
  console.log(`iFlow CLI Local Bridge (@iflow-ai/iflow-cli adapter, BYOK skip-login)

  --status                Check iflow.js, version, isolated home & state
  --models                List verified GLM presets
  --file <path>           Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>         Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>             Working directory (default: process.cwd())
  --cwd-file <path>       Read UTF-8 working directory from file
  --state <path>          Override state JSON path
  --reuse                 Resume last completed session in same cwd
  --session <id>          Explicit session ID to resume
  --model <id>            Model ID (default: ${DEFAULT_GLM_MODEL})
  --base-url <url>        Override OpenAI-compat base URL (default: ${DEFAULT_GLM_BASE_URL})
  --api-key-env <VAR>     Explicit env var name holding API key
  --write                 Pass -y (yolo mode; default: --plan read-only)
  --timeout <sec>         Timeout seconds (1..86400, default 600)
  --dry-run               Validate inputs and print args without executing
  --verbose               Print stderr Execution Info
  -h, --help              Show help
`);
}

function cmdStatus(cliPath, opts, root, stateFile, iflowHomeDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(cliPath), "..", "package.json"), "utf8"));
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts, iflowHomeDir);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "node iflow.js -o exec-info.json -p (isolated .iflow/settings.json + IFLOW_API_KEY env)",
    cliPath,
    version: pkg.version,
    iflowHomeDir,
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
      model: state.model || null,
      updatedAt: state.updatedAt || null,
    } : null,
  }, null, 2));
}

function cmdModels(opts) {
  console.log(JSON.stringify({
    authType: "openai-compatible",
    baseUrl: opts.baseUrl || DEFAULT_GLM_BASE_URL,
    models: ["glm-4.7", "glm-5.3", "glm-5.2", "glm-5-turbo"].map((id) => ({ id })),
  }, null, 2));
}

async function dispatch(cliPath, opts, root, stateFile, iflowHomeDir) {
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

  const { env, hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts, iflowHomeDir);
  if (!hasKey) throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / IFLOW_API_KEY / OPENAI_API_KEY.");

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    targetSessionId = state.lastSessionId;
  }

  // Write isolated .iflow/settings.json without plaintext apiKey
  const cfgDir = path.join(iflowHomeDir, ".iflow");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "settings.json"), JSON.stringify({ selectedAuthType: "openai-compatible" }, null, 2), "utf8");

  const baseDir = path.dirname(stateFile);
  const execInfoFile = path.join(baseDir, "exec-info.json");
  try { fs.unlinkSync(execInfoFile); } catch { /* ignore */ }

  let effectivePrompt = task.text;
  let stagedTaskPath = "";
  if (task.text.length > 8000) {
    stagedTaskPath = path.join(baseDir, "active-task.md");
    fs.writeFileSync(stagedTaskPath, task.text, "utf8");
    effectivePrompt = `Read and execute every requirement in the UTF-8 task file at: ${stagedTaskPath}`;
  }

  const args = buildExecArgs({ ...opts, cliPath }, execInfoFile, targetSessionId, resolvedModel, effectivePrompt);
  const resultFile = path.join(baseDir, "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[iFlow Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[iFlow Bridge] cwd=${root} keyVar=${keySourceVar} baseUrl=${baseUrl} model=${resolvedModel} yolo=${opts.write} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[iFlow Bridge] dry-run args=${JSON.stringify(args.slice(1, -1))}`);
    console.log(`[iFlow Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    if (stagedTaskPath) try { fs.unlinkSync(stagedTaskPath); } catch { /* ignore */ }
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

    const child = spawn(process.execPath, args, {
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

    if (opts.verbose && stderr.trim()) console.log(`[iFlow stderr]\n${stderr.trim()}`);
    let execInfo = null;
    try {
      if (fs.existsSync(execInfoFile)) execInfo = JSON.parse(fs.readFileSync(execInfoFile, "utf8"));
    } catch { /* ignore */ }

    const sessionId = execInfo?.["session-id"] || targetSessionId || "";
    const verdict = evaluateTerminalState({ exitCode, timedOut, stdoutText, execInfo });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    if (sessionId) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: sessionId,
        lastCwd: root,
        model: resolvedModel,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId: sessionId || null,
      cwd: root,
      requestedModel: resolvedModel,
      assistantRounds: execInfo?.assistantRounds ?? null,
      tokenUsage: execInfo?.tokenUsage ?? null,
      elapsedSec: elapsed,
      taskSha256: task.sha256,
      reply: verdict.finalText || stdoutText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[iFlow Bridge] session=${sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} rounds=${execInfo?.assistantRounds ?? "?"}`);
    console.log(`\n=== [iFlow CLI Reply] ===\n${verdict.finalText || stdoutText.trim() || "(no reply)"}\n`);

    if (!verdict.ok) {
      const cleanErr = stripExecutionInfo(stderr).split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`${verdict.reason}${cleanErr ? " | stderr: " + cleanErr : ""}`);
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
    : path.join(root, "private", "iflow-bridge", "state.json");
  const iflowHomeDir = path.join(path.dirname(stateFile), "iflow-home");
  const cliPath = findIflowCli();

  if (opts.status) return cmdStatus(cliPath, opts, root, stateFile, iflowHomeDir);
  if (opts.models) return cmdModels(opts);

  return dispatch(cliPath, opts, root, stateFile, iflowHomeDir);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[iFlow Bridge Error]", e.message || e);
    process.exit(1);
  });
}
