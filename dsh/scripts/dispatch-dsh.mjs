#!/usr/bin/env node
/**
 * DSH (DeepSeek Harness / DSH Desktop) local loopback bridge.
 *
 * Zero third-party dependencies. Reuses the ALREADY RUNNING desktop Harness
 * process and its logged-in model account: it does not create a second DSH
 * instance, does not read account credentials, and does not expose a port.
 *
 * Protocol (verified against dsh 0.1.5-rc.2 / dsh-desktop 0.1.1):
 *   1. Harness prints "dsh web: http://127.0.0.1:<port>/?token=<per-process token>"
 *      into <userData>/logs/harness.log on every start.
 *   2. GET /?token=... exchanges that token for a signed, authority-bound
 *      HttpOnly cookie. Neither Authorization headers nor API query tokens work.
 *   3. POST /api/<endpoint> with a Connection RPC envelope:
 *      { type:"client-request", rpcId, method:"<endpoint>", payload:{ args:{...} } }
 *      and the session cookie. Response is { type:"server-response", ..., result }.
 *   4. session/create -> session/prompt -> session/list + session/page polling.
 *
 * Safety rules:
 *   - Task text MUST come from a UTF-8 ticket file (--file), never from a long
 *     inline --prompt (Windows terminal paste buffer corruption).
 *   - Token/cookie never written to stdout, logs, state file or result file.
 *   - No automatic approval of tool calls. The native DSH permission policy is
 *     left untouched; a pending approval is reported, not clicked.
 *   - Timeout/disconnect is "uncertain": never auto-resend, never auto-reuse.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const MAX_TICKET_BYTES = 1024 * 1024;
const POLL_MS = 1500;
const PAGE_LIMIT = 200;
const MAX_PAGE_WALKS = 8;

const PS_DISCOVER = [
  "$rows = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*harness-node-entry.mjs*' }",
  "foreach ($p in $rows) {",
  "  $m = [regex]::Match($p.CommandLine, '--port\\s+(\\d+)')",
  "  if ($m.Success) { Write-Output (\"{0} {1}\" -f $p.ProcessId, $m.Groups[1].Value) }",
  "}",
].join("\n");

const USAGE = `DSH bridge (no inline prompts; use a UTF-8 ticket file)

  node scripts/dispatch-dsh.mjs --status
  node scripts/dispatch-dsh.mjs --models
  node scripts/dispatch-dsh.mjs --file DSH_TASK.md
  node scripts/dispatch-dsh.mjs --reuse --file DSH_FOLLOWUP.md
  node scripts/dispatch-dsh.mjs --reuse --model MODEL_ID --file DSH_TASK.md
  node scripts/dispatch-dsh.mjs --file DSH_TASK.md --dry-run

Options: --status --models --dry-run --reuse --file FILE --model ID
         --cwd DIR --state FILE --log FILE --timeout SECONDS --help
State:  private/dsh-bridge/state.json (and last-result.json), or --state FILE.
`;

export function parseArgs(argv) {
  const a = {
    status: false, models: false, dryRun: false, reuse: false, help: false,
    file: "", model: "", timeout: 600, cwd: ".", state: "", log: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--status") a.status = true;
    else if (k === "--models") a.models = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--reuse") a.reuse = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--file") a.file = argv[++i] ?? "";
    else if (k === "--model") a.model = argv[++i] ?? "";
    else if (k === "--cwd") a.cwd = argv[++i] ?? ".";
    else if (k === "--state") a.state = argv[++i] ?? "";
    else if (k === "--log") a.log = argv[++i] ?? "";
    else if (k === "--timeout") a.timeout = Number(argv[++i]);
    else if (k === "--prompt") throw new Error("--prompt is disabled: write the task to a UTF-8 ticket file and use --file (Windows terminal paste-buffer corruption).");
    else throw new Error(`unknown option: ${k}`);
  }
  if (!Number.isFinite(a.timeout) || a.timeout <= 0) throw new Error("--timeout must be a positive number of seconds");
  if ((a.status ? 1 : 0) + (a.models ? 1 : 0) + (a.file ? 1 : 0) > 1) throw new Error("choose only one of --status / --models / --file");
  if (!a.status && !a.models && !a.file && !a.help && !a.dryRun) throw new Error("missing --status, --models or --file");
  return a;
}

export function readTicket(root, file) {
  if (!file) throw new Error("missing --file");
  const abs = path.resolve(root, file);
  const buf = fs.readFileSync(abs);
  if (buf.length === 0) throw new Error(`ticket is empty: ${abs}`);
  if (buf.length > MAX_TICKET_BYTES) throw new Error(`ticket exceeds ${MAX_TICKET_BYTES} bytes: ${abs}`);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { throw new Error(`ticket is not valid UTF-8: ${abs}`); }
  text = text.replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error(`ticket has no content: ${abs}`);
  return { abs, text, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

export function discoverProcesses(exec = execFileSync) {
  let out = "";
  try {
    out = exec("powershell.exe", ["-NoProfile", "-Command", PS_DISCOVER], {
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
  } catch { return []; }
  return String(out).split(/\r?\n/)
    .map((line) => /^(\d+)\s+(\d+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), port: Number(m[2]) }));
}

export function findLogFiles() {
  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  const files = [];
  for (const root of roots) {
    const dirs = [root];
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.push(path.join(root, e.name));
      }
    } catch { /* unreadable profile root */ }
    for (const d of dirs) {
      const p = path.join(d, "logs", "harness.log");
      if (fs.existsSync(p)) files.push(p);
    }
  }
  return files.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
}

export function extractToken(logText, port) {
  const re = new RegExp(`dsh web:\\s+http://127\\.0\\.0\\.1:${port}/\\?token=([^\\s]+)`, "g");
  let match, token;
  while ((match = re.exec(logText)) !== null) token = match[1];
  return token;
}

export function parseCookies(headers) {
  const raw = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
  return raw.map((line) => String(line).split(";", 1)[0].trim()).filter(Boolean).join("; ");
}

export async function exchangeCookie(port, token) {
  const res = await fetch(`http://127.0.0.1:${port}/?token=${token}`, {
    redirect: "manual", signal: AbortSignal.timeout(10000),
  });
  if (![200, 302, 303, 307, 308].includes(res.status)) return null;
  return parseCookies(res.headers) || null;
}

export async function connect({ logOverride, processes, logs } = {}) {
  const procs = processes ?? discoverProcesses();
  const logFiles = logOverride ? [path.resolve(logOverride)] : (logs ?? findLogFiles());
  const candidates = [];
  for (const log of logFiles) {
    let text;
    try { text = fs.readFileSync(log, "utf8"); } catch { continue; }
    if (procs.length > 0) {
      for (const p of procs) {
        const token = extractToken(text, p.port);
        if (token) candidates.push({ pid: p.pid, port: p.port, log, token });
      }
    } else {
      // Fallback when the process table is not readable: take the newest URL.
      const re = /dsh web:\s+http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+)/g;
      let m, last;
      while ((m = re.exec(text)) !== null) last = m;
      if (last) candidates.push({ pid: 0, port: Number(last[1]), log, token: last[2] });
    }
  }
  if (candidates.length === 0) {
    throw new Error("no running DSH Harness endpoint found (process table + harness.log). Start DSH Desktop first, or pass --log <path-to-harness.log>.");
  }
  const failures = [];
  for (const c of candidates) {
    const cookie = await exchangeCookie(c.port, c.token).catch(() => null);
    if (!cookie) { failures.push(`port ${c.port} from ${path.basename(c.log)}`); continue; }
    return { pid: c.pid, port: c.port, log: c.log, cookie };
  }
  // Never include the token or cookie in the error text.
  throw new Error(`Harness token exchange rejected (${failures.join("; ")}). The launch token is per-process: restart DSH Desktop, or check --log.`);
}

export function envelope(endpoint, args) {
  const rpcId = randomUUID();
  return {
    rpcId,
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
  };
}

export async function rpc(ctx, endpoint, args) {
  const { rpcId, body } = envelope(endpoint, args);
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ctx.cookie },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status} ${text.slice(0, 160)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${endpoint}: non-JSON response`); }
  if (json.type !== "server-response" || json.rpcId !== rpcId) throw new Error(`${endpoint}: invalid RPC envelope or rpcId mismatch`);
  if (json.result?.ok !== true) {
    const e = json.result?.error ?? {};
    throw new Error(`${endpoint} failed: ${e.code ?? "unknown"}: ${String(e.message ?? "").slice(0, 200)}`);
  }
  return json.result.value;
}

export function normalizeCwd(p) {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function assistantText(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text).join("").trim();
}

export function turnReason(event) {
  const r = event?.data?.reason;
  return typeof r === "string" ? r : (r?.kind ?? "unknown");
}

/** Host-side evidence of the model actually used for a request (not self-report). */
export function requestConfig(records) {
  for (const r of [...records].reverse()) {
    if (r.event?.type !== "request/header") continue;
    const c = r.event.data?.header?.config;
    if (c && typeof c.model === "string") {
      return { provider: c.provider ?? null, model: c.model, reasoningEffort: c.reasoningEffort ?? null };
    }
  }
  return null;
}

export async function findSession(ctx, sessionId) {
  const list = await rpc(ctx, "session/list", { _request: {} });
  return (list.items ?? []).find((x) => x.sessionId === sessionId);
}

export async function collectNewRecords(ctx, sessionId, throughSeq, baseline) {
  const all = [];
  let beforeSeq;
  for (let i = 0; i < MAX_PAGE_WALKS; i++) {
    const request = {
      address: { kind: "session", sessionId },
      throughSeq,
      maxMessages: PAGE_LIMIT,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    };
    let page;
    try { page = await rpc(ctx, "session/page", { request }); }
    catch (e) { if (all.length === 0) throw e; break; }
    const records = page.records ?? [];
    if (records.length === 0) break;
    all.push(...records);
    const min = Math.min(...records.map((r) => Number(r.event.seq)));
    if (!page.hasMore || min <= baseline) break;
    beforeSeq = min;
  }
  return all.filter((r) => Number(r.event.seq) > baseline)
    .sort((a, b) => Number(a.event.seq) - Number(b.event.seq));
}

const STEP_TYPES = new Set([
  "user/message", "tool/call", "tool/result", "assistant/message",
  "turn/end", "approval/asked",
]);

export async function waitForReply(ctx, sessionId, requestId, baseline, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const seen = new Set();
  let stable = 0, lastAsOf = -1, approvalWarned = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let item;
    try { item = await findSession(ctx, sessionId); } catch { continue; }
    if (!item) continue;
    const asOf = Number(item.projections?.asOfSeq ?? 0);
    let records;
    try { records = await collectNewRecords(ctx, sessionId, asOf, baseline); }
    catch { continue; }
    for (const r of records) {
      const key = `${r.event.seq}:${r.event.type}`;
      if (!seen.has(key) && STEP_TYPES.has(r.event.type)) {
        seen.add(key);
        console.log(`  -> [seq ${r.event.seq}] ${r.event.type}`);
      }
    }
    if (!approvalWarned && records.some((r) => r.event.type === "approval/asked")) {
      console.log("  -> [Approval pending] DSH is waiting for a native permission decision; the bridge never auto-approves.");
      approvalWarned = true;
    }
    const user = records.find((r) => r.event.type === "user/message"
      && JSON.stringify(r.event.data ?? {}).includes(requestId));
    if (!user) { stable = 0; lastAsOf = -1; continue; }
    const after = records.filter((r) => Number(r.event.seq) > Number(user.event.seq));
    const turns = after.filter((r) => r.event.type === "turn/end");
    const replies = after.filter((r) => r.event.type === "assistant/message");
    if (!item.running && turns.length > 0 && replies.length > 0) {
      if (asOf === lastAsOf) stable++;
      else { lastAsOf = asOf; stable = 1; }
      if (stable >= 2) {
        const lastTurn = turns[turns.length - 1];
        const lastReply = replies[replies.length - 1];
        return {
          reply: assistantText(lastReply.event),
          reason: turnReason(lastTurn.event),
          asOf,
          requestConfig: requestConfig(records),
          eventCount: records.length,
        };
      }
    } else { stable = 0; lastAsOf = -1; }
  }
  return null;
}

/** Pure validation against the live registry; never mutates state or sessions. */
export function resolveModelArg(catalog, modelArg) {
  let provider, model;
  if (modelArg.includes("/")) [provider, model] = modelArg.split("/", 2);
  else {
    const found = (catalog.groups ?? []).flatMap((g) => (g.models ?? [])
      .filter((m) => m.id === modelArg).map((m) => ({ provider: g.id, model: m.id })));
    if (found.length !== 1) throw new Error(`model ${JSON.stringify(modelArg)} is not uniquely registered; use --models or provider/model`);
    ({ provider, model } = found[0]);
  }
  const group = (catalog.groups ?? []).find((g) => g.id === provider);
  if (!group || !(group.models ?? []).some((m) => m.id === model)) {
    throw new Error(`model ${provider}/${model} not found in live registry`);
  }
  return { provider, model };
}

export async function applyModel(ctx, sessionId, resolved) {
  const value = await rpc(ctx, "session/selectModel", {
    request: { sessionId, provider: resolved.provider, model: resolved.model },
  });
  return { ...value.selected, ...resolved };
}

export function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

export function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return null; }
}

export function acquireLock(statePath) {
  const lock = `${statePath}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    const fd = fs.openSync(lock, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`lock exists (${lock}); another dispatch may still be running. Inspect it before removing.`);
    throw e;
  }
  return () => { try { fs.unlinkSync(lock); } catch { /* already removed */ } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }

  const statePath = path.resolve(ROOT, args.state || path.join("private", "dsh-bridge", "state.json"));
  const resultPath = path.join(path.dirname(statePath), "last-result.json");
  const cwd = path.resolve(ROOT, args.cwd);
  const ticket = args.file ? readTicket(ROOT, args.file) : null;

  if (args.dryRun) {
    console.log(JSON.stringify({
      dryRun: true, ticket: ticket.abs, bytes: ticket.bytes,
      sha256: ticket.sha256, cwd, statePath,
    }, null, 2));
    return;
  }

  if (args.status || args.models) {
    const ctx = await connect({ logOverride: args.log });
    const cat = await rpc(ctx, "session/modelCatalog", {});
    if (args.models) {
      console.log(JSON.stringify({
        default: cat.default,
        groups: (cat.groups ?? []).map((g) => ({
          id: g.id, name: g.name,
          models: (g.models ?? []).map((m) => ({ id: m.id, name: m.name })),
        })),
      }, null, 2));
      return;
    }
    const list = await rpc(ctx, "session/list", { _request: {} });
    const state = readState(statePath);
    console.log(JSON.stringify({
      connected: true, harnessPid: ctx.pid, port: ctx.port,
      log: path.basename(ctx.log),
      defaultModel: cat.default,
      sessionCount: (list.items ?? []).length,
      state: state ? { sessionId: state.sessionId, lastStatus: state.lastStatus, cwd: state.cwd, model: state.model ?? null } : null,
    }, null, 2));
    return;
  }

  const release = acquireLock(statePath);
  const t0 = Date.now();
  let state = readState(statePath);
  const previousState = state;
  let sessionId = "";
  let ctx;
  let phase = "before-session";
  let sessionCreated = false;
  try {
    ctx = await connect({ logOverride: args.log });
    console.log(`[DSH Bridge] Connected: harnessPid=${ctx.pid} port=${ctx.port} log=${path.basename(ctx.log)}`);

    // Validate against the live registry BEFORE any state/session mutation.
    let resolvedModel = null;
    if (args.model) {
      const catalog = await rpc(ctx, "session/modelCatalog", {});
      resolvedModel = resolveModelArg(catalog, args.model);
      console.log(`[DSH Bridge] Model validated: ${resolvedModel.provider}/${resolvedModel.model}`);
    }

    if (args.reuse) {
      if (!state || state.lastStatus !== "completed" || !state.sessionId) {
        throw new Error("--reuse requires a completed session recorded by this bridge in the same state file");
      }
      if (normalizeCwd(state.cwd) !== normalizeCwd(cwd)) {
        throw new Error("--reuse cwd mismatch: refusing to drive a session owned by another directory");
      }
      const item = await findSession(ctx, state.sessionId);
      if (!item) throw new Error(`recorded session ${state.sessionId} no longer exists in DSH; start a new session`);
      sessionId = state.sessionId;
      console.log(`[DSH Bridge] Reusing session: ${sessionId}`);
    } else {
      const created = await rpc(ctx, "session/create", { request: { cwd } });
      sessionId = created.sessionId;
      sessionCreated = true;
      console.log(`[DSH Bridge] New session: ${sessionId}`);
    }

    writeState(statePath, {
      version: 1, sessionId, cwd, port: ctx.port,
      model: state?.model ?? null, lastStatus: "dispatching",
    });
    phase = "session-ready";

    let selectedModel = null;
    if (resolvedModel) {
      selectedModel = await applyModel(ctx, sessionId, resolvedModel);
      console.log(`[DSH Bridge] Model selected: ${selectedModel.provider}/${selectedModel.model}`);
    }

    const item = await findSession(ctx, sessionId);
    const baseline = Number(item?.projections?.asOfSeq ?? 0);
    const requestId = randomUUID();
    const sent = `${ticket.text.trim()}\n\n[dsh-bridge requestId: ${requestId} (internal correlation tag; ignore)]`;
    const accepted = await rpc(ctx, "session/prompt", {
      request: {
        requestId, sessionId, mode: "queue",
        content: [{ type: "text", text: sent }],
      },
    });
    if (accepted?.accepted !== true) throw new Error("session/prompt did not confirm acceptance");
    phase = "prompt-accepted";
    console.log(`[DSH Bridge] Prompt accepted: ${requestId}`);

    const done = await waitForReply(ctx, sessionId, requestId, baseline, args.timeout);
    if (!done) {
      writeState(statePath, {
        version: 1, sessionId, cwd, port: ctx.port,
        model: selectedModel ?? state?.model ?? null, lastStatus: "uncertain",
      });
      fs.writeFileSync(resultPath, JSON.stringify({
        status: "uncertain", sessionId, requestId,
        ticketSha256: ticket.sha256, at: new Date().toISOString(),
        note: "Timed out or lost connection. The DSH task may still be running. Do not auto-resend.",
      }, null, 2));
      throw new Error("timeout waiting for DSH reply; state marked uncertain (no auto-resend)");
    }

    const ok = done.reason === "completed" && done.reply.length > 0;
    writeState(statePath, {
      version: 1, sessionId, cwd, port: ctx.port,
      model: selectedModel ? `${selectedModel.provider}/${selectedModel.model}` : (state?.model ?? null),
      lastStatus: ok ? "completed" : "failed",
    });
    fs.writeFileSync(resultPath, JSON.stringify({
      status: ok ? "completed" : "failed", sessionId, requestId,
      turnEndReason: done.reason, asOfSeq: done.asOf,
      observedRequestConfig: done.requestConfig, selectedModel,
      ticketSha256: ticket.sha256, elapsedMs: Date.now() - t0,
      reply: done.reply, at: new Date().toISOString(),
    }, null, 2));

    const cfg = done.requestConfig;
    console.log(`\n=== [DSH Reply] (turn/end: ${done.reason}, ${Math.round((Date.now() - t0) / 1000)}s, host request model: ${cfg ? `${cfg.provider}/${cfg.model}` : "not observed in this window"}) ===\n${done.reply || "(no assistant text)"}`);
    phase = "done";
    if (!ok) throw new Error(`DSH turn ended with reason ${done.reason} or empty reply`);
  } catch (e) {
    // Phase-aware recovery: no work sent -> keep prior completed state intact;
    // new session already created -> mark uncertain; prompt already accepted -> uncertain.
    if (phase === "session-ready") {
      if (sessionCreated) {
        writeState(statePath, {
          version: 1, sessionId, cwd, port: ctx.port,
          model: state?.model ?? null, lastStatus: "uncertain",
        });
      } else if (previousState) {
        writeState(statePath, previousState);
      }
    } else if (phase === "prompt-accepted" && !/timeout waiting/i.test(String(e?.message ?? ""))) {
      writeState(statePath, {
        version: 1, sessionId, cwd, port: ctx.port,
        model: state?.model ?? null, lastStatus: "uncertain",
      });
    }
    throw e;
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`[DSH Bridge Error] ${e?.message ?? String(e)}`);
    process.exit(1);
  });
}
