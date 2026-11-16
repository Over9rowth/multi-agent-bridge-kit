#!/usr/bin/env node
/**
 * Gemini CLI Local Bridge 离线单元测试（不连接网络、不消耗配额）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildExecArgs,
  consumeStreamJsonLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  resolveModelId,
  validateShortAsciiPrompt,
} from "./dispatch-gemini.mjs";

const SAMPLE_MODELS = [
  { id: "gemini-4-argon", name: "gemini-4-argon" },
  { id: "gemini-4-carbon", name: "gemini-4-carbon" },
  { id: "gemini-3.5-flash", name: "gemini-3.5-flash" },
];

test("1. parseArgs enforces safety defaults and rejects conflicts", () => {
  const def = parseArgs(["--file", "TASK.md"]);
  assert.equal(def.approvalMode, "default");
  assert.equal(def.withExtensions, false);

  const yolo = parseArgs(["--write", "--file", "TASK.md"]);
  assert.equal(yolo.approvalMode, "yolo");

  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both --file and --prompt/);
  assert.throws(() => parseArgs(["--reuse", "--session", "123"]), /Cannot pass both --reuse and --session/);
  assert.throws(() => parseArgs(["--approval-mode", "bad"]), /Invalid --approval-mode/);
});

test("2. validateShortAsciiPrompt rejects non-ASCII and >= 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文工单"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM and computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单内容", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单内容");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. resolveModelId rejects unknown models pre-dispatch", () => {
  assert.equal(resolveModelId(SAMPLE_MODELS, "gemini-4-argon"), "gemini-4-argon");
  assert.throws(() => resolveModelId(SAMPLE_MODELS, "fake-model"), /not in Gemini CLI discovered models/);
});

test("5. buildExecArgs disables extensions by default and sets stream-json", () => {
  const opts = parseArgs(["--model", "gemini-4-argon", "--approval-mode", "plan", "--file", "T.md"]);
  const args = buildExecArgs(opts, "sid-123", "gemini-4-argon");
  assert.deepEqual(args, ["--resume", "sid-123", "-p", "", "-m", "gemini-4-argon", "-e", "none", "--approval-mode", "plan", "--skip-trust", "-o", "stream-json"]);
});

test("6. consumeStreamJsonLine concatenates delta assistant chunks and extracts stats.models", () => {
  const ctx = { sessionId: "", initModel: "", assistantText: "", tools: [], resultStatus: null, resultError: null, stats: null, observedModels: [], nonJsonLines: [] };
  consumeStreamJsonLine(JSON.stringify({ type: "init", session_id: "s-1", model: "gemini-3.5-flash" }), ctx);
  consumeStreamJsonLine(JSON.stringify({ type: "message", role: "assistant", content: "343_", delta: true }), ctx);
  consumeStreamJsonLine(JSON.stringify({ type: "message", role: "assistant", content: "ok", delta: true }), ctx);
  consumeStreamJsonLine(JSON.stringify({ type: "result", status: "success", stats: { models: { "gemini-4-argon": { total_tokens: 100 } } } }), ctx);

  assert.equal(ctx.sessionId, "s-1");
  assert.equal(ctx.assistantText, "343_ok");
  assert.deepEqual(ctx.observedModels, ["gemini-4-argon"]);

  const v = evaluateTerminalState({ exitCode: 0, timedOut: false, ctx, requestedModel: "gemini-3.5-flash" });
  assert.equal(v.ok, true);
  assert.match(v.routedModelMismatch, /observed=gemini-4-argon/);
});

test("7. evaluateTerminalState rejects interactive auth prompt even on exitCode=0", () => {
  const ctx = {
    sessionId: "",
    initModel: "",
    assistantText: "",
    tools: [],
    resultStatus: null,
    resultError: null,
    stats: null,
    observedModels: [],
    nonJsonLines: ["Opening authentication page in your browser. Do you want to continue? [Y/n]:"],
  };
  const v = evaluateTerminalState({ exitCode: 0, timedOut: false, ctx, requestedModel: "gemini-4-argon" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /interactive browser authentication/);
});
