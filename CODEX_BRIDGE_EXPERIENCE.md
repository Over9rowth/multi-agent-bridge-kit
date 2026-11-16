# 面向 Codex 的本地桥接器：实战记录与经验沉淀

> **定位**：把 `AGENT_BRIDGE_METHODOLOGY.md` 的「通用五步搭桥方法论」应用到 **OpenAI Codex（Windows 桌面版 + CLI 0.166.0-alpha.5.1）** 的完整实战记录。
> **结论先行**：方法论的**目标**（主 Agent 派单、复用本机账号态、卸载编码/测试循环、只回传摘要）在 Codex 上完全成立；但方法论的**第 1、2、5 步技术手段全部失效**——Codex 不提供可被外部进程复用的回环 RPC 端点，正确桥接点是官方无头 CLI `codex exec --json`，走 **JSONL over stdio**，不是端口。
> **实测日期**：2026-11-04；**环境**：Windows / Node v22.22.2 / Codex CLI 0.166.0-alpha.5.1 / ChatGPT 账号已登录。

---

## 一、 本次交付了什么

| 文件 | 说明 |
| :--- | :--- |
| `dispatch-codex-template.mjs` | 跨项目通用桥接器。接口刻意与 `dispatch-antigravity-template.mjs` 对齐（`--status` / `--file` / `--reuse` / `--model` / `--timeout` / `--thread`），复制到任意项目即可用 `process.cwd()` 作为工作根。 |
| `CODEX_BRIDGE_EXPERIENCE.md` | 本文件：逆向探测证据、五步方法论映射、协议差异、踩坑库、实测记录、提示词模板。 |

**协同模型**：本桥接器中，Codex 是被差遣的**子 Agent（施工队）**；主 Agent 可以是 WorkBuddy / Claude / Gemini / Cursor 等任意持有本地终端权限的会话。

---

## 二、 探测过程与关键证据

### 2.1 进程形态（对应方法论第 1 步）

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'codex' }
```

实测得到 5 类进程，其中与桥接相关的是两个：

```
codex.exe  app-server --analytics-default-enabled ...                 # 桌面 App 的引擎，stdio 模式
codex.exe  exec-server --remote https://codex-cloud-environments...   # 云环境执行器
codex-windows-sandbox-service.exe / codex-code-mode-host.exe / codex-computer-use-swift.exe
```

对照 `Get-NetTCPConnection -State Listen` 全量枚举：**没有任何 Codex 进程监听 TCP 回环端口**（列表中只有 Antigravity `language_server` 的 52139/52140 等）。

进一步验证官方 daemon 通道：

```
codex app-server daemon version
  -> Error: failed to connect to %USERPROFILE%\.codex\app-server-control\app-server-control.sock
     Caused by: 套接字操作遇到了一个已死的网络。(os error 10050)
```

且 `%USERPROFILE%\.codex\app-server-control\` 目录**不存在**。`\\.\pipe\` 下确有 `codex-ipc`、`codex-app-tools-*` 等命名管道，但属于桌面 App 私有 IPC，无公开 RPC schema，不适合作为稳定桥接点。

> **判断**：Codex 桌面 App 的 `app-server` 由 App 自身以**子进程 stdio 独占**方式启动，外部进程无法像 Antigravity 那样「模拟 UI 外壳向 127.0.0.1 发包」。方法论第 1 步（动态端口 + CSRF Token 提取）在 Codex 上无对象可探。

### 2.2 可用协议入口（对应方法论第 2 步）

无需抓包、无需扫描二进制符号表。CLI 自帮助即完整协议说明：

| 命令 | 关键能力 |
| :--- | :--- |
| `codex exec --help` | `--json`（JSONL 事件流）、`-s <sandbox>`、`-C <cwd>`、`-m <model>`、`--skip-git-repo-check`、`--ignore-user-config`、`--approve-for-me`、`-o <file>`、`-` 从 stdin 读指令 |
| `codex exec resume --help` | `--json`、`-m`、`-o`、`<SESSION_ID> -`；**不支持** `-C` / `-s` / `--approve-for-me` |
| `codex login status` | 返回 `Logged in using ChatGPT`，确认复用本机凭据 |
| `codex app-server proxy --help` | `--sock <SOCKET_PATH>` 代理 stdio 到 control socket（本次 daemon 未运行，不可用） |

JSONL 事件流实测形态（4 行完成一次极简任务）：

```json
{"type":"thread.started","thread_id":"01a1a5c1-401b-7fc2-80a8-2902a581e3c9"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"BRIDGE_HANDSHAKE_OK"}}
{"type":"turn.completed","usage":{"input_tokens":14263,"cached_input_tokens":12672,"output_tokens":10}}
```

`thread_id` 即会话主键（对应 Antigravity 的 `cascadeId`）；`item.completed` 里 `type === "agent_message"` 的文本即最终回执（对应 `CORTEX_STEP_TYPE_PLANNER_RESPONSE`）。

### 2.3 模型注册表（对应方法论第 3 步）

不通过 RPC，直接读本地缓存 `~/.codex/models_cache.json`：

```json
{ "fetched_at": "...", "models": [ { "slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol", ... } ] }
```

本次读到 10 个模型：`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6.1-terra`、`gpt-6-sol`、`gpt-reserve`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`codex-auto-review`。
`--model <slug>` 直接透传 `-m`。**注意**：这是本地缓存而非实时接口，新模型上线后需 Codex 自身刷新缓存；`--status` 会带出 `modelsFetchedAt` 供判断时效。

**如何证明模型真的切换生效**（脚本日志里的 `model=<slug>` 只证明参数已下发，不是证据）：读 Codex 自己写的 rollout 会话记录，按桥接器输出的 `thread` id 找文件，核对其中的 `model` 字段与 `session_id`：

```powershell
$f = Get-ChildItem "$env:USERPROFILE\.codex\sessions" -Recurse -Filter "*<thread_id>*.jsonl" | Select-Object -First 1
Select-String -Path $f.FullName -Pattern '"model":"[^"]*"' | ForEach-Object { $_.Matches.Value } | Sort-Object -Unique
```

2026-11-04 实测：`--model gpt-6-luna` 派单的 thread `01a1a5fc-c1a9-7cc3-b678-1333951f1da6`，其 rollout 中 `"model":"gpt-6-luna"` 出现 7 次，`session_id` 与 thread id 一致、`source: "exec"`、`cli_version` 与 `--status` 一致。这与方法论坑点 15 的教训同源：**模型自述、配置保存值、桥接器自己的日志，都不是实际请求证明**。

### 2.4 二进制发现（替代端口发现）

Codex 安装采用版本化哈希目录，路径会随升级变化，因此**绝不能写死**：

```
%LOCALAPPDATA%\OpenAI\Codex\bin\b6c7fc9497179c98\codex.exe
```

桥接器按 `CODEX_BIN` → `PATH` → `%LOCALAPPDATA%\OpenAI\Codex\bin\*`（按 mtime 取最新）的顺序动态解析，等价于方法论「动态凭据探测」的 Codex 变体。凭据走 `~/.codex/auth.json`，**无需额外 API Key**。

---

## 三、 五步方法论在 Codex 上的映射（核心经验）

| 方法论步骤 | Antigravity 做法 | Codex 上的实际做法 | 是否成立 |
| :--- | :--- | :--- | :--- |
| 1. 进程与动态凭据 | 读进程表拿 `--csrf_token` + 动态端口 | 动态定位版本化 `codex.exe`；`login status` 确认 `auth.json` 登录态；**无端口、无 Token** | ❌ 手段失效，目标保留 |
| 2. 协议识别 | 扫 Go 二进制符号表拿 RPC 路径与 JSON 字段 | 直接读 `codex exec --help` / `resume --help`，使用官方 JSONL 事件流 | ❌ 无需逆向 |
| 3. 模型注册表 | 调 `GetCascadeModelConfigData` | 读 `~/.codex/models_cache.json` 的 `models[].slug` | ✅ 等价替代 |
| 4. 会话样本克隆 | 从历史 step 提取 `plannerConfig` 保证工具链同构 | **不需要**：无 `cascadeConfig`；工具链由 CLI 内置 + sandbox 策略决定；上下文用 `exec resume <threadId>` 复用，工单文件即 prompt | ❌ 不适用 |
| 5. 自动审批 + 摘要回传 | EAGER 策略 + `WAITING` 轮询 + `HandleCascadeUserInteraction` 自动确认 | **无 WAITING 轮询**：headless 单进程同步跑完；由 `-s danger-full-access`（脚本 `--write`）代替人工审批；只取最后一条 `agent_message` 回传主 Agent | ⚠️ 机制不同，目标达成 |

**最重要的一条经验**：不要被「回环桥接」这个形式绑住。方法论真正可迁移的是**「找官方已存在的无头入口 → 复用账号态 → 会话持久化 → 只回摘要」**这条链路，而不是「127.0.0.1 + CSRF」这个实现细节。Codex 把无头入口做成了官方 CLI 子命令，反而比逆向 RPC 更稳、更不容易随版本失效。

---

## 四、 桥接器设计要点

1. **工单文件派单**：`--file CODEX_TASK.md`，UTF-8 内容经 `child.stdin.write(text, "utf8")` 送入 `codex exec ... -`，一条纯 ASCII 短命令即可规避 Windows 终端长中文假发送（沿用原方法论坑点 01）。
2. **必须闭合 stdin**：写完立即 `child.stdin.end()`，否则进程挂起（见坑点 06）。
3. **会话持久化**：收到 `thread.started` 后把 `thread_id` 写入项目根 `.codex-bridge-state.json`；`--reuse` 自动读出并改走 `exec resume <id> -`。
4. **上下文隔离 + 终态校验**：只打印 `command_execution` / `file_change` 的一步摘要，过滤 `reasoning` 与完整 JSONL；只采纳 `item.completed` 的 `agent_message` 作为最终回执，且必须收到 `turn.completed` 才判成功（见坑点 20 / 第十节）。实测一次施工主 Agent 侧仅约 6 行输出 + 一段 3 行中文回执。
5. **默认快速通道**：默认加 `--ignore-user-config`（见坑点 08）；需要 MCP/插件时用 `--with-user-config` 显式开启。
6. **Windows 施工开关**：`--write` = `-s danger-full-access`（见坑点 07）。默认仍是较安全的 `workspace-write`。
7. **超时必须杀进程树**：`taskkill /PID /T /F` + 3 秒兜底 resolve（见坑点 09）。

---

## 五、 真机实测记录（逐项可复核）

测试目录：`%TEMP%\codex-bridge-test\`（临时目录，未触碰用户项目）。

| # | 场景 | 命令要点 | 实测结果 |
| :--- | :--- | :--- | :--- |
| 1 | 裸 CLI 握手 | `codex exec --json --ignore-user-config -s read-only ... -` + stdin `/dev/null` | ✅ 11s，4 行 JSONL，返回 `BRIDGE_HANDSHAKE_OK` |
| 2 | `--status` | 桥接器 | ✅ `connected:true`，定位二进制、版本、登录态、10 个模型、configModel=`gpt-6.1-sol` |
| 3 | `--dry-run` | `--file CODEX_TASK.md` | ✅ 打印参数与中文工单前 120 字，UTF-8 无乱码 |
| 4 | 默认配置首次派单 | 加载完整 `config.toml` | ❌ 9m07s 未退出，仅完成 2 条 pwsh 命令，人工中止；但 `bridge-probe.txt` 已落盘 |
| 5 | 快速通道 + `workspace-write` | `--file CODEX_TASK.md` | ⚠️ 26.6s 正常退出、链路全通，但子 Agent 回报「环境为只读，检查命令也被策略拒绝」，任务未达标 |
| 6 | 快速通道 + `danger-full-access` | `--sandbox danger-full-access --file ...` | ✅ 18.8s，创建 `bridge-probe.txt`、执行 `node -e` 读回、回执含 `CODEX_BRIDGE_TASK_OK`；落盘内容 `CODEX_BRIDGE_FILE_OK` |
| 7 | `--reuse` | `--reuse --file CODEX_TASK_REUSE.md` | ✅ 11.6s，复用同一 `thread_id`，正确回答上一轮文件内容 `CODEX_BRIDGE_FILE_OK` |
| 8 | `--model` + `--prompt` + `--write` | `--model gpt-6-luna --prompt "Reply with exactly MODEL_PROBE_OK" --write` | ✅ 10.1s，返回 `MODEL_PROBE_OK` |
| 9 | **真实复杂任务：跨目录只读代码审查** | `--write --file CODEX_TASK_REVIEW.md`（工单要求审查 D 盘桥接器自身，只输出 3–5 条问题） | ✅ 34.8s，Codex 返回 4 条具体缺陷（3 条高危）+ `CODEX_REVIEW_DONE`，逐条核对源码后确认全部成立 |
| 10 | 修复后回归 | `--prompt "Reply with exactly PATCH_OK" --write` → 再 `--reuse --prompt "What exact word..."` | ✅ 21.0s / 13.3s，两轮均 `turnCompleted=true`，复用同一 thread 且正确回答 `PATCH_OK` |
| 11 | **指定模型 + 中文回复 + 主机侧模型证据** | `--model gpt-6-luna --write --file CODEX_TASK_LUNA.md` | ✅ 22.0s，回执严格为 `luna已收到`、`turnCompleted=true`；对应 rollout 中 `"model":"gpt-6-luna"` 出现 7 次，`session_id` 与 thread id 一致 |

**证据文件**：`run3/bridge-probe.txt`（内容 `CODEX_BRIDGE_FILE_OK`）、`run3/.codex-bridge-state.json`（`lastThreadId: 01a1a5cf-173f-7601-8c18-c013e8a5829c`）、`CODEX_TASK_REVIEW.md` / `CODEX_TASK_LUNA.md` 与对应 stdout 回执、各次任务 stdout；模型证据见 `~/.codex/sessions/2026/11/04/rollout-2026-11-04T17-56-07-01a1a5fc-…jsonl`。

**未实测项（如实标注）**：
- 修复后的超时 `taskkill /T /F` 分支未再触发（修复后各次任务均在 30s 内结束）——**已实现，未实测触发**。
- `codex app-server proxy --sock` 路径：本机 daemon control socket 不存在，**未验证能否在 daemon 启动后连上**。
- `--with-user-config` 完整工具链下的稳定施工：**实测失败（挂起），不建议日常使用**。
- `--danger` / `--approve` / `--verbose` / `--thread` 参数：**已实现，未逐项实测**。
- 并发多桥接器派单、超长会话（>100 步）表现：未验证。

---

## 六、 新增踩坑库（编号与 `AGENT_BRIDGE_METHODOLOGY.md` 第五节 05–10 对齐；自审条目另见坑点 20 / 第十节）

### 坑点 05：目标 Agent 根本没有可复用的回环 RPC 端点（2026-11-04）
- **现象**：按方法论第 1 步枚举本机监听端口，Codex 相关进程没有任何 TCP 回环端口；`codex app-server daemon version` 报 `failed to connect to ...\app-server-control.sock`（os error 10050），且该目录不存在。
- **根因**：Codex 桌面版 `app-server` 由 App 以**子进程 stdio 独占**启动，不监听端口；`\\.\pipe\codex-ipc` 等命名管道为私有 IPC，无公开 RPC schema。方法论第 1、2、4 步在 Codex 上无对象可探。
- **根治方案**：改走官方无头入口 `codex exec --json`（JSONL over stdio）：`--help` 取协议、`~/.codex/models_cache.json` 取模型表、`exec resume <threadId>` 复用会话。详见本文第三节映射表。

### 坑点 06：非交互环境下 `codex exec` 等待 stdin 永久挂起（2026-11-04）
- **现象**：`codex exec --json ... "PROMPT"` 在 Bash / 后台任务中输出 `Reading additional input from stdin...` 后卡死，进程被 SIGTERM，JSONL 文件 0 字节。
- **根因**：CLI 规定「stdin 为管道时，其内容会作为 `<stdin>` 块追加到 prompt」。Node `spawn` 默认 `stdin: "pipe"`，若不写入且不关闭，Codex 一直等 EOF。
- **根治方案**：① 直接把工单内容写进 stdin 并立刻 `child.stdin.end()`（本桥接器采用，同时解决长中文命令行问题）；② 或 shell 侧 `< /dev/null`。两者择一，不可省略。

### 坑点 07：Windows 下 `workspace-write` 实际只读，施工单必须提权（2026-11-04）
- **现象**：`-s workspace-write` 下子 Agent 回复「环境为只读，且检查命令也被策略拒绝，无法创建文件或运行 Node 验证」，但进程正常退出 `exit=0`，桥接器会误判为「已完成」——这是**软失败**。
- **根因**：Codex Windows sandbox（MXC）在该机器的临时目录 / 非 Git 工作区上没有授予写权限；`--ignore-user-config` 又去掉了用户配置里更宽松的 `sandbox = "elevated"`。
- **根治方案**：施工单显式 `--write`（= `-s danger-full-access`）。**验收必须以产物为准**（检查目标文件是否落盘），不能只看退出码和回执文本；主 Agent 应核对工单里约定的完成标记（如 `CODEX_BRIDGE_TASK_OK`）。

### 坑点 08：加载完整用户 `config.toml` 导致子进程挂起 9 分钟（2026-11-04）
- **现象**：桥接器首次派单未加 `--ignore-user-config`，9 分 07 秒仍未退出，`--json` 只吐出 2 条 `command_execution`；`--timeout 300` 也未能让脚本退出。
- **根因**：用户 `config.toml` 启用了 `node_repl` MCP、`browser`/`computer-use` 等插件及 `sandbox = "elevated"`；Windows 下会拉起 MXC sandbox 与多个 `codex.exe sandbox` 子进程（`node_repl kernel.js` 等），初始化与工具链链路极重，且部分子进程持有 stdio 管道不释放。对照实验：同一任务加 `--ignore-user-config` 后 11～27 秒内结束。
- **根治方案**：桥接器**默认**带 `--ignore-user-config`（认证仍走 `CODEX_HOME`，不丢登录态），需要插件时显式 `--with-user-config`。同时用坑点 09 的进程树 kill 兜底。

### 坑点 09：Windows 下 `child.kill()` 杀不掉进程树，超时形同虚设（2026-11-04）
- **现象**：`setTimeout(() => child.kill(), 300000)` 触发后，脚本仍卡在 `await child.on("close")`，运行 9 分钟不退出。
- **根因**：Node 在 Windows 上 `kill()` 只终止直接子进程；Codex 派生的 sandbox / pwsh 孙进程仍持有 stdout/stderr 管道，`close` 事件永不触发。
- **根治方案**：超时后 `spawnSync("taskkill", ["/PID", pid, "/T", "/F"])` 杀整棵树，并额外挂 3 秒兜底 `finish(-1)` 强制结束 Promise，保证脚本必定退出。

### 坑点 10：`resume` 不接受 `-C` / `-s` / `--approve-for-me`（2026-11-04）
- **现象**：若把新建会话的参数原样套到 `exec resume`，CLI 报未知参数。
- **根因**：`codex exec resume --help` 的参数集是主命令的子集，sandbox 与 cwd 沿用首次建会话时的配置。
- **根治方案**：桥接器 `buildArgs()` 对 resume 分支只下发 `--json --skip-git-repo-check [-m] [--ignore-user-config] -`；cwd 由 `spawn({cwd})` 提供。因此**跨项目复用同一 thread 是不安全的**，应按项目隔离 state 文件。

> **关于坑点 20**：Codex 自审另发现「exit=0 + 有回复文本 ≠ 任务完成」等 4 项缺陷。本文成文后，方法论第五节被 WorkBuddy / DSH 线并发追加了坑点 11–19，故该条目按全局递增登记为**坑点 20**（见方法论文末与本文第十节），此处不重复占号，也不改动他人条目。

> **补充设计提醒（不另编号）**：`exec resume` 的「成功」不等于「上下文被正确使用」。本次用「只回答上一轮文件内容」验证，返回 `CODEX_BRIDGE_FILE_OK` 且 thread id 未变，才可判定上下文复用有效；若工单自带全部背景，即使 resume 失效也看不出来。每次升级桥接器后建议做一次「不含背景信息的追问」回归验证。

---

## 七、 命令速查

```powershell
# 1. 连接状态 / 二进制 / 登录态 / 可用模型
node dispatch-codex-template.mjs --status

# 2. 先写 UTF-8 工单文件，确认写入成功后再发纯 ASCII 短命令（Windows 施工单）
node dispatch-codex-template.mjs --write --file CODEX_TASK.md

# 3. 同模块小步追加（复用 thread）
node dispatch-codex-template.mjs --reuse --file CODEX_TASK.md

# 4. 指定模型（见 --status 的 models[].slug）
node dispatch-codex-template.mjs --write --model gpt-6-luna --file CODEX_TASK.md

# 5. 只读审查 / 代码评审类任务（不写文件）
node dispatch-codex-template.mjs --sandbox read-only --file REVIEW_TASK.md

# 6. 调试：只看参数不启动；或打印原始 JSONL
node dispatch-codex-template.mjs --dry-run --file CODEX_TASK.md
node dispatch-codex-template.mjs --verbose --write --file CODEX_TASK.md
```

**黄金校验**：命令发出后必须见到 `[Codex Bridge] New session` 或 `Reuse session`，以及结尾的 `[Codex Reply]`；未出现即判定为未发出或中途失败。

---

## 八、 给主 Agent 的一键提示词模板

### 模板 A：把 Codex 当施工队（本桥接器的标准用法）

```markdown
请先读取 `D:\本地快速部署multi-agent-orchestration桥接\CODEX_BRIDGE_EXPERIENCE.md`。
在本项目中你担任「总架构师」，只负责方案、拆解与验收；具体编码、构建、测试排错统一派给本机 Codex 子 Agent：
1. 把 `dispatch-codex-template.mjs` 复制到当前项目（若尚未存在），先运行 `node dispatch-codex-template.mjs --status` 确认在线；
2. 派单铁律：先把任务写入 UTF-8 工单文件 `CODEX_TASK.md`，确认写入成功，再执行纯 ASCII 短命令
   `node dispatch-codex-template.mjs --write --file CODEX_TASK.md`（同模块追加用 `--reuse`，跨模块新任务不加）；
3. 严禁在 `--prompt` 中粘贴长段中文与路径；严禁只看退出码就宣布完成，必须确认日志 `turnCompleted=true`，并核对工单里约定的完成标记与产物文件；
4. 遇到新问题并解决后，把「现象 + 根因 + 根治方案」追加到本目录的踩坑库。
```

### 模板 B：Codex 本身是主 Agent 时

若某天由 Codex 担任主 Agent，本套件的角色对调：让 Codex 通过终端调用 `dispatch-antigravity-template.mjs` 把施工卸载给 Antigravity；`CODEX_BRIDGE_EXPERIENCE.md` 的坑点 06（stdin 闭合）与坑点 07（软失败验收）对任何无头子 Agent 同样适用。

---

## 九、 局限与风险声明

1. `--write`（`danger-full-access`）**取消沙箱与审批**。本桥接器默认不启用，仅在可信工作区、由主 Agent 明确派单时使用；工单应写清允许改动的文件范围。
2. `--with-user-config` 在本机实测会挂起，属于**环境相关结论**，换机器/换 Codex 版本可能不成立，使用前需重新实测。
3. 模型注册表读的是本地缓存，非实时接口；`--model` 传错 slug 时由 CLI 报错，桥接器不做预校验。
4. 本次全部实测为**单会话、单任务、临时目录**；并发派单、超长会话、Git worktree 场景均未验证。
5. 本桥接器不连接桌面 App 正在运行的会话，派单产生的是独立 headless thread（会出现在 Codex 会话历史中），不会干扰用户当前 UI 对话——这是与 Antigravity 桥接器在行为上的另一处差异。

---

## 十、 闭环验证：让 Codex 审查桥接器自身（2026-11-04）

为验证「这套桥接器能否真的承担任务，而不只是跑通握手」，用桥接器本身向 Codex 派了一份**只读代码审查工单**（`CODEX_TASK_REVIEW.md`）：要求读取 D 盘的 `dispatch-codex-template.mjs`，禁止改动任何文件，只输出 3–5 条具体问题并带唯一完成标记。

- **实测**：34.8s 返回，4 条意见（3 条高危），末行 `CODEX_REVIEW_DONE`。
- **Codex 原始意见（归纳）**：
  1. [高] 超时兜底只结束 Promise；孙进程持有管道时 Node 仍可挂起 → 应销毁 stdio、`unref()`，并报告进程树清理失败。
  2. [高] 成功判定未要求 `turn.completed`，且会把 `item.started/updated` 的流式消息当最终回复 → 应记录终态事件、只采纳已完成消息。
  3. [高] `thread_id` 等进程结束才保存，中途退出丢会话；直接覆盖状态文件非原子 → 应在 `thread.started` 时即时原子持久化。
  4. [中] PATH 探测允许返回 `.cmd` / `.bat`，但 `spawn` 不带 shell 会启动失败 → 只接受原生 `codex.exe`。
- **核实结论**：逐条对照源码，**4 条全部成立**，不是「听起来有道理」而是有明确代码位置的真实缺陷；已全部修复（见坑点 20）。
- **修复后回归**：新会话 21.0s 返回 `PATCH_OK` 且 `turnCompleted=true`；`--reuse` 13.3s 复用同一 thread 并正确回答 `PATCH_OK`。
- **意义**：这是「主 Agent 派单 → 子 Agent 读取真实项目文件 → 回传可执行结论 → 主 Agent 修复并复测」的完整闭环。工单中约定**唯一完成标记 + 严格输出格式**，对验收至关重要（呼应坑点 07）。

**仍需注意**：本次自审使用 `--write`（取消沙箱）以允许跨盘读取绝对路径，工单明确禁止写操作。若未来要在更严格沙箱下做同类审查，需重新实测 `read-only` 是否允许读取工作区外的文件。

---

Multi-Agent Local Bridge Kit | Codex 桥接器实战记录，2026-11-04（2026-11-16 补充 BYO-Key 免登录直连智谱 GLM `open.bigmodel.cn/api/v1` 双模式升级，详见 `codex/README.md`）。
