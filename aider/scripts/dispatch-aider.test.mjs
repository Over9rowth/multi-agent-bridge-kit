#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildExecArgs,
  buildModelMetadata,
  evaluateTerminalState,
  parseAiderOutput,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-aider.mjs";

test("1. parseArgs parses --target / --read lists & defaults", () => {
  const def = parseArgs(["--target", "a.js,b.js", "--read", "fixture.json", "--file", "T.md"]);
  assert.deepEqual(def.targets, ["a.js", "b.js"]);
  assert.deepEqual(def.reads, ["fixture.json"]);
  assert.equal(def.write, false);
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM & computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aider-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv sets OPENAI_API_BASE & buildModelMetadata maps openai/<model>", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const envRes = buildChildEnv(opts, { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.modelSpec, "openai/glm-4.7");
  assert.equal(envRes.env.OPENAI_API_BASE, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(envRes.env.HTTP_PROXY, undefined);

  const meta = buildModelMetadata(envRes.modelSpec);
  assert.equal(meta["openai/glm-4.7"].litellm_provider, "openai");
});

test("5. buildExecArgs uses --chat-mode ask when read-only & --restore-chat-history on reuse", () => {
  const ro = buildExecArgs(parseArgs(["--file", "T.md"]), {
    modelSpec: "openai/glm-4.7", metaFile: "m.json", chatHistoryFile: "c.md", llmHistoryFile: "l.txt", msgFile: "msg.md", restore: false,
  });
  assert.ok(ro.includes("ask"));

  const rw = buildExecArgs(parseArgs(["--write", "--target", "result.txt", "--file", "T.md"]), {
    modelSpec: "openai/glm-4.7", metaFile: "m.json", chatHistoryFile: "c.md", llmHistoryFile: "l.txt", msgFile: "msg.md", restore: true,
  });
  assert.ok(!rw.includes("ask"));
  assert.ok(rw.includes("--restore-chat-history"));
  assert.ok(rw.includes("result.txt"));
});

test("6. parseAiderOutput & evaluateTerminalState capture applied edits", () => {
  const parsed = parseAiderOutput("AIDER_DONE\nApplied edit to result.txt\nTokens: 100 sent, 20 received.");
  assert.deepEqual(parsed.applied, ["result.txt"]);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, parsed }).ok, true);
});
