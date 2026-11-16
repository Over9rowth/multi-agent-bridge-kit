#!/usr/bin/env node
/**
 * 只读安全审计：检查 opencode/ 交付物是否误混入凭据、私钥、会话令牌或代理/项目敏感信息。
 * 只输出文件路径与命中计数，绝不打印匹配值本身。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = [
  "README.md",
  ".gitignore",
  "scripts/dispatch-opencode.mjs",
  "scripts/dispatch-opencode.test.mjs",
  "scripts/verify-no-secrets.mjs",
];

const PATTERNS = [
  { name: "gcp_private_key", regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: "api_key_sk", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "google_api_key", regex: /\bAIza[0-9A-Za-z\-_]{30,}\b/g },
  { name: "bearer_token", regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/g },
  { name: "oauth_client_secret", regex: /"client_secret"\s*:\s*"[^"]+"/g },
  { name: "adc_refresh_token", regex: /"refresh_token"\s*:\s*"[^"]+"/g },
];

const findings = [];
for (const rel of TARGETS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  for (const p of PATTERNS) {
    const matches = text.match(p.regex);
    if (matches && matches.length > 0) {
      findings.push({ file: rel, pattern: p.name, count: matches.length });
    }
  }
}

console.log(JSON.stringify({
  scannedFiles: TARGETS.length,
  findings,
  verdict: findings.length === 0 ? "clean" : "leaks_detected",
}, null, 2));

if (findings.length > 0) process.exit(1);
