import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, readTask, extractReply, validateReuse, CdpClient, readTargets, availableModels, switchSessionModel } from './dispatch-workbuddy.mjs';

test('rejects unknown, duplicate, missing and invalid arguments before sending', () => {
  for (const args of [['--prompt', 'x'], ['--port', '0'], ['--timeout', 'NaN'], ['--timeout', '-1'], ['--mode', 'bypass'], ['--file'], ['--reuse', '--reuse'], ['--status', '--file', 'x'], ['--models', '--file', 'x'], ['--models', '--status']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--file', '中文 工单.md', '--allow-debug']).file, '中文 工单.md');
  assert.equal(parseArgs(['--models']).models, true);
  assert.equal(parseArgs(['--reuse', '--model', 'hy3', '--file', 'task.md']).model, 'hy3');
});
test('reads UTF-8 with BOM; rejects malformed, empty and oversized task files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-bridge-'));
  const f = path.join(dir, 'task.md');
  try {
    fs.writeFileSync(f, '\uFEFF中文测试'); assert.equal(readTask(f).text, '中文测试');
    fs.writeFileSync(f, Buffer.from([0xff])); assert.throws(() => readTask(f));
    fs.writeFileSync(f, ' \n'); assert.throws(() => readTask(f), /empty/);
    fs.writeFileSync(f, Buffer.alloc(1024 * 1024 + 1)); assert.throws(() => readTask(f), /1 MiB/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('does not report success for missing output, cancellation, truncation or failure', () => {
  const good = { stopReason: 'end_turn', _meta: { 'codebuddy.ai/outcome': 'SUCCESS', 'codebuddy.ai': { lastAssistantText: '真实完成' } } };
  assert.equal(extractReply(good), '真实完成');
  for (const stopReason of ['cancelled', 'max_tokens', undefined]) assert.throws(() => extractReply({ ...good, stopReason }));
  assert.throws(() => extractReply({ stopReason: 'end_turn' }));
  assert.throws(() => extractReply({ ...good, _meta: { ...good._meta, 'codebuddy.ai/outcome': 'ERROR' } }));
});
test('reuse requires owned session, exact canonical workspace and completed previous task', () => {
  const state = { schema: 1, workspace: '/project', sessionId: 'ours', ownedSessions: ['ours'], phase: 'completed' };
  assert.equal(validateReuse(state, '/project'), 'ours');
  assert.throws(() => validateReuse(state, '/other'));
  assert.throws(() => validateReuse({ ...state, sessionId: 'user-chat' }, '/project'));
  assert.throws(() => validateReuse({ ...state, phase: 'uncertain' }, '/project'));
});
test('refuses remote or mismatched WebSocket destinations', async () => {
  for (const url of ['ws://example.com:48173/devtools/page/a', 'ws://127.0.0.1:10/devtools/page/a', 'wss://127.0.0.1:48173/devtools/page/a', 'ws://127.0.0.1:48173/other']) await assert.rejects(CdpClient.connect({ webSocketDebuggerUrl: url }, 48173), /non-local/);
});
test('CDP correlates out-of-order replies, passes native caller context and handles exceptions', async () => {
  class FakeSocket extends EventTarget {
    sent = [];
    send(s) { this.sent.push(JSON.parse(s)); }
    close() {}
    reply(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  }
  const socket = new FakeSocket(), client = new CdpClient(socket);
  const a = client.invoke('session:get', ['id']), b = client.evaluate('1+1');
  assert.match(socket.sent[0].params.expression, /undefined/);
  socket.reply({ id: 2, result: { result: { value: 2 } } });
  socket.reply({ id: 1, result: { result: { value: { sessionId: 'id' } } } });
  assert.equal(await b, 2); assert.deepEqual(await a, { sessionId: 'id' });
  const bad = client.evaluate('throw 1'); socket.reply({ id: 3, result: { exceptionDetails: { text: 'failed' } } });
  await assert.rejects(bad, /failed/);
  const rejected = client.invoke('unknown'); socket.reply({ id: 4, result: { result: { value: { __wbError: true, message: 'Native rejected' } } } });
  await assert.rejects(rejected, /Native rejected/); client.close();
});

test('model registry filters disabled/non-CLI models and does not expose config secrets', () => {
  const config = { secret: 'do not expose', agents: [{ name: 'cli', models: ['hy4free', 'hy4std', 'hy3'] }], models: [
    { id: 'hy4free', name: 'Hy4', credits: 'x0.00', secret: 'do not expose' },
    { id: 'hy4std', name: 'Hy4', disabled: true }, { id: 'hy3', name: 'Hy3' }, { id: 'other', name: 'Other' }
  ] };
  assert.deepEqual(availableModels(config), [{ id: 'hy4free', name: 'Hy4', credits: 'x0.00' }, { id: 'hy3', name: 'Hy3' }]);
  assert.throws(() => availableModels({ models: config.models }), /unavailable/);
});

test('same-session switch updates both saved configuration and loaded runtime before confirming', async () => {
  const calls = [], client = { invoke: async (channel, args) => { calls.push({ channel, args }); return channel === 'wb:conversations:get' ? { configManager: { model: 'hy3' } } : {}; } };
  assert.equal(await switchSessionModel(client, 'ours', 'hy3'), 'hy3');
  assert.deepEqual(calls, [
    { channel: 'wb:conversations:configSetModel', args: ['ours', 'hy3'] },
    { channel: 'session:setModel', args: ['ours', 'hy3'] },
    { channel: 'wb:conversations:get', args: ['ours'] }
  ]);
});

test('does not declare model-switch success when runtime rejects or config disagrees', async () => {
  const rejectRuntime = { invoke: async channel => { if (channel === 'session:setModel') throw Error('runtime rejected'); return {}; } };
  await assert.rejects(switchSessionModel(rejectRuntime, 'ours', 'hy3'), /runtime rejected/);
  const mismatch = { invoke: async () => ({ configManager: { model: 'hy4free' } }) };
  await assert.rejects(switchSessionModel(mismatch, 'ours', 'hy3'), /did not confirm/);
});
test('absolute timeout and connection close reject pending calls without retrying', async () => {
  class FakeSocket extends EventTarget { sent = 0; send() { this.sent++; } close() {} }
  const socket = new FakeSocket(), client = new CdpClient(socket);
  await assert.rejects(client.call('Runtime.evaluate', {}, 5), /Do not resend/);
  assert.equal(socket.sent, 1);
  const pending = client.call('Runtime.evaluate', {});
  socket.dispatchEvent(new Event('close'));
  await assert.rejects(pending, /closed/); assert.equal(client.pending.size, 0);
});
test('discovery selects only WorkBuddy main renderer and never redirects', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify([
      { type: 'page', url: 'file:///D:/workbuddy/WorkBuddyAI/resources/app.asar/renderer/index.html' },
      { type: 'page', url: 'https://example.com/app.asar/renderer/index.html' },
      { type: 'page', url: 'file:///tmp/renderer/index.html' },
      { type: 'webview', url: 'file:///D:/workbuddy/WorkBuddyAI/resources/app.asar/renderer/index.html' }
    ]));
  };
  try { assert.equal((await readTargets(48173)).length, 1); }
  finally { globalThis.fetch = original; }
});
