# Part I (Main Track): How to Build Local Bridges Across Different Agents

[简体中文](AGENT_BRIDGE_METHODOLOGY.md) | **English**

> **Two-Part Structure of This Methodology**:
> - **Part I (This Document — Primary Focus)**: **How to build reliable, reusable local bridges across different Agents** (so an Architect main Agent can discover, isolate, dispatch UTF-8 work orders to, and verify any local worker Agent—whether desktop IDE, embedded runtime, or headless CLI).
> - **Part II (Supporting Guide)**: [`AGENT_USAGE_AND_BYPASS_METHODOLOGY.en.md`](AGENT_USAGE_AND_BYPASS_METHODOLOGY.en.md) — **How to use non-official models / attach external API keys to your preferred Agent** (and local runtime / proxy requirements), offered as an optional enabler for users who want to plug custom keys into their favorite Agent.

---

## 0. The Five Bridging Archetypes (What Actually Determines How a Bridge Is Built)

Across 20+ mainstream desktop and CLI Agents, what determines bridge design is **not the model or API key**, but **the control surface the target Agent exposes**:

| Archetype | Representative Agents | Discovery (Step 1) | Transport & Contract (Step 2) | Terminal Verification (Step 5) |
| :--- | :--- | :--- | :--- | :--- |
| **1. Desktop Loopback RPC / Web Server** | Antigravity, DSH | Process cmdline ports, `--csrf_token`, or startup-log `?token=` | ConnectRPC JSON or Cookie-backed HTTP RPC envelopes | Cursor baseline + consecutive stable `IDLE` / `asOfSeq` polls |
| **2. Desktop DevTools (CDP + Native IPC)** | WorkBuddy | Ephemeral `127.0.0.1` CDP port + unique main renderer target | `Runtime.evaluate` calling internal `__wbInvoke` IPC | `stopReason=end_turn` + `SUCCESS` + Restore normal launch |
| **3. Native Headless CLI (stdio JSONL / JSON)** | Codex, Claude Code, Gemini CLI, Copilot, Kimi, Pi, OMP, Kilo, OpenCode, iFlow, OpenClaw, Goose | Native binary (`*.exe`, never `.cmd` shims) or JS entrypoint | Closed `stdin` or `--prompt <file>` + `stream-json` / `--json` | **Never trust `exit=0` alone**: require explicit protocol terminal event + host-observed model |
| **4. Embedded Engine / Direct Core Import** | VS Code Cline (`@cline/core`), ZCode (`zcode.cjs`) | Extension/app ESM or CJS core bundle | Direct Node import (with `CONNECT` proxy `fetch` or `node:sqlite` patch if needed) | Core event subscription + local `sessions.db` SQLite audit |
| **5. Post-Run DB / Diff-Only CLI** | Crush, Continue (`cn`), Aider | Native binary / isolated Python venv | Run non-interactively, then inspect `session last --json` / `ls --json` / edit diffs | Session DB audit or independent file-diff verification |

> **Core Insight**: You cannot copy-paste protocols between Agents. What transfers universally is the **5-Step Bridging Chain**, **UTF-8 Task-File Dispatch (`--file`)**, **Workspace/Session Isolation**, and **3-Layer Closed-Loop Verification**.

---

## 1. Why "Architect Main Agent + Local Bridge + Worker Sub-Agents"?

- **Token Bleed in Main Sessions**: High-tier reasoning models excel at architecture, design review, and decomposition, but 85%–90% of engineering tokens are spent in multi-turn edit → build → read-errors → fix loops where context grows quadratically.
- **Delegation via Local Bridge**: By dispatching self-contained UTF-8 work orders to specialized local Agents (or lower-cost high-throughput models) over headless CLI or loopback IPC, intermediate tool logs remain isolated inside the worker session and only concise summaries + verified file diffs return to the Architect.

---

## 2. The Universal 5-Step Bridging Methodology

When onboarding any new local Agent (or upgrading after a major version bump):

1. **Step 1 — Entrypoint & Credential Discovery**:
   - Locate the native binary (`*.exe` on Windows, avoiding `.cmd`/`.bat` shims for `spawn`), JS bundle entrypoint, or active desktop process (`Get-CimInstance` / process log).
   - For BYO-Key skip-login Agents, determine the isolated config directory env var (`CODEX_HOME`, `PI_CODING_AGENT_DIR`, `CRUSH_GLOBAL_CONFIG`, `CONTINUE_GLOBAL_DIR`, `OPENCLAW_STATE_DIR`, `COPILOT_HOME`, `GOOSE_PATH_ROOT`) so existing user logins remain untouched.
2. **Step 2 — Protocol & Schema Extraction (Read-Only)**:
   - Inspect `--help`, bundled JS/OpenAPI descriptors, or Go/Rust binary symbol tables—never hardcode undocumented endpoints blindly.
   - Identify structured headless output (`stream-json`, `--format json`, `--mode json`, `-o exec-info.json`, or Connection RPC envelopes) and the exact terminal completion event.
3. **Step 3 — Model Registry Lookup & Pre-Validation**:
   - Query live model catalogs (`/api/model`, `models_cache.json`, `models.json`, `ProviderSettingsManager`, etc.) and reject invalid/disabled models **before** creating a session or mutating `state.json`.
4. **Step 4 — Session Isolation, Permissions & Context Reuse**:
   - Default to safe read-only or standard approval modes; require an explicit `--write` flag for autonomous file edits/command execution.
   - Persist `{ phase, lastSessionId, lastCwd, taskSha256 }` atomically (`.tmp` + `rename`) and enforce same-`cwd` ownership before allowing `--reuse`.
   - Store **zero plaintext API keys** on disk; inject credentials purely through environment variables and config indirection.
5. **Step 5 — 3-Layer Closed-Loop Verification**:
   - **Layer 1 (Accepted)**: Request/process accepted with valid session/thread ID.
   - **Layer 2 (Protocol Terminal State)**: Explicit completion event observed (`turn.completed`, `result.subtype === "success"`, `step_finish.reason === "stop"`, `agent_end`, `complete`, `isByok === true`), zero permission denials, and host-observed model ID recorded.
   - **Layer 3 (Artifact Verification)**: Main Architect independently inspects generated files, SHA-256 hashes, and test results.

---

## 3. Master Pitfall Index (01–50)

### General & Desktop Host Bridges (01–25)
- **01 — Windows Long UTF-8 `--prompt` Hang**: PowerShell / ConPTY buffers stall on long multi-byte CLI prompts. **Fix**: Always write UTF-8 task files (`<= 1 MiB`) and dispatch short pure-ASCII `--file` commands.
- **02 — Trajectory Bloat Beyond ~100 Steps**: Reusing long sessions slows down inference. **Fix**: Use `--reuse` only for small follow-ups within the same module; start fresh sessions across independent modules.
- **03 — Stale Task-File Race**: Overwriting `TASK.md` concurrently with execution dispatches old instructions. **Fix**: Write & confirm task file completion (and verify SHA-256) before spawning the bridge.
- **04 — Transient `IDLE` During Async Commands (Antigravity)**: `sum.status` flashes `IDLE` while background sub-steps remain `RUNNING`/`WAITING`. **Fix**: Require zero pending steps, `PLANNER_RESPONSE` terminal type, and 2 consecutive stable polls.
- **05 — No Reusable Loopback Port (Codex)**: Codex desktop owns `app-server` via private stdio. **Fix**: Bridge official headless `codex exec --json` over stdio.
- **06 — `codex exec` Hangs Waiting for `stdin` EOF**: Piped stdin blocks forever unless closed. **Fix**: Write prompt to `child.stdin` and call `child.stdin.end()` immediately.
- **07 — Headless Soft Failure (`exit=0` on Read-Only Sandbox)**: Codex `workspace-write` can exit `0` while reporting read-only failure. **Fix**: Explicit `--write` (`danger-full-access`) + independent artifact checks.
- **08 — Heavy User `config.toml` Stalls Codex for 9+ Minutes**: MCP/plugins/MXC sandbox hang initialization. **Fix**: Pass `--ignore-user-config` in subscription mode (or use minimal isolated `CODEX_HOME` in BYOK mode).
- **09 — Windows `child.kill()` Leaves Grandchild Pipes Open**: Node `close` never fires on timeout. **Fix**: `taskkill /PID <pid> /T /F` + 3s stdio handle destruction & `unref()`.
- **10 — `codex exec resume` Accepts Only a Subset of Flags**: Rejects `-C`, `-s`, `--approve-for-me`. **Fix**: Separate new vs. resume argument builders and isolate state per directory.
- **11–19 — DSH Harness Web RPC Pitfalls**: `/?token=` exchanges for an `HttpOnly` cookie (API rejects query/Bearer tokens); `throughSeq` cannot be a sentinel `1e9`; outer parameter wrapper varies (`_request` vs `request`); validate models before mutating state; verify `request/header.header.config.model` (never trust self-reported model names); match messages by `requestId`; beware `selectModel` global side effects; write complex probes as `.mjs` files rather than inline PowerShell/MSYS bash strings; distinguish API session storage from GUI workspace filtering.
- **20 — `exit=0` + Text Output ≠ Task Completion**: Streaming partial `item.updated` messages must be ignored; require `turn.completed` and atomic state persistence upon `thread.started`.
- **21–25 — ZCode & Node 22 SQLite Pitfalls**: Missing `zcode-builtin.json` fallback path; Node 22.15.1 missing `DatabaseSync.prototype.isTransaction` fixed via `-r patch-sqlite.cjs`; `${providerId}/${modelId}$${reasoningLevel}` syntax; strict two-part `{id}.{secret}` Z.ai key format; headless `--prompt` required to avoid stripped `@zcode/tui` crash.

### OpenCode, Gemini CLI & VS Code Cline (26–38)
- **26–29 — OpenCode**: Pre-validate `provider/model[#variant]` against `/api/model` to avoid orphan `outcome="failed"` sessions; require `step_finish.reason === "stop"` (ignore `"tool-calls"`) + `/api/session/{id}/message` verification; strip `OPENCODE_SESSION_ID`/`OPENCODE_TERMINAL` from child env; spawn native `opencode.exe` directly in UTF-8 instead of PowerShell 5.1 BOM redirection.
- **30–34 — Gemini CLI**: Set `GEMINI_CLI_NO_RELAUNCH=true`; map `GOOGLE_CLOUD_LOCATION` (not `VERTEX_LOCATION`) and reject `Opening authentication page` `exit=0` fake success; pass `-e none` to save 12k+ extension tokens; concatenate `delta: true` chunks and read `result.stats.models` for true executed model; merge `bundle/chunk-*.js` model constants and pre-validate.
- **35–38 — VS Code Cline**: Bypass fragile `vscode://` URI handler (breaks on `&`, pops UI, overwrites global Hooks) by importing `@cline/core` directly in Node; inject a zero-dep `http.request(CONNECT) + tls.connect` `fetch` for Node 22.15.1 proxy support; note `core.subscribe(listener, { sessionId })` parameter order; use `interactive: true` + `core.readMessages()` for cross-process `--reuse`.

### Qwen Ecosystem Research & Removed Environment Note (39–41)
- **39 — Discontinued `qwen-oauth` & Desktop Hardware Signing**: `qwen-oauth` free tier ended `2026-04-15`; Qianwen desktop uses `SecurityGuardSDK64.dll` dynamic headers that cannot be forged. (The temporary `@qwen-code/qwen-code` bridge was later removed per project cleanup.)
- **40 — `vertex-ai` + Proxy `HttpsProxyAgent` Bug**: Bundled v0.27.4 threw `HttpsProxyAgent is not a constructor` when proxy env vars were set under `--auth-type vertex-ai`.
- **41 — `stream-json` Soft Denials**: Always verify `result.subtype === "success"`, `!is_error`, and `permission_denials.length === 0`.
- **Qwen Desktop Option 2 (⚠️ Unverified / Never Experienced)**: Static inspection of `cowork-agent-host.asar` (`engine/bundle.cjs`) revealed a `DASHSCOPE_API_KEY` branch and `start/stop/onChatMessage` exports, but **no runtime shim was ever built or tested**.

### Headless CLI Bridging & BYO-Key Adapter Pitfalls (42–50)

> *(Note: End-to-end smoke checks used an available GLM API quota purely as a multi-protocol test target; the bridging rules and pitfalls below apply equally to any OpenAI/Anthropic/Responses-compatible provider.)*
- **42 — Claude `--bare` & Copilot CLI `anthropic` BYOK**: Claude `--bare` skips onboarding/OAuth cleanly; Copilot CLI must bypass `copilot-shim` to invoke native `copilot.exe`, set `COPILOT_OFFLINE=true`, and use `COPILOT_PROVIDER_TYPE=anthropic` to prevent HTTP 400 from missing `reasoning_content` replay on tool turns.
- **43 — Codex BYO-Key Isolation**: Skip stale empty version folders in `LocalAppData\OpenAI\Codex\bin\`; keep isolated `CODEX_HOME` outside `%TEMP%`; omit `--ignore-user-config` so isolated `config.toml` + `models.json` load cleanly.
- **44 — Pi / OMP Dialect, Bun & Toolset Divergence**: Set `compat.supportsDeveloperRole: false` for GLM; OMP requires native `bun.exe` (ES2025 `using`) and uses `glob` rather than Pi's `ls`/`find`.
- **45 — OpenClaw Windows Symlink `EPERM` & Workspace Pollution**: Set `plugins.enabled: false` to avoid symlink `EPERM` without Windows Developer Mode, and `agents.defaults.skipBootstrap: true` so OpenClaw does not write `SOUL.md`/`AGENTS.md`/`BOOTSTRAP.md` into target repos.
- **46 — Kimi Code v2.6.2 Path & Flag Conflicts**: Config moved to `.kimi-code/config.toml` (`api_key_env`); `-p` forbids combining `-y`/`--auto`/`--plan`.
- **47 — Crush Config Pollution & Goose Keyring/Chunking**: Set `CRUSH_GLOBAL_CONFIG` to keep `crush.json` out of user repos; set `GOOSE_DISABLE_KEYRING=true` and stitch `stream-json` text by `message.id`.
- **48 — Domestic Proxy Stripping & Concurrent 429 Limits**: Strip `HTTP_PROXY`/`HTTPS_PROXY` automatically for domestic endpoints (`bigmodel.cn`, `z.ai`); stagger parallel multi-agent bursts to avoid account-level `429 Rate limit exceeded`.
- **49 — Continue CLI Stdin & Aider Scope**: Windows `cn -p` ignores piped stdin (pass `--prompt <taskFile>` and `--fork` for reuse); Aider is diff-based (pass `--target`/`--read` and default to `--chat-mode ask`).
- **50 — Cursor Free Tier, Qoder CLI & Trae Auth vs. Open-Source Split**: Cursor routes Agent/Chat through `api2.cursor.sh` and blocks custom models on Free plans (`The model ... does not work with your current plan or api key`; `PrivateInference` requires Team/Enterprise `readTeamEnablement()`); `@qoder-ai/qodercli` requires `qodercli login` (`NonInteractiveAuthRequiredError`) before unlocking BYOK `customModels`; Trae splits into Trae IDE (requires online login, relays custom models via `/custom_model` WebSocket, and restricts Free `identity: 0` accounts with `503 No available accounts`), commercial `traecli` (Enterprise Flagship only), and MIT open-source `bytedance/trae-agent` (bridged and E2E-verified in `trae-agent/`). For Cursor/Trae IDEs without Pro, use VS Code-compatible BYOK extensions (Cline/Kilo/Continue) or run our headless bridges.
- **51 — `bytedance/trae-agent` Missing `docker` Core Dep, Windows `cmd.exe` GBK Buffer Poisoning & `exit=0` False Success**: `base_agent.py` imports `docker` unconditionally even though `pyproject.toml` places `docker` inside `[project.optional-dependencies].evaluation` (must install with `--extra evaluation`); on Chinese Windows locales, `bash_tool.py` starts `cmd.exe /v:on` and calls strict UTF-8 `_buffer.decode()`, throwing `UnicodeDecodeError` on GBK bytes (e.g. `0xb0`) before clearing `_buffer`, permanently poisoning every subsequent shell call until `max_steps` exhausts; `trae-cli run` also exits `0` when `success: false`, and `final_result` is often `""` when `task_done` completes without trailing prose. **Fix**: Preload `trae-agent/scripts/trae-launcher.py` (`chcp 65001` + `mbcs` fallback & buffer flush on decode error), set `PYTHONUTF8=1`, check `trajectory.success === true`, and fall back to the last non-empty `llm_response.content` in `agent_steps`.
