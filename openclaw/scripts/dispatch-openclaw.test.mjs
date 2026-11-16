#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildExecArgs,
  buildOpenClawConfig,
  evaluateTerminalState,
  parseArgs,
  parseOpenClawJson,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-openclaw.mjs";

test("1. parseArgs defaults & conflicts", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.provider, "bigmodel");
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both/);
  assert.throws(() => parseArgs(["--reuse", "--session", "s1"]), /Cannot pass both/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM & computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildOpenClawConfig disables plugins (Windows symlink EPERM) & enables skipBootstrap", () => {
  const cfg = buildOpenClawConfig({ workspace: "D:\\proj", provider: "bigmodel", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", keyEnvVar: "ZAI_API_KEY", model: "glm-4.7" });
  assert.equal(cfg.plugins.enabled, false);
  assert.equal(cfg.agents.defaults.skipBootstrap, true);
  assert.equal(cfg.models.providers.bigmodel.apiKey, "${ZAI_API_KEY}");

  const envRes = buildChildEnv(parseArgs(["--file", "T.md"]), "C:\\tmp\\s", "C:\\tmp\\s\\openclaw.json", { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.env.OPENCLAW_NO_RESPAWN, "1");
  assert.equal(envRes.env.HTTP_PROXY, undefined);
});

test("5. buildExecArgs builds embedded --local --json command", () => {
  const args = buildExecArgs({ ...parseArgs(["--file", "T.md"]), cliPath: "openclaw.mjs" }, "oc-1", "glm-4.7", "hello");
  assert.deepEqual(args, ["openclaw.mjs", "agent", "--local", "--json", "--session-id", "oc-1", "--model", "bigmodel/glm-4.7", "-m", "hello"]);
});

test("6. parseOpenClawJson & evaluateTerminalState reject aborted / empty payloads", () => {
  const parsed = parseOpenClawJson('{"payloads":[{"text":"OPENCLAW_DONE"}],"meta":{"aborted":false,"agentMeta":{"model":"glm-4.7"}}}');
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, parsed }).ok, true);
  const aborted = parseOpenClawJson('{"payloads":[{"text":"x"}],"meta":{"aborted":true}}');
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, parsed: aborted }).ok, false);
});
