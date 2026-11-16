#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildRunArgs,
  consumeStreamJsonLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-goose.mjs";

test("1. parseArgs defaults & conflicts", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.provider, "openai");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goose-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv sets isolated GOOSE_PATH_ROOT & disables keyring", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const envRes = buildChildEnv(opts, "C:\\tmp\\goose-home", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.env.GOOSE_DISABLE_KEYRING, "true");
  assert.equal(envRes.env.GOOSE_MODE, "auto");
  assert.equal(envRes.env.OPENAI_HOST, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(envRes.env.OPENAI_BASE_PATH, "chat/completions");
  assert.equal(envRes.env.HTTP_PROXY, undefined);
});

test("5. buildRunArgs includes --with-builtin developer on --write & --resume --session-id", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const args = buildRunArgs(opts, "20261116_1", "glm-4.7");
  assert.ok(args.includes("developer"));
  assert.ok(args.includes("--resume"));
  assert.ok(args.includes("20261116_1"));
});

test("6. consumeStreamJsonLine accumulates chunked text by message.id & requires complete", () => {
  const ctx = { observedModel: null, msgTexts: new Map(), lastMsgId: "", toolsCalled: [], errors: [], completed: false, usage: null };
  consumeStreamJsonLine(JSON.stringify({ type: "message", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "GOOSE_" }], metadata: { inference: { provider: "openai", requestedModel: "glm-4.7" } } } }), ctx);
  consumeStreamJsonLine(JSON.stringify({ type: "message", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "OK" }], metadata: { inference: { provider: "openai", requestedModel: "glm-4.7" } } } }), ctx);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, false);
  consumeStreamJsonLine(JSON.stringify({ type: "complete", total_tokens: 100 }), ctx);
  const verdict = evaluateTerminalState({ exitCode: 0, timedOut: false, ctx });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.finalText, "GOOSE_OK");
});
