#!/usr/bin/env node
/**
 * VS Code Cline Local Bridge 离线单元测试（不触发请求、不消耗额度）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareSemverDesc,
  evaluateClineResult,
  parseArgs,
  readUtf8TaskFile,
  resolveProviderAndModel,
  validateShortAsciiPrompt,
} from "./dispatch-cline.mjs";

const SAMPLE_PROVIDERS = {
  vertex: {
    modelId: "gemini-3.5-flash",
    knownModels: {
      "gemini-3.5-flash": {},
      "gemini-3.5-flash-lite": {},
      "gemini-4-argon": {},
    },
  },
  gemini: {
    modelId: "gemini-4-argon",
    knownModels: { "gemini-4-argon": {} },
  },
};

test("1. parseArgs defaults write=false and rejects conflicts", () => {
  const def = parseArgs(["--file", "TASK.md"]);
  assert.equal(def.write, false);
  assert.equal(def.mode, "act");
  assert.throws(() => parseArgs(["--file", "a.md", "--prompt", "hi"]), /Cannot pass both --file and --prompt/);
  assert.throws(() => parseArgs(["--reuse", "--session", "s1"]), /Cannot pass both --reuse and --session/);
  assert.throws(() => parseArgs(["--mode", "invalid"]), /Invalid --mode/);
});

test("2. validateShortAsciiPrompt enforces pure ASCII < 80 chars", () => {
  assert.doesNotThrow(() => validateShortAsciiPrompt("Reply OK"));
  assert.throws(() => validateShortAsciiPrompt("中文长指令"), /pure ASCII/);
  assert.throws(() => validateShortAsciiPrompt("x".repeat(80)), />= 80/);
});

test("3. readUtf8TaskFile strips BOM and computes SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-bridge-test-"));
  const f = path.join(dir, "t.md");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("工单", "utf8")]));
  const res = readUtf8TaskFile(f);
  assert.equal(res.text, "工单");
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("4. compareSemverDesc sorts latest Cline extension version first", () => {
  const sorted = ["4.1.9", "4.1.26", "4.2.0"].sort(compareSemverDesc);
  assert.deepEqual(sorted, ["4.2.0", "4.1.26", "4.1.9"]);
});

test("5. resolveProviderAndModel supports provider/model syntax and rejects unknown models", () => {
  const r1 = resolveProviderAndModel({
    configuredProviders: SAMPLE_PROVIDERS,
    liveCatalog: {},
    globalState: { mode: "act", actModeApiProvider: "vertex" },
    rawProvider: "",
    rawModel: "gemini/gemini-4-argon",
  });
  assert.equal(r1.providerId, "gemini");
  assert.equal(r1.modelId, "gemini-4-argon");

  assert.throws(() => resolveProviderAndModel({
    configuredProviders: SAMPLE_PROVIDERS,
    liveCatalog: {},
    globalState: {},
    rawProvider: "vertex",
    rawModel: "nonexistent-model",
  }), /not found in Cline catalog/);

  assert.throws(() => resolveProviderAndModel({
    configuredProviders: SAMPLE_PROVIDERS,
    liveCatalog: {},
    globalState: {},
    rawProvider: "openai",
    rawModel: "gpt-4o",
  }), /not configured in Cline/);
});

test("6. evaluateClineResult verifies finishReason=completed, non-empty text, and model match", () => {
  const ok = evaluateClineResult({
    finishReason: "completed",
    text: "DONE",
    model: { provider: "vertex", id: "gemini-3.5-flash" },
  }, { providerId: "vertex", modelId: "gemini-3.5-flash" });
  assert.equal(ok.ok, true);
  assert.equal(ok.observedModel, "vertex/gemini-3.5-flash");

  const err = evaluateClineResult({ finishReason: "error", text: "rate limit" }, null);
  assert.equal(err.ok, false);

  const mismatch = evaluateClineResult({
    finishReason: "completed",
    text: "DONE",
    model: { provider: "vertex", id: "gemini-4-carbon" },
  }, { providerId: "vertex", modelId: "gemini-3.5-flash" });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /Model mismatch/);
});
