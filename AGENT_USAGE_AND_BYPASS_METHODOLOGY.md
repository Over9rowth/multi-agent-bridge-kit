# 第二部分（辅助篇）：如何在自己喜欢的 Agent 上使用非官方模型 / 接入外来 API Key 与环境门槛

**简体中文** | [English](AGENT_USAGE_AND_BYPASS_METHODOLOGY.en.md)

> **本篇定位（辅助手段，而非建桥目的本身）**：
> - **核心主篇**见 [`AGENT_BRIDGE_METHODOLOGY.md`](AGENT_BRIDGE_METHODOLOGY.md)——重点讲解**如何给不同架构的本地 Agent 建桥**（五类技术原型、五步建桥法、50+ 避坑库）；
> - **本篇（辅助篇）**解决的是另一个实际工程诉求：**当你选定了自己喜欢的某款 Agent（想用它的工具链或交互体验），但不想被官方会员或单一厂商模型绑定时，如何把外来的 API Key（如智谱 GLM、DeepSeek、OpenRouter 或私有兼容网关）无痕、安全地“拼接”进去**，以及不同 Agent 对本地运行时与网络代理的挑剔程度。

---

## 一、 如何把外来 API Key / 非官方模型拼接到自己喜欢的 Agent 上（4 种工程手法）

市面上主流编码 Agent 往往默认绑定厂商自家账号体系（如 Claude Pro/Max、ChatGPT Plus/Pro、GitHub Copilot 订阅、Kimi Code 会员、Google Gemini OAuth、iFlow 登录、Kilo Gateway 等）。但工程化场景下，开发者经常希望把**同一把 API Key（例如智谱 GLM Coding Plan、DeepSeek、OpenRouter 或自建网关）**复用进所有 Agent 中。

根据本机对主流工具及开源配置器 **CC Switch**（`farion1231/cc-switch`）的逆向与实测，跳过官方会员登录的核心手段可归为 **四类工程模式**：

### 模式 A：官方原生 `--bare` / BYOK 环境变量直覆（最干净，无需改全局配置文件）

部分大厂官方 CLI 已原生内置“自带密钥 + 离线跳过登录”开关：

1. **Claude Code（`@anthropic-ai/claude-code` v2.1.325）**：
   - **传统绕过法（CC Switch 方案）**：在 `~/.claude.json` 写入 `"hasCompletedOnboarding": true` 跳过交互式登录引导，再在 `~/.claude/settings.json` 写 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`。
   - **桥接器最优无痕法（实测通过）**：无头派单直接传 **`--bare`**（跳过首次安装确认、跳过个人 hooks/plugins、跳过账号登录检查），并通过子进程环境变量注入：
     - `ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`
     - `ANTHROPIC_API_KEY=<ZHIPU_KEY>`
     - `ANTHROPIC_MODEL=glm-4.7`、`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL=glm-4.7`
     - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（阻断非必要遥测与检查，防止无外网代理时卡顿）
2. **GitHub Copilot CLI（`@github/copilot` v1.0.112）**：
   - **关键坑点**：VS Code 自带的 `copilot-shim\copilot.exe` 只是安装引导占位符，不能直驱；必须安装 `@github/copilot` 定位原生 `copilot.exe`。
   - **原生 BYOK + 离线模式（实测 `isByok: true, premiumRequests: 0`）**：
     - `COPILOT_HOME=<隔离目录>`
     - `COPILOT_OFFLINE=true`（不连接 GitHub 服务器验证 Copilot 订阅）
     - `COPILOT_PROVIDER_TYPE=anthropic`
     - `COPILOT_PROVIDER_BASE_URL=https://open.bigmodel.cn/api/anthropic`
     - `COPILOT_PROVIDER_API_KEY=<ZHIPU_KEY>`
     - `COPILOT_MODEL=glm-4.7`
   - **协议选型坑点**：若用 `COPILOT_PROVIDER_TYPE=openai` 连推理模型，Copilot CLI 在工具调用续轮时不会回传 `reasoning_content`，容易触发上游 HTTP 400；**改用 `anthropic` 协议分支连接智谱 `/api/anthropic` 可彻底规避**。

### 模式 B：隔离配置目录 + Env-Var 间接引用（不碰用户现有登录态，磁盘零明文密钥）

大多数现代 CLI 从指定的 Home/Config 目录读取 Provider 配置，且**支持在配置文件中通过占位符引用环境变量**，从而实现“同一套脚本既隔离了用户的官方订阅配置，又不在磁盘留下任何明文 API Key”：

| Agent | 隔离配置目录 / 注入方式 | 配置文件中的环境变量间接引用语法 | 直连智谱 GLM 协议端点 | 关键避坑 |
| :--- | :--- | :--- | :--- | :--- |
| **Codex** (`codex.exe` 0.167) | 设 `CODEX_HOME=<非Temp隔离目录>` | `config.toml` 中写 `env_key = "ZAI_API_KEY"` + `wire_api = "responses"` + `model_catalog_json` | `https://open.bigmodel.cn/api/v1` | **不可放 `%TEMP%`**（会拒绝建 helper）；跳过空版本目录；非订阅隔离配置**不要加** `--ignore-user-config` |
| **Kimi Code** (`@moonshot-ai/kimi-code` 2.6.2) | 隔离 `HOME`/`USERPROFILE` 下 `.kimi-code/config.toml` | `api_key_env = "ZAI_API_KEY"`（`type = "openai"`） | `https://open.bigmodel.cn/api/coding/paas/v4` | v2.6.2 改读 `.kimi-code/` 而非 `.kimi/`；`-p` 模式下禁止叠加 `-y`/`--auto`/`--plan` |
| **Pi** (`@mariozechner/pi-coding-agent` 0.73) | `PI_CODING_AGENT_DIR` + `models.json` | `"apiKey": "ZAI_API_KEY"` | `https://open.bigmodel.cn/api/coding/paas/v4` | 必须配 `compat: { supportsDeveloperRole: false }`，否则 GLM 拒收 `developer` 角色 |
| **Oh My Pi** (`@oh-my-pi/pi-coding-agent` 18.20) | `PI_CODING_AGENT_DIR` + `models.yml` | `apiKey: ZAI_API_KEY` | `https://open.bigmodel.cn/api/coding/paas/v4` | 必须用 `bun.exe`（Node 22 报语法错）；内置工具是 `glob` 不是 Pi 的 `ls`/`find` |
| **Kilo CLI** (`@kilocode/cli` 7.8.27) | `KILO_CONFIG_CONTENT` 内存 JSON | `"apiKey": "{env:ZAI_API_KEY}"` | `https://open.bigmodel.cn/api/coding/paas/v4` | 必须调用原生 `kilo.exe`；`step_finish.part.reason === "stop"` 才算结束 |
| **Crush** (`@charmland/crush` 0.101) | `CRUSH_GLOBAL_CONFIG` + `-D <dataDir>` | `"api_key": "$ZAI_API_KEY"` | `https://open.bigmodel.cn/api/coding/paas/v4` | 用 `CRUSH_GLOBAL_CONFIG` 隔离配置，防止在用户项目目录残留 `crush.json` |
| **Continue CLI** (`@continuedev/cli` 1.5.47) | `CONTINUE_GLOBAL_DIR` + `--config <yaml>` | `apiKey: ${{ secrets.ZAI_API_KEY }}` | `https://open.bigmodel.cn/api/coding/paas/v4` | Windows 下 `-p` 必须显式传 `--prompt <taskFile>`；复用用 `--fork <sessionId>` |
| **iFlow CLI** (`@iflow-ai/iflow-cli` 0.5.19) | 隔离 `HOME` 下 `.iflow/settings.json` | `selectedAuthType: "openai-compatible"` + env `IFLOW_API_KEY`/`IFLOW_BASE_URL` | `https://open.bigmodel.cn/api/coding/paas/v4` | 无需在 `settings.json` 写 `apiKey`，全部由 `IFLOW_*` 环境变量覆盖 |
| **OpenClaw** (`openclaw` 2026.5.7) | `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` | `apiKey: "${ZAI_API_KEY}"` | `https://open.bigmodel.cn/api/coding/paas/v4` | 必加 `plugins.enabled: false`（防 Windows `EPERM` 符号链接崩溃）和 `skipBootstrap: true`（防生成 `SOUL.md`） |
| **Goose** (`aaif-goose/goose` 1.59.2) | 隔离 `GOOSE_PATH_ROOT` + `XDG_*` + `GOOSE_DISABLE_KEYRING=true` | 环境变量 `OPENAI_API_KEY` + `OPENAI_HOST` + `OPENAI_BASE_PATH=chat/completions` | `https://open.bigmodel.cn/api/coding/paas/v4` | 关闭 Keyring 防系统弹窗；`stream-json` 按 `message.id` 拼分片 |
| **Aider** (`aider-chat` 0.86.2) | `--model-metadata-file` 隔离 JSON | 环境变量 `OPENAI_API_KEY` + `OPENAI_API_BASE` | `https://open.bigmodel.cn/api/coding/paas/v4` | 非通用工具代理，需通过 `--target` / `--read` 传入文件；默认 `--chat-mode ask` |

### 模式 C：本地路由协议转换（CC-Switch Router / 聚合模式原理）

当某个客户端**只支持单一种协议**，而你手头的供应商**只提供另一种协议**时（例如早期只支持 OpenAI Chat Completions 的供应商接入只说 Responses API 的 Codex，或想让 Claude Code 调 Gemini/OpenAI 模型）：
- **CC Switch 的做法**：在 `127.0.0.1:15721` 启动一个本地 Rust HTTP 代理（“路由模式”），对外伪装成目标 CLI 期待的端点（如 Anthropic `/v1/messages` 或 OpenAI `/v1/responses`），对内按规则翻译成上游供应商协议并自动做故障转移与 thinking 整流器转换；若只需混用多家供应商模型，则在“聚合模式”中合并生成统一模型清单。
- **为什么智谱 GLM 在本次实测中不需要开 CC Switch 本地路由也能直连全部 13 个 Agent？**
  因为智谱开放平台目前已同时原生开放了 **三套标准协议端点**：
  1. **OpenAI Chat Completions**：`https://open.bigmodel.cn/api/coding/paas/v4`（Coding 套餐） / `https://open.bigmodel.cn/api/paas/v4`（标准按量）
  2. **OpenAI Responses API**：`https://open.bigmodel.cn/api/v1`（供 Codex CLI 原生 `wire_api = "responses"` 直连）
  3. **Anthropic Messages API**：`https://open.bigmodel.cn/api/anthropic`（供 Claude Code、GitHub Copilot CLI BYOK 直连）

### 模式 D：不可跳过或“有 BYOK 入口但仍强绑账号/会员”的类型（明确红线与本机实测取证）

并非所有自带 API Key 填写框的工具都能免会员/免登录直连：

1. **Cursor（基于 Cursor v3.29.x 客户端与源码核验）**：
   - **架构现状**：Cursor 桌面端（`Cursor.exe` + 内置扩展 `cursor-agent-host` / `cursor-always-local`）在免费账号（`stripeMembershipType = free`）下不提供可独立免登录直连第三方模型的开源 CLI。
   - **无法免会员直接用 GLM Agent 的底层原因（源码级证实）**：
     1. 核对 `workbench.desktop.main.js` 与 `cursor-agent-host/dist/main.js` 证实，Cursor 的 Chat / Composer / Agent 请求**均先发往 Cursor 云端后端 `https://api2.cursor.sh`**（专有 Protobuf/ConnectRPC），而非客户端本地直连第三方 API；
     2. 即使开启 `Override OpenAI Base URL`，`127.0.0.1` 或内网代理仍会被 Cursor 云端拒连，且 `free` 会员账号下对自定义模型与 Agent 实施服务端套餐门控（`BAD_MODEL_NAME: "The model ... does not work with your current plan or api key"`，智谱官方 Cursor 文档亦明确声明“**只有订阅了 Cursor 高级会员及以上的用户才支持自定义配置模型**”）；
     3. 即使其内部包含 `PrivateInference`（`CURSOR_PRIVATE_INFERENCE_CONFIG`）本地循环模块，也会调用 `readTeamEnablement()` 校验企业/团队授权（非团队账号报 `private-inference-not-enrolled`），且普通 `local-loop` 在 `getApiKey()` 前强制校验已授权订阅登录态（`No sign-in authorizes local...`）。
   - **合规替代方案（在 Cursor 中免会员用 GLM）**：① 在 Cursor 内安装兼容 VS Code 的开源 BYOK 扩展（如 **Cline**、**Kilo Code**、**Continue**）直连智谱；② 直接在 Cursor 终端运行本套件的 13 路免登录桥接器（`claude-code`、`codex --byok`、`pi`、`omp`、`kilo`、`crush` 等）。
2. **Qoder CLI（`@qoder-ai/qodercli` v1.1.89 实测）、TraeCode CLI (`traecli`) 与 Factory Droid**：
   - **先登录才能用 BYOK**：实测以隔离 `--config-dir` + `--settings`（传入 `providers` 自定义智谱端点）运行 `qodercli -p`，在发出任何模型请求前即以 `NonInteractiveAuthRequiredError: Not logged in · Please run /login`（exit 1）退出。核对 `qodercli.js` 源码证实 `authType` 仅接受 `qoder-browser` / `qoder-pat`，启动器 `BUd()` 强制先验 Qoder 登录态，然后才开放 `customModels`（BYOK）。Factory Droid 同理需先登录账号（且需海外手机验证）。
   - **Trae 三条产品线区分（⚠️ 本机未安装实测，基于官方文档、源码与社区实证核对）**：
     - **Trae IDE**（`trae.cn` / `trae.ai`）：**同样不能免登录，且自定义模型走云端中转并受账号套餐限制**——社区逆向与官方论坛已证实：① 必须联网登录 Trae 账号激活 AI 面板（断网报 997）；② 添加自定义 OpenAI 模型后，实际请求通过 WebSocket 走 Trae 官方 `/custom_model` 转发而非客户端直连；③ Free 免费账号（`identity: 0, permission: 0`）实际发消息会受限报 `503 No available accounts`（升级 Pro 或企业版后放行）。若要在 Trae IDE 内免会员用智谱 GLM，建议改在扩展中装 **Cline / Kilo Code / Continue**；
     - **商业版 `TraeCode CLI` (`traecli`)**：官方仅对 **TRAE CN 企业旗舰版**开放，强依赖 `traecli login` / `TRAECLI_PERSONAL_ACCESS_TOKEN`，个人版与无账号均不可用；
     - **开源版 `bytedance/trae-agent` (`trae-cli`)**：MIT 开源、**100% 支持免登录 BYO-Key**——现已在 `trae-agent/` 搭桥并实测跑通（基于 `uv` + Python 3.12.16，安装需加 `--extra evaluation` 补齐 `docker` 依赖，并用 `trae-launcher.py` 修复 Windows 中文 `cmd.exe` GBK 缓冲毒化与 `traj.json` 终态校验；R1 `33.9s`、R2 `--reuse` `13.4s`）。
3. **桌面私有 IPC / 本地动态令牌类（Antigravity、WorkBuddy、DSH）**：
   - 这些工具本身是依托已登录的桌面宿主运行的（如 Antigravity 的 ConnectRPC + `--csrf_token`、WorkBuddy 的临时 CDP + `__wbInvoke`、DSH 的启动令牌换签名 Cookie）。桥接器的设计原则是**合法复用已开启的本机桌面会话服务**，不提取桌面加密 Cookie，也不篡改安装包。
4. **硬件签名与已停用 OAuth（以千问生态为例）**：
   - 经对 `@qwen-code/qwen-code` v0.27.4 与千问桌面端 `qianwen.exe` 5.2.5.301 的只读分析：`qwen-oauth` 免费层已于 `2026-04-15` 停用；桌面端免 Key 请求依赖原生库 `SecurityGuardSDK64.dll` 签名 `X-U-SIGN-WG` / `X-U-KPS-WG`，外部进程**无法也严禁伪造**。
   - **未体验备案**：静态分析显示千问桌面端 `cowork-agent-host.asar` 内 `engine/bundle.cjs` 保留了 `DASHSCOPE_API_KEY` 直连分支，但**我们从未实际搭建垫片或实际体验过该“方案二”**（此前曾短暂验证过 `@qwen-code/qwen-code` CLI，现已按用户要求卸载并删除该环境）。

---

## 二、 市面 20 款主流 Agent 的架构定位与核心区别

按底层执行引擎、工具链形态与典型用途，目前套件内涵盖的 20 款 Agent 可分为 **五大阵营**：

| 阵营 | 代表 Agent | 核心通信/执行机制 | 工具调用与编辑能力 | 会话持久化 | 适用场景与明显短板 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. 一线大厂原生无头 CLI** | **Claude Code**, **Codex**, **Gemini CLI**, **GitHub Copilot CLI** | 原生二进制/官方 CLI JSONL over stdio（`--bare`/`exec --json`/`stream-json`） | 自带极成熟的文件读写、Diff/Patch、Bash/PowerShell 沙箱、子代理 | 本地项目级 JSONL / Rollout 文件 | **主力通用编码首选**；权限控制细（`plan` / `workspace-write` / `bypassPermissions`）；Codex 只认 Responses API，Copilot BYOK 推荐 Anthropic 协议 |
| **2. 轻量开源 Agentic CLI（Pi/OpenCode 系）** | **Pi**, **Oh My Pi (omp)**, **OpenCode**, **Kilo CLI**, **Crush** | 轻量本地 JSONL / HTTP API / SQLite，高度可定制 `models.json`/`yml` | 内置精细文件读取/编辑/搜索/Shell 工具；Crush 事后查 SQLite `session last --json` | 本地 JSONL 或 SQLite DB | **多模型实验与低开销调度首选**；`pi`/`omp` 工具调用极快（17s 级），`omp` 内建 `ast_grep`/`ast_edit`；`kilo` 可纯内存 JSON 注入零落盘配置 |
| **3. 国产开源/生态 CLI** | **Kimi Code**, **iFlow CLI**, **ZCode** | Node.js / CLI 无头流式或 stdio JSON | 自带 Read/Write/Shell 工具；ZCode 偏推理展示与 SQLite 直读 | `.kimi-code/`、`.iflow/`、`~/.zcode/cli/db/db.sqlite` | **国内直连延迟极低**；注意各自奇特的参数约束（如 Kimi `-p` 禁搭 `-y`、ZCode 需 Node 22 SQLite 补丁） |
| **4. 通用个人/开源多平台 Agent** | **OpenClaw**, **Goose** | OpenClaw 嵌入式 `--local --json`（本用于网关/IM 频道）；Goose Rust 引擎 + MCP 扩展 | OpenClaw 偏通用工作区助手（会自建 `SOUL.md` 需禁）；Goose 靠 `--with-builtin developer` | 会话 JSONL / Goose SQLite | **跨场景自动化与 MCP 生态强**；OpenClaw 冷启动较慢（30–55s），Goose Rust 二进制启动快且支持 MCP 扩展矩阵 |
| **5. IDE 扩展/Git-Diff/桌面宿主** | **VS Code Cline (`@cline/core`)**, **Continue CLI (`cn`)**, **Aider**, **Antigravity**, **WorkBuddy**, **DSH** | Cline 直导扩展 ESM 核心；Continue 走 YAML 配置；Aider Python+LiteLLM+Git Diff；其余走桌面 RPC/CDP | Aider **无通用 Shell 工具**，专攻精确文件 Diff 编辑；Antigravity/WorkBuddy/DSH 依赖运行中的桌面端 | SQLite / `.aider.chat.history.md` / 桌面内存 | **Aider 适合已有 Git 仓的定向重构**；Cline/Continue 适合复用 IDE 规则与上下文；桌面宿主流（Antigravity/WorkBuddy/DSH）最适合直接复用已登录的免费/套餐桌面额度 |

---

## 三、 本地环境要求、运行时梯度与网络/代理要求高低

这是实际部署中最容易踩坑的部分。不同 Agent 对 **本地运行时、系统权限、网络代理** 的依赖门槛差异极大：

### 1. 本地环境门槛梯度（从低到高）

| 等级 | 运行时与系统要求 | 代表 Agent | 典型本地踩坑与应对 |
| :--- | :--- | :--- | :--- |
| **Tier 1：零额外运行时（原生单文件可执行程序）** | 只要对应 OS 的单个原生 `.exe`（Go / Rust / Zig / 打包二进制），无需装 Python/Bun | **Claude Code** (`claude.exe`), **Codex** (`codex.exe`), **Copilot** (`copilot.exe`), **Kilo** (`kilo.exe`), **Crush** (`crush.exe`), **Goose** (`goose.exe`), **OpenCode** (`opencode.exe`) | Windows 下切勿在 Node `spawn(..., { shell: false })` 中调用 npm 生成的 `.cmd`/`.ps1` 包装脚本，必须定位到包内原生 `.exe`；Codex 可能在 `%LOCALAPPDATA%\OpenAI\Codex\bin\` 留存空哈希目录 |
| **Tier 2：纯 Node.js ≥ 22 环境** | 需要 Node 22.15+（直接 `node dist/xxx.js` 拉起） | **Pi**, **Kimi Code**, **Continue CLI**, **iFlow**, **OpenClaw**, **Gemini CLI**, **ZCode**, **Cline (`@cline/core`)** | 1. **Windows 符号链接 `EPERM`**：OpenClaw 启用内置插件会在未开启 Windows 开发者模式时建 symlink 失败，必须设 `plugins.enabled: false`；<br>2. **Node 22 `node:sqlite` 兼容**：ZCode 需 `-r patch-sqlite.cjs` 补丁修复 `DatabaseSync.isTransaction` 缺失；<br>3. **PowerShell 5.1 编码**：PS 5.1 管道与重定向默认带 UTF-8 BOM `\uFEFF` 且按 GBK 解码，且不支持 `||`，必须用工单文件 `--file` 交由 Node `spawn` 读写 UTF-8 |
| **Tier 3：特殊 JS 运行时（Bun）** | 强依赖 **Bun ≥ 1.4**（ES2025 `using` 语法） | **Oh My Pi (`omp`)** | Node 22.15 直接跑会 `SyntaxError: Unexpected identifier`；必须安装 `bun` 并显式调用原生 `bun.exe` |
| **Tier 4：重型 Python 虚拟环境** | 需要 Python 3.10–3.12 独立 `venv` + 上百个科学计算/解析轮子（`litellm`、`tree-sitter`、`scipy`、`tiktoken` 等） | **Aider** (`aider-chat` 0.86.2) | 切勿直接 `pip install` 污染全局 Python；建议隔离到 `%USERPROFILE%\.local\aider-venv`，并设 `PYTHONIOENCODING=utf-8` 防 Windows GBK 崩溃 |
| **Tier 5：依赖已启动的桌面 GUI 宿主** | 必须先登录并保持桌面 IDE/App 在前台或后台运行 | **Antigravity**, **WorkBuddy**, **DSH** | 需处理动态端口发现、临时 CDP 启动与退出后 Restore（如 WorkBuddy）、或特定签名 Cookie 交换（DSH） |

### 2. 网络环境差异：境外 AI 服务 vs 国内直连端点

| 维度 | 境外 AI 服务（Anthropic / OpenAI / Google Vertex & Gemini OAuth / GitHub） | 国内直连 API（智谱 GLM / Kimi / DeepSeek / 火山方舟 / 阿里云百炼） |
| :--- | :--- | :--- |
| **代理要求** | **强依赖稳定境外节点**（通常需本机全局 TUN 或本地 HTTP/HTTPS 代理端口，如 `127.0.0.1:7897`） | **必须直连，严禁误挂境外代理！**（走境外代理不仅延迟飙升 3–10 倍，部分国内 CDN/WAF 还会直接重置或超时） |
| **Node.js 22 代理陷阱** | **核心大坑**：Node `v22.15.1` 原生全局 `fetch()` **默认忽略 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量**（且不支持 `NODE_USE_ENV_PROXY`），导致 `@cline/core`、`Gemini` 等直连 `oauth2.googleapis.com:443` 报 `ConnectTimeoutError`。<br>👉 **解法**：要么系统开启 TUN 模式，要么像 `cline/scripts/dispatch-cline.mjs` 那样注入手写零依赖 `http.request({method:"CONNECT"}) + tls.connect` 隧道 `fetch` | 本套件所有国内 GLM 桥接器在检测到 `bigmodel.cn` / `z.ai` 基址时，**自动从子进程 `env` 中 `delete HTTP_PROXY / HTTPS_PROXY`**，即使主终端挂着境外代理也能秒级直连智谱 |
| **打包代理兼容 Bug** | 部分第三方打包 CLI（如实测过的 Qwen Code v0.27.4 `--auth-type vertex-ai`）存在 `HttpsProxyAgent is not a constructor` 内部兼容错误 | 国内直连彻底绕开 `HttpsProxyAgent` 路径，零依赖故障 |
| **认证与配额稳定性** | 易遇 `oauth_creds.json` 过期静默弹窗、GCP 429 单模型限流桶竞争（如本机实测 `gemini-4-carbon` 易 429 而 `gemini-4-argon` 可用） | **需区分套餐端点与按量端点**（如智谱 Coding Plan 走 `/api/coding/paas/v4`、`/api/v1`、`/api/anthropic`，标准按量走 `/api/paas/v4`）；高频并发仍可能触发 `429 Rate limit exceeded`（实测并行拉起多个 Agent 时触发），需控制并发或错峰重试 |

---

## 四、 实战选型与配置建议

1. **如果你只要一把智谱 GLM API Key 跑通全部主流 Agent（推荐主力矩阵）**：
   - **日常重度编码/多文件修改**：优先 **Claude Code (`--bare`)**、**Codex (`--byok`)**、**Pi** 或 **Oh My Pi (`omp`)** —— 实测单轮文件读写 17–24 秒、跨进程 `--reuse` 6–19 秒、权限清晰且零全局配置污染；
   - **想免费蹭用 Copilot/Kimi/Continue/Goose 外壳生态**：**GitHub Copilot CLI (`COPILOT_OFFLINE=true` + `anthropic`)**、**Kimi Code (`api_key_env`)**、**Goose (`goose.exe`)** 均为原生级支持，100% 实测通过；
   - **已有 Git 仓库只做精准 Diff 改动**：**Aider (`--target ... --write`)** Token 极其省（单轮仅 ~700–1200 tokens）；
   - **需要切回境外旗舰推理模型（如 Gemini 4 Argon / Claude / GPT）**：优先走本机已就绪的 **OpenCode (`opencode/`)**、**VS Code Cline (`cline/`)**、**Gemini CLI (`gemini-cli/`)** 或桌面端 **Antigravity / WorkBuddy / DSH**。
2. **三条不可违背的安全与工程铁律**：
   - **磁盘零明文密钥**：所有桥接器配置文件（`config.toml`、`models.json`、`models.yml`、`crush.json`、`config.yaml`、`openclaw.json`）一律只写环境变量引用名，每次改动后必跑 `verify-no-secrets.mjs`；
   - **UTF-8 工单文件派单 + 黄金校验**：超过 80 字符或含中文的任务必须落盘为 UTF-8 `--file`，禁止长中文直接拼接在 PowerShell 命令行；
   - **三层验收不轻信退出码**：同时核验进程 `exit=0`、协议终态事件（如 `turn.completed` / `result.subtype=success` / `agent_end` / `complete` / `isByok=true`）以及目标文件是否真实落盘。
