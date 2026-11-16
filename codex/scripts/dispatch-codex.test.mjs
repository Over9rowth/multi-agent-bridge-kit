#!/usr/bin/env node
/**
 * Codex Local Bridge (BYO-Key + Subscription) 离线单元测试
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildArgs,
  buildByokConfigToml,
  buildExecutionPlan,
  consumeLine,
  evaluateTerminalState,
  parseArgs,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "../../dispatch-codex-template.mjs";

test("1. parseArgs defaults & conflicts", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.sandbox, "workspace-write");

  const w = parseArgs(["--write", "--file", "T.md"]);
  assert.equal(w.sandbox, "danger-full-access");

  assert.throws(() => parseArgs(["--byok", "--subscription"]), /Cannot pass both --byok and --subscription/);
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both/);
  assert.throws(() => parseArgs(["--reuse", "--thread", "t1"]), /Cannot pass both/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM & computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildExecutionPlan activates BYOK skip-login with ZAI_API_KEY & isolated CODEX_HOME", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const stateFile = "D:\\proj\\private\\codex-bridge\\state.json";
  const plan = buildExecutionPlan(opts, stateFile, { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(plan.mode, "byok");
  assert.equal(plan.hasKey, true);
  assert.equal(plan.baseUrl, "https://open.bigmodel.cn/api/v1");
  assert.equal(plan.model, "glm-4.7");
  assert.equal(plan.ignoreUserConfig, false);
  assert.equal(plan.env.HTTP_PROXY, undefined);

  const toml = buildByokConfigToml({ baseUrl: plan.baseUrl, keyEnvVar: plan.keyEnvVar, model: plan.model, modelsJsonPath: "C:\\tmp\\models.json" });
  assert.match(toml, /wire_api = "responses"/);
  assert.match(toml, /env_key = "ZAI_API_KEY"/);
  assert.doesNotMatch(toml, /dummy-secret/);
});

test("5. buildArgs handles new exec vs resume & subscription ignore-user-config", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const byokPlan = buildExecutionPlan(opts, "D:\\proj\\state.json", { ZAI_API_KEY: "x" });
  assert.deepEqual(buildArgs({ ...opts, root: "D:\\proj", threadId: "" }, byokPlan), [
    "exec", "--json", "--skip-git-repo-check", "-m", "glm-4.7", "-C", "D:\\proj", "-s", "danger-full-access", "-",
  ]);
  assert.deepEqual(buildArgs({ ...opts, root: "D:\\proj", threadId: "th-1" }, byokPlan), [
    "exec", "resume", "th-1", "--json", "--skip-git-repo-check", "-m", "glm-4.7", "-",
  ]);

  const subPlan = buildExecutionPlan(parseArgs(["--subscription", "--file", "T.md"]), "D:\\proj\\state.json", {});
  assert.equal(subPlan.ignoreUserConfig, true);
});

test("6. consumeLine & evaluateTerminalState require turn.completed & completed agent_message", () => {
  const ctx = { threadId: "", lastMessage: "", usage: null, error: null, turnCompleted: false, toolsCalled: [] };
  consumeLine(JSON.stringify({ type: "thread.started", thread_id: "01a1" }), ctx);
  consumeLine(JSON.stringify({ type: "item.updated", item: { type: "agent_message", text: "partial" } }), ctx);
  assert.equal(ctx.lastMessage, "");
  consumeLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "CODEX_DONE" } }), ctx);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, false);
  consumeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10 } }), ctx);
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, ctx }).ok, true);
});
