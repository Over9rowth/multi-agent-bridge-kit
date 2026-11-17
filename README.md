<p align="center">
  <a href="https://github.com/Over9rowth">
    <img src="./docs/suiren-badge.svg" alt="OVER9ROWTH · 燧人计划" width="420" />
  </a>
</p>

# 本地快速部署 Multi-Agent Orchestration 桥接套件

**简体中文** | [English](README_EN.md)

本开源项目解决的核心工程问题是：**「如何给市面上各种架构完全不同的本地 Coding Agent 搭桥」**，让一个「主 Agent（总架构师）」通过统一的 UTF-8 工单与纯 ASCII 短命令，自动发现并差遣本地的各类子 Agent（桌面 IDE / 扩展内核 / 无头 CLI）完成多文件编码、构建检查与测试闭环，避免主会话上下文被长链路试错撑爆。

全套方法论拆分为**主、辅两部分**：
1. **第一部分（核心主篇 · 怎么建桥）**：[`AGENT_BRIDGE_METHODOLOGY.md`](AGENT_BRIDGE_METHODOLOGY.md) —— **五类建桥技术原型 + 通用五步建桥法 + 三层终态验收 + 坑点 01–50**（无论子 Agent 用已有登录态还是自有 Key，桥接协议层都遵循本篇）。
2. **第二部分（辅助篇 · 怎么在喜欢的 Agent 上用非官方模型）**：[`AGENT_USAGE_AND_BYPASS_METHODOLOGY.md`](AGENT_USAGE_AND_BYPASS_METHODOLOGY.md) —— 当你选定了某款喜欢的 Agent 但不想被官方订阅锁死时，如何把外来 API Key（如智谱 GLM、DeepSeek、自定义网关等）无痕拼接进去，以及各工具的运行时/代理门槛对比。

---

## 📂 目录文件说明

| 文件名 | 用途说明 |
| :--- | :--- |
| `README.md` | **入口速查手册**：含一键复制给主 Agent 的「启动提示词模板」与常用命令 |
| `AGENT_BRIDGE_METHODOLOGY.md` | **核心五步搭桥方法论与实战避坑库**：从零探测进程、逆向协议、克隆配置到实战踩坑沉淀（坑点 01–50） |
| `AGENT_USAGE_AND_BYPASS_METHODOLOGY.md` | **主流 Agent 使用、免会员跳过登录（BYO-Key）与环境门槛方法论**（2026-11-16 新增）：覆盖 20 款 Agent 绕过登录原理、架构区别、Windows/Python/Bun/代理要求对照 |
| `dispatch-antigravity-template.mjs` | **跨项目通用版桥接器脚本**：自动适配当前所在项目目录（`process.cwd()`），复制到任何项目即可直接运行 |
| `dispatch-codex-template.mjs` | **Codex 版桥接器**（2026-11-16 升级双模式）：支持 ChatGPT 订阅与 **BYO-Key 免登录直连智谱 GLM**（`codex/README.md`），6 项离线测试 |
| `CODEX_BRIDGE_EXPERIENCE.md` | **Codex 搭桥实战记录**：五步方法论映射与失效点、协议差异、坑点 05–10 ＋ 20、真机实测与自审闭环 |
| `workbuddy/README.md` | **WorkBuddy 5.9.4 适配说明**：临时 CDP + 渲染器 `__wbInvoke` IPC，真实文件工单与会话复用实测、限制与未验证项 |
| `dsh/` | **DSH 桥接器目录**（2026-11-04 新增）：面向本机 DSH Desktop / DeepSeek Harness 的独立适配，含 `scripts/dispatch-dsh.mjs`、离线测试与密钥审计脚本 |
| `dsh/README.md` | **DSH 搭桥实战记录**：Harness Web `/api` Connection RPC 协议还原、五步映射、真机实测证据、12 条踩坑、安全边界与未验证项 |
| `zcode/` | **ZCode 桥接器目录**（2026-11-04 新增）：面向本机 ZCode Desktop 3.17.2 / CLI 0.17.1，支持 Z.ai API 调用、`GLM-5.3-Flash` 高思考强度调度、Node 22 SQLite 兼容补丁 |
| `zcode/README.md` | **ZCode 搭桥实战记录**：五步映射、AST 语法还原（`${providerId}/${modelId}$${reasoningLevel}`）、坑点 21–25、真实调用证据 |
| `opencode/` | **OpenCode 桥接器目录**（2026-11-16 新增）：面向本机 `@opencode/cli` v2.2.7，走 `opencode run --format json` + `opencode api` 服务端复核 |
| `opencode/README.md` | **OpenCode 搭桥实战记录**：五步映射、JSONL + OpenAPI 双通道、坑点 26–29、7 项离线测试与真机实测证据 |
| `gemini-cli/` | **Gemini CLI 桥接器目录**（2026-11-16 新增）：面向本机 `@google/gemini-cli` v0.68.0，直驱 `bundle/gemini.js` + `stream-json`，实测驱动 `gemini-4-argon`（炫彩猫猫） |
| `gemini-cli/README.md` | **Gemini CLI 搭桥实战记录**：五步映射、Vertex vs OAuth 配额边界、坑点 30–34、7 项离线测试与真机 E2E 证据 |
| `cline/` | **VS Code Cline 桥接器目录**（2026-11-16 新增）：直驱 VS Code Cline v4.1.26 内置 `@cline/core` ESM 无头核心，免 URI 弹窗、支持轻量模型秒切 |
| `cline/README.md` | **Cline 搭桥实战记录**：放弃 `/lg-task` URI 改用 `@cline/core` 原因、Node 22 代理隧道、坑点 35–38、6 项离线测试与真机实测证据 |
| `claude-code/` | **Claude Code 桥接器**（2026-11-16）：`--bare` 免登录 + `ANTHROPIC_BASE_URL` 直连智谱 GLM，6 项单测 + 密钥审计 + E2E |
| `codex/` | **Codex BYO-Key 测试与文档目录**（2026-11-16）：配套 `dispatch-codex-template.mjs` 免登录模式（`wire_api="responses"`），6 项单测 |
| `copilot/` | **GitHub Copilot CLI 桥接器**（2026-11-16）：`COPILOT_OFFLINE=true` + Anthropic BYOK 免订阅直连 GLM，6 项单测 + E2E |
| `kimi-code/` | **Kimi Code CLI 桥接器**（2026-11-16）：隔离 `.kimi-code/config.toml` + `api_key_env` 免登录直连 GLM，6 项单测 + E2E |
| `pi/` | **Pi Coding Agent 桥接器**（2026-11-16）：`PI_CODING_AGENT_DIR/models.json` 免登录直连 GLM，6 项单测 + E2E |
| `omp/` | **Oh My Pi (`omp`) 桥接器**（2026-11-16）：原生 `bun.exe` + `models.yml` 免登录直连 GLM，6 项单测 + E2E |
| `kilo/` | **Kilo CLI 桥接器**（2026-11-16）：`KILO_CONFIG_CONTENT` 纯内存注入免登录直连 GLM，6 项单测 + E2E |
| `crush/` | **Crush CLI 桥接器**（2026-11-16）：`CRUSH_GLOBAL_CONFIG` 零污染 + `session last --json` 复核，6 项单测 + E2E |
| `continue-cli/` | **Continue CLI (`cn`) 桥接器**（2026-11-16）：`CONTINUE_GLOBAL_DIR` + `${{ secrets.* }}` 免 Hub 登录，6 项单测 + E2E |
| `iflow/` | **iFlow CLI 桥接器**（2026-11-16）：隔离 `.iflow/settings.json` + `IFLOW_API_KEY` 免登录，6 项单测 + E2E |
| `openclaw/` | **OpenClaw 桥接器**（2026-11-16）：`agent --local --json` + 禁插件防 Windows `EPERM` + `skipBootstrap`，6 项单测 + E2E |
| `goose/` | **Goose CLI 桥接器**（2026-11-16）：Rust `goose.exe` + 禁 Keyring + 分片拼接直连 GLM，6 项单测 + E2E |
| `aider/` | **Aider 桥接器**（2026-11-16）：隔离 Python venv `aider.exe` + `--target`/`--read` 定向 Diff，6 项单测 + E2E |
| `trae-agent/` | **Trae Agent 开源桥接器**（2026-11-16）：面向 MIT 版 `bytedance/trae-agent` (`Python 3.12 + uv`)，含 `trae-launcher.py` Windows GBK 缓冲补丁 + `traj.json` 终态校验，6 项单测 + E2E |
| `docs/ENGINEERING_MANUAL_v0.2.zh-CN.md` | **工程手册 v0.2（最新完整版）**：整合 21 种 Agent 桥接器、坑点 01–51 统一索引、全套 131 项离线测试与凭据脱敏规范 |

> **注意**：Codex 与 Antigravity 的桥接机制不同。Codex 不暴露可复用的回环 RPC 端点，请直接读 `CODEX_BRIDGE_EXPERIENCE.md` 与 `codex/README.md`，不要照搬「扫端口 + CSRF Token」流程。

> **适配样本索引（共 21 款）**：Antigravity／Codex（订阅+BYOK）／WorkBuddy／DSH／ZCode／OpenCode／Gemini CLI／VS Code Cline／Claude Code／GitHub Copilot CLI／Kimi Code／Pi／Oh My Pi／Kilo／Crush／Continue CLI／iFlow／OpenClaw／Goose／Aider／Trae Agent（开源版）。**不同工具协议互不相通，换目标 Agent 必须按五步法还原契约**；真正共用的只有「环境变量注入密钥 + 工单文件派单铁律 + 发送后黄金校验 + 闭环终态校验 + 持续演进铁律」。

---

## 🚀 一、 给主 Agent 的「一键启动提示词」（直接复制发送）

### 场景 1：在新项目中，让任意主 Agent 照着本文件夹自动搭桥并开始工作
> 把下面这段话直接发给你的主 Agent（Claude / Gemini / Codex / Cursor 等）：

```markdown
请先读取 `D:\本地快速部署multi-agent-orchestration桥接\README.md` 与 `D:\本地快速部署multi-agent-orchestration桥接\AGENT_BRIDGE_METHODOLOGY.md`。
在本项目中，你担任「总设计师与总架构师」，只负责与我沟通方案、拆解架构与最终验收；
具体的多文件代码编写、构建与测试排错，请通过本地桥接器交由本机正在运行的 Antigravity 子模型完成：
1. 请将样本脚本 `D:\本地快速部署multi-agent-orchestration桥接\dispatch-antigravity-template.mjs` 复制到当前项目的 `scripts/dispatch-flash.mjs`（若尚未存在）；
2. 运行 `node scripts/dispatch-flash.mjs --status` 验证连接并查看可用模型列表；
3. **派单方式铁律**：后续具体编码与测试任务，**强制优先先写入 UTF-8 工单文件 `FLASH_TASK.md`，确认写入成功后再执行纯 ASCII 短命令 `node scripts/dispatch-flash.mjs --file FLASH_TASK.md`（同一模块小步追加可加 `--reuse`，跨模块新任务不带 `--reuse`）派单，严禁在 `--prompt` 中直接粘贴长段中文与路径**（避免 Windows 终端缓冲区卡死造成假发送）；
4. **黄金校验**：执行命令后必须确认终端输出 `[Flash Bridge] New session` 或 `Reusing session`，否则视为未发出；
5. **持续演进铁律**：若在桥接调用中遇到任何问题并解决，必须将问题与解决方案同步记录到项目文档与 `D:\本地快速部署multi-agent-orchestration桥接\AGENT_BRIDGE_METHODOLOGY.md` 中。
```

---

### 场景 2：当你换了另一个主 Agent，接管已有桥接器的项目
> 把下面这段话发给新换上的主 Agent：

```markdown
请先读取 `D:\本地快速部署multi-agent-orchestration桥接\AGENT_BRIDGE_METHODOLOGY.md` 了解我们的主从 Agent 协作规范与实战避坑记录。
你担任本项目的「总架构师」，日常编码、编译与测试循环请统一**优先写入工单文件后运行纯 ASCII 短命令 `node scripts/dispatch-flash.mjs --file FLASH_TASK.md`**（同一模块内小步追加使用 `--reuse`，跨独立模块任务不加 `--reuse`）派发给 Antigravity 子模型完成，**严禁在 `--prompt` 中直接粘贴长段中文**；
不要在主会话中反复跑耗费 Token 的编译排错循环。
硬性规则：若在桥接调用中遇到任何问题并解决，必须将问题与解决方案同步记录到项目文档与 `D:\本地快速部署multi-agent-orchestration桥接\AGENT_BRIDGE_METHODOLOGY.md` 中。
```

---

### 场景 3：针对全新的本地 Agent 软件（或软件大版本更新后）重新逆向搭桥
> 把下面这段话发给主 Agent：

```markdown
请读取 `D:\本地快速部署multi-agent-orchestration桥接\AGENT_BRIDGE_METHODOLOGY.md`，严格按照其中的「通用五步搭桥方法论」：
1. 扫描本机目标 Agent 后台进程、动态监听端口与内存 Token；
2. 扫描二进制符号表获取 RPC 接口与请求结构体字段；
3. 拉取模型枚举列表并克隆现有会话样本的 `plannerConfig`；
4. 实现带自动审批（Auto-Approve）与工单文件读取（`--file`）的桥接脚本并完成真机握手实测；
5. 将更新后的桥接器样本同步回 `D:\本地快速部署multi-agent-orchestration桥接\`；
6. 若遇到任何新问题并解决，必须将问题与解决方案同步记录到项目文档与 `D:\本地快速部署multi-agent-orchestration桥接\AGENT_BRIDGE_METHODOLOGY.md` 中。
```

---

### 场景 4：把本机 Codex 当作施工队（已实测跑通，2026-11-04）
> 适用于主 Agent 想把编码/构建/测试循环卸载给本机 Codex 的场景。先读 `CODEX_BRIDGE_EXPERIENCE.md`，再把下面这段发给主 Agent：

```markdown
请读取 `D:\本地快速部署multi-agent-orchestration桥接\CODEX_BRIDGE_EXPERIENCE.md`。
在本项目中你担任「总架构师」，只负责方案、拆解与验收；具体编码、构建、测试排错统一派给本机 Codex 子 Agent：
1. 把 `dispatch-codex-template.mjs` 复制到当前项目（若尚未存在），先运行 `node dispatch-codex-template.mjs --status` 确认在线；
2. 派单铁律：先把任务写入 UTF-8 工单文件 `CODEX_TASK.md`，确认写入成功，再执行纯 ASCII 短命令
   `node dispatch-codex-template.mjs --write --file CODEX_TASK.md`（同模块小步追加用 `--reuse`，跨模块新任务不加）；
3. 严禁在 `--prompt` 中粘贴长段中文与路径；严禁只看退出码就宣布完成，必须确认日志 `turnCompleted=true`，并核对工单约定的完成标记与产物文件是否落盘；
4. 模型可秒切：`node dispatch-codex-template.mjs --status` 查看 models[].slug，派单加 `--model <slug>`；
5. 遇到新问题并解决后，把「现象 + 根因 + 根治方案」追加到本目录踩坑库。
```

常用命令：

```powershell
node dispatch-codex-template.mjs --status                          # 状态 / 登录态 / 模型表
node dispatch-codex-template.mjs --write --file CODEX_TASK.md      # Windows 施工单（写文件 + 执行命令）
node dispatch-codex-template.mjs --reuse --file CODEX_TASK.md      # 复用上一 thread
node dispatch-codex-template.mjs --dry-run --file CODEX_TASK.md    # 只验参数，不启动
```

---

## ⚡ 二、 子任务模型秒切指南（`--model` 参数）

无需修改脚本代码，主 Agent 在调用桥接器时只需通过 `--model` 即可根据子任务性质切换最合适的模型：

| 别名 / 参数写法 | 对应 Antigravity 模型 | 内部枚举 ID | 推荐应用场景 |
| :--- | :--- | :--- | :--- |
| `--model high` *(默认)* | **Gemini 3.8 Flash (High)** | `MODEL_PLACEHOLDER_M318` | **主力施工队**：常规多文件开发、写测试、跑构建排错 |
| `--model medium` | **Gemini 3.8 Flash (Medium)** | `MODEL_PLACEHOLDER_M319` | 轻量级样式调整、文案修改、简单脚本执行 |
| `--model low` | **Gemini 3.8 Flash (Low)** | `MODEL_PLACEHOLDER_M320` | 极速简单批量替换 |
| `--model sonnet` | **Claude Sonnet 5.5 (High)** | `MODEL_PLACEHOLDER_M405` | 复杂前后端逻辑重构、高难度模块编写 |
| `--model opus` | **Claude Opus 5.5 (High)** | `MODEL_PLACEHOLDER_M402` | 疑难杂症深度排障 |
| `--model argon` | **Gemini 4 Argon (High)** | `MODEL_PLACEHOLDER_M417` | 跨模块审美与复杂架构子任务 |
| `--model gpt` | **GPT-OSS 120B (Medium)** | `MODEL_OPENAI_GPT_OSS_120B_MEDIUM` | 开源大模型对照实验 |

### 常用命令示例
```powershell
# 1. 查看当前连接状态与实时可用模型列表
node scripts/dispatch-flash.mjs --status

# 2. 【核心主力派单方式】跨模块任务新开会话派单（先写入 FLASH_TASK.md 确认成功，再执行纯 ASCII 短命令）
node scripts/dispatch-flash.mjs --file FLASH_TASK.md

# 3. 【同模块小步追加】复用上次会话上下文继续执行工单
node scripts/dispatch-flash.mjs --reuse --file FLASH_TASK.md

# 4. 临时切换为 Claude Sonnet 5.5 (High) 处理高难度重构
node scripts/dispatch-flash.mjs --reuse --model sonnet --file FLASH_TASK.md

# 5. 【仅限 < 80 字极短英文字符串】快捷调试指令（严禁在 --prompt 中粘贴长段中文与复杂路径）
node scripts/dispatch-flash.mjs --reuse --prompt "run pnpm test and fix failures"
```

## WorkBuddy 桥接器（2026-11-04）

现已提供独立的 WorkBuddy 5.9.4 桥接样本，入口：[workbuddy/README.md](workbuddy/README.md)。这是临时本机CDP与原生IPC适配，不是Antigravity协议的简单改名；真实文件工单和会话复用已验证，保留原生权限。详见该文的启动、派单、恢复及限制，不默认开启调试连接。

---

## DSH / DeepSeek Harness 桥接器（2026-11-04，已真机跑通）

第四个目标 Agent 适配样本，入口：[dsh/README.md](dsh/README.md)。面向本机运行的 `DSH Desktop 0.1.1` + `@deepseek-ai/dsh@0.1.5-rc.2` 的 Harness 自带 Web Server。

**不要照搬 Antigravity 的「扫端口 + CSRF Token」流程，也不要套用 WorkBuddy 的 CDP/IPC 或 Codex 的 stdio**：DSH 的凭据是 `harness.log` 里每进程一次性的启动令牌 `?token=`，**只能在根路径 `GET /?token=...` 换取 authority-bound、HttpOnly、SameSite=Strict 的签名 Cookie**；之后所有请求走 `POST /api/<endpoint>` 的 Connection RPC 信封（`client-request` / `server-response` + `rpcId` 关联）。API 路径上的 query token 与 `Authorization` 头一律不收，直接访问 `/api` 会 401。端点与参数外层名来自 `node_modules` 里只读的生成描述符，**不反编译、不提取账号凭据、不自动批准工具或命令**。

> 把下面这段发给主 Agent：

```markdown
请读取 `D:\本地快速部署multi-agent-orchestration桥接\dsh\README.md`，在 `dsh/` 目录先运行
`node scripts/dispatch-dsh.mjs --status` 确认本机 DSH Desktop 已启动并进入 Harness 界面。
你担任总架构师；具体编码与测试任务一律先写成 UTF-8 工单文件，确认写入成功后
用纯 ASCII 短命令 `node scripts/dispatch-dsh.mjs --cwd private/my-work --file DSH_TASK.md` 派发；
同模块小步追加用 `--reuse`，跨模块新任务不带 `--reuse`。
`--prompt` 已被本 CLI 直接禁用；不要把 `--status` 当成后台常驻服务。
状态为 uncertain 时禁止自动重发，先去 DSH 界面确认与查看 last-result.json；
切模型前先看 `--models`，注意 `--model` 会改配置级默认模型，用完按需恢复。
桥接器不自动批准工具或命令，验收要独立核对产物与主机侧请求配置，不能只信模型自述。
若遇到新问题并解决，按维护铁律把「现象 + 根因 + 根治方案」追加到 dsh/README.md 第 8 节与套件方法论文档。
```

常用命令（在 `dsh/` 目录下执行）：

```powershell
node scripts/dispatch-dsh.mjs --status                          # 实时连接状态
node scripts/dispatch-dsh.mjs --models                         # 实时模型注册表
node scripts/dispatch-dsh.mjs --cwd private/my-work --file DSH_TASK.md
node scripts/dispatch-dsh.mjs --reuse --cwd private/my-work --file DSH_FOLLOWUP.md
node scripts/dispatch-dsh.mjs --file DSH_TASK.md --dry-run      # 只验工单编码/字节数/SHA-256
node --test scripts/dispatch-dsh.test.mjs                      # 10 项离线协议测试
node scripts/verify-no-secrets.mjs                             # 令牌 / 签名 Cookie 泄漏审计
```

真机已跑通：隔离工单读 fixture 得 `DSH_FILE_OK 343 dsh-bridge-20261104-indigo-47`、同会话 `--reuse` 保留上下文、模型切换由主机侧 `request/header.header.config.model` 独立确认（非模型自述）、未知模型与跨目录 `--reuse` 均被拒、只读命令与工作区内写文件成功；离线测试 10/10、密钥审计 `clean`。**未做多文件重构/构建排错/E2E/并发派单，不承诺任何 Token 节省比例**；完整证据、14 条踩坑、界面可见性说明、残留配置变化与未验证项见 [dsh/README.md](dsh/README.md)。

---

## ZCode 桥接器（2026-11-04，已真机跑通）

第五个目标 Agent 适配样本，入口：[zcode/README.md](zcode/README.md)。面向本机运行的 `ZCode Desktop 3.17.2` / `ZCode CLI 0.17.1`，核心位于 `resources/glm/zcode.cjs`，支持自主配置当期旗舰推理大模型或轻量高吞吐执行模型。

**关键机制与差异**：
1. **Node 22 内置 SQLite 事务补丁**：Node 22.15.1 下启动 CLI 会触发 `DatabaseSync.isTransaction` 属性缺失导致的迁移断言失败崩溃。必须通过 `-r patch-sqlite.cjs` 前置挂载补丁。
2. **Z.ai 独立 API 与 BigModel 套餐隔离**：必须使用合法的两段式 API Key（`{apiKeyId}.{secret}`），禁止使用单段 Key。
3. **高思考强度模型选择语法**：ModelPicker 语法形如 `${providerId}/${modelId}$${reasoningLevel}`，默认自动配置为 `zai-standard-api/GLM-5.3-Flash$high`。
4. **历史直读避免 TUI 崩溃**：桌面版未随附 `@zcode/tui`，请使用桥接器内置的 `--show latest` 或 `--history` 从本地 SQLite 数据库直接解析对话与 GLM 思考链。

> 把下面这段发给主 Agent：

```markdown
请读取 `D:\本地快速部署multi-agent-orchestration桥接\zcode\README.md` 与 `D:\本地快速部署multi-agent-orchestration桥接\文档\本地 Multi-Agent 编排与客户端桥接工程手册v0.2.md`。
在 `zcode/` 目录运行 `node scripts/dispatch-zcode.mjs --status` 确认 ZCode 引擎及配置就绪。
你担任总架构师；编码与测试任务一律先写成 UTF-8 工单文件，使用纯 ASCII 短命令派发：
node zcode/scripts/dispatch-zcode.mjs --file TASK-001.md --model GLM-5.3-Flash --thinking high
同一模块小步追加使用 --reuse。
查看历史会话或模型思考链时，运行：
node zcode/scripts/dispatch-zcode.mjs --show latest
禁止在无 --prompt 情况下直接执行 --resume，严禁在日志或代码中记录明文 API Key。
```

常用命令：
```powershell
node zcode/scripts/dispatch-zcode.mjs --status                          # 检查引擎与配置状态
node zcode/scripts/dispatch-zcode.mjs --models                          # 查看可用模型及思考强度选项
node zcode/scripts/dispatch-zcode.mjs --history                         # 查看历史会话列表
node zcode/scripts/dispatch-zcode.mjs --show latest                     # 直读最新会话详情与思考过程
node zcode/scripts/dispatch-zcode.mjs --file TASK-001.md --dry-run      # 离线预检工单
node zcode/scripts/dispatch-zcode.mjs --file TASK-001.md                # 派发工单
node zcode/scripts/dispatch-zcode.mjs --reuse --file TASK-002.md        # 会话复用
node zcode/scripts/dispatch-zcode.test.mjs                              # 6 项离线单元测试
```

真机已跑通：6 项单元测试全部通过；指定 `zai-standard-api/GLM-5.3-Flash$high` 实测完成首轮精准中文回复（“ZCode桥接已收到！”）并在第二轮追问中成功召回，记录 100 个 reasoning tokens，全程无凭据泄露。完整细节见 [工程手册 v0.2](文档/本地%20Multi-Agent%20编排与客户端桥接工程手册v0.2.md)。

---

## OpenCode 桥接器（2026-11-16，已真机跑通）

第六个目标 Agent 适配样本，入口：[opencode/README.md](opencode/README.md)。面向本机运行的 `@opencode/cli` v2.2.7（原生 `opencode.exe` + 后台共享 HTTP 服务）。

**关键机制与差异**：
1. **官方双通道无需提取 Token**：实时模型/Agent 注册表、会话复核走 `opencode api get /api/{info,model,agent,session}`（自动发现后台服务并鉴权）；任务执行走官方无头 `opencode run --format json`（JSONL over stdio），`stdin` 传入 UTF-8 工单并立即 `stdin.end()`。
2. **派单前纯只读模型校验**：直接把无效 `--model` 传给 `opencode run` 会先在服务端留下 `outcome="failed"` 的残留空会话；桥接器先对照 `/api/model` 校验 `provider/model[#variant]`，不合法直接拒绝，不污染状态。
3. **双层终态 + 服务端模型证据**：不仅校验流末 `step_finish.part.reason === "stop"`（排除中间 `"tool-calls"` 轮），还读取 `/api/session/{id}/message` 核验 `idle.outcome === "succeeded"` 及 `assistant.model`。
4. **父会话环境隔离**：自动剥离 `OPENCODE_SESSION_ID` / `OPENCODE_TERMINAL` / `OPENCODE`，并在缺省 `OPENCODE_CONFIG` 时自动探测安装包旁边的 `opencode.json(c)`；默认保留原生权限守卫（不自动传 `--auto`）。

> 把下面这段发给主 Agent：

```markdown
请读取 `D:\本地快速部署multi-agent-orchestration桥接\opencode\README.md` 与 `D:\本地快速部署multi-agent-orchestration桥接\AGENT_BRIDGE_METHODOLOGY.md`。
在 `opencode/` 目录先运行 `node scripts/dispatch-opencode.mjs --status` 确认本机 OpenCode 服务在线。
你担任总架构师；具体编码与测试任务一律先写成 UTF-8 工单文件，再用纯 ASCII 短命令派发：
node D:\本地快速部署multi-agent-orchestration桥接\opencode\scripts\dispatch-opencode.mjs --cwd <项目路径> --file TASK_001.md --model google-vertex/gemini-3.5-flash
同一模块小步追加加 `--reuse`，跨模块新任务不加 `--reuse`；中文工作目录先把路径写入 `cwd.txt` 再传 `--cwd-file cwd.txt`。
桥接器默认保留 OpenCode 原生权限策略（不加 `--auto`）；验收时除回执文本与 `observedModel` 外，必须独立检查目标产物与测试结果。
若遇到新问题并解决，按维护铁律把「现象 + 根因 + 根治方案」追加到 `AGENT_BRIDGE_METHODOLOGY.md` 坑点库。
```

常用命令（在 `opencode/` 目录下执行）：

```powershell
node scripts/dispatch-opencode.mjs --status
node scripts/dispatch-opencode.mjs --models
node scripts/dispatch-opencode.mjs --agents
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --file TASK_001.md --dry-run
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --file TASK_001.md --model google-vertex/gemini-3.5-flash
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --reuse --file TASK_002.md --model google-vertex/gemini-3.8-flash
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --show latest
node --test scripts/dispatch-opencode.test.mjs
node scripts/verify-no-secrets.mjs
```

真机已跑通：离线测试 7/7、密钥审计 `clean`；隔离工单读 `fixture.json` 并写入 `result.txt`（`343_oc-bridge-20261116-ok`，`9.6s`、`outcome=succeeded`、`observedModel=google-vertex/gemini-3.5-flash#default`）；同会话 `--reuse` + 切模型 `gemini-3.8-flash`（`2.2s`）不重读文件准确召回并由服务端独立核验模型切换；无效模型前置拒绝（未建状态文件）与跨目录 `--reuse` 拒绝均通过。完整细节与未验证项见 [opencode/README.md](opencode/README.md)。

---

## Gemini CLI 桥接器（2026-11-16，已真机跑通）

第七个目标 Agent 适配样本，入口：[gemini-cli/README.md](gemini-cli/README.md)。面向本机运行的 `@google/gemini-cli` v0.68.0（直接由 `node.exe` 拉起 `bundle/gemini.js`，无需 `.cmd`/`.ps1` 包装器）。

**关键机制与差异**：
1. **禁二次拉起与禁重扩展**：设 `GEMINI_CLI_NO_RELAUNCH=true` 防止 `gemini.js` 二次派生子进程；默认传 `-e none` 禁用重型扩展，避免无端灌入 18KB 系统提示与阻塞 MCP 初始化。
2. **Vertex vs OAuth 配额真相**：若 `~/.gemini/settings.json` 为 `vertex-ai`，则走 GCP Vertex 配额（必须补齐 `GOOGLE_CLOUD_PROJECT` 与 `GOOGLE_CLOUD_LOCATION`——注意不是 `VERTEX_LOCATION`）；本机实测 `gemini-4-argon`（炫彩猫猫）在独立桶跑通，而 `gemini-4-carbon` 会与主会话竞争同一个 429 限流桶；若想改走个人 Google 账号额度，需终端交互刷新过期的 `oauth_creds.json` 并切回 `oauth-personal`。
3. **分片拼接与真实模型观测**：`-o stream-json` 中助手回复带 `delta: true`，必须累加拼接；`init.model` 可能仅回显请求别名（如 `gemini-3.5-flash`），实际执行模型须读取 `result.stats.models`。

常用命令（在 `gemini-cli/` 目录下执行）：

```powershell
node scripts/dispatch-gemini.mjs --status
node scripts/dispatch-gemini.mjs --models
node scripts/dispatch-gemini.mjs --cwd D:\YourProject --file TASK_001.md --model gemini-4-argon --write
node scripts/dispatch-gemini.mjs --cwd D:\YourProject --reuse --file TASK_002.md --model gemini-4-argon --write
node --test scripts/dispatch-gemini.test.mjs
node scripts/verify-no-secrets.mjs
```

真机已跑通：离线测试 7/7、密钥审计 `clean`；隔离工单以 `gemini-4-argon`（`25.8s`）完成 `read_file` + `write_file` 并由 `stats.models` 证实为 `gemini-4-argon`；同会话 `--reuse`（`7.4s`）准确召回；无效模型前置拒绝与跨目录 `--reuse` 拒绝通过。完整细节与坑点 30–34 见 [gemini-cli/README.md](gemini-cli/README.md)。

---

## VS Code Cline 桥接器（2026-11-16，已真机跑通）

第八个目标 Agent 适配样本，入口：[cline/README.md](cline/README.md)。面向本机安装的 VS Code Cline 扩展（`saoudrizwan.claude-dev-4.1.26`）。

**关键机制与差异**：
1. **直驱内嵌 `@cline/core` ESM 核心**：不走会触发 VS Code 弹窗、要求侧边栏可见且覆盖全局 `Documents/Cline/Hooks` 的 `vscode://saoudrizwan.claude-dev/lg-task` URI，而是直接导入扩展自带的 `@cline/core`（`ClineCore.create({ backendMode: "local" })`），天然复用 `~/.cline/data/` 凭据、模型目录与 `sessions.db`。
2. **Node 22.15.1 代理隧道补丁**：Node 22.15.1 原生 `fetch()` 忽略 `HTTPS_PROXY`，脚本自动读取环境变量或 VS Code `settings.json` 中的 `http.proxy` 并注入 `CONNECT` 隧道 `fetch`。
3. **自由切模型与跨进程复用**：可绕开默认易 429 的重模型，随时切换 `vertex/gemini-3.5-flash` 或 `vertex/gemini-3.5-flash-lite` 等轻量模型；通过 `core.readMessages(sid)` 传入 `initialMessages` 实现跨进程 `--reuse`。

常用命令（在 `cline/` 目录下执行）：

```powershell
node scripts/dispatch-cline.mjs --status
node scripts/dispatch-cline.mjs --models --provider vertex
node scripts/dispatch-cline.mjs --cwd D:\YourProject --file TASK_001.md --model vertex/gemini-3.5-flash --write
node scripts/dispatch-cline.mjs --cwd D:\YourProject --reuse --file TASK_002.md --model vertex/gemini-3.5-flash-lite --write
node scripts/dispatch-cline.mjs --cwd D:\YourProject --show latest
node --test scripts/dispatch-cline.test.mjs
node scripts/verify-no-secrets.mjs
```

真机已跑通：离线测试 6/6、密钥审计 `clean`；Round 1（`vertex/gemini-3.5-flash`、`23.1s`）完成 `read_files -> editor -> read_files` 落盘 `result.txt`；Round 2（跨进程 `--reuse` 切 `vertex/gemini-3.5-flash-lite`、`5.6s`）准确召回；无效模型前置拒绝与跨目录 `--reuse` 拒绝通过。完整细节与坑点 35–38 见 [cline/README.md](cline/README.md)。

---

## 13 路可插拔外接 API（BYO-Key）无头桥接实测矩阵（2026-11-16，全量端到端验真）

针对原生无头 CLI 或可扩展配置目录的 Agent，套件提供了完整的隔离派单适配器，支持通过环境变量注入任意兼容端点（OpenAI Chat / OpenAI Responses / Anthropic Messages）。下表为各桥接器的建桥机制与端到端联通性实测记录（注：本次验证恰好使用手头可用的智谱 GLM 兼容额度作为三协议标准测试端点；所有脚本均可通过 `--base-url` / `--model` / `--api-key-env` 无缝替换为 DeepSeek、OpenRouter、Ollama 或任意官方/自建端点）。完整外接 API 方法与环境门槛见：[AGENT_USAGE_AND_BYPASS_METHODOLOGY.md](AGENT_USAGE_AND_BYPASS_METHODOLOGY.md)。

> 已按要求卸载并移除旧 `@qwen-code/qwen-code` 与 `qwen-code/` 环境；关于 `qwen-oauth` 停用与千问桌面端方案二（未实际体验过）的分析保留在 `AGENT_BRIDGE_METHODOLOGY.md` 与 `AGENT_USAGE_AND_BYPASS_METHODOLOGY.md` 中。

| Agent | 入口目录 / 脚本 | 建桥隔离与免登录核心手段 | 单测 & 审计 | 端到端实测（标准测试模型 R1 写文件 / R2 `--reuse`） |
| :--- | :--- | :--- | :--- | :--- |
| **Claude Code** | [`claude-code/`](claude-code/README.md) | `--bare` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` | 6/6, `clean` | R1 `23.8s` (`tools=3`) / R2 `9.3s` |
| **Codex (BYOK)** | [`codex/`](codex/README.md) (`dispatch-codex-template.mjs --byok`) | 隔离 `CODEX_HOME` (`env_key` + `models.json` + `/api/v1` `responses`) | 6/6, `clean` | R1 `19.8s` / R2 `19.7s` |
| **GitHub Copilot CLI** | [`copilot/`](copilot/README.md) | `COPILOT_OFFLINE=true` + Anthropic BYOK (`isByok=true, premiumRequests=0`) | 6/6, `clean` | R1 `21.9s` / R2 `6.8s` |
| **Kimi Code** | [`kimi-code/`](kimi-code/README.md) | 隔离 `.kimi-code/config.toml` (`api_key_env`) | 6/6, `clean` | R1 `23.8s` / R2 `5.8s` |
| **Pi** | [`pi/`](pi/README.md) | `PI_CODING_AGENT_DIR/models.json` (`supportsDeveloperRole: false`) | 6/6, `clean` | R1 `17.8s` / R2 `7.1s` |
| **Oh My Pi (`omp`)** | [`omp/`](omp/README.md) | 原生 `bun.exe` + `models.yml` + `glob` 工具集 | 6/6, `clean` | R1 `17.7s` / R2 `5.9s` |
| **Kilo CLI** | [`kilo/`](kilo/README.md) | `KILO_CONFIG_CONTENT` 内存注入 (`{env:ZAI_API_KEY}`) | 6/6, `clean` | R1 `36.4s` / R2 `15.9s` |
| **Crush** | [`crush/`](crush/README.md) | `CRUSH_GLOBAL_CONFIG` + `session last --json` | 6/6, `clean` | R1 `30.4s` / R2 `11.8s` |
| **Continue CLI (`cn`)** | [`continue-cli/`](continue-cli/README.md) | `CONTINUE_GLOBAL_DIR` + YAML `${{ secrets.* }}` + `--fork` | 6/6, `clean` | R1 `34.9s` / R2 `16.2s` |
| **iFlow CLI** | [`iflow/`](iflow/README.md) | 隔离 `.iflow/settings.json` (`openai-compatible`) + `IFLOW_API_KEY` | 6/6, `clean` | R1 `27.3s` / R2 `9.3s` |
| **OpenClaw** | [`openclaw/`](openclaw/README.md) | `agent --local --json` + `plugins.enabled: false` + `skipBootstrap: true` | 6/6, `clean` | R1 `55.9s` / R2 `39.3s` |
| **Goose** | [`goose/`](goose/README.md) | 隔离 `GOOSE_PATH_ROOT` + `GOOSE_DISABLE_KEYRING=true` + `OPENAI_HOST` | 6/6, `clean` | R1 `20.7s` / R2 `6.0s` |
| **Aider** | [`aider/`](aider/README.md) | 隔离 Python venv `aider.exe` + `OPENAI_API_BASE` + `--target`/`--read` | 6/6, `clean` | R1 `Applied edit` / R2 `--chat-mode ask` 召回 |
| **Trae Agent (开源)** | [`trae-agent/`](trae-agent/README.md) | `uv` + Python 3.12 + `trae-launcher.py` (`cmd.exe` UTF-8 补丁) + `traj.json` | 6/6, `clean` | R1 `33.9s` (`tools=7`) / R2 `13.4s` |

通用派单示例（统一从环境变量注入 Key，切勿硬编码进仓库文件）：

```powershell
$env:ZAI_API_KEY = "<YOUR_COMPAT_API_KEY>"
node claude-code/scripts/dispatch-claude.mjs --cwd D:\YourProject --file TASK_001.md --write
node dispatch-codex-template.mjs --byok --cwd D:\YourProject --file TASK_001.md --write
node pi/scripts/dispatch-pi.mjs --cwd D:\YourProject --file TASK_001.md --write
```

