#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildExecArgs,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  stripExecutionInfo,
  validateShortAsciiPrompt,
} from "./dispatch-iflow.mjs";

test("1. parseArgs defaults & conflicts", () => {
  const def = parseArgs(["--file", "T.md"]);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv sets IFLOW_API_KEY / IFLOW_BASE_URL / isolated HOME", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const envRes = buildChildEnv(opts, "C:\\tmp\\iflow-home", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.env.IFLOW_API_KEY, "dummy-id.dummy-secret");
  assert.equal(envRes.env.IFLOW_BASE_URL, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(envRes.env.HOME, "C:\\tmp\\iflow-home");
  assert.equal(envRes.env.HTTP_PROXY, undefined);
});

test("5. buildExecArgs uses --plan vs -y & -r on reuse", () => {
  const ro = buildExecArgs({ ...parseArgs(["--file", "T.md"]), cliPath: "iflow.js" }, "info.json", "", "glm-4.7", "hello");
  assert.ok(ro.includes("--plan"));
  const rw = buildExecArgs({ ...parseArgs(["--write", "--file", "T.md"]), cliPath: "iflow.js" }, "info.json", "s-1", "glm-4.7", "hello");
  assert.ok(rw.includes("-y"));
  assert.ok(rw.includes("-r"));
});

test("6. stripExecutionInfo & evaluateTerminalState validate reply & exit code", () => {
  assert.equal(stripExecutionInfo("err\n<Execution Info>{}</Execution Info>"), "err");
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, stdoutText: "IFLOW_DONE", execInfo: { "session-id": "s-1" } }).ok, true);
  assert.equal(evaluateTerminalState({ exitCode: 1, timedOut: false, stdoutText: "err", execInfo: null }).ok, false);
});
