#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["README.md", ".gitignore", "scripts/dispatch-aider.mjs", "scripts/dispatch-aider.test.mjs", "scripts/verify-no-secrets.mjs"];
const PATTERNS = [
  { name: "gcp_private_key", regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: "api_key_sk", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "zhipu_two_part_key", regex: /\b[0-9a-f]{32}\.[A-Za-z0-9]{10,}\b/g },
  { name: "bearer_token", regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/g },
];

const findings = [];
for (const rel of TARGETS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  for (const p of PATTERNS) {
    const matches = text.match(p.regex);
    if (matches && matches.length > 0) findings.push({ file: rel, pattern: p.name, count: matches.length });
  }
}
console.log(JSON.stringify({ scannedFiles: TARGETS.length, findings, verdict: findings.length === 0 ? "clean" : "leaks_detected" }, null, 2));
if (findings.length > 0) process.exit(1);
