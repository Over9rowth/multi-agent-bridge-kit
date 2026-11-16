#!/usr/bin/env node
/** Offline protocol/unit tests. No DSH connection, no model calls, no credentials. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assistantText, discoverProcesses, envelope, extractToken, normalizeCwd,
  parseArgs, parseCookies, readTicket, requestConfig, resolveModelArg,
  rpc, turnReason,
} from "./dispatch-dsh.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-test-"));
}

test("parseArgs: only ticket files, no inline prompts", () => {
  assert.throws(() => parseArgs(["--prompt", "a very long chinese task"]), /--prompt is disabled/);
  assert.throws(() => parseArgs(["--status", "--models"]), /choose only one/);
  assert.throws(() => parseArgs(["--file", "A.md", "--timeout", "0"]), /positive number/);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  const a = parseArgs(["--reuse", "--file", "A.md", "--model", "m1", "--timeout", "45"]);
  assert.equal(a.reuse, true);
  assert.equal(a.file, "A.md");
  assert.equal(a.model, "m1");
  assert.equal(a.timeout, 45);
});

test("readTicket: UTF-8, BOM, empty, oversize and invalid bytes", () => {
  const dir = tmpDir();
  try {
    const good = path.join(dir, "good.md");
    fs.writeFileSync(good, "\uFEFF中文工单 DSH_OK\r\n", "utf8");
    const t = readTicket(dir, "good.md");
    assert.equal(t.text.startsWith("中文工单"), true);
    assert.equal(t.sha256.length, 64);

    fs.writeFileSync(path.join(dir, "empty.md"), "", "utf8");
    assert.throws(() => readTicket(dir, "empty.md"), /empty/);

    fs.writeFileSync(path.join(dir, "blank.md"), "   \n", "utf8");
    assert.throws(() => readTicket(dir, "blank.md"), /no content/);

    fs.writeFileSync(path.join(dir, "big.md"), Buffer.alloc(1024 * 1024 + 1, 0x61));
    assert.throws(() => readTicket(dir, "big.md"), /exceeds/);

    fs.writeFileSync(path.join(dir, "bad.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    assert.throws(() => readTicket(dir, "bad.md"), /not valid UTF-8/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: Connection RPC shape and unique correlation ids", () => {
  const a = envelope("session/prompt", { request: { sessionId: "s1" } });
  const b = envelope("session/prompt", { request: { sessionId: "s1" } });
  const j = JSON.parse(a.body);
  assert.equal(j.type, "client-request");
  assert.equal(j.method, "session/prompt");
  assert.deepEqual(j.payload, { args: { request: { sessionId: "s1" } } });
  assert.equal(j.rpcId, a.rpcId);
  assert.notEqual(a.rpcId, b.rpcId);
});

test("parseCookies: strips attributes and never retains raw secrets in output", () => {
  const headers = {
    getSetCookie: () => ["dsh_session=v1.abc; Path=/; HttpOnly; SameSite=Strict", "second=xyz; Path=/"],
    get: () => null,
  };
  assert.equal(parseCookies(headers), "dsh_session=v1.abc; second=xyz");
  const single = { get: (k) => (k === "set-cookie" ? "one=1; Path=/" : null) };
  assert.equal(parseCookies(single), "one=1");
});

test("extractToken: last matching per-process URL wins and other ports are ignored", () => {
  const log = [
    "[t1] dsh web: http://127.0.0.1:43130/?token=OLD_TOKEN",
    "[t2] dsh web: http://127.0.0.1:43131/?token=OTHER_PORT",
    "[t3] dsh web: http://127.0.0.1:43130/?token=NEW_TOKEN",
  ].join("\n");
  assert.equal(extractToken(log, 43130), "NEW_TOKEN");
  assert.equal(extractToken(log, 43131), "OTHER_PORT");
  assert.equal(extractToken(log, 43129), undefined);
});

test("discoverProcesses: parses whitelisted PID/port rows only", () => {
  const rows = discoverProcesses(() => "360 43130\r\n999 43131\r\ngarbage\r\n");
  assert.deepEqual(rows, [{ pid: 360, port: 43130 }, { pid: 999, port: 43131 }]);
  assert.deepEqual(discoverProcesses(() => { throw new Error("no CIM"); }), []);
});

test("event projection: assistant text, turn reason and host request config", () => {
  assert.equal(assistantText({ data: { message: { content: [
    { type: "tool-call", name: "x" }, { type: "text", text: "A" }, { type: "text", text: "B" },
  ] } } }), "AB");
  assert.equal(assistantText({ data: {} }), "");
  assert.equal(turnReason({ data: { reason: { kind: "completed" } } }), "completed");
  assert.equal(turnReason({ data: { reason: "aborted" } }), "aborted");
  assert.equal(requestConfig([
    { event: { type: "user/message", data: {} } },
    { event: { type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" } } } } },
  ]).model, "deepseek-v4-flash");
  assert.equal(requestConfig([{ event: { type: "user/message", data: {} } }]), null);
});

test("resolveModelArg: validates live registry before any dispatch", () => {
  const cat = {
    groups: [
      { id: "deepseek-official", models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-flash" }] },
    ],
  };
  assert.throws(() => resolveModelArg(cat, "no-such-model"), /not uniquely registered/);
  assert.throws(() => resolveModelArg(cat, "other-provider/deepseek-flash"), /not found in live registry/);
  assert.deepEqual(resolveModelArg(cat, "deepseek-v4-flash"), { provider: "deepseek-official", model: "deepseek-v4-flash" });
  assert.deepEqual(resolveModelArg(cat, "deepseek-official/deepseek-flash"), { provider: "deepseek-official", model: "deepseek-flash" });
});

test("normalizeCwd: Windows path comparison is case/separator insensitive", () => {
  assert.equal(normalizeCwd("D:\\A\\B\\"), normalizeCwd("d:/a/b"));
  assert.notEqual(normalizeCwd("D:\\A\\B"), normalizeCwd("D:\\A\\C"));
});

test("rpc: validates envelope, rpcId correlation and error results", async () => {
  const original = globalThis.fetch;
  let captured;
  const reply = (init, result) => {
    const req = JSON.parse(init.body);
    return new Response(JSON.stringify({ type: "server-response", rpcId: req.rpcId, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return reply(init, { ok: true, value: { accepted: true } });
    };
    const value = await rpc({ port: 43130, cookie: "test=value" }, "session/prompt", { request: {} });
    assert.deepEqual(value, { accepted: true });
    assert.equal(captured.url, "http://127.0.0.1:43130/api/session/prompt");
    assert.equal(captured.init.headers.cookie, "test=value");
    assert.equal(JSON.parse(captured.init.body).type, "client-request");

    globalThis.fetch = async (_url, init) => {
      const req = JSON.parse(init.body);
      return new Response(JSON.stringify({
        type: "server-response", rpcId: `${req.rpcId}-wrong`, result: { ok: true, value: {} },
      }), { status: 200 });
    };
    await assert.rejects(() => rpc({ port: 1, cookie: "x" }, "session/list", {}), /rpcId mismatch/);

    globalThis.fetch = async (_url, init) => reply(init, {
      ok: false, error: { code: "gateway/bad-request", message: "nope" },
    });
    await assert.rejects(() => rpc({ port: 1, cookie: "x" }, "session/list", {}), /gateway\/bad-request: nope/);

    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    await assert.rejects(() => rpc({ port: 1, cookie: "x" }, "session/list", {}), /HTTP 401/);
  } finally { globalThis.fetch = original; }
});
