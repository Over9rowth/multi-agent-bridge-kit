# 本地 Agent 桥接套件 · 完整工程手册 (v0.2)

整理日期：2026-11-04（Asia/Shanghai）。版本：v0.2。
本文件在 v0.1 基础上，结合 **ZCode** 本地多智能体桥接落地实战进行了全量升级。新增 ZCode 桥接器专章、Node 22 SQLite 兼容补丁机制、Z.ai 平台密钥格式规范、坑点 21–25 深度排障索引、会话直读与思考链解析能力，以及端到端敏感凭据脱敏安全规范。

> [!IMPORTANT]
> **安全红线**：本手册及所有关联文档严格遵守凭据安全规范，严禁明文记录或外泄真实 API Key。文中所涉密钥均使用脱敏占位符（如 `<YOUR_ZAI_API_KEY_ID>.<YOUR_ZAI_API_KEY_SECRET>`）。实际部署请通过环境变量或加密配置文件注入。

---

## 目录

- [01 · 总览与快速开始](#ch01)
- [02 · 通用方法与协议对照](#ch02)
- [03 · Antigravity 桥接器](#ch03)
- [04 · Codex 桥接器](#ch04)
- [05 · WorkBuddy 桥接器](#ch05)
- [06 · DSH / DeepSeek Harness 桥接器](#ch06)
- [07 · ZCode 桥接器](#ch07) *(v0.2 新增)*
- [08 · 排障与维护（含坑点 01–25 统一索引）](#ch08) *(v0.2 扩充)*
- [09 · 工单与交接模板](#ch09) *(v0.2 扩充)*
- [10 · 证据、来源与核对记录](#ch10) *(v0.2 扩充)*

---

<a id="ch01"></a>

# 01 · 总览与快速开始

## 1. 这套工具解决什么问题

主 Agent（如架构师、编排中枢）负责与用户确认需求、拆解任务并进行多轮业务验收；执行 Agent 则负责读取工单、执行具体的文件读写、代码重构、测试套件运行，并回传结构化结果。桥接器负责将工单任务精准投递至本地运行的 Agent 客户端、维护本地会话持久化并等待协议终态。

这种分工把大模型长链路、高消耗的代码编辑与测试循环卸载至本地运行的专用 Agent，极大地减少了主会话的上下文膨胀。

“Multi-Agent Orchestration”在这里指主 Agent 依据工单标准驱动底层执行客户端。本手册提供实事求是的工程落地实现与排障记录，不作脱离可复核证据的虚假性能宣传。

## 2. 工作区地图

| 路径（相对工作区根目录） | 内容说明 |
| --- | --- |
| `README.md` | 原入口与 20 款 Agent 桥接器速查索引，包含一键接手提示词与常用命令 |
| `AGENT_BRIDGE_METHODOLOGY.md` | 通用方法论与坑点 01–50 实战避坑库 |
| `AGENT_USAGE_AND_BYPASS_METHODOLOGY.md` | **主流 Agent 使用、免会员跳过登录（BYO-Key）与环境门槛方法论**（2026-11-16 新增） |
| `CODEX_BRIDGE_EXPERIENCE.md` | Codex 历史实现与实测记录（BYO-Key 免登录模式另见 `codex/README.md`） |
| `dispatch-antigravity-template.mjs` | Antigravity 适配脚本 |
| `dispatch-codex-template.mjs` | Codex 适配脚本（支持 ChatGPT 订阅 + BYO-Key / GLM 免登录双模式） |
| `claude-code/`、`codex/`、`copilot/`、`kimi-code/`、`pi/`、`omp/`、`kilo/`、`crush/`、`continue-cli/`、`iflow/`、`openclaw/`、`goose/`、`aider/`、`trae-agent/` | **14 路可插拔外接 API（BYO-Key）无头桥接套件**（各含 `scripts/`、`*.test.mjs`、`verify-no-secrets.mjs` 与 `README.md`） |
| `workbuddy/` | WorkBuddy 说明、派发器、启动/恢复脚本和离线测试 |
| `dsh/` | DSH 说明、派发器、离线测试和审计脚本 |
| `dsh/private/` | 历史工单、fixture、状态与结果；包含本机运行信息，不是通用默认配置 |
| `zcode/` *(v0.2 新增)* | ZCode 桥接套件：适配器、SQLite 兼容补丁、6 项离线单元测试及 README |
| `zcode/scripts/dispatch-zcode.mjs` | ZCode 专用派发器，支持任务派单、会话复用、状态直读、历史查询与 Dry-Run |
| `zcode/scripts/patch-sqlite.cjs` | Node 22 内置 `node:sqlite` 事务状态补丁与良性 stderr 拦截器 |
| `zcode/scripts/dispatch-zcode.test.mjs` | ZCode 桥接器 6 项离线单元测试 |
| `文档/` | 本次整合成果：分章与合并版工程手册（v0.1 / v0.2） |

## 3. 五种桥接器怎么选

按本地已经安装、已配置凭据且准备使用的目标软件选取适配器。软件显示名或相似参数不代表协议兼容。

| 目标 | 连接方式 | 使用前提 | 权限行为 | 状态与数据落盘位置 |
| --- | --- | --- | --- | --- |
| **Antigravity** | 本地回环 ConnectRPC | 运行 `language_server.exe`，能读取进程与监听端口 | 开启 EAGER，自动确认 `runCommand` | 当前目录 `.agent-bridge-state.json` |
| **Codex** | 原生 CLI，JSONL over stdio | 找得到原生 CLI 可执行文件，CLI 已登录 | 默认 `workspace-write`；绕过审批需显式参数 | 工作根 `.codex-bridge-state.json` |
| **WorkBuddy** | 临时 CDP → `__wbInvoke` → 原生 IPC | 临时调试实例、唯一主渲染器、Node ≥ 22 | 原生 `default`，桥接器不自动批准 | 启动目录 `private/workbuddy-bridge/state.json` |
| **DSH** | Harness Web Connection RPC | DSH 已运行，能发现 Harness 进程与启动日志 | 原生策略，桥接器提示待审批 | 启动目录 `private/dsh-bridge/state.json` |
| **ZCode** *(v0.2)* | Node 22 进程拉起 + 补丁，stdio JSON | 本地安装 ZCode 桌面端或 CLI，Z.ai 两段式 API 密钥 | 默认 `--mode yolo`，执行命令受控 | 状态：`private/zcode-bridge/state.json`；底库：`~/.zcode/cli/db/db.sqlite` |
| **OpenCode** *(2026-11-16)* | `opencode run --format json` + `opencode api` | 本机安装 `@opencode/cli`（原生 `opencode.exe`），后台服务已就绪或 `--standalone` | 默认保留原生权限；仅显式 `--auto` 放行非拒绝项 | 启动目录 `private/opencode-bridge/state.json` + `last-result.json` |
| **Gemini CLI** *(2026-11-16)* | `node bundle/gemini.js -p "" -o stream-json` | 本机全局 npm `@google/gemini-cli`（v0.68.0），Vertex AI 或有效 OAuth 凭据 | 默认 `default` 审批，`-e none` 禁扩展；施工需 `--write`（`yolo`） | 启动目录 `private/gemini-bridge/state.json` + `last-result.json` |
| **Cline** *(2026-11-16)* | 内嵌 `@cline/core` ESM 核心 (`ClineCore`) | 本机 VS Code 安装 `saoudrizwan.claude-dev`，Node 22 代理隧道 `fetch` | 默认拒绝未授权写/命令；施工需 `--write` | 启动目录 `private/cline-bridge/state.json` + `~/.cline/data/db/sessions.db` |
| **Claude Code** *(2026-11-16)* | `claude.exe -p --bare --output-format stream-json` | `@anthropic-ai/claude-code` + 环境变量 `ANTHROPIC_BASE_URL` / `API_KEY` | 默认 `default`；施工需 `--write` (`bypassPermissions`) | `private/claude-bridge/state.json` |
| **Codex (BYOK)** *(2026-11-16)* | `codex.exe exec --json` + 隔离 `CODEX_HOME` | `--byok` 或 `ZAI_API_KEY` + `/api/v1` `wire_api="responses"` | 默认 `workspace-write`；施工需 `--write` | `private/codex-bridge/state.json` + `codex-home/` |
| **Copilot CLI (BYOK)** *(2026-11-16)* | `copilot.exe -p --output-format json` | `@github/copilot` + `COPILOT_OFFLINE=true` + `anthropic` 协议 | 默认只读；施工 `--write` (`--allow-all`) | `private/copilot-bridge/state.json` |
| **Kimi Code** *(2026-11-16)* | `node main.mjs --output-format stream-json -p` | `@moonshot-ai/kimi-code` v2.6.2 + 隔离 `.kimi-code/config.toml` (`api_key_env`) | `-p` 自动执行（禁止与 `-y`/`--plan` 混用） | `private/kimi-bridge/state.json` |
| **Pi / Oh My Pi (`omp`)** *(2026-11-16)* | `node cli.js` / `bun.exe cli.js --mode json -p` | `PI_CODING_AGENT_DIR` + `models.json`/`yml` (`supportsDeveloperRole: false`) | 默认只读工具集；施工 `--write` | `private/{pi,omp}-bridge/state.json` |
| **Kilo / Crush** *(2026-11-16)* | `kilo.exe run --format json` / `crush.exe run -q` | `KILO_CONFIG_CONTENT` 内存注入 / `CRUSH_GLOBAL_CONFIG` 隔离 | 施工 `--write` (`--auto` / `-y`) | `private/{kilo,crush}-bridge/state.json` |
| **Continue / iFlow** *(2026-11-16)* | `cn.js --config <yaml> -p` / `iflow.js -o exec-info.json -p` | `CONTINUE_GLOBAL_DIR` + `${{ secrets.* }}` / `IFLOW_API_KEY` | 默认 `--readonly`/`--plan`；施工 `--write` | `private/{continue,iflow}-bridge/state.json` |
| **OpenClaw / Goose / Aider / Trae Agent** *(2026-11-16)* | `openclaw agent --local` / `goose.exe run` / `aider.exe` / `trae-launcher.py run` | OpenClaw 禁插件防 `EPERM`；Goose 禁 Keyring；Aider/Trae 隔离 Python venv（Trae 附 `cmd.exe` UTF-8 补丁） | Aider 默认 `--chat-mode ask`；Trae 默认禁 `bash`/编辑工具；施工 `--write` | `private/{openclaw,goose,aider,trae}-bridge/state.json` |

## 4. 从零开始的操作顺序

1. **环境准备**：准备 Windows PowerShell 与 Node.js（推荐 Node `v22.15.1` 或具备对应内置 API 的 Node 22 环境）。
2. **选择适配器**：按需选取单一适配器，阅读对应手册前提与目录隔离规则，无需多目标同时部署。
3. **确认认证与凭据**：
   - Antigravity / Codex / WorkBuddy / DSH：复用桌面现有登录态或进程启动令牌；
   - ZCode：配置标准 Z.ai 两段式 API 密钥（`{apiKeyId}.{secret}`），禁止使用单段非法密钥。
4. **编写 UTF-8 工单**：在目标项目编写任务工单，明确输入约束、改动边界与可独立核验的验收条件（AC）。
5. **执行离线预检**：支持预检的适配器先执行 `--dry-run`，核验参数拼装、工作目录与工单 SHA-256 哈希。
6. **派发任务**：按手册派单，完整记录任务哈希、执行工作区、会话 ID 与模型配置。
7. **三层验收核验**：分别核验“请求被接受”、“协议终态成立”与“工单业务产物验收”。
8. **清理与恢复**：WorkBuddy 需执行 Restore 还原桌面端并检查调试端口；ZCode 任务可通过 `--show latest` 直读本地 SQLite 会话及思考链，确认推理完整性。

## 5. 三层验收体系

| 层次 | 能证明什么 | 不能证明什么 | 典型验证方式 |
| --- | --- | --- | --- |
| **第一层：请求被接受** | 客户端/进程已成功接收工单载荷 | 任务已执行、产物已生成 | DSH `Prompt accepted`、ZCode 进程收到 prompt |
| **第二层：协议终态成立** | 本轮执行已达通信协议正常终止点 | 代码逻辑正确、测试确实通过 | Codex `turn.completed`、ZCode `result` 响应与 exit 0 |
| **第三层：工单业务验收** | 独立验证产物内容、测试套件通过 | 未来版本仍兼容、未测场景也正确 | 主 Agent 独立读取改动文件、运行测试、核验 SHA-256 |

---

<a id="ch02"></a>

# 02 · 通用方法与协议对照

## 1. 五步搭桥方法论

面向任意本地运行的 AI 客户端，统一遵循以下五步完成工程化桥接：

| 步骤 | 核心任务 | 输出与交付物 |
| --- | --- | --- |
| **1. 发现入口** | 确定目标软件暴露的通信通道（CLI 可执行文件、回环 RPC、本地 WebSocket/CDP 还是 Node entry bundle） | 动态探测逻辑、可执行路径与备选 Fallback 列表 |
| **2. 还原契约** | 分析输入参数、交互协议（stdio JSONL/JSON、ConnectRPC、HTTP 信封）、鉴权方式与终态判定 | 最小请求构造器、响应解析器、运行时兼容补丁 |
| **3. 确认模型** | 确定模型注册表来源（实时查询、本地缓存或 ModelPicker 语法选择器） | 模型与思考强度配置规范、合法模型映射表 |
| **4. 会话与权限** | 明确工作目录作用域、状态持久化方式、会话创建与复用机制，评估权限副作用 | 会话创建/复用逻辑、原子状态写入、目录匹配检查 |
| **5. 验收闭环** | 建立三层验收标准，支持离线预检（Dry-Run），提供执行结果审计能力 | `--dry-run` 预演、超时处理、历史对话与思考链直读工具 |

## 2. 五个样本的实际架构映射表

| 项目 | Antigravity | Codex | WorkBuddy | DSH | ZCode *(v0.2)* |
| --- | --- | --- | --- | --- | --- |
| **入口发现** | 扫描 `language_server.exe`、端口、CSRF Token | `CODEX_BIN` → PATH → 版本化 bin | 启动器建立临时端口，筛选主渲染器 | 扫描 Harness 进程 + 读取启动日志 | `findZCodePaths()` 扫描 `<ZCODE_INSTALL_DIR>` 及 `resources/glm/zcode.cjs` |
| **通信协议** | ConnectRPC JSON | 原生 CLI，`codex exec --json` (JSONL) | CDP `Runtime.evaluate` 调原生 IPC | HTTP Connection RPC 信封 | Node 22 原生进程拉起，stdio JSON 管道通信 |
| **前置补丁** | 无 | 无 | 无 | 无 | `patch-sqlite.cjs`（Node 22 SQLite 事务补丁） |
| **认证与凭据** | 进程启动命令行参数 | CLI 自行读取已登录账号态 | 桌面端原生上下文 | 启动令牌换取签名 Cookie | `provider_config.json`，Z.ai 两段式 API 密钥 |
| **模型契约** | RPC 实时注册表（status 仅 Flash） | `models_cache.json` 本地缓存 | CLI 可用模型白名单 | 实时 `session/modelCatalog` | ModelPicker 语法：`${provider}/${model}$${thinking}` |
| **模型层级** | 宿主默认 / 旗舰或工兵自选 | CLI 默认 / 自选 | 平台白名单模型 | 实时 Catalog / 自选 | 平台注册模型 / 自选思考强度 |

> [!NOTE]
> **【关于模型选型与代际演进的说明】**：
> 大语言模型更新换代极为迅速。本工程手册**不限定、不锁死、也不特别推荐任何具体的商业模型名称**。
> 本套桥接架构的核心在于“通信通道与控制协议打通”。在实际工程分工中，用户根据任务层级自主配置：
> - **顶层架构 / 深度推导**：配置当期最前沿的**旗舰级推理大模型**；
> - **代码修改 / 测试运行 / 批量工单**：配置当期低成本、高吞吐的**轻量级执行工兵模型**。
| **本轮定位** | `baseSteps` 后的增量轨迹 | 子进程 stdio 事件流 / thread | `session:sendMessage` 响应 | baseline + requestId + 增量事件 | stdio `result` 输出 + SQLite 会话记录 |
| **终态判定** | IDLE、无未决步骤、连续稳定 | exit=0、无错误、`turn.completed` | `end_turn`、SUCCESS、非空文本 | running=false、turn/end、连续两次游标稳定 | exit=0、解析出 `turnId` 与非空响应 |
| **数据落盘** | 当前目录 `.agent-bridge-state.json` | 工作根 `.codex-bridge-state.json` | `private/workbuddy-bridge/state.json` | `private/dsh-bridge/state.json` | 状态文件 + `~/.zcode/cli/db/db.sqlite` 底库 |

## 3. 架构分流特性：CLI 无头进程 vs Electron 渲染层存储隔离

在图形化 AI IDE（如 ZCode、WorkBuddy 等）中，存在明确的架构分层：
1. **桌面图形视窗（GUI）**：运行在 Electron 渲染进程中，聊天历史与 UI 状态存储于 Chromium 层的 `IndexedDB` 或 `LocalStorage`。
2. **底层 CLI 引擎（Headless Bridge）**：专为自动化编排与批处理设计，独立于桌面渲染进程，会话记录持久化于本机的 SQLite 数据库（例如 ZCode 的 `~/.zcode/cli/db/db.sqlite`）。

**重要推论**：
- 通过桥接器在无头模式下派发的任务，**不会自动弹现在桌面图形客户端的会话列表中**；
- 这是为了避免多智能体高并发、批处理任务污染用户的日常开发会话；
- 查看历史会话必须依赖桥接器提供的直读工具（如 `--show [sessionId|latest]`），不能以“桌面窗口看不到”为由断言任务未执行。

---

<a id="ch03"></a>

# 03 · Antigravity 桥接器

来源：[现有脚本](../dispatch-antigravity-template.mjs)、[原方法论](../AGENT_BRIDGE_METHODOLOGY.md)、[原入口](../README.md)。本章按脚本静态核对；本次仅做语法检查，没有连接 Antigravity。

## 1. 前提与执行目录

需要 Windows、Node、运行中的 `language_server.exe`，且当前终端可执行 PowerShell CIM 和查询该进程监听端口。脚本 metadata 固定为 Antigravity `2.28.2`，不是实时版本探测。

以下命令从**工作区根目录**执行。任务默认在该目录运行；以后复制到其他项目时应从对应项目根执行。文件要先写好，不能把模板说明直接当已存在的工单。

```powershell
node dispatch-antigravity-template.mjs --status
node dispatch-antigravity-template.mjs --file TASK-001.md
node dispatch-antigravity-template.mjs --reuse --file TASK-002.md
node dispatch-antigravity-template.mjs --reuse --model sonnet --file TASK-002.md
```

原材料常用 `scripts/dispatch-flash.mjs`，这是部署到项目后的人为命名；当前套件没有这个路径。上面使用真实存在的根目录脚本名。

## 2. 参数与运行文件

| 参数 | 当前行为 |
| --- | --- |
| `--status` | 发现进程和可用 RPC 端口，打印连接摘要与 Flash 模型子集 |
| `--file FILE` | 从当前工作目录解析并以 UTF-8 读取工单 |
| `--reuse` | 尝试从 `.agent-bridge-state.json` 取 lastCascadeId；没有状态时新建 |
| `--model VALUE` | 静态别名映射，否则把 VALUE 当模型 ID 发送；不校验实时可用性 |
| `--cascade ID` | 显式指定 cascade，优先于 reuse；只可用于明确受控的会话 |
| `--timeout SEC` | 等待循环秒数，默认 600；不是所有网络请求的绝对截止时间 |
| `--prompt TEXT` | 实现上支持；本套流程统一使用工单文件 |

没有 `--cwd`、`--dry-run`、`--models` 或帮助分支。未知参数会被忽略，不能用退出成功判断参数有效。工单只做解码与非空判断，没有 WorkBuddy/DSH 的严格 UTF-8、BOM 处理和 1 MiB 限制。

默认状态文件位于 `process.cwd()`，保存 lastCascadeId 和 modelId；没有完成状态、工单哈希、派单锁或独立 `last-result.json`。多进程运行可能互相覆盖状态。

## 3. 连接与请求契约

脚本选取进程表中的**首个** `language_server.exe`，从命令行读取 `--csrf_token`，枚举该进程监听端口，逐个调用 `GetCascadeModelConfigData` 找可用端口。多个实例时未提供精确实例选择器；不能假设首个进程一定对应希望操作的项目。

```text
POST http://127.0.0.1:<动态端口>/exa.language_server_pb.LanguageServerService/<Method>
Content-Type: application/json
Connect-Protocol-Version: 1
x-codeium-csrf-token: <本进程动态值>
```

新会话调用 `StartCascade`，包含 metadata、`workspaceUris`、source 与 trajectoryType 枚举；随后记录 baseSteps，调用 `SendUserCascadeMessage`，再轮询轨迹和步骤。

| RPC 方法 | 当前脚本中的关键内容 |
| --- | --- |
| `GetCascadeModelConfigData` | `{}`，用于试探端口/取模型配置 |
| `StartCascade` | workspaceUris 为当前根的 file URL；source=`CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT`，trajectoryType=`CORTEX_TRAJECTORY_TYPE_CASCADE` |
| `SendUserCascadeMessage` | metadata、cascadeId、items:[{text}]、cascadeConfig |
| `GetAllCascadeTrajectories` | trajectorySummaries 中的状态、stepCount、trajectoryId |
| `GetCascadeTrajectorySteps` | cascadeId、startIndex、endIndex，取本轮步骤 |
| `HandleCascadeUserInteraction` | interaction 包含 trajectoryId、stepIndex、runCommand.confirm/命令文本 |

原方法论还发现 DeleteCascadeTrajectory/CancelCascadeInvocation，但当前模板没有实现对应 CLI 功能；不能以端点被枚举推断脚本支持取消或删除。

原方法论建议从正常会话还原 `plannerConfig`；当前脚本的 `makeConfig()` 使用已写入代码的工具、Hook、提示区和内置技能列表，**不会每次动态克隆用户会话配置**。升级时这些常量可能失效，需重新还原契约，不能把脚本配置等同于全部版本的 UI 配置。

## 4. 模型映射及查询局限

| 别名 | 脚本内 ID | 原文历史标签 |
| --- | --- | --- |
| `high`（默认） | `MODEL_PLACEHOLDER_M318` | Gemini 3.8 Flash High |
| `medium` | `MODEL_PLACEHOLDER_M319` | Gemini 3.8 Flash Medium |
| `low` | `MODEL_PLACEHOLDER_M320` | Gemini 3.8 Flash Low |
| `argon` | `MODEL_PLACEHOLDER_M417` | Gemini 4 Argon High |
| `sonnet` | `MODEL_PLACEHOLDER_M405` | Claude Sonnet 5.5 High |
| `opus` | `MODEL_PLACEHOLDER_M402` | Claude Opus 5.5 High |
| `gpt` | `MODEL_OPENAI_GPT_OSS_120B_MEDIUM` | GPT-OSS 120B Medium |

原文另列 Argon Medium `M418`，当前脚本没有对应别名，可在经目标注册表确认后直接传内部 ID。`--status` 调用的 RPC 能返回注册表，但脚本只打印标签含 Flash 的项；旧文声称它展示“所有模型”并不符合当前输出。非 Flash 模型不能靠该输出完整发现。

## 5. 自动审批行为

`makeConfig` 设置 `CASCADE_COMMANDS_AUTO_EXECUTION_EAGER`。轮询新增步骤时，遇到 WAITING 且带 runCommand，会调用 `HandleCascadeUserInteraction`，提交 `confirm: true` 及命令文本。没有按工单文件范围实现命令白名单过滤。

这是该脚本实际的自动执行设计，不能套用 WorkBuddy/DSH“桥接器不会自动批准”的说明。工单范围是对执行 Agent 的约束，不是脚本强制文件隔离。

## 6. 发送、完成与超时

`[Flash Bridge] New session` 或实际代码中的 `Reuse session` 在消息发送之前输出；它们只能证明会话分支被执行。原文写 `Reusing session` 与当前字符串不同。`SendUserCascadeMessage` 返回后才进入等待循环。

结束条件为：本轮 stepCount 大于 baseline、状态 IDLE、没有 RUNNING/GENERATING/WAITING 步骤、最后非临时步骤为 PLANNER_RESPONSE，并连续两次轮询保持相同步数。轮询间隔 1.5 秒；两次满足不应被解释为固定额外等待 3 秒。

输出本轮最后一条 plannerResponse，缺失文本时会输出 `(Completed)`；因此协议分支结束仍需独立查验产物。模板 Reply 标题固定写 Flash，即便选其他模型也不会更名，不能用标题认定模型身份。

超过循环时限抛错，但 HTTP 请求没有单独超时、任务不会自动取消，状态也不标 uncertain。人工应把超时视为结果未知，先查目标会话，再决定后续操作；不能立即 reuse 或重发。

## 7. 历史经验与未验证范围

原材料记载 2026-11-03 的长中文命令假发送、长会话变慢、并发覆写工单发错内容，以及 2026-11-04 的异步构建期间瞬时 IDLE 误判。当前脚本包含后者的稳定检查实现。

本工作区未提供独立 Antigravity 测试文件及完整原始在线轨迹；本次不能把这些记载提升为新实测，也不能证明多实例、并发、升级后字段兼容或 Token 节省比例。排障对应原坑点 01–04，见[排障章节](#ch07)。

---


<a id="ch04"></a>

# 04 · Codex 桥接器

来源：[现有脚本](../dispatch-codex-template.mjs)、[原实战记录](../CODEX_BRIDGE_EXPERIENCE.md)。这里描述本工作区桥接器的实现，涉及 CLI 的历史兼容结论以 2026-11-04、版本 `0.166.0-alpha.5.1` 为边界；本次没有运行 Codex 模型请求。

## 1. 前提与使用方式

需要已安装并登录的原生 Codex CLI，Node 能以子进程方式启动它。桥接器按 `CODEX_BIN` → PATH → `%LOCALAPPDATA%/OpenAI/Codex/bin/*`（目录 mtime 降序）的顺序查找，不接受 `.cmd`/`.bat` 包装器。

脚本通过官方无头命令 `codex exec --json` 派单，不接管桌面当前对话。原文中“Codex 没有回环端点”应限定为当时检查的本机实例和当前桥接方案，不能推断所有未来版本都不提供其他传输。

以下命令从**工作区根目录**执行。先准备 `TASK-001.md`；检查与 dry-run 不会启动模型任务，但 status 会启动 CLI 的版本/登录状态检查。

```powershell
node dispatch-codex-template.mjs --help
node dispatch-codex-template.mjs --status
node dispatch-codex-template.mjs --dry-run --file TASK-001.md

# 示例：只读任务，新会话
node dispatch-codex-template.mjs --sandbox read-only --file TASK-001.md

# 示例：沿用默认 workspace-write，新会话
node dispatch-codex-template.mjs --file TASK-001.md

# 示例：同一模块后续工单，继承原 thread 的会话配置
node dispatch-codex-template.mjs --reuse --file TASK-002.md
```

历史机器曾在临时、非 Git 工作区中出现 `workspace-write` 任务实际无法写入的软失败。原记录用 `--write` 完成了写入验证，但这不证明所有 Windows 写任务都必须扩大 sandbox。检查任务产物和实际拒绝原因后，再按授权范围决定权限模式。

## 2. 参数表

| 参数 | 当前脚本行为 |
| --- | --- |
| `--status` | 检查版本/登录，读模型缓存、配置默认模型和上次 thread；不执行任务 |
| `--file FILE` | 相对工作根读取 UTF-8 工单；优先于 prompt |
| `--reuse` | 从工作根状态取 lastThreadId；没有记录时警告后新建 |
| `--thread ID` | 显式 thread，优先于 reuse；不得用于任意其他会话 |
| `--model SLUG` | 直接传 `-m`，桥接器不预校验模型是否可用 |
| `--cwd DIR` | 工作根，默认当前目录；影响工单解析、状态位置和子进程 cwd |
| `--sandbox MODE` | 新建会话使用，默认 `workspace-write`；显式值优先于 write |
| `--write` | 未显式指定 sandbox 时采用 `danger-full-access` |
| `--approve` | 新会话附加 `--approve-for-me`，resume 分支不附加 |
| `--danger` | 附加 `--dangerously-bypass-approvals-and-sandbox`，与 write 不同 |
| `--with-user-config` | 不添加默认的 `--ignore-user-config` |
| `--timeout SEC` | 模型子进程等待超时，默认 600；终止进程树和兜底还需额外时间 |
| `--dry-run` | 找二进制、读工单并打印参数；不 spawn 模型、不改状态 |
| `--verbose` | 打印原始 JSONL 的截断事件行，可能含任务内容 |
| `--prompt TEXT` | 实现支持；帮助写“短 ASCII”，代码并未强制字符数/ASCII 限制 |
| `--help` / `-h` | 显示脚本帮助 |

`CODEX_BIN` 可以显式指定原生二进制路径；`CODEX_HOME` 由环境决定配置和账号态位置。不在文档中复制账号文件。脚本没有严格未知参数拒绝、完整数值校验、工单体积限制或严格 UTF-8 校验；本套流程仍用文件派单并人工核对。

## 3. 权限开关如何区分

`--write` 只让 `-s` 取值成为 `danger-full-access`；它与 `--danger` 的参数拼接是独立的。原文“write 取消沙箱与审批”“write 代替人工审批”容易把不同控制混为一谈：仅凭本脚本可以确认 sandbox 参数变化，不能保证宿主、CLI 和组织策略都不再要求审批。

扩大权限的命令示例，仅适用于已明确选择该模式的任务：

```powershell
node dispatch-codex-template.mjs --write --file TASK-001.md
```

工单中的“只读”“只改指定文件”属于执行约定，不能替代 sandbox 技术限制；历史跨盘只读审查用过 write，不意味着应把所有代码审查都设成该模式。

## 4. 配置、会话与状态

默认添加 `--ignore-user-config`，以避开原机器完整 MCP/插件配置下的初始化挂起。认证仍由 CLI 处理；不代表自动加载原会话的插件和全部工具。需要完整配置时显式开启，并重新验证工具链。

新会话大致参数：

```text
codex exec --json --skip-git-repo-check [其他公共参数] -C <工作根> -s <模式> -
```

复用参数：

```text
codex exec resume <threadId> --json --skip-git-repo-check [公共参数] -
```

resume 不下发 `-C`、`-s`、`--approve-for-me`；子进程仍以 `cwd` 启动，但不应把改变 cwd 或给 reuse 加 write 理解为迁移/重配原会话。需要不同项目或权限模式时新开 thread。

工单写入 stdin 后立即 `end()`，避免 CLI 永远等待 EOF。收到 `thread.started` 后立刻以临时文件 + rename 保存 `.codex-bridge-state.json`，末尾再次更新。状态含 lastThreadId/model/sandbox/updatedAt，不含“上一轮成功”标志；resume 时记录的 sandbox 也不能当原会话实际权限证明。

没有派单锁、失败后自动阻止 reuse、跨目录所有权核对或 `last-result.json`。应独立保留 stdout 与工单，不要让多个任务共用同一状态文件。收到 thread 不代表任务成功。

## 5. 模型与结束条件

`--status` 读取 `models_cache.json`，输出 models 与 modelsFetchedAt；它不是实时在线注册表。原记录出现的 `gpt-6.1-sol`、`gpt-6-luna` 等只作为历史例子，使用前检查本机输出。

解析器只采纳 `item.completed` 的 agent_message；记录 `turn.completed` 和 usage；最终要求没有 error/turn.failed、未超时、进程 exit=0 且收到 `turn.completed`。**当前成功分支未额外要求最后文本非空，也不核对工单标记、文件或测试结果**。因此 `(no agent_message captured)` 或模型拒绝执行都应由人工验收拦住。

`New session` / `Reuse session` 是 spawn 前打印的意向日志，dry-run 也会输出。实际 thread.started、工具/文件事件和终态才是后续链路证据。

指定模型的日志只说明参数。历史记录通过同 thread 的 Codex rollout 中 session_id/model/source/cli_version 验证请求选择；读取此类记录时只摘必要字段，不复制整份用户会话内容。

## 6. 超时与排障

Windows 超时分支调用 `taskkill /PID <子进程> /T /F`，之后带 3 秒兜底销毁 stdio、unref 并退出；失败会告警。非 Windows 使用不同的 kill 路径，本套未做跨平台验证。历史自审后这段已修复，但修复后的进程树超时分支没有真实触发记录，本次只核对实现和语法。

完整用户配置下历史挂起 9m07s；快速配置中同类简单任务约 11～27s。耗时是当时样本，不能据此估计任意开发任务。超时不应自动重发，先确认 thread 和产物，特别是清理失败时。

## 7. 历史实测与局限

2026-11-04 原记录列有 11 类场景：握手、状态、dry-run、完整配置失败、默认 sandbox 软失败、扩大 sandbox 写文件成功、resume 上下文、指定模型、桥接器自审、修复后回归，以及中文精确回复/主机侧模型记录。

其中自审 34.8s 返回 4 条有效缺陷；修复后新会话/reuse 分别 21.0s/13.3s。单项写文件样本 18.8s；模型中文回复样本 22.0s。这些来自原文，不是本次重新计时。

原始证据主要在外部临时目录与 `.codex/sessions`，本工作区没有打包全部文件。本次只确认原文及对应实现存在。并发、多文件施工/构建完整验收、超长会话、Git worktree、不同 CLI 版本、部分高级参数仍未完整验证，见[证据章节](#ch09)。

---


<a id="ch05"></a>

# 05 · WorkBuddy 桥接器

来源：[原说明](../workbuddy/README.md)、[派发器](../workbuddy/scripts/dispatch-workbuddy.mjs)、[启动/恢复脚本](../workbuddy/scripts/workbuddy-bridge-session.ps1)、[离线测试](../workbuddy/scripts/dispatch-workbuddy.test.mjs)。历史适配环境为 WorkBuddy AI `5.9.4`、Node `22.15.1`、Windows。

## 1. 连接方式与前提

采用临时回环 CDP → 主渲染器 `window.__wbInvoke` → 原生会话和工具。它依赖当前版本内部接口，不是稳定公开 API。独立内置 CLI 曾出现桌面登录态不能复用的问题，现脚本不走该路径，也不启用旧 eval-proxy。

需要 Node ≥22、已登录 WorkBuddy，且用户已选择临时调试桥接模式。该连接具有客户端控制能力；`--allow-debug` 是派发时明确选择此连接，不是自动批准权限请求。

以下所有命令从**套件 `workbuddy/` 目录**执行；在其他项目部署时，从该项目根执行配套脚本。默认任务目录、运行态和启动器 runtime 记录随执行目录变化，不能换个目录执行 Restore。

## 2. 启动与检查

先从托盘菜单退出已有 WorkBuddy。原机器关闭窗口或 Ctrl+Q 不会真正结束主实例；启动器发现旧实例会拒绝启动，防止第二实例仅转交唤醒请求。

历史安装路径如下；使用时换成自己的真实路径：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/workbuddy-bridge-session.ps1 -Mode Start -Executable <WORKBUDDY_DIR>\WorkBuddyAI.exe
node scripts/dispatch-workbuddy.mjs --status
node scripts/dispatch-workbuddy.mjs --models
```

Start 默认 `-Port 48173`，以 `127.0.0.1` 调试参数启动，记录 PID/路径/启动时间，并最多等待约 30 次就绪检查；检查监听归属和主渲染器。自定义端口时后续 Node 命令同步加 `--port`。

普通启动没有临时 CDP 端口，status 连接失败是预期；`/workbuddy/probe` 发现服务并不等于可派单端点。status/models 会连接调试端口，但不执行工单，不需要 allow-debug。

## 3. 工单与模型操作

准备 UTF-8 工单之后：

```powershell
node scripts/dispatch-workbuddy.mjs --file TASK-001.md --dry-run
node scripts/dispatch-workbuddy.mjs --file TASK-001.md --allow-debug
node scripts/dispatch-workbuddy.mjs --reuse --file TASK-002.md --allow-debug

# hy3 是历史注册 ID，实际使用前查 --models
node scripts/dispatch-workbuddy.mjs --reuse --model hy3 --file TASK-002.md --allow-debug
```

| 参数 | 行为 |
| --- | --- |
| `--file FILE` | 必需任务输入；严格 UTF-8、非空、≤1 MiB；剥离 BOM |
| `--workspace DIR` | 原生会话实际目录，必须存在；取 realpath，默认当前目录 |
| `--state FILE` | 状态文件，默认当前目录 `private/workbuddy-bridge/state.json` |
| `--reuse` | 仅复用状态里自有、同真实目录且上一轮 completed 的会话 |
| `--model ID` | 按实时 CLI 注册表校验 ID，再交原生接口选择 |
| `--mode craft\|ask\|plan` | 新会话模式，默认 craft；reuse 显式带 mode 会报错 |
| `--port N` | 默认 48173 |
| `--timeout SEC` | 派单 IPC 等待时限，默认 600，范围 1..86400；不等于整个初始化流程的总时限 |
| `--allow-debug` | 真实派单必需；保留原生 default 权限 |
| `--dry-run` | 在连接之前检查工单、真实目录并输出字节数/哈希等 |
| `--status` / `--models` / `--help` | 状态、模型或帮助；status/models 分别执行 |

不支持 `--prompt`、`--cwd`、任意 sessionId 注入、会话删除或自动部署。参数解析会拒绝未知/重复参数及缺失值。

历史名称 Hy4 对应 `hy4free`、`hy4std`，Hy3 对应 `hy3`；不是 `--model hy4`。历史实测为 hy4free↔hy3，未调用 hy4std。

## 4. 原生契约与模型双更新

IPC 格式是 `__wbInvoke(channel, undefined, ...businessArgs)`；第二参数为 callerContext，不是业务参数。

| 通道/字段 | 作用 |
| --- | --- |
| `wb:conversations:create` | 创建指定 cwd、mode、permissionMode=default 的原生会话 |
| `session:get` | 检查保存会话和目录 |
| `config:getProductConfiguration` | 过滤出 CLI 可用且未禁用模型；仅输出白名单字段 |
| `wb:conversations:configSetModel` | 更新会话保存配置 |
| `session:setModel` | 更新已加载运行时；切换时必须与上一调用配套 |
| `wb:conversations:get` | 核对保存的模型配置 |
| `session:sendMessage` | 派发任务并等待对应结果 |
| `_meta["codebuddy.ai"].lastAssistantText` | 取得最终回复 |

只改 configSetModel 时，历史下一轮实际 requestModelId 仍为 hy4free；补齐 session:setModel 后才为 hy3。现脚本两层一起改，但返回 configuredModel 仍是配置确认值。历史另查运行时 MODEL_REQUEST/requestModelId，才确认请求选择改变。

主渲染器筛选限定本地 `app.asar/renderer/index.html`，要求唯一目标；WebSocket 只接受同端口的 `ws://127.0.0.1/.../devtools/page/`。不能把任意网页当 IPC 目标。

## 5. 状态、完成和失败

默认状态与 `last-result.json` 在同目录，锁为 `<state>.lock`。不同状态文件若在同一目录仍共享结果文件名，建议任务线使用不同目录。`--workspace` 只改变会话目录，不会自动把运行态移入该目录。

派发器用临时文件加 rename 保存 JSON。运行态可能含任务内容、目录和模型配置，不作为可移植脚本的一部分；本次文档只链接现有材料，不复制其他项目的运行记录。

状态 phase 可能为 dispatching、completed、uncertain、switching-model。reuse 检查自有会话数组、真实路径及 completed。锁不自动清理；确认旧进程和原生任务后再处理。

New/Reusing session 表示确认会话，不代表工单已结束。成功必须 `stopReason=end_turn`、存在 outcome 时为 SUCCESS，且最终文本非空。结果保存会话、目录、configuredModel、工单哈希与回复；桥接器不替代产物验收。

sendMessage 超时或异常通常把状态标 uncertain，任务可能继续；禁止自动重发或 reuse。切模型中失败可能留 switching-model，先核对两层配置；部分更早创建/校验失败不保证已写出完整失败状态。没有自动取消或超时后结果恢复。

## 6. 使用后恢复

确认该实例任务已完成或停止，再在**启动时相同目录**运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/workbuddy-bridge-session.ps1 -Mode Restore
```

Restore 核对 runtime 记录的 PID、路径、启动时间，只停止本轮记录的主进程，检查调试端口无监听，然后请求普通启动并删除 runtime 记录。重复 Restore 会拒绝。脚本的“普通启动请求已发出”不等于完整登录/界面功能已通过自动验收；应目视确认正常启动。

runtime 丢失或身份变化时不要批量结束同名进程；按软件正常退出再普通启动，并独立确认调试端口关闭。移植时将 `private/workbuddy-bridge/` 加入项目忽略规则；当前套件 workbuddy 子目录并没有独立 `.gitignore`，原项目“已忽略”的说明不能自动套用。

## 7. 历史证据与本次边界

2026-11-04 原文记载：握手、读隔离 fixture 得 343/校验标记、同会话追问、hy4free→hy3 双更新后的真实请求日志、未知模型拒绝、完整 Start/Restore 成功；后续 11 项测试覆盖并取代首轮仅 8 项的记录。

“追问不调用工具”没有独立工具审计。原始实测目录在外部 YourProject 项目，当前套件未包含这些结果文件；只能作为有具体证据位置的历史记载。本次新运行离线测试为 11/11，启动器仅解析检查，没有运行 Start/Restore。业务文件修改、编译/全量测试、hy4std、其他模型、跨版本兼容及并发仍未验证。

---


<a id="ch06"></a>

# 06 · DSH / DeepSeek Harness 桥接器

来源：[原说明](../dsh/README.md)、[派发器](../dsh/scripts/dispatch-dsh.mjs)、[测试](../dsh/scripts/dispatch-dsh.test.mjs)、[审计工具](../dsh/scripts/verify-no-secrets.mjs)。历史适配版本：DSH Desktop `0.1.1` + `@deepseek-ai/dsh@0.1.5-rc.2`。

## 1. 前提与执行目录

DSH Desktop 已运行并进入 Harness；模型账号由其自身登录。需要能查询 Harness 进程及读取启动日志。桥接器不启动第二实例、不修改安装包、不导出账号凭据。

以下命令从**套件 `dsh/` 目录**执行；默认工单路径、`--cwd` 相对路径和状态路径均以派发器启动目录为基准。切到其他目录执行会得到不同默认状态。

```powershell
node scripts/dispatch-dsh.mjs --help
node scripts/dispatch-dsh.mjs --status
node scripts/dispatch-dsh.mjs --models
```

`--status` 连接当前 Harness 后查询目录/模型等摘要，命令结束即退出；没有新增常驻桥接服务。

## 2. 工单、目录与模型

先准备 `TASK-001.md` 与已存在的任务目录，例如通过编辑器创建 `private/my-work`。任务目录与套件历史测试目录分开。

```powershell
node scripts/dispatch-dsh.mjs --cwd private/my-work --file TASK-001.md --dry-run
node scripts/dispatch-dsh.mjs --cwd private/my-work --file TASK-001.md
node scripts/dispatch-dsh.mjs --reuse --cwd private/my-work --file TASK-002.md

# 模型 ID 来自历史样本，运行前先查 --models
node scripts/dispatch-dsh.mjs --reuse --model deepseek-v4-flash --cwd private/my-work --file TASK-002.md
```

| 参数 | 行为 |
| --- | --- |
| `--file FILE` | 严格 UTF-8、非空、≤1 MiB；剥离 BOM，计算字节数及 SHA-256 |
| `--cwd DIR` | 会话工作目录，默认 `.`；不是进程切换目录参数 |
| `--reuse` | 状态中必须有 sessionId 且 lastStatus=completed，目录比较通过 |
| `--model ID` | 实时注册表唯一 ID，或 `provider/model`；未知项提前拒绝 |
| `--state FILE` | 默认 `private/dsh-bridge/state.json`，结果为同目录 last-result.json |
| `--log FILE` | 手动指定 Harness 启动日志路径 |
| `--timeout SEC` | 默认 600；等待轮询时限，各网络操作另有超时，非严格总时长上限 |
| `--dry-run` | 连接前检查工单并打印 cwd/statePath/哈希；不代表任务目录存在或可写 |
| `--status` / `--models` | 分别查询；不能与工单派单混用 |
| `--help` / `-h` | 显示帮助 |

`--prompt` 被明确禁用。CLI 没有取消、删除会话或自动恢复功能。路径比较 `normalizeCwd` 不解析真实文件系统身份，因此仍需按项目隔离状态，不能依赖状态 JSON 证明不可伪造的所有权。

中文绝对工作目录可预先存入 UTF-8 `WORKSPACE.txt`，在 PowerShell 用 ASCII 命令读取；文件内容写实际目标路径，不要直接复用旧的 cwd.txt：

```powershell
$taskWorkspace = (Get-Content -LiteralPath WORKSPACE.txt -Raw -Encoding UTF8).Trim()
node scripts/dispatch-dsh.mjs --cwd "$taskWorkspace" --file TASK-001.md --dry-run
node scripts/dispatch-dsh.mjs --cwd "$taskWorkspace" --file TASK-001.md
```

这是 PowerShell 语法。原文 `CWD=$(cat ...)` 属于 Bash，不能直接粘贴进 PowerShell。套件已有 cwd.txt 指向历史用户项目，不应当作通用默认值。

## 3. 发现、认证与 Connection RPC

发现进程命令行含 `harness-node-entry.mjs` 的实例，只输出 PID/port 白名单；查 APPDATA/LOCALAPPDATA 下的 logs/harness.log，读取匹配端口最后一次启动 URL。进程表不可读时退回日志中最新 URL。令牌为本进程 Web 启动令牌，不是账号 API Key。

认证先 `GET /?token=<启动令牌>`，从响应取签名 Cookie；后续 POST 只带 Cookie。原文依据目标实现记录其 authority-bound、HttpOnly、SameSite=Strict 等约束；桥接器没有重新实现目标服务的服务端鉴权。不能把令牌放在 `/api` query 或 Authorization 头。

```json
{
  "type": "client-request",
  "rpcId": "<本次RPC唯一ID>",
  "method": "session/prompt",
  "payload": { "args": { "request": { "...": "按目标契约填写" } } }
}
```

请求路径为 `POST /api/<endpoint>`。响应必须为 server-response、同一 rpcId、result.ok=true，再取 value；HTTP 200 本身不代表 RPC 成功。上例为结构示意，不是可直接发送的完整工单请求。

响应结构为 `{"type":"server-response","rpcId":"<同一ID>","result":{"ok":true,"value":...}}`；业务失败为 `ok:false,error:{code,message,...}`。create 的 request 含 cwd；prompt 的 request 含 requestId、sessionId、`mode:"queue"` 与 `content:[{type:"text",text:...}]`；page 的 request 含 session address、throughSeq、maxMessages 及可选 beforeSeq。这些字段都来自本脚本适配的版本，升级后需重新对照描述符。

| 端点 | args 外层 |
| --- | --- |
| `session/modelCatalog` | `{}` |
| `session/list` | `{ "_request": {} }` |
| `session/create` / `session/prompt` / `session/page` / `session/selectModel` | `{ "request": { ... } }` |

原契约来源是安装目录的生成描述符与连接库，不需要反编译。session/create 原生提供工具和权限，无需 plannerConfig 克隆。令牌/Cookie 不写入 stdout、状态或结果文件。

## 4. 本轮关联与终态

创建/复用后，取 `session/list` 的 projections.asOfSeq 作 baseline；session/prompt 使用 requestId，工单末尾附内部关联标签。返回 accepted=true 才输出 `Prompt accepted`。

轮询间隔 1.5 秒，以当前 asOfSeq 为 session/page 的 throughSeq，回取 baseline 后增量；每页最多 200 条，最多回溯 8 页。不能用任意超大游标。代码在 user/message data 中查 requestId 字符串，不是按第一条用户消息定位，也不只限定在 source.rpcId 字段。

结束等待要求：本轮用户事件被关联、running=false、之后有 turn/end 和 assistant/message，并连续两次观察到相同 asOfSeq。随后主流程要求 turn/end reason=completed 且回复非空，才写 completed。检测 approval/asked 只提示，不批准。

使用字段 observedRequestConfig 记录增量中的 request/header 配置，比模型自述更直接；字段缺失时不能声称已经独立验证模型。selectedModel 只说明配置选择。

## 5. 状态、副作用与异常

默认 `<state>.lock` 防同一状态文件的并发；不自动清锁。同目录不同 state 仍共享 `last-result.json`，应使用不同目录隔离结果。状态持有 sessionId/cwd/model/lastStatus 等，不含启动令牌或 Cookie。

超时写 uncertain 和结果摘要，不自动取消，禁止自动重发/reuse；网络异常也可能留下 uncertain。失败恢复依阶段而异：提交前可能保留上一完成状态，已建新会话可能标 uncertain。不能假设每个失败都有新的 last-result.json；旧结果可能仍在，应核对 requestId/哈希/时间。

**模型切换有配置级副作用。** 原文实测 session/selectModel 改变之后新会话的默认模型，不只当前会话。历史测试后默认模型 ID 恢复为 deepseek-official/deepseek-flash，但 reasoningEffort 从未显式记录变成显式 high。这个残留属于历史记录，本次未连接检查当前设置，不能说它仍存在或已经恢复。

历史总会话 12→16，新增 4 个；桥接器不删除。前三个在隔离目录，第四个在原用户工作区。会话 API 成功不等于 UI 一定显示：原文关于按工作区过滤的解释是推断，界面渲染未实测。需要可见时用目标当前工作目录建新会话，并独立确认界面。

## 6. 历史实测与保留证据

2026-11-04 原文记载：读 fixture 得 `343` 和未写入工单的标记；同 session 追问；模型请求配置确认；未知模型/跨目录拒绝；只读命令；写出 13 字节文件；默认模型精确中文回复。

当前工作区仍有：[fixture](../dsh/private/dsh-bridge-test/fixture.json)、[写文件工单](../dsh/private/dsh-bridge-test/WRITE.md)、[写入产物](../dsh/private/dsh-bridge-test/dsh-bridge-write-test.txt)、[写入结果](../dsh/private/dsh-bridge/last-result.json)、[中文回复结果](../dsh/private/dsh-bridge/hello41/last-result.json)、[命令状态](../dsh/private/dsh-bridge/cmd-state.json)。这些文件能支持特定历史样本；通用 last-result 已被覆盖，无法从它还原早期每一轮。

本次离线测试 10/10；审计脚本返回 clean，但扫描范围只在 dsh 子树，且只做已知日志令牌及特定签名 Cookie 形态检查，不是全套件所有秘密的保证。未连接 DSH。多文件改造、构建/E2E、并发、高风险审批、全新会话 --model、超时取消/恢复和 UI 可见性仍未完整验证。

---


<a id="ch07"></a>

# 07 · ZCode 桥接器

来源：[`zcode/`](../zcode/)。
适配版本：ZCode Desktop `3.17.2` / ZCode CLI `0.17.1`。
环境基准：Windows 11，Node.js `v22.15.1`。
核心文件：
- 派发器：[`dispatch-zcode.mjs`](../zcode/scripts/dispatch-zcode.mjs)
- 兼容补丁：[`patch-sqlite.cjs`](../zcode/scripts/patch-sqlite.cjs)
- 测试套件：[`dispatch-zcode.test.mjs`](../zcode/scripts/dispatch-zcode.test.mjs)

## 1. 前提与执行目录

1. **Node.js 环境**：Node ≥ 22.0.0（实测基于 `v22.15.1`，自带 `node:sqlite`）。
2. **目标安装路径**：ZCode 桌面端安装于 `<ZCODE_INSTALL_DIR>` 或 `%LOCALAPPDATA%\Programs\ZCode`，核心引擎位于 `resources/glm/zcode.cjs`。
3. **Z.ai 凭据就绪**：必须使用合法的 Z.ai 平台 API 密钥（两段式格式），而非 BigModel 基础套餐。

从任意控制台或工程目录均可调用适配脚本：
```powershell
# 查看状态与可用模型列表
node "d:\本地快速部署multi-agent-orchestration桥接\zcode\scripts\dispatch-zcode.mjs" --status
node "d:\本地快速部署multi-agent-orchestration桥接\zcode\scripts\dispatch-zcode.mjs" --models

# 离线预检工单
node "d:\本地快速部署multi-agent-orchestration桥接\zcode\scripts\dispatch-zcode.mjs" --file TASK-001.md --dry-run
```

## 2. 完整参数与命令手册

| 参数 | 默认值 | 行为与约束 |
| --- | --- | --- |
| `--file FILE` | - | 读取工单文件；严格 UTF-8、非空、≤ 1 MiB，计算 SHA-256 并剔除 BOM |
| `--prompt TEXT` | - | 快速测试短文本；与 `--file` 互斥 |
| `--model ID` | <平台默认> | 目标平台支持的任意模型 ID（如旗舰大模型或轻量执行模型） |
| `--thinking LEVEL` | normal | 思考强度等级；可选 low, high, max，无思考模型传 normal |
| `--provider ID` | `zai-standard-api` | 指定供应商标识（默认隔离使用 Z.ai 标准 API） |
| `--cwd / --workspace` | 当前工作目录 | 目标任务的工作区物理路径 |
| `--mode MODE` | `yolo` | 运行权限模式；支持 `yolo`（全自动）与 `safe`（提示） |
| `--reuse / --resume` | false | 复用上一轮会话；从状态文件读取 `lastSessionId` |
| `--timeout SEC` | 600 | 任务超时时间（秒） |
| `--dry-run` | false | 预演模式：完成全部前置检查与参数拼接后安全退出，不发起调用 |
| `--status` | - | 检查 ZCode 安装路径、Node 版本、SQLite 状态并打印配置摘要 |
| `--models` | - | 列出当前注册的所有可用模型及思考强度选项 |
| `--history` | - | 直读本地 SQLite 数据库，按时间倒序列出最近会话概要 |
| `--show [ID]` | - | 直读指定会话的完整历史（含用户输入、GLM 思考链与回复）；支持 `latest` 别名 |
| `--api-key KEY` | - | 动态传入或更新 Z.ai API Key（两段式结构，安全注入） |

## 3. 运行机制与核心兼容补丁 (`patch-sqlite.cjs`)

### 3.1 Node 22 内置 SQLite 事务状态补丁原理
ZCode 启动时依赖本地 SQLite 数据库初始化会话。其内部迁移脚本存在如下断言：
```javascript
if (e.isTransaction !== !n.transactionOpen) {
  throw new SqliteSessionMigrationError("Migration transaction ownership mismatch");
}
```
在 Node.js `v22.15.1` 中，内置模块 `node:sqlite` 的 `DatabaseSync.prototype.isTransaction` 属性为 `undefined`，导致上述比较恒为 `true` 而抛出致命崩溃。

[`patch-sqlite.cjs`](../zcode/scripts/patch-sqlite.cjs) 通过 Node.js `-r` 参数前置预载，执行如下 Monkey Patch：
```javascript
// 状态机拦截 DatabaseSync 的 exec 行为，实时维护 isTransaction 状态
Object.defineProperty(DatabaseSync.prototype, 'isTransaction', {
  get() { return Boolean(this.__in_tx); },
  configurable: true,
  enumerable: true
});
```
当检测到底层执行 `BEGIN` 时置为 `true`，遇到 `COMMIT` 或 `ROLLBACK` 时复位为 `false`，彻底修复迁移初始化崩溃。

### 3.2 拦截良性 stderr 输出防全屏红字
PowerShell 在遇到外部子进程向 `stderr` 写入任何文本时，默认会将其包装为 `NativeCommandError` 并渲染为全屏红字。ZCode 启动时会正常输出诊断日志（如 `ZCode Built-in skipped (not-due)`）。  
`patch-sqlite.cjs` 重写了 `process.stderr.write`，自动过滤此类非错误性诊断信息，并设置 `NODE_ENV=production`，保持终端清爽可靠。

## 4. 模型选择器语法与思考强度配置

逆向工程分析证实，ZCode CLI 的模型与思考强度由选择器语法统一表达：
```text
${providerId}/${modelId}$${reasoningLevel}
```
* **providerId**：`zai-standard-api`（Z.ai 平台调用）。
* **modelId**：`GLM-5.3-Flash`。
* **reasoningLevel**：`high`（支持 `low`、`high`、`max`）。

派发器在调用时，会自动在用户配置目录 `~/.zcode/v2/provider_config.json` 中原子化写入：
```json
{
  "config": {
    "defaultModelSelection": "zai-standard-api/GLM-5.3-Flash$high"
  }
}
```

## 5. 凭据规范与安全隔离（严格脱敏）

* **凭据两段式结构**：Z.ai 标准 API Key 必须是由点号分隔的两段式结构：`{apiKeyId}.{secret}`。如果缺少 secret（仅传递 32 字符的 ID），客户端签名认证器将无法生成请求签名，远端服务端亦会返回 `401 token expired or incorrect`。
* **安全注入方式**：
  ```powershell
  # 方式 A：通过环境变量注入（推荐，避免日志泄露）
  $env:ZAI_API_KEY = "<YOUR_ZAI_API_KEY_ID>.<YOUR_ZAI_API_KEY_SECRET>"
  node dispatch-zcode.mjs --prompt "测试"

  # 方式 B：通过命令行参数注入
  node dispatch-zcode.mjs --api-key "<YOUR_ZAI_API_KEY_ID>.<YOUR_ZAI_API_KEY_SECRET>" --prompt "测试"
  ```
* **脱敏红线**：工单、日志与手册中绝对禁止记录实际密钥内容。

## 6. 会话直读与思考链解析（免 TUI 依赖）

针对 ZCode 桌面安装包裁减了 `@zcode/tui` 导致直接运行 `--resume <sessionId>` 报错的问题，适配器提供了原生 SQLite 解析功能：

```powershell
# 列出最近历史会话
node "d:\本地快速部署multi-agent-orchestration桥接\zcode\scripts\dispatch-zcode.mjs" --history

# 直读最新会话详情（包含 GLM 思考过程与 Token 统计）
node "d:\本地快速部署multi-agent-orchestration桥接\zcode\scripts\dispatch-zcode.mjs" --show latest
```

直读模块会直接解开底层 SQLite 中存储的 JSON 消息体，提取出 `🧠 [GLM-5.3-Flash Thinking / 思考过程]` 以及对应的 Reasoning Tokens，实现 100% 透明审计。

---

<a id="ch08"></a>

# 08 · 排障与维护（含坑点 01–25 统一索引）

本章合并各目标桥接器在工程实践中的现象、根因与处理手段，统一编号坑点 01–25 以便追溯。

## 1. 先定位卡在哪一层

| 观察到的现象 | 优先排查项 | 后续动作 |
| --- | --- | --- |
| 终端毫无输出，命令瞬间退出 | 检查工单是否存在、命令路径是否有中文乱码、Node 进程是否正常拉起 | 优先使用 ASCII 相对路径，核实 `--file` 路径 |
| 终端全屏红字但进程 exit code 为 0 | 外部命令向 `stderr` 输出了诊断信息，PowerShell 触发 `NativeCommandError` | 引入 `patch-sqlite.cjs` 过滤良性 stderr，设置 `NODE_ENV=production` |
| 报 `Cannot find package '@zcode/tui'` | 执行 `--resume` 时未传 `--prompt`，引擎试图拉起交互式终端 UI（TUI） | 改用 `--show latest` 查看历史，或追加 `--prompt` 正常派发任务 |
| 报 `Migration transaction ownership mismatch` | Node 22 内置 `node:sqlite` 缺失 `isTransaction` 属性 | 运行命令必须前置引入 `-r patch-sqlite.cjs` 补丁 |
| API 报 401 认证拒绝或签名断言失败 | 传递的 API Key 为单段式（缺少 secret），或与 BigModel 套餐混淆 | 检查 Key 格式是否为合法的两段式 `{apiKeyId}.{secret}` |
| 任务已结束，但在桌面客户端界面找不到会话 | CLI 无头会话落盘在本地 SQLite，而桌面 GUI 使用 Electron 前端存储 | 属于架构预期隔离，通过 `--history` 或 `--show` 在终端查看 |

## 2. 核心坑点 01–25 完整索引表

| 编号 | 涉及目标 | 故障现象 | 根因或底层机制 | 最终解决方案与标准行为 |
| :--- | :--- | :--- | :--- | :--- |
| **01** | 通用 | Windows 长中文 prompt 假发送/卡住 | 控制台管道缓冲溢出与编码乱码 | 强制落地为 UTF-8 工单文件，短命令 `--file` 派单 |
| **02** | Antigravity | 长会话多轮迭代后响应急剧变慢 | 轨迹上下文（Trajectory）膨胀（约 100–150 步） | 同模块追加复用，跨模块强制新建会话 |
| **03** | 通用 | 覆写工单后客户端依然读取旧任务 | 文件异步写入延迟与操作系统读写竞争 | 写入成功核对 SHA-256 后再顺序派单；使用专属任务文件 |
| **04** | Antigravity | 异步构建任务时客户端瞬时 IDLE 提前退出 | 空闲检测未覆盖后台未决步骤 | 增加未决步骤核验、末步骤类型校验及连续两次稳定检查 |
| **05** | Codex | 扫描不到任何本地回环端口 | 桌面端 `app-server` 采用 stdio 独占，未起 daemon | 改用官方原生 CLI `codex exec --json`（JSONL over stdio） |
| **06** | Codex | 子进程一直挂起等待输入 | stdin 管道未正常发送 EOF 关闭信号 | 任务内容写入后立即调用 `stdin.end()` 闭合输入 |
| **07** | Codex | exit 0 退出但实际没有生成目标产物 | 遭遇模型软拒绝或工作区沙箱限制 | 独立核对产物与拒绝原因；按需配置 `--write` |
| **08** | Codex | 挂载完整用户配置后任务挂起超时 | 用户配置中的外部插件、MCP 初始化阻塞 | 默认指定 `--ignore-user-config` 快速启动 |
| **09** | Codex | 任务超时 kill 后后台孤儿进程未退出 | Windows 子进程树 stdio 句柄泄露 | 采用 `taskkill /F /T` 强制终止整颗进程树 |
| **10** | Codex | resume 会话时拒绝接收新建类参数 | Codex CLI 的 resume 仅支持参数子集 | 分离新建与恢复逻辑，参数严格按阶段装配 |
| **11** | DSH | API 调用返回 HTTP 401 认证拒绝 | 启动令牌不能直接作为 Authorization 或 query | 先访问 `GET /?token=` 交换签名 Cookie，后续携带 Cookie |
| **12** | DSH | 游标超界抛 `throughSeq out of range` | 填入了任意超大游标，脱离实际日志记录 | 先调 `session/list` 获取当前 `asOfSeq` 作为分页基准 |
| **13** | DSH | API 报 400 Bad Request / Gateway Error | 端点外层包装名不统一（`_request` vs `request`） | `session/list` 用 `_request`，其余端点严格按契约使用 `request` |
| **14** | DSH | 校验失败导致本地状态文件污染 | 先写入临时状态再做模型可用性验证 | 校验逻辑前置，确保仅在通过校验后原子写入状态 |
| **15** | 通用 | 配置已更新但实际调用仍使用旧模型 | 仅修改持久化配置，未同步更新已加载运行时 | WorkBuddy 实行双更新；ZCode 更新 `provider_config.json` |
| **16** | DSH | 单轮轮询出现多条用户消息导致关联错位 | 客户端插件注入了运行时系统上下文 | 必须关联业务 `requestId` 标签，不能盲目取第一条消息 |
| **17** | DSH | 会话切模型对后续所有会话产生全局副作用 | `selectModel` 修改了全局配置层 | 记录配置变更历史，测试完毕后主动执行现场复原 |
| **18** | 通用 | PowerShell 与 Bash 脚本语法混用报错 | 环境变量获取、管道传递和路径格式不兼容 | 复杂逻辑交由 Node.js 脚本承载，控制台只执行标准命令 |
| **19** | DSH | 接口显示有会话但桌面 UI 看不到 | 会话工作区与桌面当前打开目录不一致 | 严格使用真实工作区路径创建会话，明确 API 与 UI 范围 |
| **20** | Codex | exit 0 误判为成功；状态落盘不及时 | 流式文本未完成，以进程退出代替终态 | 严格监听 `turn.completed` 事件，原子化写入状态 |
| **21** | **ZCode** | 报无法定位 `zcode-builtin.json` 配置 | 打包目录与源码相对路径脱节，缺少内置文件 | 在 `resources/glm/provider/` 补齐软链接或配置副本 |
| **22** | **ZCode** | 报 `Migration transaction ownership mismatch` 崩溃 | Node 22 内置 SQLite 缺少 `isTransaction` 属性 | 采用 `patch-sqlite.cjs` 挂载属性补丁并拦截事务状态 |
| **23** | **ZCode** | 无法生效指定模型与高思考强度 | 未遵循 ModelPicker 语法选择器规则 | 统一采用 `${provider}/${model}$${thinking}` 注入配置 |
| **24** | **ZCode** | 报签名失败或 401 认证拒绝；终端全红 | 误传单段 Key；调试日志输出至 stderr 引发报错 | 规范化 Z.ai 两段式密钥；补丁拦截良性 stderr 输出 |
| **25** | **ZCode** | 运行 `--resume` 报缺少 `@zcode/tui` | 无 `--prompt` 时触发了桌面安装包未随附的 TUI | 改用桥接器内置 `--show [sessionId|latest]` 直读 SQLite |
| **26** | **OpenCode** | 无效 `--model` 仍会在服务端留下失败空会话 | `opencode run` 先建会话再校验模型路由 | 派单前先调 `opencode api get /api/model` 纯只读校验（含 `#variant`），不合法直接拒绝 |
| **27** | **OpenCode** | 工具调用中间轮也输出 `step_finish`，易误判完成 | 工具轮 `reason="tool-calls"`，仅收尾轮为 `"stop"` | 强制要求末 `step_finish.reason="stop"` + 非空文本 + `/api/session/{id}/message` 复核 `idle.outcome="succeeded"` |
| **28** | **OpenCode** | 外部终端缺环境变量或内部终端带父会话 `OPENCODE_SESSION_ID` | TUI 批处理注入环境变量与父会话上下文隔离需求冲突 | 子进程 `env` 剥离 `OPENCODE_SESSION_ID/TERMINAL`，缺省 `OPENCODE_CONFIG` 自动向上探测 `opencode.json(c)` |
| **29** | **OpenCode** | PowerShell 重定向中文 JSON 输出出现 BOM 与乱码 | PowerShell 5.1 默认按 GBK 解码 stdout 再写 UTF-8 BOM | Node 直接 `spawn` 原生 `opencode.exe`（拒绝 `.cmd`），UTF-8 读写 stdio 并剥离 BOM |
| **30** | **Gemini CLI** | `gemini.js` 默认二次拉起子 `node` 进程 | 自动内存重配置逻辑会派生子进程并抹掉 `GEMINI_CLI_AUTH_OVERRIDE` | 固定注入 `GEMINI_CLI_NO_RELAUNCH=true` |
| **31** | **Gemini CLI** | `VERTEX_LOCATION` 无效；OAuth 过期弹窗却 `exit=0` | `vertex-ai` 只认 `GOOGLE_CLOUD_LOCATION`；交互提示退出仍返回 0 | 自动映射 `GOOGLE_CLOUD_LOCATION`，终态检测拒绝交互登录提示假成功 |
| **32** | **Gemini CLI** | 仅回复 OK 却消耗 12k+ Token 且 MCP 报 `-32000` | 默认加载全部扩展与未就绪 MCP Server | 默认传 `-e none` 禁扩展（按需 `--with-extensions`） |
| **33** | **Gemini CLI** | 回复只剩最后几个字且 `init.model` 与实际不符 | `stream-json` 带 `delta: true` 分片且内部路由可改派模型 | 累加拼接 delta 文本，以 `result.stats.models` 作主机侧实际模型证明 |
| **34** | **Gemini CLI** | `models -o json` 缺少 4 系模型且错模型会留空会话 | 4 系模型位于 `bundle/chunk-*.js` 常量表，CLI 先建会话后校验 | 只读合并 `bundle` 聊天模型列表，派单前纯校验拒绝无效模型 |
| **35** | **Cline** | `/lg-task` URI 易被拆参/弹窗且锁死全局 Hooks | `cmd.exe` 拆 `&`、`cli.js` 缺 Node 标志、覆盖全局 Hooks | 放弃 URI 路线，改用扩展内嵌 `@cline/core` ESM 核心 |
| **36** | **Cline** | Node 22.15.1 原生 `fetch` 忽略代理超时 | Node 22.15.1 不支持 `NODE_USE_ENV_PROXY` | 注入基于 `new Request` + `CONNECT` 隧道的代理 `fetch` |
| **37** | **Cline** | `core.subscribe` 报 `d.listener is not a function` | 签名实为 `subscribe(listener, { sessionId })` | 调整参数顺序，第一参数传回调 |
| **38** | **Cline** | `interactive: false` 报错清理及跨进程无法恢复 | 单轮结束即从内存卸载会话 | 用 `interactive: true` + `core.stop()`；跨进程传 `readMessages()` 作为 `initialMessages` |
| **39** | **Qwen (已删环境)** | `qwen-oauth` 不可用；桌面端无端口且带硬件签名 | `qwen-oauth` 于 2026-04-15 停用；桌面端用 `SecurityGuardSDK64` 签动态头 | 改用显式 API Key；桌面端方案二仅静态只读分析、**未实际体验过** |
| **40** | **Qwen (已删环境)** | `vertex-ai` + 代理报错 `HttpsProxyAgent is not a constructor` | v0.27.4 打包内 `vertex-ai` 代理分支 CJS/ESM 导入异常 | 避免混合分支；Vertex 交由 Gemini CLI / Cline / OpenCode |
| **41** | **Qwen (已删环境)** | `stream-json` 易漏判工具审批被拒 | 仅检查 `exit=0` 会忽略 `permission_denials` | 终态校验强制 `subtype==="success"` + `is_error===false` + `permission_denials.length===0` |
| **42** | **Claude / Copilot** | Copilot 占位符阻断与 OpenAI 思考续轮 400 | `copilot-shim` 非真 CLI；OpenAI 通道不回传 `reasoning_content` | 调 npm `@github/copilot` 原生 `copilot.exe`，设 `COPILOT_OFFLINE=true` + `anthropic` 协议 |
| **43** | **Codex (BYOK)** | 空版本目录 `ENOENT`；`Temp` 警告；`--ignore-user-config` 失效 | 旧哈希空目录；安全拒绝 Temp helper；跳过隔离 `config.toml` | `findCodexBin` 验文件存在；隔离 `CODEX_HOME` 放工作状态目录且 BYOK 不加 `--ignore-user-config` |
| **44** | **Pi / OMP** | GLM 拒 `developer` 角色；Node 22 跑 OMP 报语法错；OMP 缺 `ls` | 上游不认 `developer`；OMP 用 ES2025 `using`；内置工具为 `glob` | 设 `supportsDeveloperRole: false`；OMP 用原生 `bun.exe` + `read,bash,edit,write,grep,glob` |
| **45** | **OpenClaw** | Windows `symlink EPERM`；工作区被写入 `SOUL.md`/`AGENTS.md` | 插件技能建符号链接受限；默认开启 bootstrap 引导文件 | 配置固定 `plugins.enabled: false` + `agents.defaults.skipBootstrap: true` |
| **46** | **Kimi Code** | v2.6.2 找不到 `config.toml`；`-p` 与 `-y` 冲突退出 | 目录迁至 `.kimi-code/`；源码禁止 `--prompt` 搭 `--yolo`/`--plan` | 写隔离 `.kimi-code/config.toml`（`api_key_env`）；无头只传 `--output-format stream-json -p` |
| **47** | **Crush / Goose** | 工作区残留 `crush.json`；Goose 弹窗阻塞与文本分片 | 默认读 cwd 配置；Windows Keyring；`stream-json` 按消息分片 | Crush 用 `CRUSH_GLOBAL_CONFIG` 隔离；Goose 禁 Keyring 并按 `message.id` 拼接 |
| **48** | **国内直连 GLM** | 残留境外代理拖垮连接；高频并行触发 429 | 国内端走代理易超时；同账号并发超限触发速率限制 | 检测到 `bigmodel.cn`/`z.ai` 自动剥离 `HTTP_PROXY`/`HTTPS_PROXY`；多路任务错峰调度 |
| **49** | **Continue / Aider** | `cn -p` 忽略管道 stdin；Aider 非通用工具代理 | Windows stdin 未接管；Aider 基于 Git/文件 Diff 工作 | Continue 落地 `active-task.md` 传 `--prompt`；Aider 用 `--target`/`--read` + `--chat-mode ask` |
| **50** | **Cursor / Qoder CLI / Trae** | 有自定义 Key 入口但仍报无权限或未登录 | Cursor 经 `api2.cursor.sh` 中转且免费版封锁自定义模型；`qodercli` 先验登录；Trae IDE 经 `/custom_model` 中转且 Free 版报 503 | Cursor/Trae IDE 内改用 Cline/Kilo 扩展；Trae 无头走开源 `bytedance/trae-agent` |
| **51** | **Trae Agent (开源)** | 缺 `docker` 报错；中文 `cmd.exe` `0xb0` 毒化缓冲；`exit=0` 假成功 | `base_agent.py` 顶层 `import docker`；`_buffer.decode()` 抛异常未清缓冲；失败或无参 `task_done` 致 `final_result` 为空 | 安装加 `--extra evaluation`；`trae-launcher.py` 切 65001 + `mbcs` 清缓冲；核验 `traj.json` `success===true` |

## 3. WorkBuddy 专属维护经验

WorkBuddy 采用临时 CDP 连接主渲染器执行原生 IPC，其维护要点：
1. 启动必须通过 `workbuddy-bridge-session.ps1 -Mode Start`，核对 PID、监听端口及唯一主渲染器；
2. 派单必须附带 `--allow-debug`，桥接器不自动批准文件写入与命令执行；
3. 会话结束必须在同一目录下执行 `-Mode Restore` 恢复正常桌面启动并释放调试端口。

## 4. DSH 维护与审计细节

1. 日志端口与启动令牌动态绑定，禁止硬编码启动 URL；
2. 每次任务生成唯一 `requestId` 并写入工单尾部，确保事件轮询过滤精准无误；
3. 执行 `verify-no-secrets.mjs` 定期对日志与状态做已知令牌和签名 Cookie 形态审计。

---

<a id="ch09"></a>

# 09 · 工单与交接模板

## 1. 标准工单模板 (`TASK-TEMPLATE.md`)

```markdown
# TASK-001：<任务名称>

目标：<描述任务执行后可观察到的实际变化>
工作目录：<绝对物理路径，如 D:\Projects\Demo>
允许修改：<明确的文件范围，如 src/utils.js, test/utils.test.js>
禁止触碰：<如 node_modules/, .env, 配置文件等>

任务步骤：
1. <第一步具体操作与预期>
2. <第二步具体操作与预期>

验收条件 (AC)：
- AC-001：<具体产物文件路径及内容规则>
- AC-002：<自动化测试命令及预期输出，如 npm test 退出码为 0>
- AC-003：<边界情况验证>

回执规范：
- 列出实际修改的文件清单与代码 Diff 摘要；
- 逐条汇报 AC-001 至 AC-003 的验证结果；
- 只有全部 AC 通过，方可输出标记：TASK_001_COMPLETED_SUCCESSFULLY。
```

## 2. 五种目标的补充约束表

| 目标软件 | 派单约束与特殊注意事项 |
| --- | --- |
| **Antigravity** | 必须由主进程监控；脚本会自动批准 `runCommand`，需提前在工单限定风险命令；超时不自动取消 |
| **Codex** | 检查原生 CLI 版本；区分 `--write`（工作区写入）与 `--danger`（绕过沙箱）；必须核验 `turn.completed` |
| **WorkBuddy** | 必须使用临时调试实例启动；派单加 `--allow-debug`；任务完成后在相同目录执行 Restore 还原 |
| **DSH** | 严格隔离工作目录；禁止传 `--prompt`；以 `requestId` 过滤事件；切模型注意全局副作用 |
| **ZCode** | 必须带前置补丁；Z.ai 密钥严格使用两段式；查看历史使用 `--show` 命令，禁止无参数 `--resume` |

## 3. 通用接手提示词 (主 Agent Handoff Prompt)

```text
你已接入本地 Agent 桥接系统。请遵守如下规范：
1. 目标客户端已选定为：<Antigravity / Codex / WorkBuddy / DSH / ZCode>。
2. 所有执行任务必须以 UTF-8 工单文件写入工作区，严禁直接在终端发送过长文本。
3. 严格执行三层核验：【第一层】进程接受 -> 【第二层】协议终态 -> 【第三层】独立业务产物核对。
4. 遇到未知状态或超时，严禁盲目重发。必须先核查目标软件真实状态与本地数据落盘记录。
5. 【安全红线】：严禁在任何输出、日志、工单或代码中暴露明文 API Key；所有凭据必须脱敏。
```

---

<a id="ch10"></a>

# 10 · 证据、来源与核对记录

整理与本次检查日期：2026-11-04（Asia/Shanghai）。版本：v0.2。

## 1. 证据等级定义

- **Level 1（本次真机执行）**：在当前环境真机执行命令，取得实际退出码、返回值与持久化产物；
- **Level 2（源码与协议核对）**：通过静态 AST 分析、反编译或生成描述符核对输入输出契约；
- **Level 3（历史遗留证据）**：基于工作区内保留的历史日志、结果 JSON 和状态文件取证；
- **Level 4（推断/未验证）**：尚未经过受控验证的推测，文档中明确标注，不得包装为通过。

## 2. 来源及整合去向

| 来源 | 用途 | 本版主要去向 |
| --- | --- | --- |
| [`README.md`](../README.md) | 套件定位、五大桥接器速查与接手提示词 | 01、03–07、09 |
| [`AGENT_BRIDGE_METHODOLOGY.md`](../AGENT_BRIDGE_METHODOLOGY.md) | 五步法、协议、坑点 01–25 避坑库 | 02、07、08 |
| [`CODEX_BRIDGE_EXPERIENCE.md`](../CODEX_BRIDGE_EXPERIENCE.md) | CLI 发现、JSONL、实测记录与自审 | 04、08、本章 |
| [`workbuddy/README.md`](../workbuddy/README.md) | 临时调试、原生 IPC、双更新与恢复 | 05、08、本章 |
| [`dsh/README.md`](../dsh/README.md) | Connection RPC、签名 Cookie、实测与局限 | 06、08、本章 |
| [`zcode/README.md`](../zcode/README.md) | ZCode stdio 交互、Z.ai 规范、SQLite 补丁与实测 | 07、08、本章 |
| 各桥接器 scripts 与 test.mjs | 参数契约、单元测试与执行依据 | 各专章、本章 |

## 3. 历史实测与离线核验记录

### 3.1 离线测试总表 (Level 1)
在当前工作区环境下，执行全部离线单元测试套件：
- **WorkBuddy 离线测试**：`node --test workbuddy/scripts/dispatch-workbuddy.test.mjs`（11/11 通过）
- **DSH 离线测试**：`node --test dsh/scripts/dispatch-dsh.test.mjs`（10/10 通过）
- **ZCode 离线测试**：`node "d:\本地快速部署multi-agent-orchestration桥接\zcode\scripts\dispatch-zcode.test.mjs"`（6/6 通过）
- **OpenCode 离线测试**：`node --test opencode/scripts/dispatch-opencode.test.mjs`（7/7 通过，2026-11-16 新增） + `node opencode/scripts/verify-no-secrets.mjs`（`clean`）
- **Gemini CLI 离线测试**：`node --test gemini-cli/scripts/dispatch-gemini.test.mjs`（7/7 通过，2026-11-16 新增） + `node gemini-cli/scripts/verify-no-secrets.mjs`（`clean`）
- **Cline 离线测试**：`node --test cline/scripts/dispatch-cline.test.mjs`（6/6 通过，2026-11-16 新增） + `node cline/scripts/verify-no-secrets.mjs`（`clean`）
- **14 路可插拔外接 API（BYO-Key）桥接离线测试与安全审计** *(2026-11-16 新增，各 6/6 通过且 `verify-no-secrets.mjs` 全部 `clean`)*：
  - `claude-code`（6/6）、`codex` BYO-Key（6/6）、`copilot`（6/6）、`kimi-code`（6/6）、`pi`（6/6）、`omp`（6/6）、`kilo`（6/6）、`crush`（6/6）、`continue-cli`（6/6）、`iflow`（6/6）、`openclaw`（6/6）、`goose`（6/6）、`aider`（6/6）、`trae-agent`（6/6）
- **总计**：131 项单元测试全部通过，0 失败，0 跳过（原 `qwen-code/` 环境与 6 项测试已按要求卸载删除）。

### 3.2 ZCode 桥接器实战核验记录 (Level 1)
> *（注：本记录为 2026-11-04 在本地针对真实执行链路的联通性实测凭据，仅用于证明进程拉起、思考链捕获与 Token 结算功能有效。架构本身完全支持任意模型，用户可依据当期最新模型自主配置，无需局限于该测试模型。）*
* **环境**：Windows 11 / Node `v22.15.1` / ZCode Desktop `3.17.2` / CLI `0.17.1`
* **供应商与模型**：`zai-standard-api` / `GLM-5.3-Flash` / `reasoningLevel: high`
* **会话 ID**：`sess_cc4fa82b-1fc9-4e61-a685-d64004534cf0`
* **核验记录 1（首轮精准回复）**：
  * **用户输入**：`只回复这六个字：ZCode桥接已收到！`
  * **客户端回复**：`ZCode桥接已收到！`
  * **持久化**：写入本地数据库 `%USERPROFILE%\.zcode\cli\db\db.sqlite`。
* **核验记录 2（上下文复用与高思考强度追问）**：
  * **用户输入**：`你刚才回复了我什么？`
  * **GLM 思考链记录**：
    > *The user is asking what I just replied. Looking at the previous turn, they asked me to reply with exactly six characters: "ZCode桥接已收到！" and I did. Now they want to know what that reply was. This is a straightforward factual question about the conversation, so I can simply quote it back: ZCode桥接已收到！ Technically that string is six characters plus an exclamation mark, but no need to nitpick — just answer plainly and offer to help further.*
  * **回复内容**：`我刚才回复的是：**ZCode桥接已收到！** 这是按您的要求回复的内容。请问还有什么需要帮助的吗？`
  * **Token 消耗审计**：
    * `totalTokens`: 17,255
    * `inputTokens`: 17,126
    * `outputTokens`: 129
    * `reasoningTokens`: 100（证实高思考强度生效）

### 3.3 OpenCode 桥接器实战核验记录 (Level 1, 2026-11-16)
* **环境**：Windows 11 / Node `v22.15.1` / `@opencode/cli` v2.2.7（`opencode.exe`，后台服务 `http://127.0.0.1:28894`）
* **核验条目**：
  * `--status` / `--agents` / `--models`：返回 `connected: true`、4 个可见 Agent、55 个启用模型；
  * `--dry-run` 与无效模型前置拒绝：`google-vertex/fake-model-999` 报错退出（`exit=1`），`state.json` 未创建；
  * 隔离工单 Round 1（`google-vertex/gemini-3.5-flash`、`--archived`）：`9.6s` 完成 `read -> write -> read`，落盘 `result.txt` 为 `343_oc-bridge-20261116-ok`，服务端确认 `outcome=succeeded`、`observedModel=google-vertex/gemini-3.5-flash#default`；
  * 隔离工单 Round 2（`--reuse` + 切模型 `google-vertex/gemini-3.8-flash`）：`2.2s` 复用会话 `ses_e1d24c89affeB5gBn4jYV2rPTr` 准确召回 `343_oc-bridge-20261116-ok`，服务端独立确认 `observedModel=google-vertex/gemini-3.8-flash#default`；
  * 跨目录 `--reuse` 拒绝、`--show latest`、`--history --here` 均通过。
* **未验证项**：超时 `taskkill /T /F` 进程树清理分支、`--standalone` 完整轮次、`--auto` 权限放行、多文件重构/构建循环、并发派单、`--cwd-file` 中文目录 E2E。

### 3.4 Gemini CLI 桥接器实战核验记录 (Level 1, 2026-11-16)
* **环境**：Windows 11 / Node `v22.15.1` / `@google/gemini-cli` v0.68.0（`bundle/gemini.js`，`vertex-ai` 模式）
* **核验条目**：
  * `--status` / `--models`：返回 `connected: true`、16 个过滤后聊天模型；
  * `--dry-run` 与无效模型前置拒绝：`fake-model-999` 报错退出（`exit=1`），`state.json` 未创建；
  * 隔离工单 Round 1（`gemini-4-argon`、`--write`）：`25.8s` 完成 `read_file` + `write_file`（`343_gemini-bridge-20261116` 写入 `result.txt`），返回 `GEMINI_E2E_ROUND1_OK`，`stats.models` 证实 `gemini-4-argon`；
  * 隔离工单 Round 2（`--reuse` + `gemini-4-argon`）：`7.4s` 复用 `39d72e67-e7d3-4e9e-8b19-c034ce88e493` 拼接 `delta: true` 分片准确召回 `343_gemini-bridge-20261116`；
  * 跨目录 `--reuse` 拒绝、`--history` 均通过。
* **配额与未验证项**：本机 `~/.gemini/settings.json` 为 `vertex-ai`，故与 OpenCode 共用同一 Vertex 项目配额（实测 `gemini-4-carbon` 立即 429，而 `gemini-4-argon` 独立限流桶可用）；`~/.gemini/oauth_creds.json` 已于 `2026-10-20` 过期，若需改走个人 Google 账号额度需交互刷新登录。未验证超时 `taskkill` 分支、`--with-extensions`、并发多实例。

### 3.5 VS Code Cline 桥接器实战核验记录 (Level 1, 2026-11-16)
* **环境**：Windows 11 / Node `v22.15.1` / VS Code Cline `saoudrizwan.claude-dev-4.1.26`（`@cline/core` v0.2.0）
* **核验条目**：
  * `--status` / `--models --provider vertex`：返回 `connected: true`、识别 `gemini` (27) 与 `vertex` (40 / 目录 43) 模型、代理 `http://127.0.0.1:7897`；
  * `--dry-run` 与无效模型前置拒绝：`vertex/fake-model-999` 报错退出（`exit=1`），`state.json` 未创建；
  * 隔离工单 Round 1（`vertex/gemini-3.5-flash`、`--write`）：`23.1s` 完成 `read_files -> editor -> read_files`，落盘 `result.txt` 为 `343_cline-bridge-20261116`，返回 `CLINE_E2E_ROUND1_OK`，`observedModel=vertex/gemini-3.5-flash`；
  * 隔离工单 Round 2（跨进程 `--reuse` + 切模型 `vertex/gemini-3.5-flash-lite`）：`5.6s` 恢复 `1794816648346_wzim7` 准确召回 `343_cline-bridge-20261116`，`--show latest` 独立核实 `modelInfo.id === "gemini-3.5-flash-lite"`；
  * 跨目录 `--reuse` 拒绝、`--history --here` 均通过。
* **未验证项**：超时 `core.abort` 分支、`--mode plan`、`gemini` Provider 实测、无 `--write` 时对越权写操作的中断行为、并发多实例。

### 3.6 千问生态只读调研备案与桌面端方案二未体验声明 (Level 2, 2026-11-16)
* **状态说明**：此前验证过的 `@qwen-code/qwen-code` v0.27.4 全局包与 `qwen-code/` 桥接器环境已按用户要求卸载并删除；本节仅保留静态研究事实与避坑结论：
  * `qwen-oauth` 免费层已于 `2026-04-15` 停用；桌面端 `qianwen.exe` 依赖 `SecurityGuardSDK64.dll` 私有硬件签名；
  * **方案二（直驱千问桌面端 `cowork-agent-host.asar` 内 `engine/bundle.cjs` + `DASHSCOPE_API_KEY`）**：仅作 ASAR 只读静态源码分析（Level 2），**未编写垫片也未真实体验或实测跑通**。

### 3.7 通用无头 CLI 桥接器端到端核验记录 (Level 1, 2026-11-16)
* **环境**：Windows 11 / Node `v22.15.1` / Bun `1.4.4` / Python `3.11.5` (`~/.local/aider-venv`)；*(注：本次联通性验证仅因手头刚好有可用的智谱 GLM 兼容额度，顺带用于校验 OpenAI Chat / Responses / Anthropic 三种标准协议分支；各桥接器本身完全不绑定具体模型商)*
* **全量验收标准**：每条桥接器均在独立临时隔离目录下依次完成：`--status`、`--dry-run`、Round 1（读 `fixture.json` 并落盘 `result.txt` 为 `343_<agent>-e2e-20261116`）、Round 2（跨进程 `--reuse` 不重读文件召回该字符串）、跨目录 `--reuse` 拒绝（exit=1）以及 `verify-no-secrets.mjs`（`clean`）。
* **逐项实测耗时与结果**：
  * **Claude Code**（v2.1.325、`--bare`）：R1 `23.8s` (`tools=3`)、R2 `9.3s`；
  * **Codex BYOK**（v0.167.0-alpha.4.1、`/api/v1` Responses）：R1 `19.8s`、R2 `19.7s`；
  * **GitHub Copilot CLI**（v1.0.112、`COPILOT_OFFLINE=true` + `anthropic`）：R1 `21.9s` (`isByok=true, premiumRequests=0`)、R2 `6.8s`；
  * **Kimi Code CLI**（v2.6.2、`.kimi-code/config.toml` `api_key_env`）：R1 `23.8s` (`tools=3`)、R2 `5.8s`；
  * **Pi Coding Agent**（v0.73.0、`models.json`）：R1 `17.8s` (`tools=3`)、R2 `7.1s`；
  * **Oh My Pi (`omp`)**（v18.20.3、`bun.exe` + `models.yml` + `glob`）：R1 `17.7s` (`tools=3`)、R2 `5.9s`；
  * **Kilo CLI**（v7.8.27、`KILO_CONFIG_CONTENT`）：R1 `36.4s` (`tools=3`)、R2 `15.9s`；
  * **Crush CLI**（v0.101.0、`CRUSH_GLOBAL_CONFIG` + `session last`）：R1 `30.4s` (`tools=3`、工作区零残留)、R2 `11.8s`；
  * **Continue CLI (`cn`)**（v1.5.47、`CONTINUE_GLOBAL_DIR` + `--fork`）：R1 `34.9s`、R2 `16.2s`；
  * **iFlow CLI**（v0.5.19、`IFLOW_API_KEY` + `-o exec-info.json`）：R1 `27.3s` (`rounds=4`)、R2 `9.3s`；
  * **OpenClaw**（v2026.5.7、`plugins.enabled=false` + `skipBootstrap=true`）：R1 `55.9s`（工作区零 `SOUL.md` 残留）、R2 `39.3s`；
  * **Goose**（v1.59.2、`goose.exe` + 禁 Keyring）：R1 `20.7s` (`tools=3`)、R2 `6.0s`（另在并发压测时真实捕获 `429 Rate limit exceeded`）；
  * **Aider**（v0.86.2、Python venv + `--target`/`--read`）：R1 `Applied edit to result.txt` (`763->417 tokens`)、R2 `--chat-mode ask` 准确召回；
  * **Trae Agent (开源)**（`bytedance/trae-agent`、`uv` + Python 3.12.16 + `trae-launcher.py` 补丁）：R1 `33.9s` (`tools=7`、`343_trae-e2e-20261116`)、R2 `--reuse` `13.4s` (`tools=2`) 准确召回。
* **未验证项**：全部 13 路桥接器的超时 `taskkill /T /F` 树清理实测触发、多文件大型构建循环及部分高阶可选参数；详见各桥接器子目录 `README.md` 与 [`AGENT_USAGE_AND_BYPASS_METHODOLOGY.md`](../AGENT_USAGE_AND_BYPASS_METHODOLOGY.md)。

## 4. 全量敏感信息与脱敏合规审计

本手册及工作区所有衍生材料均已执行安全审计：
1. **真实密钥清零**：原测试中使用的真实 API 密钥已全量剔除，严格采用脱敏占位符替代；
2. **扫描核验**：全目录扫描确认无任何敏感两段式密文残留；
3. **安全注入标准**：明确规定后续工程实践统一采用环境变量（如 `$env:ZAI_API_KEY`）注入凭据。
