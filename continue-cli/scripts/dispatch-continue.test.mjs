#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildConfigYaml,
  buildExecArgs,
  evaluateTerminalState,
  parseArgs,
  parseContinueResponse,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-continue.mjs";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv & buildConfigYaml use ${{ secrets.VAR }} indirection", () => {
  const opts = parseArgs(["--file", "T.md"]);
  const envRes = buildChildEnv(opts, "C:\\tmp\\cn-home", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.env.CONTINUE_GLOBAL_DIR, "C:\\tmp\\cn-home");
  assert.equal(envRes.env.HTTP_PROXY, undefined);

  const yaml = buildConfigYaml({ baseUrl: envRes.baseUrl, keyEnvVar: envRes.keyEnvVar, model: "glm-4.7" });
  assert.match(yaml, /\$\{\{ secrets\.ZAI_API_KEY \}\}/);
  assert.doesNotMatch(yaml, /dummy-secret/);
});

test("5. buildExecArgs toggles --readonly vs --auto & --fork", () => {
  const ro = buildExecArgs({ ...parseArgs(["--file", "T.md"]), cliPath: "cn.js" }, "cfg.yaml", "", "task.md");
  assert.ok(ro.includes("--readonly"));
  const rw = buildExecArgs({ ...parseArgs(["--write", "--file", "T.md"]), cliPath: "cn.js" }, "cfg.yaml", "sid-1", "task.md");
  assert.ok(rw.includes("--auto"));
  assert.ok(rw.includes("--fork"));
});

test("6. parseContinueResponse & evaluateTerminalState check status=success", () => {
  const parsed = parseContinueResponse(JSON.stringify({ response: "CN_DONE", status: "success" }));
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, parsed, stdoutText: "" }).ok, true);
  const bad = parseContinueResponse(JSON.stringify({ status: "error", error: "401" }));
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, parsed: bad, stdoutText: "" }).ok, false);
});
