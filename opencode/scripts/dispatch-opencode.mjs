#!/usr/bin/env node
/**
 * OpenCode Local Bridge - 跨项目通用适配器
 *
 * 目标：让外部「主 Agent（总架构师）」通过一条纯 ASCII 短命令，
 *       把多文件编码、构建检查与测试循环派发给本机 OpenCode (v2.x)，
 *       并执行三层验收（请求接受 -> 协议终态 + 服务端观测 -> 产物落盘）。
 *
 * 通信机制：
 *   - 发现与观测：`opencode service status` / `opencode api get /api/{info,model,agent,session}`
 *   - 任务执行：官方无头 `opencode run --format json`（JSONL over stdio）
 *   - 模型校验：派单前先核对 `/api/model`，拒绝无效/禁用/歧义模型且不污染状态文件
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
    agents: false,
    history: false,
    here: false,
    show: "",
    file: "",
    prompt: "",
    cwd: "",
    cwdFile: "",
    state: "",
    reuse: false,
    session: "",
    model: "",
    agent: "",
    title: "",
    timeout: DEFAULT_TIMEOUT_SEC,
    auto: false,
    archived: false,
    standalone: false,
    server: "",
    thinking: false,
    dryRun: false,
    verbose: false,
    help: false,
    limit: 15,
  };

  const valueFlags = new Set([
    "--show",
    "--file",
    "--prompt",
    "--cwd",
    "--cwd-file",
    "--state",
    "--session",
    "--model",
    "--agent",
    "--title",
    "--timeout",
    "--server",
    "--limit",
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
      if (a === "--show") opts.show = val;
      else if (a === "--file") opts.file = val;
      else if (a === "--prompt") opts.prompt = val;
      else if (a === "--cwd") opts.cwd = val;
      else if (a === "--cwd-file") opts.cwdFile = val;
      else if (a === "--state") opts.state = val;
      else if (a === "--session") opts.session = val;
      else if (a === "--model") opts.model = val;
      else if (a === "--agent") opts.agent = val;
      else if (a === "--title") opts.title = val;
      else if (a === "--server") opts.server = val;
      else if (a === "--timeout") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 86400) {
          throw new Error(`Invalid --timeout (must be integer 1..86400): ${val}`);
        }
        opts.timeout = n;
      } else if (a === "--limit") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 200) {
          throw new Error(`Invalid --limit (must be integer 1..200): ${val}`);
        }
        opts.limit = n;
      }
      continue;
    }

    switch (a) {
      case "--status": opts.status = true; break;
      case "--models": opts.models = true; break;
      case "--agents": opts.agents = true; break;
      case "--history": opts.history = true; break;
      case "--here": opts.here = true; break;
      case "--reuse": opts.reuse = true; break;
      case "--auto": opts.auto = true; break;
      case "--archived": opts.archived = true; break;
      case "--standalone": opts.standalone = true; break;
      case "--thinking": opts.thinking = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (opts.file && opts.prompt) {
    throw new Error("Cannot pass both --file and --prompt");
  }
  if (opts.cwd && opts.cwdFile) {
    throw new Error("Cannot pass both --cwd and --cwd-file");
  }
  if (opts.reuse && opts.session) {
    throw new Error("Cannot pass both --reuse and --session");
  }
  if (opts.standalone && opts.server) {
    throw new Error("Cannot pass both --standalone and --server");
  }
  return opts;
}

export function validateShortAsciiPrompt(text) {
  if (!text || !text.trim()) {
    throw new Error("Empty --prompt");
  }
  if (text.length >= MAX_ASCII_PROMPT_LEN) {
    throw new Error(`--prompt length (${text.length}) >= ${MAX_ASCII_PROMPT_LEN}; write UTF-8 task to a file and use --file instead`);
  }
  if (/[\r\n]/.test(text)) {
    throw new Error("--prompt must be single-line ASCII; use --file for multi-line tasks");
  }
  if (/[^\x20-\x7E]/.test(text)) {
    throw new Error("--prompt only accepts pure ASCII (< 80 chars) to avoid Windows terminal buffer hangs; use --file for Chinese/UTF-8 tasks");
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
    const { text } = readUtf8TaskFile(path.resolve(baseDir, opts.cwdFile));
    raw = text.trim();
  }
  const target = path.resolve(baseDir, raw || ".");
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Working directory does not exist or is not a directory: ${target}`);
  }
  return fs.realpathSync(target);
}

export function findOpenCodeBin(env = process.env) {
  const isWin = process.platform === "win32";
  const rejectWrapper = (p) => {
    if (isWin && /\.(cmd|bat|ps1)$/i.test(p)) {
      throw new Error(`Refusing wrapper script (${p}); native opencode.exe is required`);
    }
  };

  if (env.OPENCODE_BIN) {
    const p = path.resolve(env.OPENCODE_BIN);
    rejectWrapper(p);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error(`OPENCODE_BIN not found: ${p}`);
    }
    return p;
  }

  const exeName = isWin ? "opencode.exe" : "opencode";
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* ignore */ }
  }

  const candidates = [];
  if (env.OPENCODE_HOME) {
    candidates.push(path.join(env.OPENCODE_HOME, "node_modules", "@opencode", "cli", "bin", exeName));
  }
  if (isWin) {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    candidates.push(
      "D:\\OpenCode\\node_modules\\@opencode\\cli\\bin\\opencode.exe",
      path.join(localAppData, "OpenCode", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
      path.join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
    );
  } else {
    candidates.push("/usr/local/bin/opencode", path.join(os.homedir(), ".local", "bin", "opencode"));
  }

  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* ignore */ }
  }

  throw new Error("Native opencode binary not found. Set OPENCODE_BIN to the absolute path of opencode.exe.");
}

export function buildChildEnv(binPath, baseEnv = process.env) {
  const env = { ...baseEnv };
  // Prevent nested invocations from inheriting parent TUI session flags
  delete env.OPENCODE_SESSION_ID;
  delete env.OPENCODE_TERMINAL;
  delete env.OPENCODE;

  if (!env.OPENCODE_CONFIG) {
    let dir = path.dirname(binPath);
    for (let i = 0; i < 5; i++) {
      const jsonPath = path.join(dir, "opencode.json");
      const jsoncPath = path.join(dir, "opencode.jsonc");
      if (fs.existsSync(jsonPath)) {
        env.OPENCODE_CONFIG = jsonPath;
        if (!env.OPENCODE_HOME) env.OPENCODE_HOME = dir;
        break;
      }
      if (fs.existsSync(jsoncPath)) {
        env.OPENCODE_CONFIG = jsoncPath;
        if (!env.OPENCODE_HOME) env.OPENCODE_HOME = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return env;
}

export function parseModelSpec(raw) {
  const idx = raw.indexOf("#");
  if (idx < 0) return { modelKey: raw.trim(), variant: "" };
  const modelKey = raw.slice(0, idx).trim();
  const variant = raw.slice(idx + 1).trim();
  if (!modelKey || !variant) {
    throw new Error(`Invalid --model syntax "${raw}" (expected provider/model or provider/model#variant)`);
  }
  return { modelKey, variant };
}

export function resolveModelSpec(modelsList, rawSpec) {
  if (!rawSpec) return null;
  const { modelKey, variant } = parseModelSpec(rawSpec);
  const enabled = (modelsList || []).filter((m) => m.enabled !== false);

  let matches = [];
  if (modelKey.includes("/")) {
    const slash = modelKey.indexOf("/");
    const prov = modelKey.slice(0, slash);
    const mod = modelKey.slice(slash + 1);
    matches = enabled.filter((m) => m.providerID === prov && (m.modelID === mod || m.id === mod));
  } else {
    matches = enabled.filter((m) => m.modelID === modelKey || m.id === modelKey);
  }

  if (matches.length === 0) {
    throw new Error(`Model "${rawSpec}" not found or disabled in live /api/model catalog`);
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => `${m.providerID}/${m.modelID}`).join(", ");
    throw new Error(`Ambiguous model "${rawSpec}"; matches: ${ids}`);
  }

  const chosen = matches[0];
  if (variant) {
    const allowedVariants = (chosen.variants || []).map((v) => (typeof v === "string" ? v : v.id));
    if (!allowedVariants.includes(variant)) {
      throw new Error(`Variant "${variant}" not supported by ${chosen.providerID}/${chosen.modelID} (available: ${allowedVariants.join(", ") || "none"})`);
    }
  }

  const canonical = `${chosen.providerID}/${chosen.modelID}${variant ? "#" + variant : ""}`;
  return {
    canonical,
    providerID: chosen.providerID,
    modelID: chosen.modelID,
    variant: variant || null,
    name: chosen.name,
  };
}

export function resolveAgentId(agentsList, rawAgent) {
  if (!rawAgent) return null;
  const matches = (agentsList || []).filter((a) => !a.hidden && a.id === rawAgent);
  if (matches.length === 0) {
    const available = (agentsList || []).filter((a) => !a.hidden).map((a) => a.id).join(", ");
    throw new Error(`Agent "${rawAgent}" not found in live /api/agent catalog (available: ${available})`);
  }
  return matches[0].id;
}

export function buildRunArgs(opts, targetSessionId, canonicalModel) {
  const args = ["run", "--format", "json"];
  if (targetSessionId) args.push("--session", targetSessionId);
  if (canonicalModel) args.push("--model", canonicalModel);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.title && !targetSessionId) args.push("--title", opts.title);
  if (opts.archived) args.push("--archived");
  if (opts.auto) args.push("--auto");
  if (opts.thinking) args.push("--thinking");
  if (opts.standalone) args.push("--standalone");
  if (opts.server) args.push("--server", opts.server);
  return args;
}

export function consumeJsonlLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (verbose) console.log(`[jsonl] ${line.slice(0, 500)}`);
  if (ev.sessionID && !ctx.sessionID) ctx.sessionID = ev.sessionID;

  switch (ev.type) {
    case "step_start":
      ctx.stepCount += 1;
      break;
    case "tool_use": {
      const part = ev.part || {};
      const toolName = part.tool || "tool";
      const st = part.state?.status || "";
      ctx.tools.push({ tool: toolName, status: st });
      console.log(`  -> [tool] ${toolName} (${st || "done"})`);
      break;
    }
    case "text": {
      const txt = ev.part?.text;
      if (typeof txt === "string" && txt.length > 0) {
        ctx.textParts.push(txt);
        ctx.lastText = txt;
      }
      break;
    }
    case "retry": {
      const msg = ev.error?.message || ev.error?.type || "retrying";
      console.log(`  -> [retry #${ev.attempt ?? "?"}] ${String(msg).slice(0, 120)}`);
      break;
    }
    case "step_finish": {
      const part = ev.part || {};
      ctx.lastFinishReason = part.reason || null;
      if (typeof part.cost === "number") ctx.totalCost += part.cost;
      if (part.tokens) ctx.lastTokens = part.tokens;
      break;
    }
    case "error": {
      const errMsg = ev.error?.message || ev.message || JSON.stringify(ev.error || ev);
      ctx.errors.push(errMsg);
      break;
    }
    default:
      break;
  }
}

export function evaluateTerminalState({ exitCode, timedOut, ctx, serverVerification, requestedModel }) {
  if (ctx.errors.length > 0) {
    return { ok: false, reason: `OpenCode stream error: ${ctx.errors[ctx.errors.length - 1]}` };
  }
  if (timedOut) {
    return { ok: false, reason: "Timeout waiting for OpenCode worker" };
  }
  if (exitCode !== 0) {
    return { ok: false, reason: `opencode run exited with code ${exitCode}` };
  }
  if (ctx.lastFinishReason !== "stop") {
    return { ok: false, reason: `Incomplete stream terminal state (last step_finish reason=${ctx.lastFinishReason ?? "none"})` };
  }
  if (!ctx.lastText || !ctx.lastText.trim()) {
    return { ok: false, reason: "OpenCode finished with empty assistant text" };
  }
  if (serverVerification) {
    if (serverVerification.latestOutcome && serverVerification.latestOutcome !== "succeeded") {
      return { ok: false, reason: `Server session idle outcome=${serverVerification.latestOutcome}` };
    }
    if (requestedModel && serverVerification.observedModel) {
      const obs = serverVerification.observedModel;
      if (obs.providerID !== requestedModel.providerID || obs.id !== requestedModel.modelID) {
        return {
          ok: false,
          reason: `Model mismatch: requested ${requestedModel.providerID}/${requestedModel.modelID}, server observed ${obs.providerID}/${obs.id}`,
        };
      }
      if (requestedModel.variant && obs.variant !== requestedModel.variant) {
        return {
          ok: false,
          reason: `Variant mismatch: requested #${requestedModel.variant}, server observed #${obs.variant}`,
        };
      }
    }
  }
  return { ok: true, reason: "ok" };
}

export function extractServerVerification(messagesPayload) {
  const items = Array.isArray(messagesPayload) ? messagesPayload : (messagesPayload?.data || []);
  let latestOutcome = null;
  let observedModel = null;
  let observedAgent = null;
  let latestAssistantText = "";

  for (const item of items) {
    if (!latestOutcome && item.type === "idle" && item.outcome) {
      latestOutcome = item.outcome;
    }
    if (!observedModel && item.type === "assistant") {
      observedModel = item.model || null;
      observedAgent = item.agent || null;
      const textChunks = (item.content || [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text);
      if (textChunks.length > 0) latestAssistantText = textChunks.join("");
    }
    if (latestOutcome && observedModel) break;
  }

  return { latestOutcome, observedModel, observedAgent, latestAssistantText };
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (e) {
    if (fs.existsSync(stateFile)) {
      console.warn(`[OpenCode Bridge] State file unreadable, ignoring: ${e.message}`);
    }
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
      throw new Error(`Bridge lock exists (${lockFile}); another dispatch may be running. Inspect and remove lock manually if stale.`);
    }
    throw e;
  }
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
}

function runCliSync(bin, args, env, cwd) {
  return spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
}

function apiGetJson(bin, apiPath, env, cwd, serverUrl) {
  const args = ["api", "get", apiPath];
  if (serverUrl) args.push("--server", serverUrl);
  const res = runCliSync(bin, args, env, cwd);
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "").trim();
    throw new Error(`opencode api get ${apiPath} failed (exit ${res.status}): ${err}`);
  }
  const clean = (res.stdout || "").replace(/^\uFEFF/, "").trim();
  return JSON.parse(clean || "{}");
}

function printHelp() {
  console.log(`OpenCode Local Bridge (cross-project adapter)

  --status              Check binary, background service, config & bridge state
  --models              List active models from live /api/model catalog
  --agents              List non-hidden agents from live /api/agent catalog
  --history             List recent sessions (--here filters by --cwd)
  --show <id|latest>    Inspect session messages/tools/model directly via /api/session
  --file <path>         Read UTF-8 task prompt from file (recommended; <= 1 MiB)
  --prompt <text>       Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>           Working directory (default: process.cwd())
  --cwd-file <path>     Read UTF-8 working directory path from file (for Chinese paths)
  --state <path>        Override bridge state JSON path
  --reuse               Reuse last completed session in same cwd
  --session <id>        Explicitly target a session ID (overrides --reuse)
  --model <spec>        provider/model[#variant] or unique modelID[#variant]
  --agent <id>          Agent ID (validated against /api/agent)
  --title <text>        Optional session title for new sessions
  --timeout <sec>       Timeout in seconds (1..86400, default 600)
  --auto                Pass --auto (opt-in auto-approve non-denied permissions)
  --archived            Create session archived (hidden from normal UI lists)
  --standalone          Use private standalone server instead of shared service
  --server <url>        Connect to an explicit server URL
  --thinking            Include thinking blocks in CLI stream
  --dry-run             Pre-validate task, cwd, SHA-256, and model without executing
  --verbose             Print raw JSONL events
  -h, --help            Show help

Environment:
  OPENCODE_BIN          Explicit path to native opencode.exe
  OPENCODE_CONFIG       Override opencode.json(c) path
`);
}

async function cmdStatus(bin, env, opts, root, stateFile) {
  const ver = runCliSync(bin, ["--version"], env, root);
  const svc = runCliSync(bin, ["service", "status"], env, root);
  const serviceUrl = svc.status === 0 ? (svc.stdout || "").trim() : null;
  let info = null;
  let infoErr = null;
  if (!opts.standalone && (serviceUrl || opts.server)) {
    try {
      info = apiGetJson(bin, "/api/info", env, root, opts.server);
    } catch (e) {
      infoErr = e.message;
    }
  }
  const state = readState(stateFile);
  console.log(JSON.stringify({
    connected: Boolean(info),
    transport: opts.standalone ? "opencode run --standalone (JSONL over stdio)" : "opencode background service + opencode run --format json (JSONL over stdio)",
    binary: bin,
    version: (ver.stdout || "").trim() || null,
    serviceUrl: opts.server || serviceUrl,
    serverPid: info?.pid ?? null,
    configPath: env.OPENCODE_CONFIG || null,
    cwd: root,
    stateFile,
    bridgeState: state.phase ? {
      phase: state.phase,
      lastSessionId: state.lastSessionId || null,
      lastCwd: state.lastCwd || null,
      model: state.model || null,
      updatedAt: state.updatedAt || null,
    } : null,
    infoError: infoErr,
  }, null, 2));
  if (!info && !opts.standalone) process.exitCode = 1;
}

async function cmdModels(bin, env, opts, root) {
  const payload = apiGetJson(bin, "/api/model", env, root, opts.server);
  const items = (payload.data || []).filter((m) => m.enabled !== false).map((m) => ({
    id: `${m.providerID}/${m.modelID}`,
    name: m.name,
    status: m.status,
    variants: (m.variants || []).map((v) => (typeof v === "string" ? v : v.id)),
    contextLimit: m.limit?.context ?? null,
  }));
  console.log(JSON.stringify({ count: items.length, models: items }, null, 2));
}

async function cmdAgents(bin, env, opts, root) {
  const payload = apiGetJson(bin, "/api/agent", env, root, opts.server);
  const items = (payload.data || []).filter((a) => !a.hidden).map((a) => ({
    id: a.id,
    name: a.name,
    mode: a.mode,
    description: a.description,
  }));
  console.log(JSON.stringify({ count: items.length, agents: items }, null, 2));
}

async function cmdHistory(bin, env, opts, root) {
  const payload = apiGetJson(bin, "/api/session", env, root, opts.server);
  let items = payload.data || [];
  if (opts.here) {
    items = items.filter((s) => {
      const dir = s.location?.directory;
      if (!dir) return false;
      try { return fs.realpathSync(dir) === root; } catch { return path.resolve(dir) === root; }
    });
  }
  const summary = items.slice(0, opts.limit).map((s) => ({
    id: s.id,
    title: s.title || "(untitled)",
    outcome: s.outcome || null,
    model: s.model ? `${s.model.providerID}/${s.model.id}${s.model.variant ? "#" + s.model.variant : ""}` : null,
    agent: s.agent || null,
    directory: s.location?.directory || null,
    archived: Boolean(s.time?.archived),
    updatedAt: s.time?.updated ? new Date(s.time.updated).toISOString() : null,
  }));
  console.log(JSON.stringify({ totalReturned: items.length, showing: summary.length, sessions: summary }, null, 2));
}

async function cmdShow(bin, env, opts, root, stateFile) {
  let targetId = opts.show;
  if (targetId === "latest") {
    const state = readState(stateFile);
    if (state.lastSessionId) {
      targetId = state.lastSessionId;
    } else {
      const payload = apiGetJson(bin, "/api/session", env, root, opts.server);
      const list = payload.data || [];
      if (list.length === 0) throw new Error("No sessions found");
      targetId = list[0].id;
    }
  }
  const msgPayload = apiGetJson(bin, `/api/session/${encodeURIComponent(targetId)}/message`, env, root, opts.server);
  const verification = extractServerVerification(msgPayload);
  console.log(JSON.stringify({
    sessionID: targetId,
    latestOutcome: verification.latestOutcome,
    observedAgent: verification.observedAgent,
    observedModel: verification.observedModel,
    latestAssistantText: verification.latestAssistantText,
    messageCount: (msgPayload.data || []).length,
  }, null, 2));
}

async function dispatch(bin, env, opts, root, stateFile) {
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

  let requestedModel = null;
  if (opts.model && !opts.standalone) {
    const modelCatalog = apiGetJson(bin, "/api/model", env, root, opts.server);
    requestedModel = resolveModelSpec(modelCatalog.data || [], opts.model);
  } else if (opts.model && opts.standalone) {
    const parsed = parseModelSpec(opts.model);
    requestedModel = { canonical: opts.model, providerID: parsed.modelKey.split("/")[0], modelID: parsed.modelKey.split("/")[1] || parsed.modelKey, variant: parsed.variant || null };
  }

  if (opts.agent && !opts.standalone) {
    const agentCatalog = apiGetJson(bin, "/api/agent", env, root, opts.server);
    resolveAgentId(agentCatalog.data || [], opts.agent);
  }

  const state = readState(stateFile);
  let targetSessionId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded in state file");
    if (state.phase !== "completed") {
      throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}" (must be "completed")`);
    }
    if (state.lastCwd !== root) {
      throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    }
    targetSessionId = state.lastSessionId;
  }

  const canonicalModel = requestedModel ? requestedModel.canonical : "";
  const runArgs = buildRunArgs(opts, targetSessionId, canonicalModel);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[OpenCode Bridge] ${targetSessionId ? "Reuse session: " + targetSessionId : "New session"}`);
  console.log(`[OpenCode Bridge] cwd=${root} model=${canonicalModel || "(config default)"} agent=${opts.agent || "(default)"} auto=${opts.auto} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[OpenCode Bridge] dry-run args=${JSON.stringify(runArgs)}`);
    console.log(`[OpenCode Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const ctx = {
    sessionID: targetSessionId || "",
    stepCount: 0,
    tools: [],
    textParts: [],
    lastText: "",
    lastFinishReason: null,
    lastTokens: null,
    totalCost: 0,
    errors: [],
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
        model: canonicalModel || state.model || null,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    const child = spawn(bin, runArgs, {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let buf = "";
    let stderr = "";
    const persistDispatching = () => {
      if (!ctx.sessionID || savedSession) return;
      savedSession = true;
      writeAtomicJson(stateFile, {
        phase: "dispatching",
        lastSessionId: ctx.sessionID,
        lastCwd: root,
        model: canonicalModel || null,
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
        persistDispatching();
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
        let killOk = false;
        try {
          if (process.platform === "win32" && child.pid) {
            const kr = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 });
            killOk = kr.status === 0;
          } else {
            killOk = child.kill("SIGKILL");
          }
        } catch { /* ignore */ }
        if (!killOk) console.warn("[OpenCode Bridge] process-tree termination failed; destroying stdio handles.");
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
      consumeJsonlLine(buf, ctx, opts.verbose);
      persistDispatching();
    }

    let serverVerification = null;
    if (!opts.standalone && ctx.sessionID && !timedOut) {
      try {
        const msgPayload = apiGetJson(bin, `/api/session/${encodeURIComponent(ctx.sessionID)}/message`, env, root, opts.server);
        serverVerification = extractServerVerification(msgPayload);
      } catch (e) {
        console.warn(`[OpenCode Bridge] Server verification warning: ${e.message}`);
      }
    }

    const verdict = evaluateTerminalState({
      exitCode,
      timedOut,
      ctx,
      serverVerification,
      requestedModel,
    });

    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));
    const observedStr = serverVerification?.observedModel
      ? `${serverVerification.observedModel.providerID}/${serverVerification.observedModel.id}${serverVerification.observedModel.variant ? "#" + serverVerification.observedModel.variant : ""}`
      : null;

    if (ctx.sessionID) {
      writeAtomicJson(stateFile, {
        phase: verdict.ok ? "completed" : "uncertain",
        lastSessionId: ctx.sessionID,
        lastCwd: root,
        model: observedStr || canonicalModel || null,
        agent: serverVerification?.observedAgent || opts.agent || null,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionID: ctx.sessionID || null,
      cwd: root,
      requestedModel: canonicalModel || null,
      observedModel: observedStr,
      observedAgent: serverVerification?.observedAgent || null,
      latestOutcome: serverVerification?.latestOutcome || null,
      lastFinishReason: ctx.lastFinishReason,
      elapsedSec: elapsed,
      cost: Number(ctx.totalCost.toFixed(6)),
      tokens: ctx.lastTokens,
      toolsCount: ctx.tools.length,
      taskSha256: task.sha256,
      reply: ctx.lastText || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[OpenCode Bridge] session=${ctx.sessionID || "(none)"} elapsed=${elapsed}s exit=${exitCode} finish=${ctx.lastFinishReason || "none"} outcome=${serverVerification?.latestOutcome || "n/a"} observedModel=${observedStr || "n/a"} cost=${ctx.totalCost.toFixed(6)}`);
    console.log(`\n=== [OpenCode Reply] ===\n${ctx.lastText || "(no text captured)"}\n`);

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
    : path.join(root, "private", "opencode-bridge", "state.json");
  const bin = findOpenCodeBin();
  const env = buildChildEnv(bin);

  if (opts.status) return cmdStatus(bin, env, opts, root, stateFile);
  if (opts.models) return cmdModels(bin, env, opts, root);
  if (opts.agents) return cmdAgents(bin, env, opts, root);
  if (opts.history) return cmdHistory(bin, env, opts, root);
  if (opts.show) return cmdShow(bin, env, opts, root, stateFile);

  return dispatch(bin, env, opts, root, stateFile);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[OpenCode Bridge Error]", e.message || e);
    process.exit(1);
  });
}
