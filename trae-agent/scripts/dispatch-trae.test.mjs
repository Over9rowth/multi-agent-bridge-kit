#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  buildRunArgs,
  buildTraeConfigYaml,
  evaluateTerminalState,
  parseArgs,
  parseTrajectory,
  readUtf8TaskFile,
  validateShortAsciiPrompt,
} from "./dispatch-trae.mjs";

test("1. parseArgs defaults & validation", () => {
  const def = parseArgs(["--file", "T.md"]);
  assert.equal(def.provider, "anthropic");
  assert.equal(def.write, false);
  assert.throws(() => parseArgs(["--provider", "bad"]), /Invalid --provider/);
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM & computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. buildChildEnv & buildTraeConfigYaml keep api_key empty on disk & strip proxies for CN endpoints", () => {
  const opts = parseArgs(["--write", "--file", "T.md"]);
  const envRes = buildChildEnv(opts, { ZAI_API_KEY: "dummy-id.dummy-secret", HTTP_PROXY: "http://127.0.0.1:7897" });
  assert.equal(envRes.hasKey, true);
  assert.equal(envRes.env.ANTHROPIC_API_KEY, "dummy-id.dummy-secret");
  assert.equal(envRes.env.PYTHONUTF8, "1");
  assert.equal(envRes.env.HTTP_PROXY, undefined);

  const yaml = buildTraeConfigYaml({ provider: "anthropic", baseUrl: envRes.baseUrl, model: "glm-4.7", maxSteps: 20, write: true });
  assert.match(yaml, /api_key: ""/);
  assert.match(yaml, /- bash/);
  assert.doesNotMatch(yaml, /dummy-secret/);
});

test("5. buildRunArgs includes trae-launcher.py & --trajectory-file", () => {
  const args = buildRunArgs({
    launcherPath: "trae-launcher.py",
    cfgPath: "cfg.yaml",
    provider: "anthropic",
    model: "glm-4.7",
    baseUrl: "https://example.com",
    maxSteps: 15,
    root: "D:\\proj",
    trajFile: "traj.json",
    taskFile: "task.md",
  });
  assert.equal(args[0], "trae-launcher.py");
  assert.ok(args.includes("--trajectory-file"));
});

test("6. parseTrajectory & evaluateTerminalState reject exit=0 when trajectory.success is false", () => {
  const failTraj = parseTrajectory(JSON.stringify({ success: false, final_result: "Task execution exceeded maximum steps", agent_steps: [{}] }));
  assert.equal(evaluateTerminalState({ exitCode: 0, timedOut: false, trajectory: failTraj }).ok, false);

  const okTraj = parseTrajectory(JSON.stringify({
    success: true,
    final_result: "",
    provider: "anthropic",
    model: "glm-4.7",
    agent_steps: [
      { llm_response: { content: "TRAE_DONE", tool_calls: [{ name: "str_replace_based_edit_tool" }] }, tool_calls: [{ name: "str_replace_based_edit_tool" }] },
      { llm_response: { content: "", tool_calls: [{ name: "task_done" }] }, tool_calls: null },
    ],
  }));
  const res = evaluateTerminalState({ exitCode: 0, timedOut: false, trajectory: okTraj });
  assert.equal(res.ok, true);
  assert.equal(res.finalText, "TRAE_DONE");
  assert.deepEqual(okTraj.toolsCalled, ["str_replace_based_edit_tool", "task_done"]);
});
