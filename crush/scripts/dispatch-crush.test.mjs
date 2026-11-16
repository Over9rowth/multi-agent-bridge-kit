#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildCrushConfig,
  buildRunArgs,
  evaluateTerminalState,
  parseArgs,
  parseSessionDetail,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-crush.mjs";

test("1. parseArgs defaults & conflicts", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.provider, "bigmodel");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crush-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv sets CRUSH_GLOBAL_CONFIG & buildCrushConfig keeps $ENV indirection", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const envRes = buildChildEnv(opts, "C:\\tmp\\crush-cfg", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.env.CRUSH_GLOBAL_CONFIG, "C:\\tmp\\crush-cfg");
  assert.equal(envRes.env.HTTP_PROXY, undefined);

  const cfg = buildCrushConfig({ provider: "bigmodel", baseUrl: envRes.baseUrl, keyEnvVar: envRes.keyEnvVar, model: "glm-4.7" });
  assert.equal(cfg.providers.bigmodel.api_key, "$ZAI_API_KEY");
});

test("5. buildRunArgs includes -y on --write & -s on reuse", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const args = buildRunArgs(opts, "D:\\proj", "D:\\data", "sid-1", "glm-4.7");
  assert.deepEqual(args, ["run", "-c", "D:\\proj", "-D", "D:\\data", "-m", "bigmodel/glm-4.7", "-q", "-y", "-s", "sid-1"]);
});

test("6. parseSessionDetail & evaluateTerminalState validate end_turn & non-empty reply", () => {
  const detail = parseSessionDetail(JSON.stringify({
    meta: { id: "cr-1", prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    messages: [
      { role: "assistant", provider: "bigmodel", model: "glm-4.7", parts: [{ type: "tool_call", name: "write" }, { type: "text", text: "CRUSH_DONE" }, { type: "finish", reason: "end_turn" }] },
    ],
  }));
  assert.equal(detail.sessionId, "cr-1");
  assert.equal(detail.observedModel, "bigmodel/glm-4.7");
  assert.deepEqual(detail.toolsCalled, ["write"]);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, stdoutText: "CRUSH_DONE", sessionDetail: detail }).ok, true);

  detail.lastFinishReason = "tool_use";
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, stdoutText: "CRUSH_DONE", sessionDetail: detail }).ok, false);
});
