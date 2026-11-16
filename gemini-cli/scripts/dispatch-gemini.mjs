#!/usr/bin/env node
/**
 * Gemini CLI Local Bridge - 跨项目通用适配器
 *
 * 目标：让外部「主 Agent」通过一条纯 ASCII 短命令，
 *       把任务派发给本机 `@google/gemini-cli`（走无头 `-p "" -o stream-json`），
 *       支持 `gemini-4-argon`（炫彩猫猫）、`gemini-4-carbon`、`gemini-3.5-flash` 等模型，
 *       并执行三层验收（请求接受 -> result.status==="success" + stats.models 观测 -> 产物落盘）。
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

export function parseArgs(argv) {
  const opts = {
    status: false,
    models: false,
    history: false,
    file: "",
    prompt: "",
    cwd: "",
    cwdFile: "",
    state: "",
    reuse: false,
    session: "",
    model: "",
    approvalMode: "default", // default | auto_edit | yolo | plan
    write: false,
    yolo: false,
    withExtensions: false,
    skipTrust: true,
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
    "--approval-mode",
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
      else if (a === "--approval-mode") {
        if (!["default", "auto_edit", "yolo", "plan"].includes(val)) {
          throw new Error(`Invalid --approval-mode: ${val}`);
        }
        opts.approvalMode = val;
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
      case "--history": opts.history = true; break;
      case "--reuse": opts.reuse = true; break;
      case "--write": opts.write = true; break;
      case "--yolo": opts.yolo = true; break;
      case "--with-extensions": opts.withExtensions = true; break;
      case "--no-skip-trust": opts.skipTrust = false; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (opts.file && opts.prompt) throw new Error("Cannot pass both --file and --prompt");
  if (opts.cwd && opts.cwdFile) throw new Error("Cannot pass both --cwd and --cwd-file");
  if (opts.reuse && opts.session) throw new Error("Cannot pass both --reuse and --session");
  if (opts.yolo) opts.approvalMode = "yolo";
  else if (opts.write && opts.approvalMode === "default") opts.approvalMode = "yolo";
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

export function findGeminiEntry(env = process.env) {
  if (env.GEMINI_CLI_ENTRY) {
    const p = path.resolve(env.GEMINI_CLI_ENTRY);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error(`GEMINI_CLI_ENTRY not found: ${p}`);
    }
    return p;
  }

  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"),
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"),
    "/usr/local/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
  ];

  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
  }

  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* ignore */ }
  }
  throw new Error("Could not locate @google/gemini-cli/bundle/gemini.js. Set GEMINI_CLI_ENTRY.");
}

export function readGeminiSettings(homeDir = os.homedir()) {
  const p = path.join(homeDir, ".gemini", "settings.json");
  try {
    return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch {
    return { path: p, data: {} };
  }
}

export function discoverGcpDefaults(env = process.env, homeDir = os.homedir()) {
  const out = {
    project: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID || "",
    location: env.GOOGLE_CLOUD_LOCATION || env.VERTEX_LOCATION || env.GOOGLE_CLOUD_REGION || "",
    credentials: env.GOOGLE_APPLICATION_CREDENTIALS || "",
  };
  const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
  const adcPath = path.join(appData, "gcloud", "application_default_credentials.json");
  if (!out.credentials && fs.existsSync(adcPath)) {
    out.credentials = adcPath;
  }

  if (!out.project) {
    const gcloudCfg = path.join(appData, "gcloud", "configurations", "config_default");
    if (fs.existsSync(gcloudCfg)) {
      const txt = fs.readFileSync(gcloudCfg, "utf8");
      const m = txt.match(/^\s*project\s*=\s*([^\r\n]+)/m);
      if (m) out.project = m[1].trim();
    }
  }

  if (!out.project || !out.location) {
    const ocJson = "D:\\OpenCode\\opencode.json";
    if (fs.existsSync(ocJson)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(ocJson, "utf8"));
        const vOpts = cfg?.provider?.["google-vertex"]?.options;
        if (!out.project && vOpts?.project) out.project = vOpts.project;
        if (!out.location && vOpts?.location) out.location = vOpts.location;
      } catch { /* ignore */ }
    }
  }

  if (!out.location && out.project) out.location = "global";
  return out;
}

export function buildChildEnv(baseEnv = process.env, homeDir = os.homedir()) {
  const env = { ...baseEnv };
  // 关键：禁止 gemini.js 二次拉起子 node 进程，避免父子传递丢失或超时清理残留
  env.GEMINI_CLI_NO_RELAUNCH = "true";

  const settings = readGeminiSettings(homeDir);
  const authType = env.GEMINI_CLI_AUTH_OVERRIDE || settings.data?.security?.auth?.selectedType || "";
  if (authType === "vertex-ai") {
    const gcp = discoverGcpDefaults(env, homeDir);
    if (gcp.project && !env.GOOGLE_CLOUD_PROJECT) env.GOOGLE_CLOUD_PROJECT = gcp.project;
    if (gcp.location && !env.GOOGLE_CLOUD_LOCATION) env.GOOGLE_CLOUD_LOCATION = gcp.location;
    if (gcp.credentials && !env.GOOGLE_APPLICATION_CREDENTIALS) env.GOOGLE_APPLICATION_CREDENTIALS = gcp.credentials;
  }
  return env;
}

/**
 * 从本地 gemini-cli bundle 中只读提取内建声明模型常量与 JSON 注册表
 */
export function discoverAvailableModels(entryPath, env, cwd) {
  const catalog = new Map();
  const res = spawnSync(process.execPath, [entryPath, "models", "--output-format", "json"], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  if (res.status === 0 && res.stdout) {
    try {
      const list = JSON.parse(res.stdout.replace(/^\uFEFF/, "").trim());
      for (const m of list) {
        if (m?.id) catalog.set(m.id, { id: m.id, name: m.name || m.id, source: "cli-models" });
      }
    } catch { /* ignore */ }
  }

  // 只读扫描 bundle 内置支持的 4 系与 3 系/Gemma 模型字面量
  const bundleDir = path.dirname(entryPath);
  try {
    for (const f of fs.readdirSync(bundleDir)) {
      if (!f.startsWith("chunk-") || !f.endsWith(".js")) continue;
      const txt = fs.readFileSync(path.join(bundleDir, f), "utf8");
      if (!txt.includes("VALID_GEMINI_MODELS")) continue;
      const matches = txt.matchAll(/var\s+[A-Z0-9_]+MODEL\s*=\s*"([^"]+)"/g);
      for (const m of matches) {
        const id = m[1];
        if (id && id !== "none" && /^(gemini-|gemma-|auto$|flash$|pro$)/.test(id) && !/embedding/.test(id) && !catalog.has(id)) {
          catalog.set(id, { id, name: id, source: "bundle-const" });
        }
      }
      break;
    }
  } catch { /* ignore */ }

  return [...catalog.values()];
}

export function resolveModelId(models, rawModel) {
  if (!rawModel) return "";
  const id = rawModel.trim();
  const found = (models || []).find((m) => m.id === id);
  if (!found) {
    const allowed = (models || []).map((m) => m.id).join(", ");
    throw new Error(`Model "${id}" is not in Gemini CLI discovered models (${allowed})`);
  }
  return found.id;
}

export function buildExecArgs(opts, targetSessionId, modelId) {
  const args = [];
  if (targetSessionId) args.push("--resume", targetSessionId);
  args.push("-p", "");
  if (modelId) args.push("-m", modelId);
  if (!opts.withExtensions) args.push("-e", "none");
  args.push("--approval-mode", opts.approvalMode);
  if (opts.skipTrust) args.push("--skip-trust");
  args.push("-o", "stream-json");
  return args;
}

export function consumeStreamJsonLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    ctx.nonJsonLines.push(line);
    return;
  }
  if (verbose) console.log(`[stream-json] ${line.slice(0, 500)}`);

  switch (ev.type) {
    case "init":
      if (ev.session_id && !ctx.sessionId) ctx.sessionId = ev.session_id;
      if (ev.model) ctx.initModel = ev.model;
      break;
    case "message":
      if (ev.role === "assistant" && typeof ev.content === "string") {
        // 关键：stream-json 中助手回复带 delta: true，必须拼接而非覆盖！
        if (ev.delta) ctx.assistantText += ev.content;
        else ctx.assistantText = ev.content;
      }
      break;
    case "tool_use":
      ctx.tools.push({ name: ev.tool_name, id: ev.tool_id });
      console.log(`  -> [tool] ${ev.tool_name}`);
      break;
    case "tool_result":
      console.log(`  -> [tool_result] ${ev.tool_id} (${ev.status || "ok"})`);
      break;
    case "result":
      ctx.resultStatus = ev.status || null;
      ctx.resultError = ev.error?.message || (ev.error ? JSON.stringify(ev.error) : null);
      ctx.stats = ev.stats || null;
      if (ev.stats?.models && typeof ev.stats.models === "object") {
        ctx.observedModels = Object.keys(ev.stats.models);
      }
      break;
    default:
      break;
  }
}

export function evaluateTerminalState({ exitCode, timedOut, ctx, requestedModel }) {
  if (timedOut) return { ok: false, reason: "Timeout waiting for Gemini CLI" };
  const authPromptSeen = ctx.nonJsonLines.some((l) => /Opening authentication page/i.test(l));
  if (authPromptSeen) {
    return { ok: false, reason: "Gemini CLI attempted interactive browser authentication in headless mode" };
  }
  if (ctx.resultStatus && ctx.resultStatus !== "success") {
    return { ok: false, reason: `Gemini result status=${ctx.resultStatus}: ${ctx.resultError || "unknown error"}` };
  }
  if (exitCode !== 0) {
    return { ok: false, reason: `Gemini CLI exited with code ${exitCode}` };
  }
  if (ctx.resultStatus !== "success") {
    return { ok: false, reason: "Stream ended without result.status=success" };
  }
  if (!ctx.assistantText || !ctx.assistantText.trim()) {
    return { ok: false, reason: "Gemini CLI finished with empty assistant text" };
  }
  if (requestedModel && ctx.observedModels.length > 0 && !ctx.observedModels.includes(requestedModel)) {
    // 注：Gemini CLI 内部 agent-router 可能将 gemini-3.5-flash 路由到 gemini-4-argon，记入观测差异供审查
    return {
      ok: true,
      routedModelMismatch: `requested=${requestedModel}, observed=${ctx.observedModels.join(",")}`,
      reason: "ok",
    };
  }
  return { ok: true, routedModelMismatch: null, reason: "ok" };
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (e) {
    if (fs.existsSync(stateFile)) console.warn(`[Gemini Bridge] State unreadable, ignoring: ${e.message}`);
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
    if (e.code === "EEXIST") {
      throw new Error(`Bridge lock exists (${lockFile}); remove manually if stale.`);
    }
    throw e;
  }
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
}

function printHelp() {
  console.log(`Gemini CLI Local Bridge (cross-project adapter)

  --status                Check binary, auth config, GCP project/location & state
  --models                List discovered models from CLI & bundle
  --history               List Gemini CLI sessions in --cwd
  --file <path>           Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>         Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>             Working directory (default: process.cwd())
  --cwd-file <path>       Read UTF-8 working directory from file
  --state <path>          Override state JSON path
  --reuse                 Resume last completed session in same cwd
  --session <id>          Explicit session UUID to resume
  --model <id>            Model ID (e.g. gemini-4-argon, gemini-4-carbon, gemini-3.5-flash)
  --approval-mode <mode>  default | auto_edit | yolo | plan (default: default)
  --write / --yolo        Shorthand for --approval-mode yolo
  --with-extensions       Load user Gemini CLI extensions (disabled by default via -e none)
  --timeout <sec>         Timeout seconds (1..86400, default 600)
  --dry-run               Validate inputs and print args without running
  --verbose               Print raw stream-json events
  -h, --help              Show help
`);
}

function cmdStatus(entry, env, opts, root, stateFile) {
  const ver = spawnSync(process.execPath, [entry, "--version"], { env, encoding: "utf8", windowsHide: true, timeout: 15000 });
  const settings = readGeminiSettings();
  const authType = env.GEMINI_CLI_AUTH_OVERRIDE || settings.data?.security?.auth?.selectedType || null;
  const models = discoverAvailableModels(entry, env, root);
  const state = readState(stateFile);
  const ready = Boolean(authType !== "vertex-ai" || (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_LOCATION));
  console.log(JSON.stringify({
    connected: ver.status === 0 && ready,
    transport: "node gemini.js -p '' -o stream-json (JSONL over stdio, GEMINI_CLI_NO_RELAUNCH=true)",
    nodeBin: process.execPath,
    entry,
    version: (ver.stdout || "").trim() || null,
    authType,
    configModel: settings.data?.model?.name || null,
    gcpProject: env.GOOGLE_CLOUD_PROJECT || null,
    gcpLocation: env.GOOGLE_CLOUD_LOCATION || null,
    cwd: root,
    stateFile,
    bridgeState: state.phase ? {
      phase: state.phase,
      lastSessionId: state.lastSessionId || null,
      lastCwd: state.lastCwd || null,
      observedModels: state.observedModels || null,
      updatedAt: state.updatedAt || null,
    } : null,
    modelsCount: models.length,
  }, null, 2));
  if (!ready || ver.status !== 0) process.exitCode = 1;
}

function cmdModels(entry, env, root) {
  const models = discoverAvailableModels(entry, env, root);
  console.log(JSON.stringify({ count: models.length, models }, null, 2));
}

function cmdHistory(entry, env, root) {
  const res = spawnSync(process.execPath, [entry, "--list-sessions"], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 20000 });
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || "").trim() || `exit ${res.status}`);
  console.log((res.stdout || "").trim());
}

async function dispatch(entry, env, opts, root, stateFile) {
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

  const availableModels = discoverAvailableModels(entry, env, root);
  const resolvedModel = opts.model ? resolveModelId(availableModels, opts.model) : "";

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

  console.log(`[Gemini Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[Gemini Bridge] cwd=${root} model=${resolvedModel || "(settings default)"} approval=${opts.approvalMode} ext=${opts.withExtensions ? "enabled" : "none"} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Gemini Bridge] dry-run args=${JSON.stringify(args)}`);
    console.log(`[Gemini Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const ctx = {
    sessionId: targetSessionId || "",
    initModel: "",
    assistantText: "",
    tools: [],
    resultStatus: null,
    resultError: null,
    stats: null,
    observedModels: [],
    nonJsonLines: [],
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

    const child = spawn(process.execPath, [entry, ...args], {
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

    const verdict = evaluateTerminalState({
      exitCode,
      timedOut,
      ctx,
      requestedModel: resolvedModel,
    });
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    if (ctx.sessionId) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: ctx.sessionId,
        lastCwd: root,
        requestedModel: resolvedModel || null,
        observedModels: ctx.observedModels,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      routedModelMismatch: verdict.routedModelMismatch || null,
      sessionId: ctx.sessionId || null,
      cwd: root,
      requestedModel: resolvedModel || null,
      initModel: ctx.initModel || null,
      observedModels: ctx.observedModels,
      resultStatus: ctx.resultStatus,
      elapsedSec: elapsed,
      stats: ctx.stats,
      toolsCount: ctx.tools.length,
      taskSha256: task.sha256,
      reply: ctx.assistantText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Gemini Bridge] session=${ctx.sessionId || "(none)"} elapsed=${elapsed}s exit=${exitCode} status=${ctx.resultStatus || "none"} observedModels=${ctx.observedModels.join(",") || "none"}`);
    if (verdict.routedModelMismatch) {
      console.warn(`[Gemini Bridge] Routing notice: ${verdict.routedModelMismatch}`);
    }
    console.log(`\n=== [Gemini CLI Reply] ===\n${ctx.assistantText || "(no assistant text captured)"}\n`);

    if (!verdict.ok) {
      const errTail = stderr.trim().split(/\r?\n/).slice(-4).join(" | ");
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
    : path.join(root, "private", "gemini-bridge", "state.json");
  const entry = findGeminiEntry();
  const env = buildChildEnv();

  if (opts.status) return cmdStatus(entry, env, opts, root, stateFile);
  if (opts.models) return cmdModels(entry, env, root);
  if (opts.history) return cmdHistory(entry, env, root);

  return dispatch(entry, env, opts, root, stateFile);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Gemini Bridge Error]", e.message || e);
    process.exit(1);
  });
}
