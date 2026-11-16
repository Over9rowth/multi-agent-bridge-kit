#!/usr/bin/env node
/**
 * OpenCode Local Bridge 离线单元测试（不连接 OpenCode 服务、不消耗额度）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildRunArgs,
  consumeJsonlLine,
  evaluateTerminalState,
  extractServerVerification,
  parseArgs,
  readUtf8TaskFile,
  resolveAgentId,
  resolveModelSpec,
  validateShortAsciiPrompt,
} from "./dispatch-opencode.mjs";

const SAMPLE_MODELS = [
  {
    id: "gemini-4-carbon",
    modelID: "gemini-4-carbon",
    providerID: "google-vertex",
    name: "Gemini 4 Carbon",
    enabled: true,
    variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
  },
  {
    id: "gemini-3.5-flash",
    modelID: "gemini-3.5-flash",
    providerID: "google-vertex",
    name: "Gemini 3.5 Flash",
    enabled: true,
    variants: [],
  },
  {
    id: "disabled-model",
    modelID: "disabled-model",
    providerID: "google-vertex",
    name: "Disabled",
    enabled: false,
    variants: [],
  },
];

const SAMPLE_AGENTS = [
  { id: "build", name: "Build", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", mode: "primary", hidden: false },
  { id: "compaction", name: "Compaction", mode: "primary", hidden: true },
];

test("1. parseArgs rejects unknown flags, duplicates, and conflicting modes", () => {
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both --file and --prompt/);
  assert.throws(() => parseArgs(["--reuse", "--session", "ses_123"]), /Cannot pass both --reuse and --session/);
  assert.throws(() => parseArgs(["--timeout", "0"]), /Invalid --timeout/);
  assert.throws(() => parseArgs(["--model", "a", "--model", "b"]), /Duplicate flag/);
  const ok = parseArgs(["--reuse", "--file", "TASK.md", "--model", "google-vertex/gemini-3.5-flash", "--timeout", "120"]);
  assert.equal(ok.reuse, true);
  assert.equal(ok.file, "TASK.md");
  assert.equal(ok.timeout, 120);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply with OK"));
  assert.throws(() => validateShortAsciiPrompt("请帮我修改代码"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("a".repeat(80)), />= 80/);
  assert.throws(() => validateShortAsciiPrompt("line1\nline2"), /single-line/);
});

test("3. readUtf8TaskFile strips BOM, validates UTF-8, and computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bridge-test-"));
  const f = path.join(dir, "task.md");
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const body = Buffer.from("测试 UTF-8 工单", "utf8");
  fs.writeFileSync(f, Buffer.concat([bom, body]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "测试 UTF-8 工单");
  assert.equal(res.bytes, bom.length + body.length);
  assert.match(res.sha256, /^[0-9a-f]{64}$/);

  const bad = path.join(dir, "bad.bin");
  fs.writeFileSync(bad, Buffer.from([0xFF, 0xFE, 0xFD]));
  assert.throws(() => readUtf8TaskFile(bad));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. resolveModelSpec & resolveAgentId reject unknown, disabled, or unsupported variants", () => {
  const m1 = resolveModelSpec(SAMPLE_MODELS, "google-vertex/gemini-4-carbon#high");
  assert.equal(m1.canonical, "google-vertex/gemini-4-carbon#high");
  assert.equal(m1.variant, "high");

  const m2 = resolveModelSpec(SAMPLE_MODELS, "gemini-3.5-flash");
  assert.equal(m2.canonical, "google-vertex/gemini-3.5-flash");

  assert.throws(() => resolveModelSpec(SAMPLE_MODELS, "google-vertex/disabled-model"), /not found or disabled/);
  assert.throws(() => resolveModelSpec(SAMPLE_MODELS, "google-vertex/gemini-4-carbon#ultra"), /not supported/);
  assert.throws(() => resolveModelSpec(SAMPLE_MODELS, "unknown-model"), /not found or disabled/);

  assert.equal(resolveAgentId(SAMPLE_AGENTS, "plan"), "plan");
  assert.throws(() => resolveAgentId(SAMPLE_AGENTS, "compaction"), /not found/);
});

test("5. buildChildEnv strips parent session variables", () => {
  const env = buildChildEnv("D:\\OpenCode\\node_modules\\@opencode\\cli\\bin\\opencode.exe", {
    PATH: "C:\\Windows",
    OPENCODE: "1",
    OPENCODE_TERMINAL: "1",
    OPENCODE_SESSION_ID: "ses_parent",
    OPENCODE_CONFIG: "D:\\Custom\\opencode.json",
  });
  assert.equal(env.OPENCODE_SESSION_ID, undefined);
  assert.equal(env.OPENCODE_TERMINAL, undefined);
  assert.equal(env.OPENCODE, undefined);
  assert.equal(env.OPENCODE_CONFIG, "D:\\Custom\\opencode.json");
});

test("6. buildRunArgs constructs expected flags without auto-approve by default", () => {
  const opts = parseArgs(["--archived", "--model", "google-vertex/gemini-3.5-flash", "--title", "test"]);
  const args = buildRunArgs(opts, "", "google-vertex/gemini-3.5-flash");
  assert.deepEqual(args, ["run", "--format", "json", "--model", "google-vertex/gemini-3.5-flash", "--title", "test", "--archived"]);
  assert.equal(args.includes("--auto"), false);

  const reuseArgs = buildRunArgs(opts, "ses_abc", "google-vertex/gemini-3.5-flash");
  assert.equal(reuseArgs.includes("--title"), false);
  assert.equal(reuseArgs.includes("--session"), true);
});

test("7. consumeJsonlLine & evaluateTerminalState reject partial tool-calls and model mismatches", () => {
  const ctx = { sessionID: "", stepCount: 0, tools: [], textParts: [], lastText: "", lastFinishReason: null, lastTokens: null, totalCost: 0, errors: [] };
  consumeJsonlLine(JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { tool: "write", state: { status: "completed" } } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { reason: "tool-calls", cost: 0.01 } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "intermediate" } }), ctx);

  // If stream drops after tool-calls without final reason=stop, must fail!
  const midVerdict = evaluateTerminalState({ exitCode: 0, timedOut: false, ctx, serverVerification: null, requestedModel: null });
  assert.equal(midVerdict.ok, false);
  assert.match(midVerdict.reason, /reason=tool-calls/);

  // Complete turn with reason=stop + matching server observation
  consumeJsonlLine(JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "DONE_OK" } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { reason: "stop", cost: 0.02 } }), ctx);

  const serverVerification = extractServerVerification({
    data: [
      { type: "idle", outcome: "succeeded" },
      { type: "assistant", agent: "build", model: { providerID: "google-vertex", id: "gemini-3.5-flash", variant: "default" }, content: [{ type: "text", text: "DONE_OK" }] },
    ],
  });
  const okVerdict = evaluateTerminalState({
    exitCode: 0,
    timedOut: false,
    ctx,
    serverVerification,
    requestedModel: { providerID: "google-vertex", modelID: "gemini-3.5-flash", variant: null },
  });
  assert.equal(okVerdict.ok, true);

  // Server model mismatch check
  const mismatch = evaluateTerminalState({
    exitCode: 0,
    timedOut: false,
    ctx,
    serverVerification,
    requestedModel: { providerID: "google-vertex", modelID: "gemini-4-carbon", variant: "high" },
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /Model mismatch/);
});
