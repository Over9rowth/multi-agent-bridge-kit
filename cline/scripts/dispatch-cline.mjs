#!/usr/bin/env node
/**
 * VS Code Cline Local Bridge - 跨项目通用适配器
 *
 * 目标：让外部「主 Agent」通过一条纯 ASCII 短命令，
 *       直接驱动本机 VS Code Cline 扩展内置的无头核心引擎 `@cline/core` (`ClineCore`)，
 *       完全复用本机 Cline 已配置的 Provider / 凭据 / 模型目录 / `sessions.db`，
 *       无需与 VS Code URI 弹窗或全局 Hooks 纠缠，支持任意目录、任意轻量模型秒切与跨进程 `--reuse`。
 *
 * 零第三方依赖，仅使用 Node.js >= 22 内置模块及 Cline 自身安装的 `@cline/core`。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_ASCII_PROMPT_LEN = 80;

export function parseArgs(argv) {
  const opts = {
    status: false,
    models: false,
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
    provider: "",
    model: "",
    mode: "act", // act | plan
    write: false,
    timeout: DEFAULT_TIMEOUT_SEC,
    limit: 15,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const valueFlags = new Set([
    "--show",
    "--file",
    "--prompt",
    "--cwd",
    "--cwd-file",
    "--state",
    "--session",
    "--provider",
    "--model",
    "--mode",
    "--timeout",
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
      else if (a === "--provider") opts.provider = val;
      else if (a === "--model") opts.model = val;
      else if (a === "--mode") {
        if (!["act", "plan"].includes(val)) throw new Error(`Invalid --mode (act|plan): ${val}`);
        opts.mode = val;
      } else if (a === "--timeout") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 86400) throw new Error(`Invalid --timeout (1..86400): ${val}`);
        opts.timeout = n;
      } else if (a === "--limit") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error(`Invalid --limit (1..200): ${val}`);
        opts.limit = n;
      }
      continue;
    }

    switch (a) {
      case "--status": opts.status = true; break;
      case "--models": opts.models = true; break;
      case "--history": opts.history = true; break;
      case "--here": opts.here = true; break;
      case "--reuse": opts.reuse = true; break;
      case "--write": opts.write = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (opts.file && opts.prompt) throw new Error("Cannot pass both --file and --prompt");
  if (opts.cwd && opts.cwdFile) throw new Error("Cannot pass both --cwd and --cwd-file");
  if (opts.reuse && opts.session) throw new Error("Cannot pass both --reuse and --session");
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

export function compareSemverDesc(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function findClineExtension(env = process.env, homeDir = os.homedir()) {
  if (env.CLINE_CORE_ENTRY) {
    const p = path.resolve(env.CLINE_CORE_ENTRY);
    if (!fs.existsSync(p)) throw new Error(`CLINE_CORE_ENTRY not found: ${p}`);
    return { coreEntry: p, extVersion: null, extDir: path.dirname(p) };
  }

  const extRoots = [
    path.join(homeDir, ".vscode", "extensions"),
    path.join(homeDir, ".vscode-insiders", "extensions"),
    path.join(homeDir, ".cursor", "extensions"),
  ];
  const matches = [];
  for (const root of extRoots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const m = d.name.match(/^saoudrizwan\.claude-dev-(.+)$/);
      if (!m) continue;
      const extDir = path.join(root, d.name);
      const coreEntry = path.join(extDir, "dist", "plugin-runtime", "node_modules", "@cline", "core", "dist", "index.js");
      if (fs.existsSync(coreEntry)) {
        matches.push({ version: m[1], extDir, coreEntry });
      }
    }
  }
  if (matches.length === 0) {
    throw new Error("Could not locate VS Code Cline extension (@cline/core). Set CLINE_CORE_ENTRY.");
  }
  matches.sort((a, b) => compareSemverDesc(a.version, b.version));
  return { coreEntry: matches[0].coreEntry, extVersion: matches[0].version, extDir: matches[0].extDir };
}

export function discoverProxyUrl(env = process.env, homeDir = os.homedir()) {
  const direct = env.CLINE_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY;
  if (direct && direct.trim()) return direct.trim();

  const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
  const vscodeSettings = path.join(appData, "Code", "User", "settings.json");
  if (fs.existsSync(vscodeSettings)) {
    try {
      const raw = fs.readFileSync(vscodeSettings, "utf8");
      const m = raw.match(/"http\.proxy"\s*:\s*"([^"]+)"/);
      if (m && m[1].trim()) return m[1].trim();
    } catch { /* ignore */ }
  }
  return "";
}

/**
 * Node 22.15.1 原生 fetch 默认忽略 HTTPS_PROXY，必须为外网 HTTPS 走 CONNECT 隧道
 */
export function makeProxyFetch(proxyUrl) {
  if (!proxyUrl) return globalThis.fetch;
  const pu = new URL(proxyUrl);
  const origFetch = globalThis.fetch;
  return async function proxyFetch(input, init = {}) {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.protocol !== "https:") {
      return origFetch(req);
    }
    const headersObj = {};
    req.headers.forEach((v, k) => { headersObj[k] = v; });
    const bodyBuf = req.body ? Buffer.from(await req.arrayBuffer()) : null;
    if (bodyBuf && !headersObj["content-length"]) {
      headersObj["content-length"] = String(bodyBuf.length);
    }
    const targetPort = Number(u.port) || 443;
    const sock = await new Promise((resolve, reject) => {
      const creq = http.request({
        host: pu.hostname,
        port: Number(pu.port) || 80,
        method: "CONNECT",
        path: `${u.hostname}:${targetPort}`,
      });
      creq.on("connect", (res, socket) => {
        if (res.statusCode !== 200) return reject(new Error(`Proxy CONNECT ${res.statusCode}`));
        resolve(socket);
      });
      creq.on("error", reject);
      creq.end();
    });
    const tlsSock = tls.connect({ socket: sock, servername: u.hostname });
    const res = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: u.hostname,
        port: targetPort,
        path: u.pathname + u.search,
        method: req.method,
        headers: headersObj,
        createConnection: () => tlsSock,
      }, resolve);
      if (req.signal) {
        if (req.signal.aborted) { r.destroy(new Error("Aborted")); return; }
        req.signal.addEventListener("abort", () => r.destroy(new Error("Aborted")), { once: true });
      }
      r.on("error", reject);
      if (bodyBuf) r.write(bodyBuf);
      r.end();
    });
    const stream = new ReadableStream({
      start(controller) {
        res.on("data", (chunk) => controller.enqueue(chunk));
        res.on("end", () => controller.close());
        res.on("error", (err) => controller.error(err));
      },
      cancel() { res.destroy(); },
    });
    return new Response(stream, { status: res.statusCode, statusText: res.statusMessage, headers: res.headers });
  };
}

export function readClineGlobalState(homeDir = os.homedir()) {
  const p = path.join(homeDir, ".cline", "data", "globalState.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function resolveProviderAndModel({ configuredProviders, liveCatalog, globalState, rawProvider, rawModel }) {
  let providerId = (rawProvider || "").trim();
  let modelId = (rawModel || "").trim();

  if (!providerId && modelId.includes("/") && configuredProviders[modelId.split("/")[0]]) {
    const slash = modelId.indexOf("/");
    providerId = modelId.slice(0, slash);
    modelId = modelId.slice(slash + 1);
  }

  if (!providerId) {
    const modePref = globalState?.mode === "plan" ? globalState?.planModeApiProvider : globalState?.actModeApiProvider;
    providerId = (modePref && configuredProviders[modePref])
      ? modePref
      : (configuredProviders.vertex ? "vertex" : Object.keys(configuredProviders)[0] || "");
  }

  if (!providerId || !configuredProviders[providerId]) {
    throw new Error(`Provider "${providerId || "(none)"}" is not configured in Cline (~/.cline/data). Configured: ${Object.keys(configuredProviders).join(", ") || "none"}`);
  }

  const pCfg = configuredProviders[providerId];
  if (!modelId) {
    const gsModel = globalState?.mode === "plan" ? globalState?.planModeApiModelId : globalState?.actModeApiModelId;
    modelId = pCfg.modelId || gsModel || "";
  }
  if (!modelId) throw new Error(`No default model configured for provider "${providerId}"`);

  const knownSet = new Set([
    ...(pCfg.knownModels ? Object.keys(pCfg.knownModels) : []),
    ...(liveCatalog?.[providerId] ? Object.keys(liveCatalog[providerId]) : []),
  ]);
  if (knownSet.size > 0 && !knownSet.has(modelId)) {
    throw new Error(`Model "${modelId}" not found in Cline catalog for provider "${providerId}"`);
  }

  return { providerId, modelId, providerConfig: pCfg };
}

export function evaluateClineResult(result, expectedModel) {
  if (!result) return { ok: false, reason: "Cline returned null result" };
  if (result.finishReason !== "completed") {
    return { ok: false, reason: `Cline finishReason=${result.finishReason || "none"}: ${result.text || "failed"}` };
  }
  if (!result.text || !result.text.trim()) {
    return { ok: false, reason: "Cline finished with empty text" };
  }
  const obsId = result.model?.id || null;
  const obsProv = result.model?.provider || null;
  if (expectedModel && obsId && obsId !== expectedModel.modelId) {
    return { ok: false, reason: `Model mismatch: requested ${expectedModel.modelId}, observed ${obsId}` };
  }
  return { ok: true, reason: "ok", observedModel: obsProv && obsId ? `${obsProv}/${obsId}` : obsId };
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (e) {
    if (fs.existsSync(stateFile)) console.warn(`[Cline Bridge] State unreadable, ignoring: ${e.message}`);
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

async function loadClineRuntime() {
  const ext = findClineExtension();
  const proxyUrl = discoverProxyUrl();
  const proxyFetch = makeProxyFetch(proxyUrl);
  if (proxyUrl) globalThis.fetch = proxyFetch;

  const mod = await import(pathToFileURL(ext.coreEntry).href);
  const psm = new mod.ProviderSettingsManager();
  const rawSettings = await psm.read();
  const configuredProviders = {};
  for (const pid of Object.keys(rawSettings?.providers || {})) {
    configuredProviders[pid] = await psm.getProviderConfig(pid);
  }
  const liveCatalog = typeof mod.getLiveModelsCatalog === "function" ? await mod.getLiveModelsCatalog().catch(() => ({})) : {};
  return { ext, proxyUrl, proxyFetch, mod, configuredProviders, liveCatalog };
}

function printHelp() {
  console.log(`VS Code Cline Local Bridge (@cline/core headless adapter)

  --status              Check Cline extension, @cline/core, providers, proxy & state
  --models              List configured providers and models (--provider filters)
  --history             List Cline sessions in ~/.cline/data/db/sessions.db (--here filters cwd)
  --show <id|latest>    Inspect persisted session messages
  --file <path>         Read UTF-8 task file (recommended; <= 1 MiB)
  --prompt <text>       Short pure-ASCII single-line prompt (< 80 chars only)
  --cwd <dir>           Working directory (default: process.cwd())
  --cwd-file <path>     Read UTF-8 working directory from file
  --state <path>        Override state JSON path
  --reuse               Resume last completed session in same cwd
  --session <id>        Explicit session ID to resume
  --provider <id>       Cline provider ID (e.g. vertex, gemini)
  --model <id>          Model ID (or provider/modelId, e.g. gemini-3.5-flash)
  --mode <act|plan>     Execution mode (default: act)
  --write               Auto-approve file edits & commands (default rejects unapproved writes)
  --timeout <sec>       Timeout seconds (1..86400, default 600)
  --dry-run             Pre-validate task, provider, model & SHA-256 without starting session
  --verbose             Print Cline runtime streaming events
  -h, --help            Show help
`);
}

async function cmdStatus(rt, root, stateFile) {
  const gs = readClineGlobalState();
  const state = readState(stateFile);
  const providersSummary = {};
  for (const [pid, cfg] of Object.entries(rt.configuredProviders)) {
    providersSummary[pid] = {
      defaultModel: cfg?.modelId || null,
      region: cfg?.region || cfg?.gcp?.region || null,
      knownCount: cfg?.knownModels ? Object.keys(cfg.knownModels).length : 0,
    };
  }
  console.log(JSON.stringify({
    connected: Object.keys(rt.configuredProviders).length > 0,
    transport: "@cline/core ClineCore.create({ backendMode: 'local' }) in-process headless runtime",
    extensionVersion: rt.ext.extVersion,
    coreEntry: rt.ext.coreEntry,
    proxyUrl: rt.proxyUrl || null,
    globalDefaultProvider: gs?.actModeApiProvider || null,
    globalDefaultModel: gs?.actModeApiModelId || null,
    configuredProviders: providersSummary,
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

async function cmdModels(rt, opts) {
  const out = {};
  for (const [pid, cfg] of Object.entries(rt.configuredProviders)) {
    if (opts.provider && opts.provider !== pid) continue;
    const ids = new Set([
      ...(cfg?.knownModels ? Object.keys(cfg.knownModels) : []),
      ...(rt.liveCatalog?.[pid] ? Object.keys(rt.liveCatalog[pid]) : []),
    ]);
    out[pid] = {
      defaultModel: cfg?.modelId || null,
      models: [...ids],
    };
  }
  console.log(JSON.stringify(out, null, 2));
}

async function cmdHistory(rt, opts, root) {
  const core = await rt.mod.ClineCore.create({ backendMode: "local", clientName: "cline-bridge", fetch: rt.proxyFetch });
  try {
    let rows = await core.listHistory({ limit: opts.here ? 100 : opts.limit });
    if (opts.here) {
      rows = rows.filter((r) => {
        if (!r.cwd) return false;
        try { return fs.realpathSync(r.cwd) === root; } catch { return path.resolve(r.cwd) === root; }
      }).slice(0, opts.limit);
    }
    console.log(JSON.stringify({
      count: rows.length,
      sessions: rows.map((r) => ({
        sessionId: r.sessionId,
        status: r.status,
        provider: r.provider,
        model: r.model,
        cwd: r.cwd,
        startedAt: r.startedAt,
      })),
    }, null, 2));
  } finally {
    await core.dispose();
  }
}

async function cmdShow(rt, opts, stateFile) {
  const core = await rt.mod.ClineCore.create({ backendMode: "local", clientName: "cline-bridge", fetch: rt.proxyFetch });
  try {
    let sid = opts.show;
    if (sid === "latest") {
      const st = readState(stateFile);
      if (st.lastSessionId) sid = st.lastSessionId;
      else {
        const rows = await core.listHistory({ limit: 1 });
        if (!rows[0]) throw new Error("No Cline sessions found");
        sid = rows[0].sessionId;
      }
    }
    const meta = await core.get(sid);
    const msgs = await core.readMessages(sid);
    console.log(JSON.stringify({
      sessionId: sid,
      status: meta?.status || null,
      provider: meta?.provider || null,
      model: meta?.model || null,
      cwd: meta?.cwd || null,
      messagesCount: msgs.length,
      lastMessage: msgs[msgs.length - 1] || null,
    }, null, 2));
  } finally {
    await core.dispose();
  }
}

async function dispatch(rt, opts, root, stateFile) {
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

  const globalState = readClineGlobalState();
  const target = resolveProviderAndModel({
    configuredProviders: rt.configuredProviders,
    liveCatalog: rt.liveCatalog,
    globalState,
    rawProvider: opts.provider,
    rawModel: opts.model,
  });

  const state = readState(stateFile);
  let resumeId = opts.session || "";
  if (opts.reuse) {
    if (!state.lastSessionId) throw new Error("--reuse requested but no prior session recorded in state file");
    if (state.phase !== "completed") {
      throw new Error(`--reuse refused: prior session ${state.lastSessionId} is in phase="${state.phase}"`);
    }
    if (state.lastCwd !== root) {
      throw new Error(`--reuse refused: prior session cwd (${state.lastCwd}) != current cwd (${root})`);
    }
    resumeId = state.lastSessionId;
  }

  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  const lockFile = `${stateFile}.lock`;

  console.log(`[Cline Bridge] ${resumeId ? "Reuse session: " + resumeId : "New session"}`);
  console.log(`[Cline Bridge] cwd=${root} provider=${target.providerId} model=${target.modelId} mode=${opts.mode} write=${opts.write} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);

  if (opts.dryRun) {
    console.log(`[Cline Bridge] dry-run proxy=${rt.proxyUrl || "direct"} preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  acquireLock(lockFile);
  const t0 = Date.now();
  const core = await rt.mod.ClineCore.create({
    backendMode: "local",
    clientName: "cline-bridge",
    fetch: rt.proxyFetch,
    capabilities: opts.write
      ? undefined
      : {
          requestToolApproval: async (req) => ({
            approved: false,
            reason: `Tool "${req?.toolName || "unknown"}" denied: pass --write to auto-approve edits/commands.`,
          }),
        },
  });

  let activeSessionId = resumeId || "";
  let unsub = null;
  let timer = null;

  try {
    let initialMessages;
    if (resumeId) {
      initialMessages = await core.readMessages(resumeId);
      if (!Array.isArray(initialMessages) || initialMessages.length === 0) {
        throw new Error(`Cannot resume session ${resumeId}: persisted messages missing or empty`);
      }
      writeAtomicJson(stateFile, {
        ...state,
        phase: "dispatching",
        lastSessionId: resumeId,
        lastCwd: root,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    }

    const startCfg = {
      providerId: target.providerId,
      modelId: target.modelId,
      cwd: root,
      workspaceRoot: root,
      mode: opts.mode,
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      ...(resumeId ? { sessionId: resumeId } : {}),
      ...(target.providerConfig?.region ? { region: target.providerConfig.region } : {}),
      ...(target.providerConfig?.gcp ? { gcp: target.providerConfig.gcp } : {}),
    };

    const started = await core.start({
      interactive: true,
      ...(initialMessages ? { initialMessages } : {}),
      config: startCfg,
      toolPolicies: { "*": { autoApprove: Boolean(opts.write) } },
    });
    activeSessionId = started.sessionId;

    writeAtomicJson(stateFile, {
      phase: "dispatching",
      lastSessionId: activeSessionId,
      lastCwd: root,
      requestedModel: `${target.providerId}/${target.modelId}`,
      taskSha256: task.sha256,
      updatedAt: new Date().toISOString(),
    });

    unsub = core.subscribe((ev) => {
      if (opts.verbose && ev?.type !== "assistant_delta" && ev?.type !== "reasoning_delta") {
        console.log(`[cline-event] ${ev?.type} ${JSON.stringify(ev?.payload || {}).slice(0, 240)}`);
      }
      if (ev?.type === "agent_event" && ev.payload?.event?.type === "content_start" && ev.payload.event.contentType === "tool") {
        console.log(`  -> [tool] ${ev.payload.event.toolName}`);
      }
    }, { sessionId: activeSessionId });

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try { await core.abort(activeSessionId, new Error("Cline bridge timeout")); } catch { /* ignore */ }
        reject(new Error(`Timeout after ${opts.timeout}s waiting for Cline`));
      }, opts.timeout * 1000);
    });

    const result = await Promise.race([
      core.send({ sessionId: activeSessionId, prompt: task.text }),
      timeoutPromise,
    ]);
    clearTimeout(timer);

    const verdict = evaluateClineResult(result, target);
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    writeAtomicJson(stateFile, {
      phase: verdict.ok ? "completed" : "uncertain",
      lastSessionId: activeSessionId,
      lastCwd: root,
      observedModel: verdict.observedModel || `${target.providerId}/${target.modelId}`,
      taskSha256: task.sha256,
      updatedAt: new Date().toISOString(),
    });

    writeAtomicJson(resultFile, {
      ok: verdict.ok,
      reason: verdict.reason,
      sessionId: activeSessionId,
      cwd: root,
      requestedModel: `${target.providerId}/${target.modelId}`,
      observedModel: verdict.observedModel || null,
      finishReason: result?.finishReason || null,
      elapsedSec: elapsed,
      usage: result?.usage || null,
      toolsCalled: (result?.toolCalls || []).map((t) => t.name),
      taskSha256: task.sha256,
      reply: result?.text || "",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[Cline Bridge] session=${activeSessionId} elapsed=${elapsed}s finish=${result?.finishReason || "none"} observedModel=${verdict.observedModel || "none"} tools=${(result?.toolCalls || []).length}`);
    console.log(`\n=== [Cline Reply] ===\n${result?.text || "(no reply)"}\n`);

    if (!verdict.ok) throw new Error(verdict.reason);
  } catch (err) {
    if (activeSessionId) {
      try {
        writeAtomicJson(stateFile, {
          phase: "uncertain",
          lastSessionId: activeSessionId,
          lastCwd: root,
          taskSha256: task.sha256,
          updatedAt: new Date().toISOString(),
        });
      } catch { /* ignore */ }
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (unsub) try { unsub(); } catch { /* ignore */ }
    if (activeSessionId) {
      try { await core.stop(activeSessionId); } catch { /* ignore */ }
    }
    try { await core.dispose(); } catch { /* ignore */ }
    releaseLock(lockFile);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const root = resolveCwd(opts, process.cwd());
  const stateFile = opts.state
    ? path.resolve(process.cwd(), opts.state)
    : path.join(root, "private", "cline-bridge", "state.json");
  const rt = await loadClineRuntime();

  if (opts.status) return cmdStatus(rt, root, stateFile);
  if (opts.models) return cmdModels(rt, opts);
  if (opts.history) return cmdHistory(rt, opts, root);
  if (opts.show) return cmdShow(rt, opts, stateFile);

  return dispatch(rt, opts, root, stateFile);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Cline Bridge Error]", e.message || e);
    process.exit(1);
  });
}
