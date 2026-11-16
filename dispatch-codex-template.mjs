#!/usr/bin/env node
/**
 * Codex Local Bridge - 跨项目通用版 (支持 ChatGPT 订阅与 BYO-Key / GLM 免登录双模式)
 *
 * 目标：让「主 Agent」通过一条纯 ASCII 短命令，把编码/构建/测试子任务
 *       派发给本机 OpenAI Codex CLI（headless `codex exec --json`）。
 *
 * 支持两种认证模式：
 *   1. BYO-Key 免登录模式（--byok 或检测到 ZAI_API_KEY/ZHIPU_API_KEY/GLM_API_KEY/CODEX_API_KEY）：
 *      自动生成隔离的 `CODEX_HOME`（`config.toml` + `models.json`，仅写 `env_key` 引用，磁盘零明文密钥），
 *      直连智谱 `https://open.bigmodel.cn/api/v1`（`wire_api = "responses"`）或任意 OpenAI Responses 端点；
 *   2. ChatGPT 订阅模式（--subscription 或无 BYOK 环境变量时）：
 *      沿用本机 `~/.codex/auth.json` 登录态，默认加 `--ignore-user-config` 跳过重型 MCP/Plugins。
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
const DEFAULT_SANDBOX = "workspace-write";
const DEFAULT_GLM_RESPONSES_URL = "https://open.bigmodel.cn/api/v1";
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
    thread: "",
    model: "",
    sandbox: DEFAULT_SANDBOX,
    write: false,
    withUserConfig: false,
    approve: false,
    danger: false,
    byok: false,
    subscription: false,
    baseUrl: "",
    apiKeyEnv: "",
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
    "--thread",
    "--model",
    "--sandbox",
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
      else if (a === "--thread") opts.thread = val;
      else if (a === "--model") opts.model = val;
      else if (a === "--base-url") opts.baseUrl = val;
      else if (a === "--api-key-env") opts.apiKeyEnv = val;
      else if (a === "--sandbox") {
        if (!["read-only", "workspace-write", "danger-full-access"].includes(val)) {
          throw new Error(`Invalid --sandbox: ${val}`);
        }
        opts.sandbox = val;
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
      case "--with-user-config": opts.withUserConfig = true; break;
      case "--approve": opts.approve = true; break;
      case "--danger": opts.danger = true; break;
      case "--byok": opts.byok = true; break;
      case "--subscription": opts.subscription = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      default:
        // Allow optional bare `--file` fallback used by early callers (`--file` -> CODEX_TASK.md) only if no value was consumed above
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (opts.file && opts.prompt) throw new Error("Cannot pass both --file and --prompt");
  if (opts.cwd && opts.cwdFile) throw new Error("Cannot pass both --cwd and --cwd-file");
  if (opts.reuse && opts.thread) throw new Error("Cannot pass both --reuse and --thread");
  if (opts.byok && opts.subscription) throw new Error("Cannot pass both --byok and --subscription");
  if (opts.write && opts.sandbox === DEFAULT_SANDBOX) opts.sandbox = "danger-full-access";
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

/** 方法论第 1 步的 Codex 变体：动态发现版本化原生 codex.exe（忽略无执行文件的空版本目录） */
export function findCodexBin(env = process.env) {
  if (env.CODEX_BIN) {
    const p = path.resolve(env.CODEX_BIN);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`CODEX_BIN not found: ${p}`);
    return p;
  }
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (fs.existsSync(binRoot)) {
    const dirs = fs.readdirSync(binRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(binRoot, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs) {
      const p = path.join(binRoot, d.name, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("codex binary not found (only native codex.exe is accepted, not npm .cmd/.bat wrappers). Set CODEX_BIN.");
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
    { name: "CODEX_API_KEY", glm: false },
  ];
  for (const item of order) {
    const val = (baseEnv[item.name] || "").trim();
    if (val) return { key: val, sourceVar: item.name, isGlmLike: item.glm || /^[0-9a-f]{32}\.[A-Za-z0-9]+$/.test(val) };
  }
  return { key: "", sourceVar: null, isGlmLike: false };
}

export function buildGlmModelsCatalog() {
  const mk = (slug, ctx, levels, defLevel) => ({
    slug,
    display_name: slug,
    description: `Zhipu ${slug} via OpenAI Responses API`,
    default_reasoning_level: defLevel,
    supported_reasoning_levels: levels.map((e) => ({ effort: e, description: e })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    base_instructions: "",
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: false,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "bytes", limit: 10000 },
    context_window: ctx,
    max_context_window: ctx,
    effective_context_window_percent: 95,
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: ["text"],
  });
  return {
    models: [
      mk("glm-4.7", 200000, ["low", "medium", "high"], "medium"),
      mk("glm-5.3", 1048576, ["low", "high", "max"], "high"),
      mk("glm-5.2", 1048576, ["low", "high", "max"], "high"),
      mk("glm-5-turbo", 204800, ["low", "high"], "high"),
    ],
  };
}

export function buildByokConfigToml({ baseUrl, keyEnvVar, model, modelsJsonPath }) {
  return `model_provider = "ZAI"
model = ${JSON.stringify(model)}
model_catalog_json = ${JSON.stringify(modelsJsonPath.replace(/\\/g, "/"))}

[model_providers.ZAI]
name = "ZAI"
base_url = ${JSON.stringify(baseUrl)}
env_key = ${JSON.stringify(keyEnvVar)}
wire_api = "responses"
`;
}

export function ensureByokCodexHome(codexHomeDir, { baseUrl, keyEnvVar, model }) {
  fs.mkdirSync(codexHomeDir, { recursive: true });
  const modelsPath = path.join(codexHomeDir, "models.json");
  const configPath = path.join(codexHomeDir, "config.toml");
  fs.writeFileSync(modelsPath, JSON.stringify(buildGlmModelsCatalog(), null, 2), "utf8");
  fs.writeFileSync(configPath, buildByokConfigToml({ baseUrl, keyEnvVar, model, modelsJsonPath: modelsPath }), "utf8");
  return { modelsPath, configPath };
}

export function buildExecutionPlan(opts, stateFile, baseEnv = process.env) {
  const cred = resolveByokCredential(opts, baseEnv);
  const useByok = !opts.subscription && Boolean(opts.byok || opts.baseUrl || opts.apiKeyEnv || cred.key);

  if (useByok) {
    const baseUrl = (opts.baseUrl || (cred.isGlmLike ? DEFAULT_GLM_RESPONSES_URL : "https://api.openai.com/v1")).trim();
    const model = opts.model || (cred.isGlmLike || baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai") ? DEFAULT_GLM_MODEL : "gpt-5.3-codex");
    const codexHomeDir = path.join(path.dirname(stateFile), "codex-home");
    const env = { ...baseEnv, CODEX_HOME: codexHomeDir };
    if (baseUrl.includes("bigmodel.cn") || baseUrl.includes("z.ai")) {
      delete env.HTTP_PROXY;
      delete env.HTTPS_PROXY;
    }
    return {
      mode: "byok",
      hasKey: Boolean(cred.key),
      keyEnvVar: cred.sourceVar || "ZAI_API_KEY",
      baseUrl,
      model,
      codexHomeDir,
      env,
      ignoreUserConfig: false, // isolated codexHome config.toml IS our clean config
    };
  }

  const subHome = baseEnv.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    mode: "subscription",
    hasKey: false,
    keyEnvVar: null,
    baseUrl: null,
    model: opts.model || "",
    codexHomeDir: subHome,
    env: { ...baseEnv },
    ignoreUserConfig: !opts.withUserConfig,
  };
}

export function buildArgs(opts, plan) {
  const common = ["--json", "--skip-git-repo-check"];
  if (plan.model) common.push("-m", plan.model);
  if (plan.ignoreUserConfig) common.push("--ignore-user-config");
  if (opts.danger) common.push("--dangerously-bypass-approvals-and-sandbox");

  if (opts.threadId) {
    return ["exec", "resume", opts.threadId, ...common, "-"];
  }
  const head = ["exec", ...common, "-C", opts.root, "-s", opts.sandbox];
  if (opts.approve) head.push("--approve-for-me");
  return [...head, "-"];
}

export function consumeLine(line, ctx, verbose = false) {
  if (!line || !line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (verbose) console.log(`[jsonl] ${line.slice(0, 500)}`);

  if (ev.type === "thread.started" && ev.thread_id) ctx.threadId = ev.thread_id;
  if (ev.type === "turn.completed") {
    ctx.turnCompleted = true;
    if (ev.usage) ctx.usage = ev.usage;
  }
  if (ev.type === "turn.failed") ctx.error = ev.error?.message || JSON.stringify(ev.error || ev);
  if (ev.type === "error") ctx.error = ev.message || JSON.stringify(ev);

  const item = ev.item || {};
  if (ev.type === "item.completed" || ev.type === "item.updated" || ev.type === "item.started") {
    switch (item.type) {
      case "agent_message":
        if (item.text && ev.type === "item.completed") ctx.lastMessage = item.text;
        break;
      case "command_execution":
        if (ev.type === "item.completed") {
          ctx.toolsCalled.push("command_execution");
          console.log(`  -> [cmd] ${String(item.command || "").slice(0, 160)} (${item.status ?? item.exit_code ?? ""})`);
        }
        break;
      case "file_change":
        if (ev.type === "item.completed") {
          ctx.toolsCalled.push("file_change");
          const files = (item.changes || []).map((c) => c.path).filter(Boolean).join(", ");
          if (files) console.log(`  -> [file] ${files.slice(0, 160)}`);
        }
        break;
      case "reasoning":
      case "web_search":
        break;
      default:
        if (ev.type === "item.completed") console.log(`  -> [${item.type || "item"}]`);
    }
  }
}

export function evaluateTerminalState({ exitCode, timedOut, ctx }) {
  if (ctx.error) return { ok: false, reason: `Codex turn failed: ${ctx.error}` };
  if (timedOut) return { ok: false, reason: "Timeout waiting for Codex" };
  if (exitCode !== 0) return { ok: false, reason: `codex exec exited ${exitCode}` };
  if (!ctx.turnCompleted) return { ok: false, reason: "Codex stream ended without turn.completed; treating as FAILED" };
  if (!ctx.lastMessage || !ctx.lastMessage.trim()) return { ok: false, reason: "Codex finished with empty agent_message" };
  return { ok: true, reason: "ok", finalText: ctx.lastMessage };
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (e) { if (fs.existsSync(stateFile)) console.warn(`[Codex Bridge] state unreadable, ignoring: ${e.message}`); return {}; }
}

function writeAtomicJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function readModelRegistry(codexHomeDir) {
  const p = path.join(codexHomeDir, "models_cache.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      fetchedAt: j.fetched_at || null,
      source: p,
      models: (j.models || []).map((m) => ({ slug: m.slug, label: m.display_name })),
    };
  } catch {
    return { fetchedAt: null, source: p, models: [] };
  }
}

function printHelp() {
  console.log(`Codex Local Bridge (ChatGPT 订阅 + BYO-Key 免登录双模式)

  --status              检查二进制 / 登录态或 BYOK 凭据 / 模型注册表 / 上次会话
  --models              列出可用模型（BYOK 模式显示 GLM Responses 目录；订阅模式读 models_cache.json）
  --file <name>         从 UTF-8 工单文件读取任务（推荐，<= 1 MiB）
  --prompt <text>       直接传短任务（仅限 < 80 字单行纯 ASCII）
  --cwd <dir>           覆盖工作根目录（默认 process.cwd()）
  --cwd-file <path>     从 UTF-8 文件读取中文工作目录
  --state <path>        覆盖状态文件 JSON 路径
  --reuse               复用上次已完成 thread（强制同目录）
  --thread <id>         显式指定 thread id（优先级高于 --reuse）
  --model <slug>        指定模型（BYOK 默认 glm-4.7，可选 glm-5.3 / glm-5.2 / glm-5-turbo）
  --byok                强制使用免登录 BYO-Key 模式（隔离 CODEX_HOME + OpenAI Responses API）
  --subscription        强制使用 ~/.codex/auth.json ChatGPT 订阅模式
  --base-url <url>      覆写 BYOK Responses 基址（默认 BigModel: ${DEFAULT_GLM_RESPONSES_URL}）
  --api-key-env <VAR>   指定存放 API Key 的环境变量名（默认查 ZAI_API_KEY/ZHIPU_API_KEY/GLM_API_KEY/CODEX_API_KEY）
  --sandbox <mode>      read-only | workspace-write (默认) | danger-full-access
  --write               等价于 --sandbox danger-full-access（Windows 真实施工必需）
  --with-user-config    订阅模式下加载完整 config.toml / MCP / 插件（默认跳过）
  --approve             加 --approve-for-me（仅新建会话有效）
  --danger              加 --dangerously-bypass-approvals-and-sandbox（危险）
  --dry-run             只打印将要执行的命令，不启动 Codex
  --verbose             打印 Codex 原始 JSONL 事件
  -h, --help            显示本帮助
`);
}

async function cmdStatus(bin, opts, root, stateFile, plan) {
  const v = spawnSync(bin, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const state = readState(stateFile);
  if (plan.mode === "byok") {
    console.log(JSON.stringify({
      connected: plan.hasKey,
      mode: "byok-skip-login",
      transport: "codex exec --json (isolated CODEX_HOME + wire_api=responses)",
      binary: bin,
      version: (v.stdout || "").trim() || null,
      codexHome: plan.codexHomeDir,
      baseUrl: plan.baseUrl,
      keyEnvVar: plan.keyEnvVar,
      hasCredentials: plan.hasKey,
      defaultModel: plan.model,
      cwd: root,
      stateFile,
      lastThreadId: state.lastThreadId || null,
      models: buildGlmModelsCatalog().models.map((m) => ({ slug: m.slug, contextWindow: m.context_window })),
    }, null, 2));
    if (!plan.hasKey) process.exitCode = 1;
    return;
  }

  const login = spawnSync(bin, ["login", "status"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const loginText = ((login.stdout || "") + (login.stderr || "")).trim();
  const loggedIn = /Logged in/i.test(loginText) && login.status === 0;
  const registry = readModelRegistry(plan.codexHomeDir);
  console.log(JSON.stringify({
    connected: loggedIn,
    mode: "subscription",
    transport: "codex exec --json (JSONL over stdio, headless process)",
    binary: bin,
    version: (v.stdout || "").trim() || null,
    login: loginText.split(/\r?\n/).filter((l) => /Logged in|not logged/i.test(l)).join(" ") || null,
    codexHome: plan.codexHomeDir,
    cwd: root,
    stateFile,
    lastThreadId: state.lastThreadId || null,
    models: registry.models,
    modelsFetchedAt: registry.fetchedAt,
  }, null, 2));
  if (!loggedIn) process.exitCode = 1;
}

function cmdModels(plan) {
  if (plan.mode === "byok") {
    console.log(JSON.stringify({
      mode: "byok",
      baseUrl: plan.baseUrl,
      models: buildGlmModelsCatalog().models.map((m) => ({ slug: m.slug, contextWindow: m.context_window })),
    }, null, 2));
    return;
  }
  const registry = readModelRegistry(plan.codexHomeDir);
  console.log(JSON.stringify({ mode: "subscription", ...registry }, null, 2));
}

async function dispatch(bin, opts, root, stateFile, plan) {
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

  if (plan.mode === "byok") {
    if (!plan.hasKey) throw new Error(`BYOK mode requires ${plan.keyEnvVar} in environment.`);
    ensureByokCodexHome(plan.codexHomeDir, {
      baseUrl: plan.baseUrl,
      keyEnvVar: plan.keyEnvVar,
      model: plan.model,
    });
  }

  const state = readState(stateFile);
  let threadId = opts.thread || "";
  if (opts.reuse) {
    if (!state.lastThreadId) throw new Error("--reuse requested but no prior thread recorded in state file");
    if (state.phase && state.phase !== "completed") {
      throw new Error(`--reuse refused: prior thread ${state.lastThreadId} is in phase="${state.phase}"`);
    }
    if (state.lastCwd && state.lastCwd !== root) {
      throw new Error(`--reuse refused: prior thread cwd (${state.lastCwd}) != current cwd (${root})`);
    }
    threadId = state.lastThreadId;
  }

  const args = buildArgs({ ...opts, root, threadId }, plan);
  const resultFile = path.join(path.dirname(stateFile), "last-result.json");
  console.log(`[Codex Bridge] ${threadId ? "Reuse session: " + threadId : "New session"} mode=${plan.mode}`);
  console.log(`[Codex Bridge] cwd=${root} sandbox=${threadId ? "(inherited)" : opts.sandbox} model=${plan.model || "(config default)"} bytes=${task.bytes} sha256=${task.sha256.slice(0, 12)}`);
  if (opts.dryRun) {
    console.log(`[Codex Bridge] dry-run args=${JSON.stringify(args)}`);
    console.log(`[Codex Bridge] preview=${JSON.stringify(task.text.slice(0, 120))}`);
    return;
  }

  const t0 = Date.now();
  const child = spawn(bin, args, {
    cwd: root,
    env: plan.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let buf = "", stderr = "";
  const ctx = { threadId: threadId || "", lastMessage: "", usage: null, error: null, turnCompleted: false, toolsCalled: [] };
  let savedThreadId = threadId || "";
  const persist = (phase = "dispatching") => {
    if (!ctx.threadId) return;
    try {
      writeAtomicJson(stateFile, {
        phase,
        mode: plan.mode,
        lastThreadId: ctx.threadId,
        lastCwd: root,
        model: plan.model || null,
        sandbox: opts.sandbox,
        taskSha256: task.sha256,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[Codex Bridge] state write failed: ${e.message}`);
    }
  };
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      consumeLine(line, ctx, opts.verbose);
      if (ctx.threadId && ctx.threadId !== savedThreadId) {
        savedThreadId = ctx.threadId;
        persist("dispatching");
      }
    }
  });
  child.stderr.on("data", (c) => { stderr += c; });

  child.stdin.on("error", () => {});
  child.stdin.write(task.text, "utf8");
  child.stdin.end();

  let timedOut = false;
  let timer, guard;
  const code = await new Promise((resolve) => {
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

  if (buf.trim()) consumeLine(buf, ctx, opts.verbose);
  const verdict = evaluateTerminalState({ exitCode: code, timedOut, ctx });
  persist(verdict.ok ? "completed" : "uncertain");

  const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));
  writeAtomicJson(resultFile, {
    ok: verdict.ok,
    reason: verdict.reason,
    mode: plan.mode,
    threadId: ctx.threadId || null,
    cwd: root,
    requestedModel: plan.model || null,
    elapsedSec: elapsed,
    usage: ctx.usage,
    toolsCalled: ctx.toolsCalled,
    taskSha256: task.sha256,
    reply: ctx.lastMessage || "",
    updatedAt: new Date().toISOString(),
  });

  console.log(`[Codex Bridge] thread=${ctx.threadId || "(none)"} elapsed=${elapsed}s exit=${code} turnCompleted=${ctx.turnCompleted}`);
  if (ctx.usage) console.log(`[Codex Bridge] usage: in=${ctx.usage.input_tokens} cached=${ctx.usage.cached_input_tokens ?? 0} out=${ctx.usage.output_tokens}`);
  console.log(`\n=== [Codex Reply] ===\n${ctx.lastMessage || "(no agent_message captured)"}\n`);

  if (!verdict.ok) {
    const noise = stderr.split(/\r?\n/).filter((l) => l && !/^\s*$/.test(l) && !/^WARNING:/.test(l) && !/thread writer lock/i.test(l));
    throw new Error(`${verdict.reason}${noise.length ? " | " + noise.slice(-4).join(" | ") : ""}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const root = resolveCwd(opts, process.cwd());
  const defaultState = opts.state
    ? path.resolve(process.cwd(), opts.state)
    : (fs.existsSync(path.join(root, ".codex-bridge-state.json"))
        ? path.join(root, ".codex-bridge-state.json")
        : path.join(root, "private", "codex-bridge", "state.json"));
  const bin = findCodexBin();
  const plan = buildExecutionPlan(opts, defaultState);

  if (opts.status) return cmdStatus(bin, opts, root, defaultState, plan);
  if (opts.models) return cmdModels(plan);
  return dispatch(bin, opts, root, defaultState, plan);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[Codex Bridge Error]", e.message || e);
    process.exit(1);
  });
}
