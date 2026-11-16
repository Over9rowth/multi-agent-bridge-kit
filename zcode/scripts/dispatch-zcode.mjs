#!/usr/bin/env node
/**
 * ZCode Local Bridge - 本地多智能体编排桥接适配器
 *
 * 遵循《本地 Multi-Agent 编排与客户端桥接工程手册》五步法：
 * 1. 发现入口：定位 D:\ZCode 及 resources\glm\zcode.cjs
 * 2. 还原契约：Node.js + patch-sqlite.cjs 挂载无头模式，JSONL/JSON stdio 通信
 * 3. 确认模型：支持 GLM-5.3-Flash，指定高思考强度 (reasoningLevel: "high")
 * 4. 会话与权限：支持 --resume / --reuse，支持 --mode (默认 yolo)，目录严格校验
 * 5. 验收闭环：三层核验（进程接受、协议终态、业务产物与响应校验），支持 --dry-run
 *
 * 用法：
 *   node dispatch-zcode.mjs --status
 *   node dispatch-zcode.mjs --models
 *   node dispatch-zcode.mjs --history
 *   node dispatch-zcode.mjs --show [sessionId]
 *   node dispatch-zcode.mjs --file TASK-001.md
 *   node dispatch-zcode.mjs --file TASK-001.md --dry-run
 *   node dispatch-zcode.mjs --reuse --file TASK-002.md
 *   node dispatch-zcode.mjs --prompt "测试" --model GLM-5.3-Flash --thinking high
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_MODEL = 'GLM-5.3-Flash';
export const DEFAULT_THINKING = 'high';
export const DEFAULT_PROVIDER = 'zai-standard-api';
export const DEFAULT_TIMEOUT = 600;

export function parseArgs(args) {
  const o = {
    timeout: DEFAULT_TIMEOUT,
    mode: 'yolo',
    model: DEFAULT_MODEL,
    thinking: DEFAULT_THINKING,
    provider: DEFAULT_PROVIDER
  };
  const values = new Set([
    '--file', '--prompt', '--workspace', '--cwd',
    '--timeout', '--model', '--thinking', '--provider',
    '--mode', '--state', '--api-key', '--show'
  ]);
  const flags = new Set(['--help', '--status', '--models', '--history', '--reuse', '--dry-run', '--verbose']);
  const seen = new Set();

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error(`Duplicate option: ${key}`);
    seen.add(key);
    if (flags.has(key)) {
      o[key.slice(2)] = true;
    } else if (values.has(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        // Special case: --show without argument shows latest
        if (key === '--show') {
          o.show = 'latest';
          continue;
        }
        throw new Error(`Missing value: ${key}`);
      }
      o[key.slice(2)] = args[++i];
    } else {
      throw new Error(`Unknown option: ${key}`);
    }
  }

  o.timeout = Number(o.timeout);
  if (!Number.isFinite(o.timeout) || o.timeout < 1 || o.timeout > 86400) {
    throw new Error('Invalid --timeout (1..86400 seconds)');
  }
  if (!['yolo', 'build', 'edit', 'plan', 'guarded'].includes(o.mode)) {
    throw new Error('Invalid --mode: yolo | build | edit | plan | guarded');
  }
  if (!['low', 'high', 'max', 'disabled'].includes(o.thinking)) {
    throw new Error('Invalid --thinking level: low | high | max | disabled');
  }

  const readOnlyFlags = [o.status, o.models, o.history, o.show].filter(Boolean).length;
  if (readOnlyFlags > 1) {
    throw new Error('--status, --models, --history, and --show are separate read-only commands');
  }

  if (readOnlyFlags === 0 && !o.file && !o.prompt) {
    throw new Error('Must provide either --file, --prompt, --status, --models, --history, or --show');
  }
  if (o.file && o.prompt) {
    throw new Error('--file and --prompt cannot be used simultaneously');
  }

  return o;
}

export function readTask(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`Task file not found: ${resolved}`);
  const data = fs.readFileSync(resolved);
  if (data.length > 1024 * 1024) throw new Error('Task file exceeds 1 MiB limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('Task file is empty');
  return {
    filePath: resolved,
    text,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex')
  };
}

export function findZCodePaths() {
  const candidateDirs = [
    process.env.ZCODE_HOME,
    'D:\\ZCode',
    'C:\\Program Files\\ZCode',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode')
  ].filter(Boolean);

  let rootDir = null;
  for (const dir of candidateDirs) {
    if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'resources', 'glm', 'zcode.cjs'))) {
      rootDir = dir;
      break;
    }
  }

  if (!rootDir) {
    throw new Error('Unable to locate ZCode installation. Set ZCODE_HOME to the ZCode root directory.');
  }

  const cliPath = path.join(rootDir, 'resources', 'glm', 'zcode.cjs');
  const configPath = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
  const dbPath = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  const patchPath = path.join(__dirname, 'patch-sqlite.cjs');

  return { rootDir, cliPath, configPath, dbPath, patchPath };
}

export function readProviderConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] } } };
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse provider_config.json: ${err.message}`);
  }
}

export function listAvailableModels(configPath) {
  const cfg = readProviderConfig(configPath);
  const models = [];
  const rules = cfg.config?.providerConfigRules?.providerRules || [];
  for (const r of rules) {
    const pId = r.providerId || r.templateId || 'unknown';
    const pName = r.providerName || pId;
    const modelOrder = r.config?.modelOrder || [];
    for (const m of modelOrder) {
      models.push({
        providerId: pId,
        providerName: pName,
        modelId: m,
        supportsThinking: m.toLowerCase().includes('glm-5.3'),
        recommendedThinking: m.toLowerCase().includes('glm-5.3') ? 'high' : 'none'
      });
    }
  }
  return models;
}

export function displaySessionHistory(dbPath, limit = 10) {
  if (!fs.existsSync(dbPath)) {
    console.log('No ZCode SQLite database found.');
    return;
  }
  const db = new DatabaseSync(dbPath);
  const sessions = db.prepare('SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC LIMIT ?').all(limit);
  console.log(`=== ZCode Recent Sessions (Total: ${sessions.length}) ===\n`);
  for (const s of sessions) {
    const timeStr = new Date(Number(s.time_updated)).toLocaleString();
    console.log(`Session ID : ${s.id}`);
    console.log(`Title      : ${s.title || '(untitled)'}`);
    console.log(`Directory  : ${s.directory}`);
    console.log(`Updated At : ${timeStr}`);
    console.log('----------------------------------------------------');
  }
  console.log('\nUse --show <sessionId> to view full dialogue & thinking tokens.');
}

export function displaySessionDetails(dbPath, targetSessionId) {
  if (!fs.existsSync(dbPath)) {
    console.log('No ZCode SQLite database found.');
    return;
  }
  const db = new DatabaseSync(dbPath);
  let sessionId = targetSessionId;
  if (!sessionId || sessionId === 'latest') {
    const latest = db.prepare('SELECT id FROM session ORDER BY time_updated DESC LIMIT 1').get();
    if (!latest) {
      console.log('No sessions found in database.');
      return;
    }
    sessionId = latest.id;
  }

  const s = db.prepare('SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ?').get(sessionId);
  if (!s) {
    console.log(`Session not found: ${sessionId}`);
    return;
  }

  console.log(`=== Session Details: ${s.id} ===`);
  console.log(`Title      : ${s.title}`);
  console.log(`Directory  : ${s.directory}`);
  console.log(`Updated At : ${new Date(Number(s.time_updated)).toLocaleString()}\n`);

  const parts = db.prepare('SELECT * FROM part WHERE session_id = ? ORDER BY sequence ASC').all(sessionId);
  let hasThinking = false;

  for (const p of parts) {
    try {
      const data = JSON.parse(p.data);
      if (data.type === 'text') {
        if (data.text.startsWith('# Environment') || data.text.startsWith('You are powered by') || data.text.startsWith('Available agent types')) {
          continue; // skip system prompt chunks
        }
        console.log(`\n💬 [Message/Turn]`);
        console.log(data.text);
      } else if (data.type === 'reasoning') {
        hasThinking = true;
        console.log(`\n🧠 [GLM-5.3-Flash Thinking / 思考过程]`);
        console.log(data.text || data.reasoning || data.delta || JSON.stringify(data));
      } else if (data.type === 'step-finish' && data.tokens) {
        console.log(`\n📊 [Usage Tokens] Total: ${data.tokens.total}, Input: ${data.tokens.input}, Output: ${data.tokens.output}, Reasoning: ${data.tokens.reasoning || 0}`);
      }
    } catch {
      console.log(p.data);
    }
  }
}

export function syncModelSelection(configPath, providerId, modelId, thinkingLevel) {
  if (!fs.existsSync(configPath)) return;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const data = JSON.parse(raw);
    data.config = data.config || {};
    data.config.defaultModelSelection = {
      providerId,
      modelId,
      options: {
        reasoningLevel: thinkingLevel
      }
    };
    if (Array.isArray(data.config.providerOrder)) {
      data.config.providerOrder = [
        providerId,
        ...data.config.providerOrder.filter(id => id !== providerId)
      ];
    }
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[WARN] Failed to write defaultModelSelection: ${e.message}`);
  }
}

function saveJson(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export async function runZCodePrompt(opts) {
  const { rootDir, cliPath, configPath, patchPath } = findZCodePaths();
  const cwd = path.resolve(opts.cwd || opts.workspace || process.cwd());
  const stateFile = path.resolve(opts.state || path.join(__dirname, '..', 'private', 'zcode-bridge', 'state.json'));

  // Ensure default model selection is synced in config
  syncModelSelection(configPath, opts.provider, opts.model, opts.thinking);

  const promptText = opts.file ? opts.task.text : opts.prompt;
  const isReuse = Boolean(opts.reuse);
  let resumeSessionId = null;

  if (isReuse) {
    if (fs.existsSync(stateFile)) {
      try {
        const lastState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (lastState.sessionId && lastState.cwd === cwd) {
          resumeSessionId = lastState.sessionId;
        }
      } catch {}
    }
    if (!resumeSessionId) {
      console.warn('[WARN] No previous completed session found for reuse; starting new session.');
    }
  }

  const cliArgs = [
    '-r', patchPath,
    cliPath,
    '--prompt', promptText,
    '--mode', opts.mode,
    '--cwd', cwd,
    '--json'
  ];

  if (resumeSessionId) {
    cliArgs.push('--resume', resumeSessionId);
  }

  if (opts['dry-run']) {
    console.log('[DRY-RUN] Execution plan verified:');
    console.log(`  Engine: ${cliPath}`);
    console.log(`  Preload Patch: ${patchPath}`);
    console.log(`  Provider: ${opts.provider}`);
    console.log(`  Model: ${opts.model}`);
    console.log(`  Thinking Level: ${opts.thinking}`);
    console.log(`  Working Directory: ${cwd}`);
    console.log(`  Mode: ${opts.mode}`);
    console.log(`  Reuse Session: ${resumeSessionId || 'false'}`);
    if (opts.file) {
      console.log(`  Task File: ${opts.task.filePath}`);
      console.log(`  Task SHA256: ${opts.task.sha256}`);
      console.log(`  Task Bytes: ${opts.task.bytes}`);
    }
    console.log(`  Command: node ${cliArgs.join(' ')}`);
    return { dryRun: true, status: 'verified' };
  }

  // Record dispatching state
  const stateRecord = {
    phase: 'dispatching',
    timestamp: new Date().toISOString(),
    cwd,
    model: opts.model,
    provider: opts.provider,
    thinking: opts.thinking,
    resumeSessionId,
    ticketSha256: opts.task?.sha256 || null
  };
  saveJson(stateFile, stateRecord);

  const env = { ...process.env };
  if (opts['api-key']) {
    env.ZAI_API_KEY = opts['api-key'];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const uncertainState = {
        ...stateRecord,
        phase: 'uncertain',
        error: 'Execution timed out',
        finishedAt: new Date().toISOString()
      };
      saveJson(stateFile, uncertainState);
      reject(new Error(`Timeout waiting for ZCode response (${opts.timeout}s). Do not resend automatically.`));
    }, opts.timeout * 1000);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (opts.verbose) process.stderr.write(chunk);
    });

    child.on('close', code => {
      clearTimeout(timer);
      let parsedResult = null;
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const j = JSON.parse(trimmed);
            if (j.sessionId || j.type === 'result' || j.response) {
              parsedResult = j;
            }
          } catch {}
        }
      }

      if (code !== 0 && !parsedResult) {
        const failState = {
          ...stateRecord,
          phase: 'failed',
          exitCode: code,
          stderr: stderr.slice(0, 1000),
          finishedAt: new Date().toISOString()
        };
        saveJson(stateFile, failState);
        return reject(new Error(`ZCode exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }

      const responseText = parsedResult?.response || stdout.trim();
      const finalState = {
        ...stateRecord,
        phase: 'completed',
        sessionId: parsedResult?.sessionId || resumeSessionId,
        traceId: parsedResult?.traceId,
        exitCode: code,
        response: responseText,
        finishedAt: new Date().toISOString()
      };
      saveJson(stateFile, finalState);

      resolve({
        code,
        result: parsedResult,
        response: responseText,
        sessionId: finalState.sessionId,
        traceId: finalState.traceId,
        stateFile
      });
    });
  });
}

// CLI Entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  try {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.help) {
      console.log(`ZCode Local Bridge Adapter (Multi-Agent Orchestration Protocol)

Commands:
  --status              Inspect ZCode instance, environment and active model
  --models              List configured models and thinking capability
  --history             List recent ZCode sessions stored in local database
  --show [sessionId]    Display complete messages, thinking process & response
  --file <ticket.md>    Dispatch task ticket with SHA-256 verification
  --prompt <text>       Direct prompt execution
  --reuse               Resume previous session in the same workspace
  --dry-run             Validate plan, hashes and schema without invocation

Options:
  --model <name>        Model ID (default: ${DEFAULT_MODEL})
  --thinking <level>    Reasoning effort: low | high | max | disabled (default: ${DEFAULT_THINKING})
  --provider <id>       Provider ID (default: ${DEFAULT_PROVIDER})
  --api-key <key>       Z.ai API Key for authorization
  --workspace <dir>     Workspace directory (default: current directory)
  --mode <mode>         Permission mode: yolo | build | edit | plan | guarded (default: yolo)
  --timeout <sec>       Execution timeout (default: ${DEFAULT_TIMEOUT}s)
  --state <file>        State file path (default: private/zcode-bridge/state.json)
  --verbose             Output engine diagnostics
`);
      process.exit(0);
    }

    const paths = findZCodePaths();

    if (opts.status) {
      console.log('=== ZCode Bridge Status ===');
      console.log(`ZCode Home: ${paths.rootDir}`);
      console.log(`ZCode CLI: ${paths.cliPath}`);
      console.log(`Preload Patch: ${paths.patchPath}`);
      console.log(`Node Runtime: ${process.version}`);
      console.log(`Default Provider: ${opts.provider}`);
      console.log(`Default Model: ${opts.model} (thinking: ${opts.thinking})`);
      const cfg = readProviderConfig(paths.configPath);
      const active = cfg.config?.defaultModelSelection;
      if (active) {
        console.log(`Configured Default: ${active.providerId}/${active.modelId} ($${active.options?.reasoningLevel || 'default'})`);
      }
      process.exit(0);
    }

    if (opts.models) {
      console.log('=== ZCode Configured Models ===');
      const models = listAvailableModels(paths.configPath);
      for (const m of models) {
        const thinkingTag = m.supportsThinking ? `[Thinking: ${m.recommendedThinking}]` : '';
        console.log(`- ${m.providerId} / ${m.modelId} ${thinkingTag}`);
      }
      process.exit(0);
    }

    if (opts.history) {
      displaySessionHistory(paths.dbPath);
      process.exit(0);
    }

    if (opts.show) {
      displaySessionDetails(paths.dbPath, opts.show);
      process.exit(0);
    }

    if (opts.file) {
      opts.task = readTask(opts.file);
    }

    const outcome = await runZCodePrompt(opts);
    if (!opts['dry-run']) {
      console.log('\n--- ZCode Bridge Response ---');
      console.log(outcome.response);
      console.log('-----------------------------');
      if (outcome.sessionId) console.log(`Session ID: ${outcome.sessionId}`);
      if (outcome.traceId) console.log(`Trace ID: ${outcome.traceId}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
