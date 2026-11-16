#!/usr/bin/env node
/**
 * 只读安全审计：检查 codex/ 与 dispatch-codex-template.mjs 是否混入 API Key、Token 或私钥。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARENT = path.resolve(ROOT, "..");
const TARGETS = [
  path.join(ROOT, "README.md"),
  path.join(ROOT, ".gitignore"),
  path.join(ROOT, "scripts/dispatch-codex.test.mjs"),
  path.join(ROOT, "scripts/verify-no-secrets.mjs"),
  path.join(PARENT, "dispatch-codex-template.mjs"),
  path.join(PARENT, "CODEX_BRIDGE_EXPERIENCE.md"),
];

const PATTERNS = [
  { name: "gcp_private_key", regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: "api_key_sk", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "zhipu_two_part_key", regex: /\b[0-9a-f]{32}\.[A-Za-z0-9]{10,}\b/g },
  { name: "bearer_token", regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/g },
];

const findings = [];
for (const full of TARGETS) {
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  for (const p of PATTERNS) {
    const matches = text.match(p.regex);
    if (matches && matches.length > 0) findings.push({ file: full, pattern: p.name, count: matches.length });
  }
}

console.log(JSON.stringify({ scannedFiles: TARGETS.length, findings, verdict: findings.length === 0 ? "clean" : "leaks_detected" }, null, 2));
if (findings.length > 0) process.exit(1);
