#!/usr/bin/env node
/**
 * Read-only audit: confirm that no Harness launch token or session cookie value
 * was copied into the bridge deliverables. Prints counts only, never secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const APPDATA = process.env.APPDATA;
const tokens = new Set();
const logs = [];

if (APPDATA) {
  const dirs = [APPDATA];
  try {
    for (const e of fs.readdirSync(APPDATA, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(APPDATA, e.name));
    }
  } catch { /* ignore */ }
  for (const d of dirs) {
    const p = path.join(d, "logs", "harness.log");
    if (!fs.existsSync(p)) continue;
    logs.push(p);
    const text = fs.readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const marker = line.indexOf("?token=");
      if (marker < 0 || !line.includes("dsh web:")) continue;
      const value = line.slice(marker + "?token=".length).trim().split(/\s/, 1)[0];
      if (value) tokens.add(value);
    }
  }
}

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
}
walk(ROOT);

// A signed DSH browser cookie value has the shape v1.<payload>.<signature>.
// Require long base64url segments so source-code regexes and short fake test
// values do not produce false positives.
const SIGNED_COOKIE_VALUE = /\bv1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/;
const tokenLeaks = [];
const cookieLeaks = [];
for (const p of files) {
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
  if ([...tokens].some((t) => text.includes(t))) tokenLeaks.push(path.relative(ROOT, p));
  if (SIGNED_COOKIE_VALUE.test(text)) cookieLeaks.push(path.relative(ROOT, p));
}

console.log(JSON.stringify({
  root: ROOT,
  harnessLogsScanned: logs.length,
  distinctLaunchTokensScanned: tokens.size,
  deliverableFilesChecked: files.length,
  tokenLeaks,
  cookieValueLeaks: cookieLeaks,
  verdict: tokenLeaks.length === 0 && cookieLeaks.length === 0 ? "clean" : "review",
  note: "Only presence is checked; token and cookie values are never printed or written.",
}, null, 2));

if (tokenLeaks.length || cookieLeaks.length) process.exitCode = 1;
