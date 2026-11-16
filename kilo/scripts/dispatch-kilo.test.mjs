#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildKiloConfigContent,
  buildRunArgs,
  consumeJsonlLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-kilo.mjs";

test("1. parseArgs defaults & conflicts", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.provider, "bigmodel");
  assert.equal(def.pure, true);
  assert.equal(def.write, false);
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both/);
  assert.throws(() => parseArgs(["--reuse", "--session", "s1"]), /Cannot pass both/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM & computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv uses KILO_CONFIG_CONTENT with {env:...} indirection", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const envRes = buildChildEnv(opts, { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.env.HTTP_PROXY, undefined);
  const cfg = JSON.parse(buildKiloConfigContent({ provider: "bigmodel", baseUrl: envRes.baseUrl, keyEnvVar: envRes.keyEnvVar, model: "glm-4.7" }));
  assert.equal(cfg.provider.bigmodel.options.apiKey, "{env:ZAI_API_KEY}");
  assert.doesNotMatch(envRes.env.KILO_CONFIG_CONTENT, /dummy-secret/);
});

test("5. buildRunArgs includes --pure, --auto on --write & -s on reuse", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const args = buildRunArgs(opts, "D:\\proj", "ses_1", "glm-4.7");
  assert.deepEqual(args, ["run", "--format", "json", "--dir", "D:\\proj", "--pure", "--auto", "--model", "bigmodel/glm-4.7", "-s", "ses_1"]);
});

test("6. consumeJsonlLine & evaluateTerminalState reject tool-calls end & require stop", () => {
  const ctx = { sessionId: "", stepCount: 0, toolsCalled: [], lastText: "", lastFinishReason: null, tokens: null, errors: [] };
  consumeJsonlLine(JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { tool: "write", state: { status: "completed" } } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { reason: "tool-calls" } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "KILO_DONE" } }), ctx);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, false);

  consumeJsonlLine(JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { reason: "stop" } }), ctx);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, true);
});
