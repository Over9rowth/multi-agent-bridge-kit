<p align="center">
  <a href="https://github.com/Over9rowth">
    <img src="./docs/suiren-badge.svg" alt="OVER9ROWTH · 燧人计划" width="420" />
  </a>
</p>

# Local Multi-Agent Orchestration & Bridge Kit

[简体中文](README.md) | **English**

This open-source kit focuses on a single core engineering question: **how to build reliable local bridges across Coding Agents with completely different internal architectures**—so an Architect main Agent can discover, isolate, dispatch UTF-8 work orders to, and verify local worker Agents (desktop IDEs, embedded extension cores, or headless CLIs) without bloating the main context window.

The methodology is organized into **two distinct tracks**:
1. **Part I (Primary Focus — How to Build Bridges Across Agents)**: [`AGENT_BRIDGE_METHODOLOGY.en.md`](AGENT_BRIDGE_METHODOLOGY.en.md) — **5 Bridging Archetypes + Universal 5-Step Discovery Chain + 3-Layer Verification + Pitfalls 01–50** (applies whether the worker uses an existing desktop/subscription login or an external API key).
2. **Part II (Supporting Guide — Using Non-Official Models / External API Keys on Your Preferred Agent)**: [`AGENT_USAGE_AND_BYPASS_METHODOLOGY.en.md`](AGENT_USAGE_AND_BYPASS_METHODOLOGY.en.md) — a practical companion guide showing how to attach external API keys and custom endpoints to whichever Agent you prefer, plus each Agent's local runtime and network/proxy requirements.

---

## 📂 Repository Map

| File / Directory | Description |
| :--- | :--- |
| `README.md` / `README_EN.md` | **Quick-Start & Adapter Index**: Bilingual entry guide, handoff prompts, and command cheat sheets |
| `AGENT_BRIDGE_METHODOLOGY.md` / [`AGENT_BRIDGE_METHODOLOGY.en.md`](AGENT_BRIDGE_METHODOLOGY.en.md) | **Core 5-Step Bridge Methodology & Pitfalls (01–50)**: Process/CLI discovery, contract extraction, model registry lookup, session/permission isolation, and 3-layer verification |
| `AGENT_USAGE_AND_BYPASS_METHODOLOGY.md` / [`AGENT_USAGE_AND_BYPASS_METHODOLOGY.en.md`](AGENT_USAGE_AND_BYPASS_METHODOLOGY.en.md) | **Mainstream Agent Usage, BYO-Key Skip-Login & Environment Matrix**: How subscription logins are bypassed (and where they cannot be bypassed, e.g. Cursor Free tier & Qoder CLI pre-auth), architectural differences across 20 Agents, and runtime/network/proxy tiers |
| `dispatch-antigravity-template.mjs` | **Antigravity Adapter**: Loopback ConnectRPC + dynamic `--csrf_token` + EAGER auto-approval |
| `dispatch-codex-template.mjs` & `codex/` | **Codex Adapter (Dual Mode)**: Supports both ChatGPT subscription (`~/.codex/auth.json`) and **BYO-Key skip-login** (`--byok` + isolated `CODEX_HOME` + OpenAI Responses API), 6 unit tests |
| `workbuddy/` | **WorkBuddy Adapter**: Ephemeral `127.0.0.1` CDP → `__wbInvoke` IPC → native session, 11 unit tests |
| `dsh/` | **DSH Adapter**: Harness Web `/api` Connection RPC + signed cookie exchange, 10 unit tests |
| `zcode/` | **ZCode Adapter**: Node 22 `node:sqlite` transaction patch (`patch-sqlite.cjs`) + Z.ai reasoning syntax, 6 unit tests |
| `opencode/` | **OpenCode Adapter**: `opencode run --format json` + `opencode api` server-side verification, 7 unit tests |
| `gemini-cli/` | **Gemini CLI Adapter**: Direct `bundle/gemini.js`, `GEMINI_CLI_NO_RELAUNCH=true`, `-e none`, delta stitching & `stats.models` check, 7 unit tests |
| `cline/` | **VS Code Cline Adapter**: Embedded `@cline/core` ESM headless runtime + Node 22 `CONNECT` proxy `fetch`, 6 unit tests |
| `claude-code/` | **Claude Code Adapter (BYOK)**: `--bare` onboarding/login skip + `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`, 6 unit tests |
| `copilot/` | **GitHub Copilot CLI Adapter (BYOK)**: `COPILOT_OFFLINE=true` + Anthropic-protocol BYOK (`isByok=true, premiumRequests=0`), 6 unit tests |
| `kimi-code/` | **Kimi Code CLI Adapter (BYOK)**: Isolated `.kimi-code/config.toml` (`api_key_env`), 6 unit tests |
| `pi/` | **Pi Coding Agent Adapter (BYOK)**: Isolated `PI_CODING_AGENT_DIR/models.json` (`supportsDeveloperRole: false`), 6 unit tests |
| `omp/` | **Oh My Pi (`omp`) Adapter (BYOK)**: Native `bun.exe` + `models.yml` + `glob` toolset, 6 unit tests |
| `kilo/` | **Kilo CLI Adapter (BYOK)**: Pure in-memory `KILO_CONFIG_CONTENT` (`{env:...}`) + native `kilo.exe`, 6 unit tests |
| `crush/` | **Crush CLI Adapter (BYOK)**: `CRUSH_GLOBAL_CONFIG` zero-workspace-pollution + `session last --json` audit, 6 unit tests |
| `continue-cli/` | **Continue CLI (`cn`) Adapter (BYOK)**: `CONTINUE_GLOBAL_DIR` + YAML `${{ secrets.* }}` + `--fork`, 6 unit tests |
| `iflow/` | **iFlow CLI Adapter (BYOK)**: Isolated `.iflow/settings.json` (`openai-compatible`) + `IFLOW_API_KEY`, 6 unit tests |
| `openclaw/` | **OpenClaw Adapter (BYOK)**: `agent --local --json` + `plugins.enabled: false` (Windows symlink fix) + `skipBootstrap: true`, 6 unit tests |
| `goose/` | **Goose CLI Adapter (BYOK)**: Rust `goose.exe` + `GOOSE_DISABLE_KEYRING=true` + chunked stream assembly, 6 unit tests |
| `aider/` | **Aider Adapter (BYOK)**: Isolated Python venv `aider.exe` + `--target`/`--read` + read-only `--chat-mode ask`, 6 unit tests |
| `trae-agent/` | **Trae Agent (Open-Source) Adapter**: `bytedance/trae-agent` (`Python 3.12 + uv`) + `trae-launcher.py` Windows `cmd.exe` UTF-8 buffer patch + `traj.json` check, 6 unit tests |
| `docs/ENGINEERING_MANUAL_v0.2.zh-CN.md` | **Full Engineering Manual (v0.2, Chinese)**: Consolidated manual covering all 21 adapters, 131 unit tests, and Pitfalls 01–51 |

> **Golden Rule**: Protocols across Agents are **not interchangeable**. Never rename a script for a different Agent—always apply the 5-step discovery workflow. What is universal across all 20 adapters: **UTF-8 task-file dispatch (`--file`) + environment-variable credential injection (zero plaintext keys on disk) + 3-layer verification (accepted → protocol terminal event → independent artifact check)**.

---

## 🚀 Cross-Agent Headless Bridge Matrix (BYO-Key Verified Adapters)

All adapters below implement isolated workspace/config dispatch, environment-variable credential indirection (zero plaintext secrets on disk), and 3-layer closed-loop verification. *(Verification note: end-to-end smoke tests were run against a spare third-party GLM endpoint simply because it natively exposes OpenAI Chat, OpenAI Responses, and Anthropic Messages APIs; every adapter is completely vendor-agnostic and works with OpenAI, Anthropic, DeepSeek, OpenRouter, Ollama, or any compatible endpoint via `--base-url`, `--model`, and `--api-key-env`.)*

Each adapter passed `--status`, `--dry-run`, **Round 1** (read `fixture.json` & write `result.txt`), **Round 2** (`--reuse` cross-process memory recall), **cross-directory `--reuse` rejection**, `6/6` offline unit tests, and `verify-no-secrets.mjs` (`clean`).

| Agent | Directory / Script | Isolation & Auth Mechanism | Unit Tests & Audit | Verified E2E (R1 / R2 `--reuse`) |
| :--- | :--- | :--- | :--- | :--- |
| **Claude Code** | `claude-code/scripts/dispatch-claude.mjs` | `--bare` + `ANTHROPIC_BASE_URL` + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | 6/6, `clean` | R1 `23.8s` (`tools=3`) / R2 `9.3s` |
| **Codex (BYOK)** | `dispatch-codex-template.mjs --byok` | Isolated `CODEX_HOME` (`env_key` + `models.json` + `wire_api="responses"`) | 6/6, `clean` | R1 `19.8s` / R2 `19.7s` |
| **Copilot CLI** | `copilot/scripts/dispatch-copilot.mjs` | `COPILOT_OFFLINE=true` + `COPILOT_PROVIDER_TYPE=anthropic` | 6/6, `clean` | R1 `21.9s` (`isByok=true`) / R2 `6.8s` |
| **Kimi Code** | `kimi-code/scripts/dispatch-kimi.mjs` | Isolated `.kimi-code/config.toml` (`api_key_env`) | 6/6, `clean` | R1 `23.8s` (`tools=3`) / R2 `5.8s` |
| **Pi** | `pi/scripts/dispatch-pi.mjs` | `PI_CODING_AGENT_DIR/models.json` (`supportsDeveloperRole: false`) | 6/6, `clean` | R1 `17.8s` (`tools=3`) / R2 `7.1s` |
| **Oh My Pi (`omp`)** | `omp/scripts/dispatch-omp.mjs` | Native `bun.exe` + `models.yml` + `glob` toolset | 6/6, `clean` | R1 `17.7s` (`tools=3`) / R2 `5.9s` |
| **Kilo CLI** | `kilo/scripts/dispatch-kilo.mjs` | `KILO_CONFIG_CONTENT` (`{env:...}`) + native `kilo.exe` | 6/6, `clean` | R1 `36.4s` (`tools=3`) / R2 `15.9s` |
| **Crush** | `crush/scripts/dispatch-crush.mjs` | `CRUSH_GLOBAL_CONFIG` + `session last --json` | 6/6, `clean` | R1 `30.4s` (`tools=3`) / R2 `11.8s` |
| **Continue CLI** | `continue-cli/scripts/dispatch-continue.mjs` | `CONTINUE_GLOBAL_DIR` + YAML `${{ secrets.* }}` + `--fork` | 6/6, `clean` | R1 `34.9s` / R2 `16.2s` |
| **iFlow CLI** | `iflow/scripts/dispatch-iflow.mjs` | Isolated `.iflow/settings.json` + `IFLOW_API_KEY` + `-o exec-info.json` | 6/6, `clean` | R1 `27.3s` (`rounds=4`) / R2 `9.3s` |
| **OpenClaw** | `openclaw/scripts/dispatch-openclaw.mjs` | `agent --local --json` + `plugins.enabled: false` + `skipBootstrap: true` | 6/6, `clean` | R1 `55.9s` / R2 `39.3s` |
| **Goose** | `goose/scripts/dispatch-goose.mjs` | Native `goose.exe` + `GOOSE_DISABLE_KEYRING=true` + `OPENAI_HOST` | 6/6, `clean` | R1 `20.7s` (`tools=3`) / R2 `6.0s` |
| **Aider** | `aider/scripts/dispatch-aider.mjs` | Isolated Python venv `aider.exe` + `--target`/`--read` + `--chat-mode ask` | 6/6, `clean` | R1 `Applied edit` / R2 recall |
| **Trae Agent** | `trae-agent/scripts/dispatch-trae.mjs` | `Python 3.12 + uv` + `trae-launcher.py` UTF-8 patch + `traj.json` check | 6/6, `clean` | R1 `33.9s` (`tools=7`) / R2 `13.4s` |

### Quick Usage Example (Never hardcode API keys into files)

```powershell
# PowerShell: inject credential strictly in-memory via environment variable
$env:ZAI_API_KEY = "<YOUR_API_KEY>"

node claude-code/scripts/dispatch-claude.mjs --cwd D:\YourProject --file TASK_001.md --write
node dispatch-codex-template.mjs --byok --cwd D:\YourProject --file TASK_001.md --write
node pi/scripts/dispatch-pi.mjs --cwd D:\YourProject --file TASK_001.md --write

# Follow-up in the same module/session:
node claude-code/scripts/dispatch-claude.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
```

---

## 📋 Architect Handoff Prompt Template

```markdown
Read `AGENT_BRIDGE_METHODOLOGY.en.md` and `AGENT_USAGE_AND_BYPASS_METHODOLOGY.en.md` first.
In this project, you act as the Architect (planning, decomposition, and final verification).
Offload multi-file edits, builds, and test loops to our local bridge worker:
1. Run `node <adapter>/scripts/dispatch-<name>.mjs --status` to confirm readiness.
2. Always write tasks to a UTF-8 file (e.g. `TASK_001.md`), confirm it is saved, and dispatch with a short pure-ASCII command:
   `node <adapter>/scripts/dispatch-<name>.mjs --cwd <project> --file TASK_001.md --write`
   (Use `--reuse` only for follow-ups in the same module/directory; omit `--reuse` for new tasks.)
3. Never paste long multi-line UTF-8 prompts into `--prompt`; never trust exit code 0 alone—verify the protocol terminal event and independently inspect modified files and test output.
4. Never persist plaintext API keys in code, configs, state files, or docs.
```
