#!/usr/bin/env node
/**
 * GitHub Copilot CLI Local Bridge 离线单元测试
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildExecArgs,
  consumeJsonlLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-copilot.mjs";

test("1. parseArgs defaults & validation", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.providerType, "anthropic");
  assert.equal(def.offline, true);
  assert.equal(def.write, false);

  assert.throws(() => parseArgs(["--provider-type", "invalid"]), /Invalid --provider-type/);
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both/);
  assert.throws(() => parseArgs(["--reuse", "--session", "s1"]), /Cannot pass both/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM & computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv sets BYOK anthropic GLM env & COPILOT_OFFLINE", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const res = buildChildEnv(opts, "C:\\tmp\\copilot-home", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTPS_PROXY: "http://127.0.0.1:7897" });
  assert.equal(res.hasKey, true);
  assert.equal(res.env.COPILOT_OFFLINE, "true");
  assert.equal(res.env.COPILOT_PROVIDER_TYPE, "anthropic");
  assert.equal(res.env.COPILOT_PROVIDER_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(res.env.COPILOT_PROVIDER_API_KEY, "dummy-id.dummy-secret");
  assert.equal(res.env.COPILOT_MODEL, "glm-4.7");
  assert.equal(res.env.HTTPS_PROXY, undefined);
});

test("5. buildExecArgs handles --write & --resume", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const args = buildExecArgs(opts, "uuid-1", "glm-4.7", "hello");
  assert.deepEqual(args, ["--no-auto-update", "--output-format", "json", "--allow-all", "--model", "glm-4.7", "--resume=uuid-1", "-p", "hello"]);
});

test("6. consumeJsonlLine & evaluateTerminalState require isByok & non-empty content", () => {
  const ctx = {
    sessionId: "", observedModel: null, isByok: null, modelResult: null,
    lastAssistantText: "", toolsCalled: [], sessionErrors: [], resultExitCode: null, usage: null,
  };
  consumeJsonlLine(JSON.stringify({ type: "assistant.message", data: { model: "glm-4.7", content: "COPILOT_DONE", toolRequests: [{ name: "create" }] } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "model.call_final_result", data: { model: "glm-4.7", isByok: true, result: "success" } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "result", sessionId: "s-9", exitCode: 0, usage: { premiumRequests: 0 } }), ctx);

  assert.equal(ctx.sessionId, "s-9");
  assert.equal(ctx.isByok, true);
  assert.deepEqual(ctx.toolsCalled, ["create"]);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, true);

  ctx.sessionErrors.push("auth failed");
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, false);
});
