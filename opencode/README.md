# OpenCode 本地桥接器：实现、真机实测与经验

日期：2026-11-16（Asia/Shanghai）。环境：Windows、Node 22.15.1、OpenCode `@opencode/cli` v2.2.7（原生二进制 `opencode.exe`），后台共享服务默认随机回环端口（本次实测 `http://127.0.0.1:28894`，PID `5240`；**端口每次启动可能变化，脚本不写死任何端口或内部会话令牌**）。

状态结论：**桥接器已跑通真机全链握手、只读注册表发现、无效模型前置拒绝（零状态污染）、文件读写工具调用、同会话 `--reuse` 上下文记忆、模型切换及服务端独立观测验证（`observedModel` + `idle.outcome`）**；离线单元测试 7/7 通过；密钥审计 `clean`。未验证项与残留变化在文末单列。

---

## 1. 交付内容

| 文件 | 作用 |
| :--- | :--- |
| `scripts/dispatch-opencode.mjs` | 零第三方依赖桥接 CLI：原生二进制探测、服务/模型/Agent 查询、派单、JSONL 终态 + 服务端复核、原子状态与锁 |
| `scripts/dispatch-opencode.test.mjs` | 7 项离线单元测试（参数解析、ASCII 守卫、BOM/UTF-8、模型/Agent 校验、环境变量隔离、终态与模型错配判定） |
| `scripts/verify-no-secrets.mjs` | 只读安全审计：检查交付物是否混入私钥、`sk-`/`AIza` Key、Bearer 令牌或 OAuth 凭据 |
| `.gitignore` | 忽略 `private/`、状态 JSON、锁文件与临时文件 |
| `README.md` | 本说明文档 |

---

## 2. 为什么 OpenCode 不套用 Antigravity / DSH 的样本

| 维度 | Antigravity | DSH | OpenCode (v2.2.7) |
| :--- | :--- | :--- | :--- |
| **入口机制** | 扫 `language_server.exe` 端口 + `--csrf_token` | 扫 Harness 进程 + `harness.log` `?token=` 换 Cookie | 官方 `opencode service status` / `opencode api`（自动发现与鉴权）+ `opencode run --format json` |
| **模型注册表** | ConnectRPC `GetCascadeModelConfigData` | `session/modelCatalog` | `opencode api get /api/model`（55 个模型含 `variants`、状态、上下文上限） |
| **会话与配置** | 需克隆 `plannerConfig` + 设 EAGER | `session/create` 原生注入 | `opencode run` 原生加载 `opencode.json(c)`、权限策略、工具与技能，无需克隆 |
| **权限策略** | `WAITING` 轮询自动批准 `runCommand` | 不自动批准 | 默认沿用原生权限（如 `*.env` 询问、`browser` 拒绝）；仅在显式传 `--auto` 时自动批准非拒绝项 |
| **终态与模型证据** | `IDLE` + `stepCount` 稳定防抖 | `running=false` + `turn/end` + `request/header` | 流终态 `step_finish(reason="stop")` + 非空文本 + `/api/session/{id}/message` 的 `idle.outcome` 与 `assistant.model` |

---

## 3. 五步方法论在 OpenCode 上的映射

### 第 1 步：入口与环境探测
- `findOpenCodeBin()` 按 `OPENCODE_BIN` → `PATH` → `OPENCODE_HOME` → 常见安装路径查找**原生 `opencode.exe`**（在 Windows 上明确拒绝 `.cmd`/`.bat` 包装脚本，避免 `spawn` 失败）。
- `buildChildEnv()` 自动剥离父终端可能携带的 `OPENCODE_SESSION_ID`、`OPENCODE_TERMINAL`、`OPENCODE`，防止嵌套调用污染；若未设置 `OPENCODE_CONFIG`，向上自动探测安装包旁边的 `opencode.json(c)`。
- 后台服务通过 `opencode service status` 与 `opencode api get /api/info` 动态确认，脚本不接触也不导出底层鉴权文件。

### 第 2 步：协议还原（只读 `--help` 与 `/openapi.json`）
- `opencode run --format json` 从 `stdin` 读取 UTF-8 工单并立即 `stdin.end()`（避免长中文命令行与挂起）。
- 实测 JSONL 事件流：`step_start`、`tool_use`、`text`、`retry`（内置 429 自动退避重试）、`step_finish`（中间工具轮为 `reason: "tool-calls"`，最终收尾轮为 `reason: "stop"`）、`error`。
- 服务端 HTTP OpenAPI（139 个端点）通过 `opencode api get ...` 直接调用，无需手动拼接认证头。

### 第 3 步：动态模型与 Agent 注册表
- `--models` 调用 `/api/model`，实时列出启用的 `providerID/modelID` 与支持变体（如 `low` / `medium` / `high` / `xhigh`）。
- `--agents` 调用 `/api/agent`，列出非隐藏 Agent（如 `build`、`plan`、`general`、`explore`）。
- 派单前通过 `resolveModelSpec()` 与 `resolveAgentId()` **纯只读校验**：无效、禁用、不支持变体或歧义模型名在创建会话与写状态前直接拒绝。

### 第 4 步：会话持久化、锁定与安全边界
- 默认状态路径 `<cwd>/private/opencode-bridge/state.json`，同目录输出 `last-result.json`，并发互斥锁 `<state>.lock`。
- 首次从 JSONL 拿到 `sessionID` 后立即原子写入 `phase: "dispatching"`；成功收尾写入 `phase: "completed"`，异常/超时写入 `phase: "uncertain"`。
- `--reuse` 严格要求 `lastSessionId` 存在、`phase === "completed"` 且 `lastCwd === realpath(cwd)`。
- **权限边界**：默认**不传 `--auto`**，保留 OpenCode 原生权限守卫；仅在外部明确传入 `--auto` 时才自动批准非明确拒绝的权限。

### 第 5 步：三层验收闭环
1. **请求被接受**：收到 `sessionID` 且无 `error` 事件。
2. **协议终态 + 服务端观测**：进程 `exit=0`、无超时、`lastFinishReason === "stop"`、最终文本非空，且拉取 `/api/session/{id}/message` 确认 `idle.outcome === "succeeded"`、`assistant.model` 与指定 `--model` 一致。
3. **产物验收**：主 Agent 独立读取目标文件、运行测试或核对唯一完成标记。

---

## 4. 常用命令（在 `opencode/` 或任意项目下运行）

```powershell
# 1. 状态与离线自检
node scripts/dispatch-opencode.mjs --status
node scripts/dispatch-opencode.mjs --models
node scripts/dispatch-opencode.mjs --agents
node --test scripts/dispatch-opencode.test.mjs
node scripts/verify-no-secrets.mjs

# 2. 派发 UTF-8 工单（先写入工单文件，再发纯 ASCII 短命令）
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --file TASK_001.md --dry-run
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --file TASK_001.md --model google-vertex/gemini-3.5-flash

# 3. 同目录同模块复用会话 + 秒切模型
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --reuse --file TASK_002.md --model google-vertex/gemini-3.8-flash

# 4. 中文工作目录走纯 ASCII 命令（先把路径写入 UTF-8 文件）
node scripts/dispatch-opencode.mjs --cwd-file cwd.txt --file TASK_001.md

# 5. 查看历史会话与直读服务端详情
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --history --here
node scripts/dispatch-opencode.mjs --cwd D:\YourProject --show latest
```

---

## 5. 真机实测与验收边界

测试目录：`%TEMP%\opencode\oc-bridge-e2e`（隔离临时目录，会话加 `--archived`）。

| 检查项 | 实测结果 |
| :--- | :--- |
| 离线单元测试（7 项） | ✅ `7/7 pass` |
| 密钥/凭据只读审计 | ✅ `clean`（5 个文件，0 命中） |
| `--status` / `--agents` / `--models` | ✅ `connected: true`（`opencode v2.2.7`、`pid 5240`、55 个模型、4 个可见 Agent） |
| `--dry-run` | ✅ 校验 UTF-8、`bytes=224`、`sha256=babdd858a266`，未触碰服务端 |
| 无效模型前置拒绝 | ✅ `google-vertex/fake-model-999` 直接报错退出（`exit=1`），`state.json` 未创建 |
| Round 1（读写文件工具） | ✅ `9.6s`，`read -> write -> read` 完成，`finish=stop`、`outcome=succeeded`、`observedModel=google-vertex/gemini-3.5-flash#default`，落盘 `result.txt` 为 `343_oc-bridge-20261116-ok` |
| Round 2（`--reuse` + 切模型追问） | ✅ `2.2s`，复用 `ses_e1d24c89affeB5gBn4jYV2rPTr`，未重读文件准确答出 `343_oc-bridge-20261116-ok`，服务端独立确认 `observedModel=google-vertex/gemini-3.8-flash#default` |
| 跨目录 `--reuse` | ✅ 明确拒绝（`exit=1`） |
| `--show latest` / `--history --here` | ✅ 准确读回最新消息与目录过滤会话列表 |

**未验证项（如实单列）**：
- 超时分支的 `taskkill /T /F` 进程树清理与 3 秒兜底（已按 Codex 经验实现，本次测试均在 10 秒内结束，未触发超时）；
- `--standalone` 模式（不连共享后台服务、自起私有进程完成整轮对话）未单独跑完整 E2E；
- `--auto` 权限放行对 `*.env` ask 策略的真实行为、多文件大工程编译循环、并发派单、以及 `--cwd-file` 中文目录真实 E2E 尚未单独测试。

**残留环境变化**：
- OpenCode 后台数据库新增数条 `--archived` 探测/E2E 会话（位于 Temp 测试目录，已归档隐藏于常规列表）。
