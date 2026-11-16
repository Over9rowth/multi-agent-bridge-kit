# Mainstream Coding Agents: BYO-Key Skip-Login, Architecture Comparison, and Environment & Network Requirements

[简体中文](AGENT_USAGE_AND_BYPASS_METHODOLOGY.md) | **English**

> **Purpose**: This guide complements `AGENT_BRIDGE_METHODOLOGY.en.md` by answering three practical engineering questions for open-source multi-agent orchestration:
> 1. **How can Coding Agents that normally require paid subscriptions or interactive login be used cleanly with your own API key (BYO-Key)? Which tools block unauthenticated BYOK?**
> 2. **What are the real architectural and workflow differences across 20 mainstream CLI & desktop Coding Agents?**
> 3. **What are each Agent's local runtime, OS permission, and network/proxy requirements (e.g., overseas endpoints requiring proxies vs. domestic direct endpoints)?**
>
> **Verification Boundary**: All 13 BYO-Key headless paths (`claude-code`, `codex --byok`, `copilot`, `kimi-code`, `pi`, `omp`, `kilo`, `crush`, `continue-cli`, `iflow`, `openclaw`, `goose`, `aider`) were verified end-to-end on Windows 11 with file read/write tools and cross-process `--reuse`. Existing desktop/CLI adapters (`antigravity`, `workbuddy`, `dsh`, `zcode`, `opencode`, `gemini-cli`, `cline`) remain documented with their verified scopes. Unverified paths (such as Qwen Desktop ASAR `engine/bundle.cjs` Option 2) are explicitly marked **not experienced / unverified**.

---

## 1. Bypassing Subscription Logins via BYO-Key (4 Engineering Patterns)

Many coding CLIs default to vendor subscriptions (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, Kimi Code, Google Gemini OAuth, iFlow, Kilo Gateway, etc.). Based on reverse-engineering local CLI configurations and tools like **CC Switch** (`farion1231/cc-switch`), BYO-Key skip-login falls into **four distinct patterns**:

### Pattern A: Native `--bare` / BYOK Environment Overrides (Cleanest, Zero Global Config Edits)

1. **Claude Code (`@anthropic-ai/claude-code` v2.1.325)**:
   - **Config-file workaround (CC Switch)**: Write `"hasCompletedOnboarding": true` in `~/.claude.json`, plus `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`.
   - **Zero-footprint headless pattern (verified)**: Pass **`--bare`** (skips onboarding prompts, personal hooks/plugins, and Claude.ai OAuth checks) and inject via child process env:
     - `ANTHROPIC_BASE_URL` (e.g., an Anthropic-compatible endpoint such as `https://open.bigmodel.cn/api/anthropic`)
     - `ANTHROPIC_API_KEY`
     - `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`
     - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (prevents telemetry/update stalls)
2. **GitHub Copilot CLI (`@github/copilot` v1.0.112)**:
   - **Shim Pitfall**: Editor-bundled `copilot-shim/copilot.exe` is only an install stub; invoke the native `copilot.exe` from `@github/copilot`.
   - **Native BYOK + Offline Mode (verified `isByok: true, premiumRequests: 0`)**:
     - `COPILOT_HOME=<isolated dir>`
     - `COPILOT_OFFLINE=true` (blocks contacting GitHub servers)
     - `COPILOT_PROVIDER_TYPE=anthropic`
     - `COPILOT_PROVIDER_BASE_URL` (no `/v1` suffix for Anthropic mode)
     - `COPILOT_PROVIDER_API_KEY` & `COPILOT_MODEL`
   - **Why `anthropic` over `openai` for reasoning models**: Copilot CLI's `openai` client does not replay `reasoning_content` across tool-call turns, triggering HTTP 400 on reasoning models; using `COPILOT_PROVIDER_TYPE=anthropic` avoids this completely.

### Pattern B: Isolated Config Directory + Env-Var Indirection (Zero Plaintext Secrets on Disk)

Most modern CLIs accept a custom home/config env var and support referencing an environment variable name inside their config file instead of storing a literal secret:

| Agent | Isolated Config Mechanism | Env-Var Indirection Syntax | Key Caveats & Pitfalls |
| :--- | :--- | :--- | :--- |
| **Codex** (`codex.exe` 0.167) | `CODEX_HOME=<non-Temp dir>` | `config.toml`: `env_key = "ZAI_API_KEY"`, `wire_api = "responses"`, `model_catalog_json` | Never put `CODEX_HOME` inside `%TEMP%` (helper creation refused); skip empty stale bin dirs; omit `--ignore-user-config` in isolated BYOK mode |
| **Kimi Code** (`@moonshot-ai/kimi-code` 2.6.2) | Isolated `HOME`/`USERPROFILE` `.kimi-code/config.toml` | `api_key_env = "ZAI_API_KEY"` (`type = "openai"`) | v2.6.2 reads `.kimi-code/` (not `.kimi/`); `-p` forbids combining `--yolo`/`--auto`/`--plan` |
| **Pi** (`@mariozechner/pi-coding-agent` 0.73) | `PI_CODING_AGENT_DIR/models.json` | `"apiKey": "ZAI_API_KEY"` | Set `compat: { supportsDeveloperRole: false }` for OpenAI-compatible endpoints that reject `role: "developer"` |
| **Oh My Pi (`omp`)** (`18.20`) | `PI_CODING_AGENT_DIR/models.yml` | `apiKey: ZAI_API_KEY` | Requires `bun.exe` (Node 22 fails on ES2025 `using`); built-in tools use `glob` rather than Pi's `ls`/`find` |
| **Kilo CLI** (`@kilocode/cli` 7.8.27) | In-memory `KILO_CONFIG_CONTENT` JSON | `"apiKey": "{env:ZAI_API_KEY}"` | Invoke native `kilo.exe`; only `step_finish.part.reason === "stop"` denotes final turn completion |
| **Crush** (`@charmland/crush` 0.101) | `CRUSH_GLOBAL_CONFIG` + `-D <dataDir>` | `"api_key": "$ZAI_API_KEY"` | Use `CRUSH_GLOBAL_CONFIG` so `crush.json` never pollutes the target project root |
| **Continue CLI** (`@continuedev/cli` 1.5.47) | `CONTINUE_GLOBAL_DIR` + `--config <yaml>` | `apiKey: ${{ secrets.ZAI_API_KEY }}` | On Windows `-p` ignores piped stdin; pass `--prompt <taskFile>`; resume via `--fork <sessionId>` |
| **iFlow CLI** (`@iflow-ai/iflow-cli` 0.5.19) | Isolated `HOME` `.iflow/settings.json` | `selectedAuthType: "openai-compatible"` + env `IFLOW_API_KEY` / `IFLOW_BASE_URL` | No `apiKey` needed inside JSON; parse `-o exec-info.json` for `session-id` & token usage |
| **OpenClaw** (`openclaw` 2026.5.7) | `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` | `apiKey: "${ZAI_API_KEY}"` | Must set `plugins.enabled: false` (prevents Windows symlink `EPERM`) and `agents.defaults.skipBootstrap: true` (prevents creating `SOUL.md`/`AGENTS.md` in target repo) |
| **Goose** (`aaif-goose/goose` 1.59.2) | Isolated `GOOSE_PATH_ROOT` + `XDG_*` + `GOOSE_DISABLE_KEYRING=true` | Env `OPENAI_API_KEY`, `OPENAI_HOST`, `OPENAI_BASE_PATH=chat/completions` | Disable keyring to avoid OS prompt hangs; stitch `stream-json` text chunks by `message.id` |
| **Aider** (`aider-chat` 0.86.2) | `--model-metadata-file` JSON | Env `OPENAI_API_KEY` + `OPENAI_API_BASE` | Diff-oriented editor (no general shell tool); pass `--target`/`--read`; use `--chat-mode ask` for read-only |

### Pattern C: Local Protocol-Translation Routers (CC Switch Router / Aggregation)

When a client only speaks one wire dialect (e.g., Codex requiring OpenAI Responses `/v1/responses`, or Claude Code requiring Anthropic `/v1/messages`) while an upstream only exposes OpenAI Chat Completions:
- Tools like **CC Switch** start a local loopback proxy (`127.0.0.1:15721`) that translates between Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, and Gemini Native, with failover and thinking-block normalization.
- Conversely, if the upstream provider natively exposes all three protocols (e.g. Zhipu BigModel provides `/api/coding/paas/v4` Chat, `/api/v1` Responses, and `/api/anthropic` Messages), **direct connection works without any local proxy**.

### Pattern D: Tools That Cannot Bypass Account / Plan Gating (Observed Evidence)

Not every tool with an API key input field allows unauthenticated or free-tier BYOK execution:

1. **Cursor (Verified on Cursor 3.29.x)**:
   - **Why Free-tier Cursor cannot use BYOK Agent / GLM without Pro/Team**:
     1. Inspecting `workbench.desktop.main.js` and `cursor-agent-host/dist/main.js` confirms Cursor routes Chat, Composer, and Agent requests **through Cursor's backend (`https://api2.cursor.sh`)** via proprietary ConnectRPC, rather than calling third-party URLs directly from localhost (`127.0.0.1` private URLs are rejected).
     2. Under a `free` membership (`stripeMembershipType = free`), Cursor enforces server-side plan gating on custom models (`The model ... does not work with your current plan or api key`).
     3. Although Cursor 3.29 bundles a `PrivateInference` local-loop module (`CURSOR_PRIVATE_INFERENCE_CONFIG`), `cursor-agent-host` calls `readTeamEnablement()` to verify Enterprise/Team enrollment (`private-inference-not-enrolled` otherwise), and standard `local-loop` requires an authorized paid sign-in (`No sign-in authorizes local...`). Cursor's standalone `agent` CLI (`cursor-agent`) likewise exchanges keys at `/auth/exchange_user_api_key` and does not support generic OpenAI endpoints.
   - **Compliant Alternatives**: Install open-source VS Code BYOK extensions (such as **Cline**, **Kilo Code**, or **Continue**) inside Cursor IDE, or run the 13 BYO-Key CLI bridges in Cursor's integrated terminal.
2. **Qoder CLI (`@qoder-ai/qodercli` v1.1.89), TraeCode CLI (`traecli`), & Factory Droid**:
   - Even though `qodercli` supports `customModels` (BYOK), its `authType` enum only accepts `qoder-browser` or `qoder-pat`, and `init()` throws `NonInteractiveAuthRequiredError: Not logged in · Please run /login` before loading custom providers. You must authenticate a Qoder account first; it does not support zero-login BYOK. Factory Droid similarly requires an authenticated Factory account.
   - **Trae's 3 Distinct Surfaces (⚠️ Not installed/tested locally; verified via official docs & `pyproject.toml`)**:
     - **Trae IDE** (`trae.cn` / `trae.ai`): Unlike Cursor Free tier, Trae IDE allows adding custom OpenAI-compatible endpoints (e.g., `https://open.bigmodel.cn/api/coding/paas/v4`) without a paid Pro subscription, though activating the IDE AI panel still requires signing into a free Trae account;
     - **Commercial `TraeCode CLI` (`traecli`)**: Restricted to **TRAE CN Enterprise Flagship** accounts via `traecli login` / `TRAECLI_PERSONAL_ACCESS_TOKEN`—unavailable without enterprise authentication;
     - **Open-Source `bytedance/trae-agent` (`trae-cli`)**: MIT-licensed and **100% zero-login BYO-Key capable** (`trae-cli run --provider openai --model-base-url ...` or `OPENAI_API_KEY`/`OPENAI_BASE_URL` or `trae_config.yaml`), requiring **Python ≥ 3.12** and `uv`.
3. **Desktop Loopback / Hardware-Signed Clients (Antigravity, WorkBuddy, DSH, Qianwen Desktop)**:
   - Desktop IDE bridges (`Antigravity`, `WorkBuddy`, `DSH`) legally reuse an already-authenticated desktop session over loopback RPC/CDP/Cookie exchange without extracting account tokens.
   - For Qwen (`@qwen-code/qwen-code` v0.27.4 & Qianwen Desktop): `qwen-oauth` free tier was discontinued on `2026-04-15`; the desktop app uses native hardware signing (`SecurityGuardSDK64.dll`), which cannot and must not be forged. Static inspection of `cowork-agent-host.asar` (`engine/bundle.cjs`) showed a `DASHSCOPE_API_KEY` branch, but **this desktop Option 2 was never built or tested in practice (explicitly unverified)**.

---

## 2. Architecture Comparison Across 20 Mainstream Agents

| Family | Agents | Transport / Execution | Tooling Model | Session Persistence | Best Fit & Limitations |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Tier-1 Native Headless CLIs** | Claude Code, Codex, Gemini CLI, Copilot CLI | Native binary / JS bundle (`--bare`, `exec --json`, `stream-json`) | Full file read/edit/patch, shell sandbox, subagents | Local JSONL / rollout logs | **Primary coding workhorses**; granular permission modes (`plan`, `workspace-write`, `bypassPermissions`) |
| **2. Lightweight Agentic CLIs** | Pi, Oh My Pi (`omp`), OpenCode, Kilo CLI, Crush | JSONL over stdio / local HTTP `/api` / SQLite | Built-in file/grep/glob/shell (`omp` adds `ast_grep`/`ast_edit`) | JSONL or SQLite DB | **Fastest multi-model orchestration & lowest overhead** (17–36s multi-step turns); easy zero-leak config injection |
| **3. Ecosystem & Domestic CLIs** | Kimi Code, iFlow CLI, ZCode | Node.js stdio JSON / stream-json | Read/Write/Shell tools; ZCode emphasizes SQLite reasoning inspection | `.kimi-code/`, `.iflow/`, `db.sqlite` | Low-latency domestic endpoints; watch CLI quirks (e.g., Kimi `-p` vs `-y` conflict, ZCode Node 22 SQLite patch) |
| **4. General & MCP-First Agents** | OpenClaw, Goose | Embedded `agent --local --json`; Rust `goose.exe` + MCP | OpenClaw workspace agent; Goose `--with-builtin developer` + MCP | Session JSONL / Goose SQLite | Great for MCP & multi-channel workflows; OpenClaw has heavier cold start (30–55s) and needs `skipBootstrap` |
| **5. IDE Cores, Diff Editors & Desktop Hosts** | VS Code Cline (`@cline/core`), Continue (`cn`), Aider, Antigravity, WorkBuddy, DSH | Direct ESM import / YAML CLI / Python+LiteLLM / Loopback RPC & CDP | Aider is **diff-only** (no general shell tool); Desktop hosts use native GUI tools | SQLite / chat history MD / desktop state | Aider excels at low-token targeted Git diffs; desktop bridges leverage existing IDE sessions |

---

## 3. Local Runtime & Network/Proxy Requirements Matrix

### A. Local Environment Complexity Tiers

1. **Tier 1 — Zero External Runtime (Single Native Binary)**:
   - **Agents**: Claude Code (`claude.exe`), Codex (`codex.exe`), Copilot (`copilot.exe`), Kilo (`kilo.exe`), Crush (`crush.exe`), Goose (`goose.exe`), OpenCode (`opencode.exe`).
   - **Windows Pitfall**: Node's `child_process.spawn` (without `shell: true`) fails on `.cmd`/`.ps1` npm shims—always resolve the underlying native `.exe`.
2. **Tier 2 — Node.js ≥ 22 Runtime**:
   - **Agents**: Pi, Kimi Code, Continue CLI, iFlow, OpenClaw, Gemini CLI, ZCode, VS Code Cline (`@cline/core`).
   - **Windows Pitfalls**:
     - OpenClaw fails with `EPERM: operation not permitted, symlink` if Windows Developer Mode is off unless `plugins.enabled: false`;
     - ZCode requires `-r patch-sqlite.cjs` on Node 22.15.1 due to missing `DatabaseSync.prototype.isTransaction`;
     - PowerShell 5.1 mangles multi-byte UTF-8 pipes & inserts BOM `\uFEFF`, and lacks `||`—dispatch via UTF-8 `--file` from Node.js.
3. **Tier 3 — Bun Runtime (≥ 1.4)**:
   - **Agent**: Oh My Pi (`omp` uses ES2025 `using` syntax; Node 22 throws `SyntaxError`, must invoke native `bun.exe`).
4. **Tier 4 — Isolated Python Virtual Environment (3.10–3.12)**:
   - **Agent**: Aider (`aider-chat` pulls `litellm`, `tree-sitter`, `scipy`, etc.). Always isolate in a dedicated venv (e.g. `~/.local/aider-venv`) and set `PYTHONIOENCODING=utf-8` on Windows.
5. **Tier 5 — Active Desktop GUI Host**:
   - **Agents**: Antigravity, WorkBuddy, DSH (require running desktop app, dynamic port/log discovery, or temporary CDP lifecycle management).

### B. Network & Proxy Environment: Overseas AI vs. Domestic Direct Endpoints

| Aspect | Overseas Endpoints (Anthropic / OpenAI / Google Vertex & OAuth / GitHub) | Domestic Direct Endpoints (BigModel GLM / Kimi / DeepSeek / Ark) |
| :--- | :--- | :--- |
| **Proxy Requirement** | **Requires stable proxy / TUN** (`HTTP_PROXY` / `HTTPS_PROXY`, e.g. `127.0.0.1:7897`). | **Must bypass overseas proxies**—routing domestic endpoints through an overseas proxy causes high latency or timeouts. |
| **Node.js 22 `fetch()` Trap** | Node `v22.15.1` global `fetch()` **ignores `HTTPS_PROXY`**. Embedded libraries like `@cline/core` time out (`ConnectTimeoutError`) unless you enable system TUN or inject a custom `http.request({ method: "CONNECT" }) + tls.connect` tunnel `fetch`. | All domestic GLM bridges in this kit automatically `delete env.HTTP_PROXY` / `HTTPS_PROXY` when targeting `bigmodel.cn` or `z.ai` so they connect directly even inside proxied shells. |
| **Auth & Quota Traps** | OAuth credentials expire silently (`oauth_creds.json` prompting interactive login with `exit=0`); GCP Vertex shares per-model 429 buckets across tools. | Separate Coding Plan endpoints (`/api/coding/paas/v4`, `/api/v1`, `/api/anthropic`) from pay-as-you-go (`/api/paas/v4`); parallel multi-agent bursts can hit account `429 Rate limit exceeded`—stagger concurrent workers. |

---

## 4. Three Non-Negotiable Engineering Rules

1. **Zero Plaintext Secrets on Disk**: Config files (`config.toml`, `models.json`, `models.yml`, `crush.json`, `config.yaml`, `openclaw.json`) must only store environment-variable references (`env_key`, `${VAR}`, `$VAR`, `{env:VAR}`, `${{ secrets.VAR }}`). Run `verify-no-secrets.mjs` before any commit.
2. **UTF-8 Task Files (`--file`)**: Any task longer than 80 ASCII chars or containing non-ASCII text must be written to a UTF-8 file and verified before execution.
3. **3-Layer Acceptance**: Never equate `exit === 0` with success—require `(1) request accepted -> (2) protocol terminal event (`turn.completed`, `result.subtype="success"`, `agent_end`, `complete`, `isByok=true`) -> (3) independent check of written files & tests`.
