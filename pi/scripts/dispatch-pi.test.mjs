#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildExecArgs,
  buildModelsJson,
  consumeJsonlLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-pi.mjs";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv & buildModelsJson keep supportsDeveloperRole=false & env-var indirection", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const envRes = buildChildEnv(opts, "C:\\tmp\\pi-agent", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.env.PI_OFFLINE, "1");
  assert.equal(envRes.env.HTTP_PROXY, undefined);

  const models = buildModelsJson({ provider: "bigmodel", baseUrl: envRes.baseUrl, keyEnvVar: envRes.keyEnvVar, model: "glm-4.7" });
  assert.equal(models.providers.bigmodel.apiKey, "ZAI_API_KEY");
  assert.equal(models.providers.bigmodel.compat.supportsDeveloperRole, false);
});

test("5. buildExecArgs toggles read-only vs --write tools & --session", () => {
  const ro = buildExecArgs({ ...parseArgs(["--file", "T.md"]), cliPath: "cli.js" }, "sess-dir", "", "glm-4.7");
  assert.ok(ro.includes("read,grep,find,ls"));

  const rw = buildExecArgs({ ...parseArgs(["--write", "--file", "T.md"]), cliPath: "cli.js" }, "sess-dir", "s.jsonl", "glm-4.7");
  assert.ok(rw.includes("read,bash,edit,write,grep,find,ls"));
  assert.ok(rw.includes("--session"));
});

test("6. consumeJsonlLine & evaluateTerminalState require agent_end & stopReason=stop", () => {
  const ctx = { sessionId: "", observedModel: null, stopReason: null, agentEnded: false, lastAssistantText: "", toolsCalled: [], errors: [], usage: null };
  consumeJsonlLine(JSON.stringify({ type: "session", id: "pi-1" }), ctx);
  consumeJsonlLine(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "bigmodel", model: "glm-4.7", stopReason: "stop", content: [{ type: "toolCall", name: "write" }, { type: "text", text: "PI_DONE" }] } }), ctx);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, false);
  consumeJsonlLine(JSON.stringify({ type: "agent_end", messages: [] }), ctx);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, true);
  assert.equal(ctx.observedModel, "bigmodel/glm-4.7");
});
