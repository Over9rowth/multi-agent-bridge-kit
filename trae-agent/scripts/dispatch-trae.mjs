#!/usr/bin/env node
/**
 * Trae Agent (bytedance/trae-agent) Local Bridge - 跨项目通用适配器
 *
 * 目标：驱动开源版 `bytedance/trae-agent` (`trae-cli` Python 3.12 + uv 隔离 venv)，
 *       通过 `trae-launcher.py` 运行时预加载补丁修复 Windows 中文终端 `cmd.exe` GBK 字节卡死 _buffer 问题，
 *       在隔离 `trae_config.yaml` 中留空 `api_key: ""`（由子进程环境变量注入，磁盘零明文密钥），
 *       支持任意 OpenAI Responses / Anthropic Messages 兼容端点，并强制核验 `traj.json` 的 `success === true`（不轻信 `exit=0`）。
 *
 * 零第三方 Node 依赖，仅使用 Node.js >= 22 内置模块。
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_ASCII_PROMPT_LEN = 80;
const DEFAULT_ANTHROPIC_URL = "https://open.bigmodel.cn/api/anthropic";
const DEFAULT_OPENAI_URL = "https://open.bigmodel.cn/api/v1";
const DEFAULT_MODEL = "glm-4.7";
const LAUNCHER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "trae-launcher.py");

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
    provider: "anthropic", // anthropic | openai
    model: "",
    baseUrl: "",
    apiKeyEnv: "",
    maxSteps: 20,
    write: false,
    timeout: DEFAULT_TIMEOUT_SEC,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const valueFlags = new Set([
    "--file", "--prompt", "--cwd", "--cwd-file", "--state",
    "--provider", "--model", "--base-url", "--api-key-env", "--max-steps", "--timeout",
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
      else if (a === "--provider") {
        if (!["anthropic", "openai"].includes(val)) throw new Error(`Invalid --provider (anthropic|openai): ${val}`);
        opts.provider = val;
      } else if (a === "--model") opts.model = val;
      else if (a === "--base-url") opts.baseUrl = val;
      else if (a === "--api-key-env") opts.apiKeyEnv = val;
      else if (a === "--max-steps") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error(`Invalid --max-steps (1..200): ${val}`);
        opts.maxSteps = n;
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

export function findTraePython(env = process.env) {
  const isWin = process.platform === "win32";
  if (env.TRAE_PYTHON_BIN) {
    const p = path.resolve(env.TRAE_PYTHON_BIN);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`TRAE_PYTHON_BIN not found: ${p}`);
    return p;
  }
  const home = os.homedir();
  const py = isWin ? "python.exe" : "python";
  const candidates = [
    path.join(home, ".local", "trae-agent", ".venv", isWin ? "Scripts" : "bin", py),
    path.join(home, "trae-agent", ".venv", isWin ? "Scripts" : "bin", py),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error("Could not locate trae-agent Python venv. Install bytedance/trae-agent into ~/.local/trae-agent/.venv or set TRAE_PYTHON_BIN.");
}

export function resolveByokCredential(opts, baseEnv = process.env) {
  if (opts.apiKeyEnv) {
    const val = (baseEnv[opts.apiKeyEnv] || "").trim();
    return { key: val, sourceVar: val ? opts.apiKeyEnv : null };
  }
  const order = opts.provider === "anthropic"
    ? ["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY", "ANTHROPIC_API_KEY"]
    : ["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY", "OPENAI_API_KEY"];
  for (const name of order) {
    const val = (baseEnv[name] || "").trim();
    if (val) return { key: val, sourceVar: name };
  }
  return { key: "", sourceVar: null };
}

export function buildTraeConfigYaml({ provider, baseUrl, model, maxSteps, write }) {
  const tools = write
    ? ["bash", "str_replace_based_edit_tool", "sequentialthinking", "task_done"]
    : ["sequentialthinking", "task_done"];
  const toolsYaml = tools.map((t) => `      - ${t}`).join("\n");
  return `agents:
  trae_agent:
    enable_lakeview: false
    model: trae_agent_model
    max_steps: ${maxSteps}
    tools:
${toolsYaml}

model_providers:
  ${provider}:
    api_key: ""
    provider: ${provider}
    base_url: ${JSON.stringify(baseUrl)}

models:
  trae_agent_model:
    model_provider: ${provider}
    model: ${model}
    max_tokens: 8192
    temperature: 0.2
    top_p: 1
    top_k: 0
    max_retries: 5
    parallel_tool_calls: true
`;
}

export function buildChildEnv(opts, baseEnv = process.env) {
  const env = { ...baseEnv };
  const cred = resolveByokCredential(opts, baseEnv);
  const defaultUrl = opts.provider === "anthropic" ? DEFAULT_ANTHROPIC_URL : DEFAULT_OPENAI_URL;
  const baseUrl = (opts.baseUrl || defaultUrl).trim();
  const model = opts.model || DEFAULT_MODEL;

  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  if (cred.key) {
    if (opts.provider === "anthropic") {
      env.ANTHROPIC_API_KEY = cred.key;
      env.ANTHROPIC_BASE_URL = baseUrl;
    } else {
      env.OPENAI_API_KEY = cred.key;
      env.OPENAI_BASE_URL = baseUrl;
    }
  }
  if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return { env, hasKey: Boolean(cred.key), keySourceVar: cred.sourceVar, baseUrl, resolvedModel: model };
}

export function buildRunArgs({ launcherPath = LAUNCHER_PATH, cfgPath, provider, model, baseUrl, maxSteps, root, trajFile, taskFile }) {
  return [
    launcherPath,
    "run",
    "--config-file", cfgPath,
    "--provider", provider,
    "--model", model,
    "--model-base-url", baseUrl,
    "--max-steps", String(maxSteps),
    "--working-dir", root,
    "--trajectory-file", trajFile,
    "--console-type", "simple",
    "--file", taskFile,
  ];
}

export function parseTrajectory(trajText) {
  if (!trajText || !trajText.trim()) return null;
  let data;
  try { data = JSON.parse(trajText); } catch { return null; }
  const steps = Array.isArray(data.agent_steps) ? data.agent_steps : [];
  const toolsCalled = [];
  let taskDoneCalled = false;
  let lastStepText = "";
  let lastThought = "";

  for (const s of steps) {
    const content = s.llm_response?.content;
    if (typeof content === "string" && content.trim()) lastStepText = content.trim();
    const executedCalls = s.tool_calls || [];
    const proposedCalls = s.llm_response?.tool_calls || [];
    for (const tc of executedCalls) {
      if (tc.name) toolsCalled.push(tc.name);
      if (tc.name === "sequentialthinking" && typeof tc.arguments?.thought === "string" && tc.arguments.thought.trim()) {
        lastThought = tc.arguments.thought.trim();
      }
    }
    for (const tc of proposedCalls) {
      if (tc.name === "task_done") {
        taskDoneCalled = true;
        if (!toolsCalled.includes("task_done")) toolsCalled.push("task_done");
      }
      if (tc.name === "sequentialthinking" && typeof tc.arguments?.thought === "string" && tc.arguments.thought.trim()) {
        lastThought = tc.arguments.thought.trim();
      }
    }
  }
  const rawFinal = typeof data.final_result === "string" ? data.final_result.trim() : "";
  const finalResult = rawFinal || lastStepText || (data.success === true && taskDoneCalled ? (lastThought || "Completed (task_done)") : "");
  return {
    success: data.success === true,
    finalResult,
    rawFinalResult: rawFinal,
    taskDoneCalled,
    provider: data.provider || null,
    model: data.model || null,
    stepsCount: steps.length,
    toolsCalled,
    executionTime: data.execution_time ?? null,
  };
}

export function evaluateTerminalState({ exitCode, timedOut, trajectory }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for Trae Agent" };
  if (exitCode !== 0) return { ok: false, reason: `trae-agent exited with code ${exitCode}` };
  if (!trajectory) return { ok: false, reason: "Trajectory JSON missing or unreadable" };
  // Critical: trae-cli exits 0 even when trajectory.success is false!
  if (!trajectory.success) {
    return { ok: false, reason: `Trae Agent trajectory.success=false: ${trajectory.finalResult || "task did not complete"}` };
  }
  if (!trajectory.finalResult || !trajectory.finalResult.trim()) {
    return { ok: false, reason: "Trae Agent finished with empty final_result" };
  }
  return { ok: true, reason: "ok", finalText: trajectory.finalResult };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[Trae Bridge] State unreadable, ignoring: ${e.message}`); return {}; }
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
  console.log(`Trae Agent (bytedance/trae-agent) Local Bridge - 开源免登录适配器

  --status                Check python venv, trae-launcher.py, env & state
  --models                List verified protocol presets (anthropic & openai responses)
  --file <path>           Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>         Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>             Working directory (default: process.cwd())
  --cwd-file <path>       Read UTF-8 working directory from file
  --state <path>          Override state JSON path
  --reuse                 Carry over prior completed turn context in same cwd
  --provider <name>       anthropic (default) | openai (Responses API)
  --model <id>            Model ID (default: ${DEFAULT_MODEL})
  --base-url <url>        Override base URL (default: ${DEFAULT_ANTHROPIC_URL} or ${DEFAULT_OPENAI_URL})
  --api-key-env <VAR>     Explicit env var name holding API key
  --max-steps <n>         Max steps (1..200, default 20)
  --write                 Unlock bash + str_replace_based_edit_tool (default read-only)
  --timeout <sec>         Timeout seconds (1..86400, default 600)
  --dry-run               Validate inputs and print args without executing
  --verbose               Print raw stdout/stderr
  -h, --help              Show help
`);
}

function cmdStatus(pythonBin, opts, root, stateFile) {
  const ver = spawnSync(pythonBin, ["-c", "import trae_agent; print('trae-agent ok')"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  const { hasKey, keySourceVar, baseUrl, resolvedModel } = buildChildEnv(opts);
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: hasKey && ver.status === 0,
    transport: "python trae-launcher.py run (Windows cmd.exe UTF-8 buffer patch + trajectory.json check)",
    pythonBin,
    launcherPath: LAUNCHER_PATH,
    importOk: ver.status === 0,
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

function cmdModels() {
  console.log(JSON.stringify({
    note: "trae-agent openai provider uses Responses API (/api/v1), while anthropic provider uses Messages API (/api/anthropic).",
    presets: [
      { provider: "anthropic", baseUrl: DEFAULT_ANTHROPIC_URL, models: ["glm-4.7", "glm-5.3", "glm-5.2"] },
      { provider: "openai", baseUrl: DEFAULT_OPENAI_URL, models: ["glm-4.7", "glm-5.3", "glm-5.2"] },
    ],
  }, null, 2));
}

async function dispatch(pythonBin, opts, root, stateFile) {
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
  if (!hasKey) throw new Error("No BYOK credential found. Set ZAI_API_KEY / ZHIPU_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY.");

  const state = readState(stateFile);
  const baseDir = path.dirname(stateFile);
  const resultFile = path.join(baseDir, "last-result.json");
  let promptBody = task.text;

  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded");
    if (state.phase !== "completed") throw new Error(`--reuse refused: prior session is in phase="${state.phase}"`);
    if (state.lastCwd !== root) throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    if (fs.existsSync(resultFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(resultFile, "utf8"));
        promptBody = `<prior_turn_context>\nPrevious Task Summary: ${String(prev.taskPreview || "").slice(0, 400)}\nPrevious Reply: ${String(prev.reply || "").slice(0, 1200)}\n</prior_turn_context>\n\n${task.text}`;
      } catch { /* ignore */ }
    }
  }

  fs.mkdirSync(baseDir, { recursive: true });
  const cfgPath = path.join(baseDir, "trae_config.yaml");
  const trajFile = path.join(baseDir, "traj.json");
  const stagedTaskFile = path.join(baseDir, "active-task.md");
  const lockFile = `${stateFile}.lock`;

  try { fs.unlinkSync(trajFile); } catch { /* ignore */ }
  fs.writeFileSync(cfgPath, buildTraeConfigYaml({
    provider: opts.provider,
    baseUrl,
    model: resolvedModel,
    maxSteps: opts.maxSteps,
    write: opts.write,
  }), "utf8");
  fs.writeFileSync(stagedTaskFile, promptBody, "utf8");

  const sessionId = opts.reuse ? state.lastSessionId : `trae-${crypto.randomUUID().slice(0, 12)}`;
  const args = buildRunArgs({
    cfgPath,
    provider: opts.provider,
    model: resolvedModel,
    baseUrl,
    maxSteps: opts.maxSteps,
    root,
    trajFile,
    taskFile: stagedTaskFile,
  });

  console.log(`[Trae Bridge] ${opts.reuse ? "Reuse context: " + sessionId : "New session: " + sessionId}`);
  console.log(`[Trae Bridge] cwd=${root} provider=${opts.provider} keyVar=${keySourceVar} model=${resolvedModel} write=${opts.write} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Trae Bridge] dry-run args=${JSON.stringify(args)}`);
    console.log(`[Trae Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    try { fs.unlinkSync(stagedTaskFile); } catch { /* ignore */ }
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

    const child = spawn(pythonBin, args, {
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

    if (opts.verbose && stdoutText.trim()) console.log(`[Trae stdout]\n${stdoutText.trim().slice(-2000)}`);
    const traj = fs.existsSync(trajFile) ? parseTrajectory(fs.readFileSync(trajFile, "utf8")) : null;
    for (const t of traj?.toolsCalled || []) console.log(`  -> [tool] ${t}`);

    const verdict = evaluateTerminalState({ exitCode, timedOut, trajectory: traj });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));
    const observedModel = traj?.model ? `${traj.provider || opts.provider}/${traj.model}` : `${opts.provider}/${resolvedModel}`;

    writeAtomicJson(stateFile, {
      phase: verdict.ok ? "completed" : "uncertain",
      lastSessionId: sessionId,
      lastCwd: root,
      observedModel,
      taskSha256: task.sha256,
      updatedAt: new Date().toISOString(),
    });

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId,
      cwd: root,
      requestedModel: `${opts.provider}/${resolvedModel}`,
      observedModel,
      stepsCount: traj?.stepsCount ?? null,
      toolsCalled: traj?.toolsCalled ?? [],
      elapsedSec: elapsed,
      taskSha256: task.sha256,
      taskPreview: task.text.slice(0, 400),
      reply: verdict.finalText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Trae Bridge] session=${sessionId} elapsed=${elapsed}s exit=${exitCode} success=${traj?.success ?? false} steps=${traj?.stepsCount ?? 0} tools=${traj?.toolsCalled?.length ?? 0}`);
    console.log(`\n=== [Trae Agent Reply] ===\n${verdict.finalText || "(no final_result)"}\n`);

    if (!verdict.ok) {
      const errTail = (stderr || stdoutText).trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`${verdict.reason}${errTail ? " | tail: " + errTail : ""}`);
    }
  } finally {
    try { fs.unlinkSync(stagedTaskFile); } catch { /* ignore */ }
    releaseLock(lockFile);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const root = resolveCwd(opts, process.cwd());
  const stateFile = opts.state
    ? path.resolve(process.cwd(), opts.state)
    : path.join(root, "private", "trae-bridge", "state.json");
  const pythonBin = findTraePython();

  if (opts.status) return cmdStatus(pythonBin, opts, root, stateFile);
  if (opts.models) return cmdModels();

  return dispatch(pythonBin, opts, root, stateFile);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Trae Bridge Error]", e.message || e);
    process.exit(1);
  });
}
