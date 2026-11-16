#!/usr/bin/env node
// WorkBuddy 5.9.4 desktop bridge. Node >=22; no third-party dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function parseArgs(args) {
  const o = { port: 48173, timeout: 600, mode: 'craft' };
  const values = new Set(['--file', '--workspace', '--port', '--timeout', '--model', '--mode', '--state']);
  const flags = new Set(['--help', '--status', '--models', '--reuse', '--dry-run', '--allow-debug']);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw Error(`Duplicate option: ${key}`);
    seen.add(key);
    if (flags.has(key)) o[key.slice(2)] = true;
    else if (values.has(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value: ${key}`);
      o[key.slice(2)] = args[++i];
    } else throw Error(`Unknown option: ${key}`);
  }
  o.port = Number(o.port); o.timeout = Number(o.timeout);
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw Error('Invalid --port');
  if (!Number.isFinite(o.timeout) || o.timeout < 1 || o.timeout > 86400) throw Error('Invalid --timeout (1..86400 seconds)');
  if (!['craft', 'ask', 'plan'].includes(o.mode)) throw Error('Invalid --mode: craft | ask | plan');
  if ((o.status || o.models) && (o.file || o.reuse || o['dry-run'] || (o.status && o.models))) throw Error('--status and --models are separate read-only commands');
  return o;
}

export function readTask(file) {
  const data = fs.readFileSync(file);
  if (data.length > 1024 * 1024) throw Error('Task file exceeds 1 MiB');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '');
  if (!text.trim()) throw Error('Task file is empty');
  return { text, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

export async function readTargets(port) {
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' }); }
  catch { throw Error(`WorkBuddy debug connection unavailable on 127.0.0.1:${port}. Start WorkBuddy with the temporary debug flags; normal launch has no bridge endpoint.`); }
  if (!response.ok) throw Error(`Debug discovery HTTP ${response.status}`);
  const body = await response.text();
  if (Buffer.byteLength(body) > 1024 * 1024) throw Error('Discovery response too large');
  const targets = JSON.parse(body);
  if (!Array.isArray(targets)) throw Error('Invalid debug discovery response');
  // Match the installed WorkBuddy renderer, never an arbitrary web page or document webview.
  return targets.filter(t => t.type === 'page' && /^file:\/\//.test(t.url || '') && /\/app\.asar\/renderer\/index\.html(?:[?#]|$)/.test(t.url));
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      try {
        if (Buffer.byteLength(String(event.data)) > 8 * 1024 * 1024) throw Error('CDP response too large');
        const message = JSON.parse(event.data);
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id); clearTimeout(call.timer);
        if (message.error) call.reject(Error(message.error.message || 'CDP error'));
        else call.resolve(message.result);
      } catch (error) { this.fail(error); socket.close(); }
    });
    socket.addEventListener('close', () => this.fail(Error('WorkBuddy debug connection closed')));
    socket.addEventListener('error', () => this.fail(Error('WorkBuddy debug connection error')));
  }
  fail(error) {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
  }
  static async connect(target, port) {
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || !url.pathname.startsWith('/devtools/page/')) throw Error('Refusing a non-local debug WebSocket');
    const socket = new WebSocket(url);
    const client = new CdpClient(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(Error('Debug connection timeout')); }, 3000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Debug connection failed')); }, { once: true });
    });
    return client;
  }
  call(method, params, timeout = 10000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Timeout waiting for ${method}; task outcome may be unknown. Do not resend automatically.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(expression, timeout) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'WorkBuddy evaluation failed');
    return result.result?.value;
  }
  async invoke(channel, args = [], timeout) {
    // The second argument is caller context, not the first business argument.
    const value = await this.evaluate(`window.__wbInvoke(${JSON.stringify(channel)},undefined,...${JSON.stringify(args)})`, timeout);
    if (value?.__wbError || value?.errorCode) throw Error(value.message || `WorkBuddy rejected ${channel}`);
    return value;
  }
  close() { this.fail(Error('Bridge closed')); this.socket.close(); }
}

export function extractReply(result) {
  const output = result?._meta?.['codebuddy.ai']?.lastAssistantText;
  if (result?.stopReason !== 'end_turn' || (result?._meta?.['codebuddy.ai/outcome'] && result._meta['codebuddy.ai/outcome'] !== 'SUCCESS')) throw Error(`WorkBuddy did not finish successfully: ${result?.stopReason || 'missing stopReason'}`);
  if (typeof output !== 'string' || !output.trim()) throw Error('WorkBuddy returned no final reply; completion is not verified');
  return output;
}

function saveJson(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export function validateReuse(state, workspace) {
  if (!state || state.schema !== 1 || state.workspace !== workspace || !state.sessionId || !state.ownedSessions?.includes(state.sessionId)) throw Error('No bridge-owned session for this workspace; omit --reuse to create one');
  if (state.phase !== 'completed') throw Error(`Previous task is ${state.phase}; inspect it in WorkBuddy before starting a new task. No automatic retry.`);
  return state.sessionId;
}

export function availableModels(config) {
  const agent = config?.agents?.find(a => a.name === 'cli');
  if (!agent || !Array.isArray(agent.models)) throw Error('WorkBuddy CLI model registry is unavailable');
  const ids = new Set(agent.models);
  return (config.models || []).filter(m => typeof m.id === 'string' && ids.has(m.id) && !m.disabled).map(m => ({
    id: m.id, name: m.name || m.id, ...(typeof m.credits === 'string' ? { credits: m.credits } : {})
  }));
}

export async function switchSessionModel(client, sessionId, model) {
  // Saved conversation config alone does not update the already loaded legacy runtime.
  await client.invoke('wb:conversations:configSetModel', [sessionId, model]);
  await client.invoke('session:setModel', [sessionId, model], 60000);
  const confirmed = await client.invoke('wb:conversations:get', [sessionId]);
  if (confirmed?.configManager?.model !== model) throw Error('WorkBuddy did not confirm the requested model after switching');
  return model;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) {
    console.log('WorkBuddy desktop bridge (Node >=22)\n  --status [--port 48173]\n  --models\n  --file TASK.md --allow-debug [--workspace DIR] [--model ID] [--mode craft|ask|plan]\n  --reuse --model ID --file FOLLOWUP.md --allow-debug\n  --file TASK.md --dry-run\n  --timeout SECONDS --state FILE\nUses native default permissions. No auto-approval, credential extraction, service start or deployment.');
    return;
  }
  const workspace = fs.realpathSync(path.resolve(o.workspace || process.cwd()));
  if (!fs.statSync(workspace).isDirectory()) throw Error('--workspace must be a directory');
  const readOnly = o.status || o.models;
  const task = readOnly ? null : readTask(path.resolve(o.file || (() => { throw Error('Missing --file TASK.md'); })()));
  if (o['dry-run']) { console.log(JSON.stringify({ dispatch: false, workspace, bytes: task.bytes, sha256: task.sha256, reuse: !!o.reuse, mode: o.mode, model: o.model || 'WorkBuddy default' }, null, 2)); return; }
  if (!readOnly && !o['allow-debug']) throw Error('Dispatch requires --allow-debug: the temporary local debug connection controls WorkBuddy. Close it after use.');
  const targets = await readTargets(o.port);
  if (targets.length !== 1) throw Error(`Expected one WorkBuddy main renderer; found ${targets.length}. No target was chosen.`);
  const client = await CdpClient.connect(targets[0], o.port);
  let lockFd, stateFile, lockFile;
  try {
    const handshake = await client.evaluate('({invoke:typeof window.__wbInvoke,eventBridge:typeof window.__wbEventBridge,version:window.workbuddyDesktop?.appVersion||null})');
    if (handshake?.invoke !== 'function' || handshake?.eventBridge !== 'function') throw Error('WorkBuddy native IPC is not ready');
    if (o.status) { console.log(JSON.stringify({ connected: true, transport: 'loopback-cdp/native-ipc', port: o.port, version: handshake.version, permissionMode: 'default', model: 'Use --models for current registered IDs' }, null, 2)); return; }
    if (o.models || o.model) {
      const models = availableModels(await client.invoke('config:getProductConfiguration'));
      if (o.models) { console.log(JSON.stringify({ models }, null, 2)); return; }
      if (!models.some(m => m.id === o.model)) throw Error(`Model ID is not available: ${o.model}. Use --models; display labels are not model IDs.`);
    }
    stateFile = path.resolve(o.state || path.join(process.cwd(), 'private', 'workbuddy-bridge', 'state.json'));
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    lockFile = `${stateFile}.lock`;
    try { lockFd = fs.openSync(lockFile, 'wx'); }
    catch { throw Error(`Bridge state is locked: ${lockFile}. Another dispatcher may be running; no automatic lock removal.`); }
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    let sessionId, selectedModel;
    if (o.reuse) {
      if (argv.includes('--mode')) throw Error('--reuse keeps the session mode; start a new session to change it');
      sessionId = validateReuse(previous, workspace);
      const info = await client.invoke('session:get', [sessionId]);
      if (!info || fs.realpathSync(info.cwd) !== workspace) throw Error('Saved session is missing or belongs to a different workspace');
      if (o.model) {
        saveJson(stateFile, { ...previous, phase: 'switching-model', requestedModel: o.model, updatedAt: new Date().toISOString() });
        selectedModel = await switchSessionModel(client, sessionId, o.model);
        console.log(`[WorkBuddy Bridge] Model switched: ${selectedModel}`);
      } else selectedModel = (await client.invoke('wb:conversations:get', [sessionId]))?.configManager?.model;
      console.log(`[WorkBuddy Bridge] Reusing session: ${sessionId}`);
    } else {
      sessionId = `wb-bridge-${randomUUID()}`;
      const created = await client.invoke('wb:conversations:create', [{ conversationId: sessionId, cwd: workspace, title: 'WorkBuddy Bridge', transport: 'local', mode: o.mode, permissionMode: 'default', isPlayground: false, ...(o.model ? { model: o.model } : {}) }], 60000);
      if (created?.info?.id !== sessionId) throw Error(created?.message || 'WorkBuddy did not confirm the requested new session');
      if (o.model && created.configManager?.model !== o.model) throw Error('WorkBuddy did not confirm the requested model');
      selectedModel = created.configManager?.model;
      console.log(`[WorkBuddy Bridge] New session: ${sessionId}`);
    }
    console.log(`[WorkBuddy Bridge] Configured model: ${selectedModel || 'WorkBuddy default'}`);
    const state = { schema: 1, workspace, sessionId, model: selectedModel || null, ownedSessions: [...new Set([...(previous?.ownedSessions || []), sessionId])], phase: 'dispatching', sha256: task.sha256, updatedAt: new Date().toISOString() };
    saveJson(stateFile, state);
    try {
      console.log('[WorkBuddy Bridge] Dispatching UTF-8 task; native permission prompts remain enabled.');
      const result = await client.invoke('session:sendMessage', [sessionId, [{ type: 'text', text: task.text }]], o.timeout * 1000);
      const output = extractReply(result);
      const report = { sessionId, workspace, configuredModel: selectedModel || null, taskSha256: task.sha256, stopReason: result.stopReason, output, completedAt: new Date().toISOString() };
      saveJson(path.join(path.dirname(stateFile), 'last-result.json'), report);
      saveJson(stateFile, { ...state, phase: 'completed', updatedAt: report.completedAt });
      console.log(`\n=== WorkBuddy Reply ===\n${output}`);
    } catch (error) {
      saveJson(stateFile, { ...state, phase: 'uncertain', updatedAt: new Date().toISOString() });
      throw error;
    }
  } finally {
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lockFile); }
    client.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[WorkBuddy Bridge Error] ${error.message}`); process.exitCode = 1; });
}
