#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildExecArgs,
  buildModelsYml,
  consumeJsonlLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-omp.mjs";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildModelsYml emits env var indirection & compat.supportsDeveloperRole=false", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const envRes = buildChildEnv(opts, "C:\\tmp\\omp-agent", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.env.HTTP_PROXY, undefined);

  const yml = buildModelsYml({ provider: "bigmodel", baseUrl: envRes.baseUrl, keyEnvVar: envRes.keyEnvVar, model: "glm-4.7" });
  assert.match(yml, /apiKey: ZAI_API_KEY/);
  assert.match(yml, /supportsDeveloperRole: false/);
  assert.doesNotMatch(yml, /dummy-secret/);
});

test("5. buildExecArgs toggles read-only vs --write tools & --resume", () => {
  const ro = buildExecArgs({ ...parseArgs(["--file", "T.md"]), cliPath: "cli.js" }, "sess-dir", "", "glm-4.7", "hello");
  assert.ok(ro.includes("read,grep,glob"));

  const rw = buildExecArgs({ ...parseArgs(["--write", "--file", "T.md"]), cliPath: "cli.js" }, "sess-dir", "01a1", "glm-4.7", "hello");
  assert.ok(rw.includes("read,bash,edit,write,grep,glob"));
  assert.ok(rw.includes("--resume"));
});

test("6. consumeJsonlLine & evaluateTerminalState require agent_end & stopReason=stop", () => {
  const ctx = { sessionId: "", observedModel: null, stopReason: null, agentEnded: false, isTerminal: false, lastAssistantText: "", toolsCalled: [], errors: [], usage: null };
  consumeJsonlLine(JSON.stringify({ type: "session", id: "omp-1" }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "bigmodel", model: "glm-4.7", stopReason: "stop", content: [{ type: "toolCall", name: "write" }, { type: "text", text: "OMP_DONE" }] } }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "agent_end", isTerminal: true, messages: [] }), ctx);
  assert.equal(ctx.sessionId, "omp-1");
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, true);
});
