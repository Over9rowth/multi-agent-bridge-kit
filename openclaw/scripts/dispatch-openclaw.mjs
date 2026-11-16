#!/usr/bin/env node
/**
 * OpenClaw Local Bridge - 跨项目通用适配器 (免 Gateway / 频道登录，嵌入式 `--local --json`)
 *
 * 目标：驱动本机 `openclaw` (`openclaw.mjs agent --local --json`)，
 *       隔离 `OPENCLAW_STATE_DIR` 与 `OPENCLAW_CONFIG_PATH`，
 *       通过 `plugins.enabled: false` 避开 Windows 符号链接 `EPERM` 崩溃，
 *       通过 `agents.defaults.skipBootstrap: true` 防止在用户项目目录生成 `SOUL.md`/`AGENTS.md`，
 *       在 `openclaw.json` 中使用 `${<ENV_VAR>}` 引用密钥（磁盘零明文密钥），直连智谱 GLM。
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

export function findOpenClawCli(env = process.env) {
  if (env.OPENCLAW_CLI_ENTRY) {
    const p = path.resolve(env.OPENCLAW_CLI_ENTRY);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`OPENCLAW_CLI_ENTRY not found: ${p}`);
    return p;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "node_modules", "openclaw", "openclaw.mjs"),
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "openclaw", "openclaw.mjs"),
    "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate openclaw/openclaw.mjs. Install `npm i -g openclaw`.");
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

export function buildOpenClawConfig({ workspace, provider, baseUrl, keyEnvVar, model }) {
  const models = [
    { id: "glm-4.7", name: "GLM-4.7" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5-turbo", name: "GLM-5-Turbo" },
  ];
  if (model && !models.some((m) => m.id === model)) models.unshift({ id: model, name: model });
  return {
    plugins: { enabled: false },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: `${provider}/${model || DEFAULT_GLM_MODEL}` },
      },
    },
    models: {
      providers: {
        [provider]: {
          baseUrl,
          apiKey: `\${${keyEnvVar}}`,
          api: "openai-completions",
          models,
        },
      },
    },
  };
}

export function buildChildEnv(opts, stateDir, cfgPath, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const baseUrl = (opts.baseUrl || DEFAULT_GLM_BASE_URL).trim();
  const model = opts.model || DEFAULT_GLM_MODEL;
  const keyEnvVar = cred.sourceVar || "ZAI_API_KEY";

  env.OPENCLAW_STATE_DIR = stateDir;
  env.OPENCLAW_CONFIG_PATH = cfgPath;
  env.OPENCLAW_NO_RESPAWN = "1";
  if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, keyEnvVar, baseUrl, resolvedModel: model };
}

export function buildExecArgs(opts, sessionId, resolvedModel, promptText) {
  const args = [
    opts.cliPath,
    "agent", "--local", "--json",
    "--session-id", sessionId,
    "--model", `${opts.provider}/${resolvedModel}`,
  ];
  if (opts.thinking) args.push("--thinking", opts.thinking);
  args.push("-m", promptText);
  return args;
}

export function parseOpenClawJson(stdoutText) {
  const raw = (stdoutText || "").trim();
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function evaluateTerminalState({ exitCode, timedOut, parsed }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for OpenClaw" };
  if (exitCode !== 0) return { ok: false, reason: `openclaw exited with code ${exitCode}` };
  if (!parsed) return { ok: false, reason: "OpenClaw did not emit valid JSON result" };
  if (parsed.meta?.aborted) return { ok: false, reason: "OpenClaw agent turn aborted" };
  const texts = (parsed.payloads || []).map((p) => p?.text).filter((t) => typeof t === "string" && t.trim());
  if (texts.length === 0) return { ok: false, reason: "OpenClaw finished with empty payloads" };
  return { ok: true, reason: "ok", finalText: texts.join("\n") };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[OpenClaw Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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
  console.log(`OpenClaw Local Bridge (openclaw agent --local --json adapter)

  --status                Check openclaw.mjs, version, isolated stateDir & state
  --models                List GLM presets
  --file <path>           Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>         Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>             Working directory (default: process.cwd())
  --cwd-file <path>       Read UTF-8 working directory from file
  --state <path>          Override state JSON path
  --reuse                 Reuse last completed session-id in same cwd
  --session <id>          Explicit session ID
  --provider <id>         Provider ID in isolated openclaw.json (default: bigmodel)
  --model <id>            Model ID (default: ${DEFAULT_GLM_MODEL})
  --base-url <url>        Override OpenAI-compat baseUrl (default: ${DEFAULT_GLM_BASE_URL})
  --api-key-env <VAR>     Explicit env var name holding API key
  --thinking <level>      off | minimal | low | medium | high | xhigh | adaptive | max
  --write                 Explicitly allow workspace file edits (instructed in workspace)
  --timeout <sec>         Timeout seconds (1..86400, default 600)
  --dry-run               Validate inputs and print args without executing
  --verbose               Print raw JSON output
  -h, --help              Show help
`);
}

function cmdStatus(cliPath, opts, root, stateFile, stateDir, cfgPath) {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(cliPath), "package.json"), "utf8"));
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts, stateDir, cfgPath);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey,
    transport: "node openclaw.mjs agent --local --json (plugins.enabled=false, skipBootstrap=true)",
    cliPath,
    version: pkg.version,
    stateDir,
    cfgPath,
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
  console.log(JSON.stringify({
    provider: opts.provider,
    baseUrl: opts.baseUrl || DEFAULT_GLM_BASE_URL,
    models: ["glm-4.7", "glm-5.3", "glm-5.2", "glm-5-turbo"].map((id) => ({ id: `${opts.provider}/${id}` })),
  }, null, 2));
}

async function dispatch(cliPath, opts, root, stateFile, stateDir, cfgPath) {
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

  const { env, hasKey, keySourceVar, keyEnvVar, baseUrl, resolvedModel } = buildChildEnv(opts, stateDir, cfgPath);
  if (!hasKey) throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / OPENAI_API_KEY.");

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    targetSessionId = state.lastSessionId;
  }
  const sessionId = targetSessionId || `oc-${crypto.randomUUID().slice(0, 12)}`;

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(buildOpenClawConfig({
    workspace: root,
    provider: opts.provider,
    baseUrl,
    keyEnvVar,
    model: resolvedModel,
  }), null, 2), "utf8");

  let effectivePrompt = task.text;
  let stagedTaskPath = "";
  if (task.text.length > 8000) {
    stagedTaskPath = path.join(path.dirname(stateFile), "active-task.md");
    fs.writeFileSync(stagedTaskPath, task.text, "utf8");
    effectivePrompt = `Read and execute every requirement in the UTF-8 task file at: ${stagedTaskPath}`;
  }

  const args = buildExecArgs({ ...opts, cliPath }, sessionId, resolvedModel, effectivePrompt);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[OpenClaw Bridge] ${targetSessionId ? "Reuse session: " + sessionId : "New session: " + sessionId}`);
  console.log(`[OpenClaw Bridge] cwd=${root} keyVar=${keySourceVar} model=${opts.provider}/${resolvedModel} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[OpenClaw Bridge] dry-run args=${JSON.stringify(args.slice(1, -1))}`);
    console.log(`[OpenClaw Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    if (stagedTaskPath) try { fs.unlinkSync(stagedTaskPath); } catch { /* ignore */ }
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
      taskSha256: task.sha256,
      updatedAt: new Date().toISOString(),
    });

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

    if (opts.verbose && stdoutText.trim()) console.log(`[OpenClaw JSON]\n${stdoutText.trim().slice(0, 1500)}`);
    const parsed = parseOpenClawJson(stdoutText);
    const agentMeta = parsed?.meta?.agentMeta || {};
    const observedModel = agentMeta.model ? `${agentMeta.provider ? agentMeta.provider + "/" : ""}${agentMeta.model}` : null;

    const verdict = evaluateTerminalState({ exitCode, timedOut, parsed });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    writeAtomicJson(stateFile, {
      phase: verdict.ok ? "completed" : "uncertain",
      lastSessionId: agentMeta.sessionId || sessionId,
      lastCwd: root,
      observedModel: observedModel || `${opts.provider}/${resolvedModel}`,
      taskSha256: task.sha256,
      updatedAt: new Date().toISOString(),
    });

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId: agentMeta.sessionId || sessionId,
      sessionFile: agentMeta.sessionFile || null,
      cwd: root,
      requestedModel: `${opts.provider}/${resolvedModel}`,
      observedModel,
      durationMs: parsed?.meta?.durationMs ?? null,
      usage: agentMeta.usage ?? null,
      elapsedSec: elapsed,
      taskSha256: task.sha256,
      reply: verdict.finalText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[OpenClaw Bridge] session=${agentMeta.sessionId || sessionId} elapsed=${elapsed}s exit=${exitCode} observedModel=${observedModel || "none"}`);
    console.log(`\n=== [OpenClaw Reply] ===\n${verdict.finalText || "(no reply)"}\n`);

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
    : path.join(root, "private", "openclaw-bridge", "state.json");
  const stateDir = path.join(path.dirname(stateFile), "openclaw-state");
  const cfgPath = path.join(stateDir, "openclaw.json");
  const cliPath = findOpenClawCli();

  if (opts.status) return cmdStatus(cliPath, opts, root, stateFile, stateDir, cfgPath);
  if (opts.models) return cmdModels(opts);

  return dispatch(cliPath, opts, root, stateFile, stateDir, cfgPath);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[OpenClaw Bridge Error]", e.message || e);
    process.exit(1);
  });
}
