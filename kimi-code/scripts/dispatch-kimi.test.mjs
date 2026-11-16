#!/usr/bin/env node
/**
 * Kimi Code CLI Local Bridge 离线单元测试
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildConfigToml,
  buildExecArgs,
  consumeStreamJsonLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-kimi.mjs";

test("1. parseArgs defaults & conflicts", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.providerType, "openai");
  assert.throws(() => parseArgs(["--provider-type", "bad"]), /Invalid --provider-type/);
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both/);
  assert.throws(() => parseArgs(["--reuse", "--session", "s1"]), /Cannot pass both/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM & computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv & buildConfigToml use api_key_env indirection (no plaintext key on disk)", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const envRes = buildChildEnv(opts, "C:\\tmp\\kimi-home", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.keyEnvVar, "ZAI_API_KEY");
  assert.equal(envRes.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(envRes.resolvedModel, "glm-4.7");
  assert.equal(envRes.env.HTTP_PROXY, undefined);

  const toml = buildConfigToml({ providerType: "openai", baseUrl: envRes.baseUrl, keyEnvVar: envRes.keyEnvVar, model: envRes.resolvedModel });
  assert.match(toml, /api_key_env = "ZAI_API_KEY"/);
  assert.doesNotMatch(toml, /dummy-secret/);
});

test("5. buildExecArgs handles -S session resume without -y/-p conflict", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const args = buildExecArgs({ ...opts, cliPath: "main.mjs" }, "session_123", "hello");
  assert.deepEqual(args, ["main.mjs", "--output-format", "stream-json", "-S", "session_123", "-p", "hello"]);
});

test("6. consumeStreamJsonLine & evaluateTerminalState capture session_id & tools", () => {
  const ctx = { sessionId: "", cliVersion: null, lastAssistantText: "", toolsCalled: [], errors: [] };
  consumeStreamJsonLine(JSON.stringify({ role: "meta", type: "system.version", version: "2.6.2" }), ctx);
  consumeStreamJsonLine(JSON.stringify({ role: "assistant", tool_calls: [{ function: { name: "Write" } }] }), ctx);
  consumeStreamJsonLine(JSON.stringify({ role: "assistant", content: "KIMI_DONE" }), ctx);
  consumeStreamJsonLine(JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_abc" }), ctx);

  assert.equal(ctx.sessionId, "session_abc");
  assert.deepEqual(ctx.toolsCalled, ["Write"]);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, true);

  ctx.lastAssistantText = "";
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, false);
});
