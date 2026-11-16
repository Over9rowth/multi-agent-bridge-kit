#!/usr/bin/env node
/**
 * Claude Code Local Bridge 离线单元测试（无网络请求、无真实凭据）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildExecArgs,
  consumeStreamJsonLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-claude.mjs";

test("1. parseArgs defaults & --write / conflict validation", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.permissionMode, "default");
  assert.equal(def.withUserConfig, false);

  const w = parseArgs(["--write", "--file", "T.md"]);
  assert.equal(w.permissionMode, "bypassPermissions");

  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both --file and --prompt/);
  assert.throws(() => parseArgs(["--reuse", "--session", "s1"]), /Cannot pass both --reuse and --session/);
  assert.throws(() => parseArgs(["--permission-mode", "bad"]), /Invalid --permission-mode/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文工单"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM and computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单内容", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单内容");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv maps ZAI_API_KEY to BigModel Anthropic endpoint & disables traffic", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const res = buildChildEnv(opts, { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(res.hasKey, true);
  assert.equal(res.keySourceVar, "ZAI_API_KEY");
  assert.equal(res.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(res.resolvedModel, "glm-4.7");
  assert.equal(res.env.ANTHROPIC_API_KEY, "dummy-id.dummy-secret");
  assert.equal(res.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(res.env.HTTP_PROXY, undefined);
});

test("5. buildExecArgs uses --bare by default and supports --resume", () => {
  const opts = parseArgs(["--write", "--model", "glm-5.3", "--file", "T.md"]);
  const args = buildExecArgs(opts, "sid-123", "glm-5.3");
  assert.deepEqual(args, [
    "-p", "--bare", "--resume", "sid-123", "--model", "glm-5.3",
    "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose",
  ]);
});

test("6. consumeStreamJsonLine & evaluateTerminalState reject denials and capture modelUsage", () => {
  const ctx = {
    sessionId: "", initModel: null, observedModel: null, apiKeySource: null,
    lastAssistantText: "", resultText: "", resultSubtype: null, isError: false,
    resultError: null, usage: null, modelUsage: null, toolsCalled: [], permissionDenials: [],
  };
  consumeStreamJsonLine(JSON.stringify({ type: "system", subtype: "init", session_id: "c-1", model: "glm-4.7" }), ctx);
  consumeStreamJsonLine(JSON.stringify({ type: "assistant", message: { model: "glm-4.7", content: [{ type: "tool_use", name: "Edit" }] } }), ctx);
  consumeStreamJsonLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "CLAUDE_DONE", modelUsage: { "glm-4.7": { inputTokens: 10 } }, permission_denials: [] }), ctx);

  assert.equal(ctx.sessionId, "c-1");
  assert.equal(ctx.observedModel, "glm-4.7");
  assert.deepEqual(ctx.toolsCalled, ["Edit"]);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, true);

  ctx.permissionDenials = [{ tool_name: "Bash" }];
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, false);
});
