# 本地 Agent 桥接器（Agent-to-Agent Local Bridge）方法论与样本手册

**简体中文** | [English](AGENT_BRIDGE_METHODOLOGY.en.md)

> **文档定位**：本文件记录了在 Windows 本地环境下，让「主 Agent（总设计师/总架构师）」无需任何第三方反代软件、无需额外配置 API Key，直接通过本机回环接口（Loopback RPC）自动发现并差遣本地正在运行的另一款 Agent IDE（以 **Antigravity** 为标准样本）及其指定子模型（如 `Gemini 3.8 Flash`）的完整逆向探测方法论、协议规范、热切换指南与主 Agent 引导提示词模板。
>
> **适用范围补充（2026-11-04）**：本文件的「回环端口 + CSRF Token + 二进制符号扫描」是针对 Antigravity 的**实现细节**，不是通用前提。已实测 **OpenAI Codex（Windows 桌面版 / CLI 0.166.0-alpha.5.1）不提供可被外部进程复用的回环 RPC 端点**：其 `app-server` 由桌面 App 以 stdio 独占，daemon control socket 未运行；正确桥接点是官方无头 CLI `codex exec --json`（JSONL over stdio）。可迁移的是「找官方无头入口 → 复用账号态 → 会话持久化 → 只回摘要」这条链路。完整五步映射、坑点 05–10 与自审坑点 20、真机实测数据见同目录 `CODEX_BRIDGE_EXPERIENCE.md`，桥接器见 `dispatch-codex-template.mjs`。
>
> **适用范围补充（2026-11-04 续，DSH）**：另两个样本进一步说明「回环 RPC」本身也不是通用前提——**WorkBuddy 5.9.4** 走临时 CDP → 渲染器 `__wbInvoke` → 原生 IPC；**DSH Desktop 0.1.1 / `@deepseek-ai/dsh@0.1.5-rc.2`** 走 Harness 自带 Web Server 的 `POST /api/<endpoint>` Connection RPC，用 `harness.log` 里的每进程启动令牌在 `GET /?token=` 换签名 Cookie，**不接受 CSRF 头、`Authorization` 头或 API query token**，也不需要克隆任何 `plannerConfig`。第 2、4 步的探测对象因此完全不同：Antigravity 扫 Go 二进制符号表，Codex 读官方无头 CLI 的 `--help` 与 models cache，WorkBuddy 读渲染器 IPC 契约，DSH 只读 `node_modules` 里的生成描述符。**可迁移的始终是「动态发现 → 只读还原契约 → 查实时注册表 → 用目标原生配置 → 闭环终态校验」这条推理链，以及工单文件派单与黄金校验；不是任何具体端口、头部、字段名或自动审批钩子（后三个样本均不自动批准）**。完整五步映射、9 条新踩坑、真机证据与未验证项见 `dsh/README.md`，桥接器见 `dsh/scripts/dispatch-dsh.mjs`。
>
> **适用范围补充（2026-11-16 续，OpenCode）**：第六个样本 **OpenCode（`@opencode/cli` v2.2.7）** 虽然自身运行了随机端口后台 HTTP 服务（本次为 `127.0.0.1:28894`）并暴露 `/openapi.json`，但同样**无需逆向提取会话令牌或手动拼接请求头**——官方 CLI 已提供 `opencode service status`、`opencode api`（复用本机服务发现与鉴权）以及无头 JSONL 通道 `opencode run --format json`。可迁移方法论在此进一步收敛为：**「官方无头执行流（JSONL over stdio）+ 官方管理 API 只读注册表/服务端复核」**的混合架构，兼顾零凭据提取与主机侧独立验真。完整实现与真机证据见 `opencode/README.md` 与 `opencode/scripts/dispatch-opencode.mjs`。

---

## 一、 核心架构思想：为什么需要「主从 Agent 本地桥接」？

1. **主 Agent 的 Token 出血点**：
   - 高阶大模型（如 `Gemini 4 Argon` / `Claude Opus`）擅长审美决策、复杂架构拆解与跨模块统筹；
   - 但在实际工程中，**85%～90% 的 Token 消耗发生在「修改十几个文件 $\rightarrow$ 跑构建/类型检查 $\rightarrow$ 读取上千行终端报错 $\rightarrow$ 修细节重跑」的多轮工具调用循环**中（历史上下文随轮次线性甚至平方级膨胀）。
2. **本地回环桥接（Loopback Bridge）的降维优势**：
   - 绝大多数现代 AI IDE（Antigravity / Windsurf / Cursor / Codeium 系等）在桌面端运行时，其 UI 外壳（Electron/VS Code）与底层的 Agent 执行引擎（如 `language_server.exe`）之间**本身就是通过本机 `127.0.0.1` 的 HTTP/gRPC/ConnectRPC 接口通信的**。
   - 只要主 Agent 拥有本地终端执行权限，就可以**直接模拟 UI 外壳向 `127.0.0.1` 的本地引擎发包**，把长链路编码与测试循环完全卸载给本地 IDE 内的低成本/高吞吐模型，且天然复用该 IDE 已登录的账号态与内置工具链。

---

## 二、 通用五步搭桥方法论（以 Antigravity 为标准样本）

当主 Agent 面对一个新的本地目标 Agent（或目标软件版本升级后）时，按以下 **5 个标准步骤**即可在 3 分钟内从零构建出全自动桥接器：

### 第 1 步：进程与动态凭据探测（Process & Ephemeral Credential Discovery）
桌面 Agent 的后台服务通常在每次启动时随机分配本地监听端口（Ephemeral Port）并生成一次性 `--csrf_token` 或 `--auth_token`。桥接器**绝不能写死端口或 Token**，而应每次启动时通过系统进程表动态提取：

```powershell
# 标准探测命令（Windows PowerShell）
$proc = Get-CimInstance Win32_Process -Filter 'Name = "language_server.exe"' | Select-Object -First 1
$csrf = [regex]::Match($proc.CommandLine, '--csrf_token\s+(\S+)').Groups[1].Value
$ports = Get-NetTCPConnection -OwningProcess $proc.ProcessId -State Listen | Select-Object -ExpandProperty LocalPort
```

### 第 2 步：通信协议识别与接口枚举（Protocol & Schema Extraction）
无需抓包软件或反编译加密的 `app.asar`，直接针对本地引擎二进制文件（如 Go 编写的 `language_server.exe`）做两项轻量级只读扫描：
1. **枚举 RPC 路径**：扫描二进制中的 `/Service/Method` 字符串（例如匹配 `/exa\.language_server_pb\.LanguageServerService\/[A-Za-z0-9_]+/`），即可拿到完整的方法表：
   - 会话生命周期：`StartCascade`、`GetAllCascadeTrajectories`、`GetCascadeTrajectorySteps`、`DeleteCascadeTrajectory`
   - 消息派发与交互：`SendUserCascadeMessage`、`HandleCascadeUserInteraction`、`CancelCascadeInvocation`
   - 模型配置查询：`GetCascadeModelConfigData`
2. **提取请求体 JSON 字段签名**：
   - Go 编译的 Protobuf 结构体在符号表中保留了完整的 Getter/Setter 方法名（如 `StartCascadeRequest).Get...`、`SendUserCascadeMessageRequest).Get...`）以及 `protobuf:"...,json=xxx"` 反射标签；
   - ConnectRPC 协议原生支持 **`POST /<Package>.<Service>/<Method>` + `Content-Type: application/json` + `Connect-Protocol-Version: 1` + `x-codeium-csrf-token: <csrf>`**，无需构造复杂的二进制 Protobuf 编码。

### 第 3 步：动态查询模型注册表（Dynamic Model Registry Lookup）
调用 `GetCascadeModelConfigData` 接口（传空对象 `{}`），即可实时获取当前账号下所有可用模型的「显示名称 $\leftrightarrow$ 内部枚举 ID」映射表，无需盲猜模型名：

| Antigravity UI 显示名称 | 内部模型枚举 ID (`planModel`) | 适用分工定位 |
| :--- | :--- | :--- |
| `Gemini 3.8 Flash (High)` | `MODEL_PLACEHOLDER_M318` | **默认主力施工队**：多文件编码、重构、跑测试排错 |
| `Gemini 3.8 Flash (Medium)` | `MODEL_PLACEHOLDER_M319` | 轻量文案/样式微调、快速脚本执行 |
| `Gemini 3.8 Flash (Low)` | `MODEL_PLACEHOLDER_M320` | 极速简单批量替换 |
| `Gemini 4 Argon (High)` | `MODEL_PLACEHOLDER_M417` | 高阶复杂推理备选 |
| ` Gemini 4 Argon (Medium)` | `MODEL_PLACEHOLDER_M418` | 均衡设计/架构备选 |
| `Claude Opus 5.5 (High)` | `MODEL_PLACEHOLDER_M402` | 深度疑难排障备选 |
| `Claude Sonnet 5.5 (High)` | `MODEL_PLACEHOLDER_M405` | 备选主力编码模型 |
| `GPT-OSS 120B (Medium)` | `MODEL_OPENAI_GPT_OSS_120B_MEDIUM` | 开源大模型对照测试 |

> **如何切换或新增模型**：如果未来 Antigravity 更新了 `4.0 Flash` 或其他新模型，只需运行 `node scripts/dispatch-flash.mjs --status` 查看实时返回的 `clientModelConfigs` 列表，或直接在调用时传 `--model <MODEL_ID>` 即可秒切。

### 第 4 步：真实会话样本解剖与配置克隆（Trajectory Inspection & Config Cloning）
这是**最关键的实战技巧**：不要凭空猜测 `SendUserCascadeMessage` 里复杂的 `cascadeConfig`（工具列表、内置 Hook、Prompt Section 等）。
正确做法是：
1. 先调 `GetAllCascadeTrajectories` 拿到任意一个用户在 UI 里正常聊过的 `cascadeId`；
2. 再调 `GetCascadeTrajectorySteps`（读取 `startIndex: 0, endIndex: 5`），找到第一个 `type === "CORTEX_STEP_TYPE_USER_INPUT"` 的步骤；
3. 直接提取该步骤里的 `userInput.userConfig.plannerConfig` 作为桥接脚本的 `cascadeConfig` 模板！这样发出去的请求与官方 UI 发出的请求 **100% 同构**，拥有完整的内置工具（`read_file`、`edit_file`、`write_file`、`run_command` 等）与技能上下文。
4. 创建新会话调用 `StartCascade` 时，需传入必填枚举 `source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT"`、`trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE"` 以及当前工作区 `workspaceUris: ["file:///d:/YourProject"]`。

### 第 5 步：全自动闭环与免人工确认钩子（Eager Execution & Auto-Approval Loop）
为了实现「主 Agent 派单后无需人工切去 Antigravity 点 Accept 按钮」，需要双保险机制：
1. **配置层开启主动执行**：在 `plannerConfig.toolConfig.runCommand.autoCommandConfig` 中设置：
   ```json
   { "autoExecutionPolicy": "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER" }
   ```
2. **轮询层自动审批拦截（`WAITING` Watcher）**：
   - 脚本每隔 `1.5s` 轮询 `GetAllCascadeTrajectories` 的 `stepCount` 与 `status`；
   - 一旦发现某个新增 Step 处于 `CORTEX_STEP_STATUS_WAITING` 且包含 `runCommand`，脚本立即自动调用 `HandleCascadeUserInteraction`：
     ```json
     {
       "cascadeId": "<cascadeId>",
       "interaction": {
         "trajectoryId": "<trajectoryId>",
         "stepIndex": 12,
         "runCommand": {
           "confirm": true,
           "proposedCommandLine": "<cmd>",
           "submittedCommandLine": "<cmd>"
         }
       }
     }
     ```
3. **上下文隔离与摘要回传**：
   - 当会话状态回到 `CASCADE_RUN_STATUS_IDLE` 且 `stepCount > baseSteps` 时，脚本只提取最后一条 `CORTEX_STEP_TYPE_PLANNER_RESPONSE` 的文本输出到标准输出（stdout）；
   - 这样子 Agent 内部几十步的读文件、编译报错、重试细节全部留在 Antigravity 会话内部，**主 Agent 只消耗几百 Token 读取最终执行回执**。

---

## 三、 本仓库现成桥接器（`scripts/dispatch-flash.mjs`）使用与切换速查

### 1. 日常调用命令
```powershell
# 1. 检查连接状态与当前账号下所有可用模型代号
node scripts/dispatch-flash.mjs --status

# 2. 派发单次任务（新建独立会话，默认使用 Gemini 3.8 Flash High）
node scripts/dispatch-flash.mjs --prompt "任务描述..."

# 3. 复用上一次的施工会话继续追加指令（推荐：保持上下文连贯）
node scripts/dispatch-flash.mjs --reuse --prompt "继续修复刚才的单元测试..."

# 4. 通过工单文件派发复杂多模块任务（最适合大中型架构落地）
node scripts/dispatch-flash.mjs --reuse --file FLASH_TASK.md
```

### 2. 秒切其他子任务模型（无需改代码）
只需传入 `--model` 参数（支持别名 `high` / `medium` / `low` 或任意原始模型枚举 ID）：
```powershell
# 切换为 Gemini 3.8 Flash (Medium)
node scripts/dispatch-flash.mjs --reuse --model medium --prompt "..."

# 切换为 Claude Sonnet 5.5 (High) 负责特定子任务
node scripts/dispatch-flash.mjs --reuse --model MODEL_PLACEHOLDER_M405 --prompt "..."

# 切换为 GPT-OSS 120B (Medium)
node scripts/dispatch-flash.mjs --reuse --model MODEL_OPENAI_GPT_OSS_120B_MEDIUM --prompt "..."
```

---

## 四、 可复用提示词模板（未来换主 Agent 或跨项目搭桥时直接复制）

### 模板 A：换用新的主 Agent 时，让它直接接管现有桥接器
> **用法**：当你换了另一个主 Agent（或开启全新工具会话）时，把下面这段话发给它即可：
>
> ```markdown
> 请先读取 `<PROJECT_ROOT>\AGENTS.md` 与 `<PROJECT_ROOT>\docs\AGENT_BRIDGE_METHODOLOGY.md`。
> 在本项目中，你担任「总设计师与总架构师」，主要负责与我沟通设计方案、架构拆解与最终验收；
> 具体的多文件代码编写、构建检查与测试运行，请直接通过终端调用本地已搭建好的 Antigravity 桥接脚本：
> `node scripts/dispatch-flash.mjs --reuse --prompt "..."`（或将施工规范写入 `FLASH_TASK.md` 后运行 `node scripts/dispatch-flash.mjs --reuse --file FLASH_TASK.md`）。
> 先运行 `node scripts/dispatch-flash.mjs --status` 确认桥接器在线，然后我们开始工作。
> ```

### 模板 B：在全新项目或针对新目标 Agent 从零自动搭桥
> **用法**：以后你在其他项目想让任意主 Agent 自动按照这套方法论为你生成专属桥接器时，发送以下提示词：
>
> ```markdown
> 我希望你担任本项目的「总架构师」，并将具体编码与测试子任务通过本地回环接口自动分派给本机正在运行的子 Agent（如 Antigravity）。
> 请读取参考样本与方法论文档：`<BRIDGE_KIT_ROOT>\AGENT_BRIDGE_METHODOLOGY.md`（以及样本脚本 `<BRIDGE_KIT_ROOT>\dispatch-antigravity-template.mjs`）。
> 按照文档中的「通用五步搭桥方法论」：
> 1. 探测本机目标 Agent 后台进程、动态端口与 CSRF/Auth Token；
> 2. 查询可用模型枚举列表，默认绑定高性价比子模型（或我指定的模型）；
> 3. 提取现有会话样本的 `plannerConfig` 并配置自动执行与 `WAITING` 状态自动确认钩子；
> 4. 在当前项目生成桥接脚本并执行一次真实握手测试，跑通后将当前桥接说明记录到本地文档中。
> ```



---

## 五、 实战踩坑与避坑记录（持续演进库）

### 坑点 01：Windows PowerShell 超长中文 `--prompt` 假发送/卡死问题（2026-11-03）
- **现象**：主 Agent 在终端执行 `node scripts/dispatch-flash.mjs --prompt "长达几百字的中文与路径..."` 时，VS Code 终端 / ConPTY / PSReadLine 粘贴缓冲区会被长多字节文本或斜杠引号卡住，终端看似进入运行状态，但 `node` 进程实际根本未启动（状态文件未更新，日志无 `[Flash Bridge]` 输出，即“以为发了实际没发出去”）。
- **根治方案**：
  1. **强制使用工单文件派单（`--file`）**：凡是超过 80 字或含路径/引号/多段要求的任务，主 Agent 必须先写入 UTF-8 工单文件，再执行纯 ASCII 短命令 `node scripts/dispatch-flash.mjs --file FLASH_TASK.md`（仅 47 个 ASCII 字符，0.1 秒瞬发，100% 杜绝终端粘贴卡死）。
  2. **发送后黄金校验**：命令发出后必须确认日志出现 `[Flash Bridge] New session` 或 `Reusing session`，未出现即判定为未发出。

### 坑点 02：`--reuse` 会话累积超过 100 步后响应变慢问题（2026-11-03）
- **现象**：同一 `cascadeId` 连续复用超过 100～150 步后，历史轨迹过大导致每步推理耗时显著增加。
- **根治方案**：跨独立模块任务（如从实验室切换到摄像馆）时**不加 `--reuse`**，开启全新会话从 Step 0 轻装上阵；仅在同一模块内小步追加时使用 `--reuse`。

### 坑点 03：工单文件覆写校验（防止与 `run_commands` 并发时误发旧工单）（2026-11-03）
- **现象**：主 Agent 在同一回合同时调用 `editor`（覆写已存在的 `FLASH_TASK.md` 但未传 `old_text` 报错）与 `run_commands`（执行 `--file FLASH_TASK.md`），会导致桥接器读到上一轮残留在 `FLASH_TASK.md` 中的旧内容。
- **根治方案**：先完成工单文件写入（或使用带任务名的独立工单文件并在单条命令内先写入再调用），确认文件更新成功后再执行 `node scripts/dispatch-flash.mjs --file ...`。

### 坑点 04：子 Agent 后台异步命令轮询期间瞬时闪回 IDLE 导致桥接器提前返回问题（2026-11-04）
- **现象**：在执行耗时较长的前台构建或 E2E 测试命令（如 `test-lab-public.mjs`）时，子 Agent 调用后台异步命令并在轮询等待间隙输出了一句过渡态文本（例如“正在等待测试完成...”），此时轨迹概要的 `sum.status` 会短暂闪回 `"CASCADE_RUN_STATUS_IDLE"`。桥接器若只检查 `sum.status === "CASCADE_RUN_STATUS_IDLE"`，会误以为整个任务已结束，从而提前拉取半截回复退出，导致主 Agent 误以为施工完毕，而后台测试仍在运行。
- **根因**：
  1. Cascade 引擎在子 Agent 结束当前动作轮次等待异步后台任务时，`trajectorySummary.status` 会暂时处于 IDLE 状态；
  2. 此时子 Agent 发出的文本仅为过渡消息，且内部 step 队列中可能仍存在状态为 `"CORTEX_STEP_STATUS_RUNNING"`、`"CORTEX_STEP_STATUS_GENERATING"` 或 `"CORTEX_STEP_STATUS_WAITING"` 的异步未决步骤；
  3. 缺乏防抖机制，单一时刻的瞬时 IDLE 不能等同于任务全局完成。
- **根治方案（三重校验 + 连续稳定 IDLE 防抖）**：
  1. **未决步骤校验**：拉取最新 steps，确保没有任何 step 处于 `RUNNING`、`GENERATING` 或 `WAITING`；
  2. **终态类型校验**：检查最后一个非临时步骤必须为 `CORTEX_STEP_TYPE_PLANNER_RESPONSE`（即模型给出了完整的阶段总结，而非悬停在半截命令或工具调用上）；
  3. **稳定 IDLE 防抖计数器**：满足上述所有条件且**连续 2 次轮询（约 3 秒）保持稳定 IDLE 且 `stepCount` 未再增长**时，才真正判定施工完成并输出最终回复。

### 坑点 05：目标 Agent 根本没有可复用的回环 RPC 端点（2026-11-04，Codex）
- **现象**：按第 1 步枚举本机监听端口，Codex 相关进程一个 TCP 回环端口都没有；`codex app-server daemon version` 报 `failed to connect to ...\app-server-control.sock`（os error 10050），且该目录不存在。
- **根因**：Codex 桌面版 `app-server` 由 App 以**子进程 stdio 独占**启动，不监听端口；`\\.\pipe\codex-ipc` 等命名管道为私有 IPC，无公开 RPC schema。方法论第 1、2、4 步（动态端口/CSRF、二进制符号扫描、会话配置克隆）在 Codex 上无对象可探。
- **根治方案**：改走官方无头入口 `codex exec --json`（JSONL over stdio），用 `--help` 取协议、用 `~/.codex/models_cache.json` 取模型表、用 `exec resume <threadId>` 复用会话。详见 `CODEX_BRIDGE_EXPERIENCE.md` 第三节映射表。

### 坑点 06：非交互环境下 `codex exec` 等待 stdin 永久挂起（2026-11-04）
- **现象**：终端输出 `Reading additional input from stdin...` 后卡死，进程被 SIGTERM，JSONL 输出 0 字节。
- **根因**：CLI 规定 stdin 为管道时其内容会作为 `<stdin>` 块追加到 prompt；`spawn` 默认 `stdin: "pipe"`，不写入且不关闭则一直等 EOF。
- **根治方案**：把工单内容写入 stdin 并立即 `child.stdin.end()`（同时规避长中文命令行），或 shell 侧 `< /dev/null`。二者不可省略。

### 坑点 07：无头子 Agent 的「软失败」——退出码 0 但任务没做成（2026-11-04）
- **现象**：Codex 在 `-s workspace-write` 下回报「环境为只读，检查命令也被策略拒绝」，`turn.completed` 正常、`exit=0`，桥接器若只看退出码会误判施工完成。Windows MXC sandbox 在该机器临时目录/非 Git 工作区未授予写权限。
- **根治方案**：① 施工单显式提权（Codex 为 `--write` → `-s danger-full-access`）；② **验收以产物为准**，工单中约定唯一完成标记（如 `CODEX_BRIDGE_TASK_OK`），主 Agent 必须核对标记与目标文件是否落盘，不能只看回执文本。

### 坑点 08：加载完整用户配置导致子进程挂起 9 分钟（2026-11-04）
- **现象**：Codex 带 `config.toml`（`node_repl` MCP、多插件、`sandbox = "elevated"`）派单，9m07s 未退出，且 `--timeout 300` 未能让脚本退出；同一任务加 `--ignore-user-config` 后 11～27 秒完成。
- **根因**：Windows 下额外拉起 MXC sandbox 与多个 `codex.exe sandbox` 子进程，部分进程持有 stdio 管道不释放。
- **根治方案**：桥接器默认 `--ignore-user-config`（认证仍走 `CODEX_HOME`），需要工具链时显式开关；并配合坑点 09 的进程树 kill。

### 坑点 09：Windows 下 `child.kill()` 杀不掉进程树，超时形同虚设（2026-11-04）
- **现象**：`setTimeout(() => child.kill(), 300000)` 触发后脚本仍卡在 `await child.on("close")`。
- **根因**：Node 在 Windows 只终止直接子进程；孙进程持有 stdout/stderr 管道时 `close` 永不触发。
- **根治方案**：超时后 `spawnSync("taskkill", ["/PID", pid, "/T", "/F"])` 杀整棵树，并加 3 秒兜底 `finish(-1)` 强制结束 Promise。

### 坑点 10：`resume` 参数集是新建会话的子集（2026-11-04）
- **现象**：把 `exec` 的 `-C` / `-s` / `--approve-for-me` 原样套到 `exec resume` 会报未知参数。
- **根因**：resume 沿用首次建会话时的 cwd 与 sandbox 配置，CLI 不接受覆盖。
- **根治方案**：resume 分支只下发 `--json --skip-git-repo-check [-m] [--ignore-user-config] -`；cwd 由 `spawn({cwd})` 提供；state 文件按项目隔离，禁止跨项目复用同一 thread。

> 以上 05–10 的完整证据、命令与实测耗时见 `CODEX_BRIDGE_EXPERIENCE.md`。

### 维护铁律
以后每次在使用桥接器过程中遇到任何新问题，解决后必须第一时间将「现象 + 根因 + 根治方案」同步追加到本节以及 `D:\本地快速部署multi-agent-orchestration桥接\` 下的文档中。

## 2026-11-04 · WorkBuddy 专用桥接器实测补充

WorkBuddy 5.9.4 的工作协议与 Antigravity 不同。新增通用套件 workbuddy/README.md、workbuddy/scripts/dispatch-workbuddy.mjs、workbuddy-bridge-session.ps1及8项测试。采用临时127.0.0.1 CDP → 主渲染器__wbInvoke → 原生本地会话，保留default权限。真实工单读取隔离fixture得到343与校验标记，同会话追加正确返回标记；已验证关闭临时调试连接并恢复普通启动。不复用CSRF/Cascade协议，不提取账号凭据，不承诺旧文档的节省比例。

问题及处理：CLI默认bin缺少full/headless产物（lite-wb分流可解决）；独立CLI未自动获取桌面认证（改走原生IPC）；18488是/workbuddy/probe而非eval服务（按源码核对接口）；旧evalModeEnabled在发布版启动流水线写死false且接口强制bypass（未修改安装包，改临时CDP及原生权限）；第二实例只唤醒旧实例（启动器拒绝已有实例）；IPC第二参数是callerContext（固定undefined）；完整进程命令行可能含嵌套敏感配置（后续只输出字段白名单）；超时结果可能不确定（状态uncertain，禁止自动重发）。完整事实、命令、限制和验证范围见workbuddy/README.md。Start完整轮询、业务代码修改/编译、模型切换未实测；不能写成无人值守开发全链完成。

### 2026-11-04 续测：WorkBuddy HY4→HY3真实切换

按用户指定实测。当前Hy4显示名对应hy4free/hy4std，Hy3 ID为hy3；本轮仅调用hy4free与hy3。现象：仅configSetModel使保存配置显示hy3，实际下一轮requestModelId仍hy4free。根因：session:sendMessage使用已经加载的legacy运行时，保存层未同步它。根治：同时调用wb:conversations:configSetModel及session:setModel；并独立验证MODEL_REQUEST/requestModelId。最终修正后的CLI同会话hy4free→hy3、上下文标记和计算结果保留；11项测试通过，未知模型派单前拒绝且状态不变。完整Start/Restore已真机通过，结束调试端口关闭、WorkBuddy正常运行。现支持--models、--reuse --model hy3。完整更新和限制见workbuddy/README.md；不能把保存配置或模型自报当成实际请求证明。

---

## 2026-11-04 · DSH / DeepSeek Harness 专用桥接器实测补充（坑点 11–18）

**样本**：`dsh/scripts/dispatch-dsh.mjs`（零第三方依赖）、`dispatch-dsh.test.mjs`、`verify-no-secrets.mjs`；完整文档 `dsh/README.md`。目标为 `DSH Desktop 0.1.1` 源码 dev 实例 + `@deepseek-ai/dsh@0.1.5-rc.2`，Harness 回环端口本次为 `127.0.0.1:43130`（**每次启动变化，脚本不写死**）。

### 五步方法论在 DSH 上的映射（关键：第 4 步不再需要克隆配置）

| 五步 | Antigravity 标准做法 | DSH 实际落点 |
| :--- | :--- | :--- |
| **1 进程/凭据探测** | CIM 找 `language_server.exe` + `--csrf_token` + `Get-NetTCPConnection` | CIM 找命令行含 `harness-node-entry.mjs` 的 Node 进程取 `--port`；从 `%APPDATA%\...\logs\harness.log` 取最后一次匹配该端口的 `dsh web: .../?token=`。**只输出 `PID PORT` 白名单**，不打印完整命令行 |
| **2 协议/接口枚举** | 扫 Go 二进制符号表 `/Service/Method` | 只读 `dsh-client-connection/lib/index.js`（`client-request` / `server-response` + `rpcId` 关联校验）与 `dsh-api-session-controller/lib/typert.host.js`（生成描述符里的端点与 `parameters[].wire`）。**CDP 式 `/json/version` 探测在此目标上无效** |
| **3 动态模型注册表** | `GetCascadeModelConfigData({})` | `session/modelCatalog`（`args: {}`）→ `default` / `groups[].models[]`；`--model` 先对实时表做**纯校验**，未知或不唯一 ID 在派单前拒绝，不回退默认模型 |
| **4 配置克隆** | 克隆历史会话 `plannerConfig` + 设 `autoExecutionPolicy: EAGER` | **无对象可克隆**：`session/create({ request: { cwd } })` 由 Harness 原生注入工具与策略。实测运行时上下文为 `file policy: workspace-write` / `Approval policy: ask`；桥接器**不自动批准** |
| **5 闭环终态** | `stepCount` + IDLE 三重校验 + `WAITING` 自动审批 | `session/list` 读 `running` 与 `projections.asOfSeq` → `session/page` 取 `seq > baseline` 增量 → `turn/end` + `assistant/message` + `running=false` + **连续 2 次 `asOfSeq` 不变**；遇 `approval/asked` 只报告、不代批 |

RPC 信封（与 Antigravity 的 ConnectRPC 完全无关，Cookie 而非 CSRF 头鉴权）：

```text
POST /api/session/prompt    Content-Type: application/json    Cookie: <signed>
{ "type": "client-request", "rpcId": "<uuid>", "method": "session/prompt",
  "payload": { "args": { "request": { "requestId", "sessionId", "mode": "queue", "content": [...] } } } }

200 { "type": "server-response", "rpcId": "<same uuid>",
      "result": { "ok": true, "value": ... } | { "ok": false, "error": {...} } }
```

### 坑点 11：把启动令牌当通用 API Token，直接打 `/api` 得 401（2026-11-04，DSH）
- **现象**：`GET /` 返回 `dsh web authentication required; reopen the URL printed by dsh web.`；把 token 塞进 `/api/...?token=` 或 `Authorization` 头仍 401。另曾误把 `43128` 当成 Harness API（该端口返回手机配对页 `Pair your phone again. HTTP 401`），并试过 CDP 式 `/json/version` 得 404。
- **根因**：DSH 0.1.2-alpha.1 起 API 全局鉴权；**根路径 `?token=` 是唯一交换点**，换取绑定 authority 的签名 Cookie（host-only / `Path=/` / HttpOnly / `SameSite=Strict`）。API 路径与 `Authorization` 头按设计都不收令牌。`43128` 是独立手机配对 Bridge，不是 Harness Web Server。
- **根治方案**：CIM 拿端口 → 日志取该端口最后一次 `?token=` → `GET /?token=`（`redirect: manual`）取 `Set-Cookie` → 后续 `/api` 只带 Cookie。该令牌是**每进程 Web 会话启动令牌，不是账号 API Key / 凭据**，只在内存、不落盘、不进 stdout/状态/结果/日志；错误信息只说「令牌交换被拒绝」。探测改走只读源码而非 CDP 假设。

### 坑点 12：`session/page` 传超大 `throughSeq` 报 `past cursor`（2026-11-04，DSH）
- **现象**：`session page through seq 1000000000 is past cursor 1195`。
- **根因**：`throughSeq` 是持久化日志游标上界，不是「取全部」的哨兵值。
- **根治方案**：先 `session/list` 读 `projections.asOfSeq`，同时作为**基线**与 `throughSeq`，只处理 `seq > baseline` 的增量事件；分页回溯上限 8 页。与坑点 04 的「基线 + 稳定防抖」同构，但字段与事件类型全部换成 DSH 的。

### 坑点 13：参数外层名不统一，凭直觉写 `request` 得到 `gateway/bad-request`（2026-11-04，DSH）
- **现象**：`session/list` 用 `args: {}` 或 `{ request: {} }` 报参数错误。
- **根因**：端点由生成描述符定义，`parameters[].wire` 各不相同：`session/list` 是 `_request`；`create` / `prompt` / `page` / `selectModel` 是 `request`；`modelCatalog` 无参数（`args: {}`）。
- **根治方案**：**逐个核对 `typert.host.js` 的 `wire` 名，不猜、不套用别的端点**；新增端点时先读描述符再写代码。这一条说明「协议枚举」在 DSH 上比扫二进制更便宜，但同样不能跳过。

### 坑点 14：失败路径污染状态文件，导致后续 `--reuse` 被拒（2026-11-04，DSH）
- **现象**：用未知模型执行一次失败派单后 `state.json` 哈希变化，后续 `--reuse` 报 `requires a completed session recorded by this bridge`；另一处 `.map(() => ({ model: m.id }))` 漏参数导致合法模型报 `m is not defined`。
- **根因**：早期实现**先写 `switching-model` 状态、再校验模型注册表**，错误路径又把状态改成 `uncertain`；但该次调用**从未发送 prompt**，不该把会话标记为不确定。
- **根治方案**：拆成「纯校验 `resolveModelArg(catalog, arg)`（不改状态、不碰会话）→ 确认有效后才 `applyModel` / 写状态 / 建会话」；引入阶段化失败恢复，`phase` 分为 `before-session` / `session-ready` / `prompt-accepted` / `done`，`before-session` 失败恢复原状态，已建会话或 prompt 已接受才写 `uncertain`。复测未知模型拒绝时状态 SHA-256 前后一致（`8a013b2f…a27bc611`）。**通用教训：校验必须发生在产生副作用之前；失败恢复要按「已经产生了多少副作用」分级，而不是一律置为不确定。**

### 坑点 15：把「模型自述」或「保存的配置」当成实际请求证明（2026-11-04，DSH；与上文 WorkBuddy HY4→HY3 续测同源）
- **现象**：早期只在用户消息**之后**的事件里找 `request/header`，`observedModelHint` 一直为 `null`；若只看模型回复或 `selectModel` 返回值，无法证明这一轮真的用了新模型。
- **根因**：`request/header` 通常出现在用户消息**之前**；`selectModel` 只写入配置层，不等于下一轮实际请求。
- **根治方案**：在**全部增量事件**里读 `request/header.data.header.config`（`provider` / `model` / `reasoningEffort`），作为主机侧证据输出 `observedRequestConfig`，并要求它与 `selectedModel` 一致才认定切换成功。实测 `--model deepseek-v4-flash` 轮两者一致。**再次强调：模型自报与配置保存值都不是实际请求证明。**

### 坑点 16：插件注入运行时上下文导致一回合两条 `user/message`（2026-11-04，DSH）
- **现象**：`session/page` 中 seq 8 是工单、seq 9 是插件注入的运行时上下文，按「本轮第一条用户消息」定位会错位。
- **根因**：DSH 会话会在用户消息后追加一条上下文消息，二者事件类型都是 `user/message`。
- **根治方案**：派单时生成 `requestId` 并写入 `session/prompt`，同时在工单尾部附 `[dsh-bridge requestId: <uuid>]` 关联标签；用 `user/message.source.rpcId === requestId` 精确匹配，**不依赖消息顺序或条数**。

### 坑点 17：`--model` 是配置级默认模型的副作用，不是会话级开关（2026-11-04，DSH）
- **现象**：切换后 `--models` 的 `default.model` 从 `deepseek-flash` 变为 `deepseek-v4-flash`，**新建会话**的 `request/header` 也体现该默认值。
- **根因**：`session/selectModel` 写入的是配置层默认选择，不只是当前会话运行时。
- **根治方案**：实测确认后用 `session/selectModel` 把默认模型 ID 恢复为 `deepseek-official/deepseek-flash`，并在文档显式标注副作用与残留变化（默认视图 `reasoningEffort` 由「未显式给出」变为显式 `"high"`）。**通用教训：调用任何「设置类」接口前先确认作用域是会话级还是全局级，测试后必须复原并如实记录残留变化。**

### 坑点 18：Windows 探测与审计工具链的转义 / 路径 / 误报陷阱（2026-11-04，DSH）
- **现象与根因**（同一类问题的四个面）：
  1. `foreach (...) { ... } | Format-List` 在 Windows PowerShell 5.1 报「不允许使用空管道元素」；
  2. Git Bash 下 inline `node -e` 的反斜杠正则被 MSYS 改写（`\s` 变 `/s`），报 `Unexpected token ':'`；
  3. Git Bash 的 `/tmp/x.json` 不能被 Windows Node 按字面 `require`（`Cannot find module '/tmp/dsh-list.json'`）；上一步失败还让 `SID` / `SEQ` 为空，接着构造出非法请求体报 `body is not JSON`；
  4. 完整进程命令行可能含嵌套敏感配置，不能整行输出；密钥审计初版用宽松正则 `dsh_session=v1\.`，把源码/测试里的假 Cookie 字符串误报为泄漏。
- **根治方案**：探测与审计逻辑一律落成 `.mjs` 文件执行，不写复杂 inline `node -e`；CIM 探测改为逐行输出纯文本 `PID PORT` 由 Node 正则解析；临时数据走 **stdin 管道**而不依赖 `/tmp` 绝对路径；审计只匹配真实签名值形态 `v1.<20+>.<20+>`，且**只打印计数与文件路径、绝不打印令牌/Cookie 值**。复测：扫描 1 份 `harness.log` 中 16 个历史启动令牌、14 个交付文件，`tokenLeaks=[]`、`cookieValueLeaks=[]`、`verdict: clean`。

> 以上 11–18 的完整表格、命令与逐轮证据见 `dsh/README.md` 第 8 节；该文另有 4 条实现细节级记录（`.map` 闭包漏参、工单文件需先读后写等），此处不重复。

### 坑点 19：会话创建成功但目标界面「看不到」＋中文工作区路径与纯 ASCII 命令冲突（2026-11-04，DSH）
- **现象**：用户反馈「怎么没看到 DSH 有跟你沟通」；但 `session/list` 返回 15 个会话，桥接器创建的 3 个都在，`running=false` 且各有完整轨迹。
- **根因**：桥接器一直用隔离目录 `dsh/private/dsh-bridge-test` 作 `cwd`，而测试机原有 12 个会话的 cwd 全是 `<YOUR_CJK_WORKSPACE>`（如 `D:\YourChineseWorkspace`）；`session/list` 返回**全部**会话、item 里也没有 `workspaceId` 字段，**界面是否按工作区过滤属于推断，未实测界面渲染**。次要问题：铁律要求派单命令纯 ASCII，中文工作区路径不能直接出现在命令行。
- **根治方案**：① 需要界面可见时把新会话 `--cwd` 指向用户当前工作区，再用 `session/list` 复核新会话的 cwd 与总数（实测新会话 `session-0084f640-…9f5` 的 cwd = `<YOUR_CJK_WORKSPACE>`，`sessionCount` 15→16）；② 中文路径写入 UTF-8 文件，用 `CWD=$(cat cwd.txt)` 注入 `--cwd "$CWD"`，命令保持纯 ASCII，并先 `--dry-run` 核对 cwd 与工单 SHA-256；③ 如实区分「会话在存储里」与「界面上看得见」，后者必须请用户目视确认。**通用教训：桥接器验收不能只信 API 返回成功，还要确认目标端的用户可见性；跨工作区派单前先查目标端已有会话的 cwd 分布。**

### 真机实测与验收边界（如实区分「已实测 / 未验证」）

- **已实测**：`--status` / `--models`；隔离工单读 `fixture.json` 得 `DSH_FILE_OK 343 dsh-bridge-20261104-indigo-47`（轨迹含 `tool/call`、`tool/result`、`turn/end`）；同会话 `--reuse` 得 `DSH_REUSE_OK ...`（同一 sessionId）；`--model` 切换由 `observedRequestConfig` 独立确认；未知模型拒绝且状态哈希不变；跨目录 `--reuse` 拒绝；只读命令 `echo DSH_CMD_OK`；工作区内写文件 `dsh-bridge-write-test.txt`（13 字节）；离线测试 10/10；密钥审计 `clean`；**追加轮：在用户中文工作区 `<YOUR_CJK_WORKSPACE>` 新建会话，默认模型 `DeepSeek-V41-Flash`(`deepseek-flash`) 按工单回复指定中文标记（6s，`turn/end: completed`，主机侧 `observedRequestConfig.model=deepseek-flash`，`sessionCount` 15→16）**。
- **未验证**：多文件重构、构建/类型检查排错循环、E2E、并发派单、需要审批的高风险操作、`--model` 用于全新会话、超时后的取消与恢复；**DSH 界面是否按工作区过滤会话、新对话是否实际显示在界面上，均未实测（需用户目视确认）**。
- **残留环境变化**：DSH 中新增 4 个测试会话（`sessionCount` 12→16，桥接器不自动删除；前 3 个在隔离目录，第 4 个在用户工作区 `<YOUR_CJK_WORKSPACE>`）；默认模型 ID 已恢复，但 `reasoningEffort` 变为显式 `"high"`。
- **安全边界**：不读账号凭据、不导出令牌、不开公网监听、不启动第二个实例、不改安装包；令牌与 Cookie 只在内存；不自动批准工具/命令；保留原生 `workspace-write` + `ask` 策略；真实任务仍消耗 DSH 账号额度。
- **不沿用旧文档承诺**：本轮**没有测量也不承诺任何 Token 节省比例**；采用 1.5s 轮询而非 `/api/remote.mux` WebSocket 事件流；协议绑定 `dsh 0.1.5-rc.2` 生成描述符，升级后需重新握手与验收；超时写 `uncertain`，**禁止自动重发**。

---

## 2026-11-04 · Codex 桥接器自审补充（坑点 20）

> **编号说明**：本文件第五节 Codex 线占坑点 05–10，WorkBuddy / DSH 线后续追加了 11–19；为避免编号冲突，Codex 自审条目按全局递增取 **坑点 20**，内容不改动任何他人条目。

### 坑点 20：exit=0 + 有回复文本 ≠ 任务完成（2026-11-04，由 Codex 自审发现）
- **发现方式**：用 Codex 版桥接器把一个「只读审查桥接器自身脚本」的工单派给 Codex，34.8s 返回 4 条审查意见（3 条高危），逐条核对源码后确认全部成立。这是「子 Agent 审查桥接器」的一次真实闭环，也证明该桥接器可承担真实复杂任务。
- **现象/根因**：原实现只检查子进程退出码与 `turn.failed`；`item.started` / `item.updated` 的 `agent_message` 是流式中间文本，若事件流截断、模型拒绝执行或审批被拒，仍可能 `exit=0` 并返回半截文本，主 Agent 误判完成。此外 `thread_id` 等 `close` 后才落盘、直接 `writeFileSync` 覆盖（非原子）、超时兜底只 resolve Promise 未销毁 stdio 管道、PATH 探测会返回无法被 `spawn` 启动的 `.cmd` / `.bat` 包装脚本。
- **根治方案（已全部实施）**：① 只采纳 `item.completed` 的 `agent_message`；② 显式记录 `turn.completed`，缺失即判失败，日志输出 `turnCompleted=false`；③ 收到 `thread.started` 立即原子落盘（`.tmp` + `rename`），状态损坏时告警而非静默忽略；④ 超时兜底销毁三条 stdio 管道并 `child.unref()`，进程树终止失败时打印告警；⑤ PATH 阶段只接受原生 `codex.exe`。
- **修复后回归**：新会话 21.0s 返回 `PATCH_OK` 且 `turnCompleted=true`；`--reuse` 13.3s 复用同一 thread 并正确回答 `PATCH_OK`。
- **通用教训**：无头 Agent 的「完成」必须以协议层的终态事件为准，不能以进程退出码或「有文本输出」为准——这与坑点 07 的软失败属同一类问题的两个层次。完整意见、修复对照与验收边界见 `CODEX_BRIDGE_EXPERIENCE.md` 第十节。

---

## 2026-11-04 · ZCode 桥接实战补充（坑点 21–24）

> **样本说明**：目标软件为 ZCode Desktop `3.17.2` / CLI `0.17.1`（位于 `<ZCODE_INSTALL_DIR>`，如 `<ZCODE_INSTALL_DIR>`）。采用 Node 22 原生进程拉起，通过 stdio 交互，并成功驱动 Z.ai 平台的 `GLM-5.3-Flash` 高思考强度模型。完整代码与说明见 `zcode/` 目录。

### 坑点 21：内建 Provider 配置缺失 (CLI 路径查找回退失败)
- **现象**：直接调用 `zcode.cjs` 报错：`无法定位 CLI ZCode Built-in Provider Config：<ZCODE_INSTALL_DIR>\resources\glm\provider\zcode-builtin.json`。
- **原因**：打包路径与源码 `../../../../../config/provider` 结构脱节，发布包放置在 `resources/config/provider`。
- **排查与修复**：在 `<ZCODE_INSTALL_DIR>\resources\glm\provider\` 下补齐 `zcode-builtin.json` 软链接或副本。

### 坑点 22：Node 22 内置 `node:sqlite` 迁移事务所有权断言失败
- **现象**：Node v22.15.1 下启动 CLI 报 `SqliteSessionMigrationError: SQLite migration initialization failed ... Cause: Error: Migration transaction ownership mismatch`。
- **原因**：源码中使用了 `if (e.isTransaction !== !!n.transactionOpen) throw ...`，而在 Node v22.15.1 中 `DatabaseSync.prototype.isTransaction` 为 `undefined`，导致 `undefined !== false` 恒成立。
- **排查与修复**：编写 `patch-sqlite.cjs` 前置 preload 脚本，定义 `isTransaction` 属性及其根据 `exec('begin')` / `commit` 的自动拦截。

### 坑点 23：模型选择器与思考强度语法还原
- **逆向分析**：AST 反编译查明模型选择表达式格式为 `${providerId}/${modelId}$${reasoningLevel}`，模型选项支持 `low`、`high`、`max`。
- **排查与修复**：在 `provider_config.json` 的 `config.defaultModelSelection` 下注入：
  ```json
  {
    "providerId": "zai-standard-api",
    "modelId": "GLM-5.3-Flash",
    "options": {
      "reasoningLevel": "high"
    }
  }
  ```

### 坑点 24：Z.ai 独立 API 与 BigModel 套餐及 Client Signing 边界
- **现象**：默认若未配置或账号关联到 BigModel，会触发 `ClientRequestSigningV4` 签名握手。如果用户传入不带点号的 Key（如仅传递 `apiKeyId`），ZCode 会断言退出。
- **排查与修复**：明确隔离 Z.ai API（`zai-standard-api`）与 BigModel 套餐；传入标准的两段式 API Key（`{apiKeyId}.{secret}`），并在桥接器中提供 `--api-key` 与环境变量支持。

### 坑点 25：无参数 `--resume` 误触交互式 TUI 导致 `@zcode/tui` 缺失崩溃
- **现象**：在终端直接运行 `zcode.cjs --resume <sessionId>` 报 `Error: Cannot find package '@zcode/tui' imported from <ZCODE_INSTALL_DIR>\resources\glm\zcode.cjs`。
- **原因**：桌面版打包裁剪了终端全屏交互字符界面（TUI）。未携带 `--prompt` 时 ZCode 引擎默认启动 TUI 模式。
- **排查与修复**：明确无头 CLI 编排与交互式终端的分流规则。批处理命令必须传入 `--prompt` 或 `--file`；查看历史会话和模型思考链使用适配器提供的 `--history` 与 `--show [sessionId|latest]` 命令直读本地 SQLite 数据库。

---

## 2026-11-16 · OpenCode v2.2.7 桥接实战补充（坑点 26–29）

> **样本说明**：目标软件为 OpenCode `@opencode/cli` v2.2.7（原生二进制 `opencode.exe` + 后台共享 HTTP 服务）。采用 `opencode api` 做实时目录查询与服务端复核、`opencode run --format json`（JSONL over stdio）执行工单。完整代码与真机实测见 `opencode/` 目录。

| 五步 | Antigravity 标准做法 | OpenCode (v2.2.7) 实际落点 |
| :--- | :--- | :--- |
| **1 入口/凭据探测** | CIM 找 `language_server.exe` + `--csrf_token` + 端口 | `findOpenCodeBin()` 定位原生 `opencode.exe`（拒绝 `.cmd`/`.bat`）；`opencode service status` + `opencode api get /api/info` 复用后台服务发现与鉴权 |
| **2 协议/接口枚举** | 扫 Go 二进制符号表 `/Service/Method` | 只读 `opencode run --help` 与 `/openapi.json`（139 个端点），明确 `run --format json` 事件流与 `/api/session/{id}/message` 结构 |
| **3 动态模型注册表** | `GetCascadeModelConfigData({})` | `opencode api get /api/model` 与 `/api/agent`；支持 `provider/model[#variant]` 实时前置校验 |
| **4 会话与权限** | 克隆 `plannerConfig` + EAGER 自动确认 | 原生加载 `opencode.json(c)` 与默认权限；剥离父会话 `OPENCODE_SESSION_ID` 等环境变量；不默认开启 `--auto` |
| **5 闭环终态** | `IDLE` + `stepCount` 稳定防抖 | `step_finish(reason="stop")` + 非空文本 + 无 `error` + `exit=0`，并向 `/api/session/{id}/message` 复核 `idle.outcome="succeeded"` 与 `assistant.model` |

### 坑点 26：把无效 `--model` 直接交给 `opencode run` 会在服务端残留下失败空会话（2026-11-16，OpenCode）
- **现象**：直接执行 `opencode run --format json --model google-vertex/non-existent-model-xyz` 时，虽然 CLI 最终以 `exit=1` 和 `provider.no-route` 报错退出，但服务端已提前建出一条 `outcome="failed"` 的空会话 `ses_...`。
- **根因**：`opencode run` 的执行顺序是先建会话，进入模型路由阶段才校验模型是否可用。
- **根治方案**：在桥接器派单前先调用 `opencode api get /api/model` 做纯只读校验（`resolveModelSpec`，校验 `providerID/modelID`、`enabled !== false` 及 `#variant` 合法性），无效模型在建会话与写 `state.json` 之前直接拒绝（实测失败后 `state.json` 仍未创建、服务端零残留）。

### 坑点 27：`opencode run --format json` 的工具中间轮也会吐出 `step_finish`，不可误判完成（2026-11-16，OpenCode）
- **现象**：包含 `read` / `write` / `shell` 等工具调用的任务，会在每次工具回合结束时输出一次 `{"type":"step_finish", "part":{"reason":"tool-calls", ...}}`；只有最终总结回答轮才是 `"reason":"stop"`。
- **根因**：若仅见 `step_finish` 或见过 `text` 就判定成功，一旦流在工具执行后截断或异常中断，桥接器会把半截流程当成完工。
- **根治方案**：强制校验最后一个 `step_finish.part.reason === "stop"` + 最终文本非空 + 无 `error` 事件 + `exit=0`；并在非 `--standalone` 模式下额外拉取 `/api/session/{id}/message` 核对 `idle.outcome === "succeeded"` 及 `assistant.model`。

### 坑点 28：外部终端缺少 `start-opencode.bat` 环境与内部终端父会话变量污染（2026-11-16，OpenCode）
- **现象**：本机 OpenCode TUI 常通过 `start-opencode.bat` 注入 `OPENCODE_CONFIG`、`OPENCODE_HOME`、`HTTP_PROXY` 等变量；外部主 Agent 在干净终端调用时可能没有这些变量，而如果在 OpenCode 自己的内置终端调用时，环境里又会带着 `OPENCODE=1`、`OPENCODE_TERMINAL=1`、`OPENCODE_SESSION_ID=ses_...`。
- **根治方案**：`buildChildEnv()` 在拉起子进程前主动删除 `OPENCODE_SESSION_ID` / `OPENCODE_TERMINAL` / `OPENCODE` 防止父子会话串线；若 `OPENCODE_CONFIG` 未设置，自动从 `opencode.exe` 上级目录向上探测 `opencode.json(c)` 补齐；日常优先连接共享后台服务（服务进程自身持有配置与代理），从而在完全剥离环境变量的外部终端也能稳定复用。

### 坑点 29：Windows PowerShell 5.1 管道/重定向捕获 `opencode.exe` 中文输出引发 BOM 与乱码（2026-11-16，OpenCode）
- **现象**：用 PowerShell `Out-File -Encoding utf8` 捕获 `opencode api get` 的中文会话列表时，PowerShell 5.1 先按 GBK 解码 stdout 再写入带 UTF-8 BOM 的文件，导致 JSON 解析报 `Unexpected token '\uFEFF'` 且中文标题变为乱码。
- **根治方案**：桥接器一律由 Node.js `spawn` / `spawnSync` 直接拉起原生 `opencode.exe`（绝不经过 PowerShell 管道或 `.cmd` 包装脚本），以纯 UTF-8 读写 stdio，并在解析 JSON / 任务文件时显式剥离可选 UTF-8 BOM。

---

## 2026-11-16 · Gemini CLI v0.68.0 桥接实战补充（坑点 30–34）

> **样本说明**：目标软件为 `@google/gemini-cli` v0.68.0（Node bundle `bundle/gemini.js`）。采用 `node.exe` 直接拉起无头 `-p "" -o stream-json`（JSONL over stdio）。完整代码与真机实测见 `gemini-cli/` 目录。

| 五步 | Antigravity 标准做法 | Gemini CLI (v0.68.0) 实际落点 |
| :--- | :--- | :--- |
| **1 入口/凭据探测** | CIM 找 `language_server.exe` + `--csrf_token` + 端口 | 定位全局 npm `bundle/gemini.js`；设 `GEMINI_CLI_NO_RELAUNCH=true`；按 `settings.json` 自动补全 `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` |
| **2 协议/接口枚举** | 扫 Go 二进制符号表 `/Service/Method` | 只读 `--help` 与 `bundle/*.js`：`gemini -p "" -o stream-json` 读 `stdin`，输出 `init` / `message(delta:true)` / `tool_use` / `tool_result` / `result` |
| **3 动态模型注册表** | `GetCascadeModelConfigData({})` | 合并 `gemini models --output-format json` 与 `bundle/chunk-*.js` 声明的 4 系模型常量；前置校验防残留会话 |
| **4 会话与权限** | 克隆 `plannerConfig` + EAGER 自动确认 | 默认 `default` 审批，施工显式 `--write`（`yolo`）；默认 `-e none` 屏蔽重扩展；`--resume <session_id>` 同目录复用 |
| **5 闭环终态** | `IDLE` + `stepCount` 稳定防抖 | `exit=0` + `result.status==="success"` + 拼接后文本非空 + 拒认浏览器登录提示假成功 + 记录 `result.stats.models` |

### 坑点 30：`gemini.js` 默认二次拉起子 `node` 进程（2026-11-16，Gemini CLI）
- **现象**：直接执行 `node gemini.js` 时会检查内存上限并再次 `spawn` 新 `node` 进程，导致环境变量 `GEMINI_CLI_AUTH_OVERRIDE` 被删除且增加进程树复杂度。
- **根治方案**：在子进程环境中固定注入 `GEMINI_CLI_NO_RELAUNCH=true`，让单进程直接跑完。

### 坑点 31：`VERTEX_LOCATION` 无效与 `oauth-personal` 过期静默 `exit=0`（2026-11-16，Gemini CLI）
- **现象**：沿用 `start-opencode.bat` 的 `VERTEX_LOCATION=global` 时，Gemini CLI 依然报错缺少 `GOOGLE_CLOUD_LOCATION`；切到 `oauth-personal` 时若本地 `oauth_creds.json` 已过期，CLI 打印 `Opening authentication page... [Y/n]:` 后竟以 `exit=0` 退出且无任何 JSON 输出。
- **根治方案**：`vertex-ai` 模式下明确使用 `GOOGLE_CLOUD_LOCATION`（可从 `VERTEX_LOCATION` 或 `opencode.json` 回退读取）；终态判定器明确检测 `Opening authentication page` 字样并要求 `result.status === "success"`，拒绝 `exit=0` 假成功。

### 坑点 32：默认加载扩展与故障 MCP 导致 12k+ Token 开销与卡顿（2026-11-16，Gemini CLI）
- **现象**：不加过滤直接运行仅回复 `OK` 的探针，竟注入 `gemini-cli-security` 等 18KB 文档消耗 12,283 input tokens，且故障 MCP server 报错阻塞初始化。
- **根治方案**：桥接器默认附加 `-e none` 禁用用户扩展（确需扩展时显式传 `--with-extensions`）。

### 坑点 33：`stream-json` 助手回复带 `delta: true` 且 `init.model` 不可信（2026-11-16，Gemini CLI）
- **现象**：`role: "assistant"` 消息按 `"343_"` + `"gemini-cli-20261116"` 分片且均带 `delta: true`；传 `-m gemini-3.5-flash` 时 `init.model` 回显 `gemini-3.5-flash`，但内部路由器实际执行了 `gemini-4-argon`。
- **根治方案**：`delta === true` 时做字符串累加拼接；主机侧实际模型以 `result.stats.models` 为准，绝不把 `init.model` 或入参当真凭据。

### 坑点 34：`gemini models -o json` 隐藏 4 系模型且无效模型会残留空会话（2026-11-16，Gemini CLI）
- **现象**：`gemini models -o json` 仅输出 4 个基础项（不含 `gemini-4-argon`/`gemini-4-carbon`），且直接传未知模型名给 CLI 会先建会话再 404。
- **根治方案**：只读合并 `bundle/chunk-*.js` 中的 `VALID_GEMINI_MODELS` 声明常量（过滤非聊天常量），在派单前先做纯只读拒绝，零状态污染。

---

## 2026-11-16 · VS Code Cline v4.1.26 桥接实战补充（坑点 35–38）

> **样本说明**：目标软件为 VS Code 扩展 `saoudrizwan.claude-dev-4.1.26`。放弃受限多的 `vscode://` URI 路线，改用扩展自带的纯 ESM 无头核心 `@cline/core`（`ClineCore.create({ backendMode: "local" })`）。完整代码与实测见 `cline/` 目录。

| 五步 | Antigravity 标准做法 | VS Code Cline (v4.1.26) 实际落点 |
| :--- | :--- | :--- |
| **1 入口/代理探测** | CIM 找 `language_server.exe` + `--csrf_token` | 按 Semver 倒序定位 `~/.vscode/extensions/saoudrizwan.claude-dev-*/.../index.js`；自动读取 env 或 VS Code `settings.json` 的 `http.proxy` 注入 `CONNECT` 隧道 `fetch` |
| **2 协议/接口枚举** | 扫 Go 二进制符号表 `/Service/Method` | 只读 `@cline/core` exports 与 `ClineCore` / `LocalRuntimeHost` 源码：`core.start()`、`core.send()`、`core.subscribe(fn, { sessionId })`、`core.readMessages()` |
| **3 动态模型注册表** | `GetCascadeModelConfigData({})` | `ProviderSettingsManager.getProviderConfig()` + `getLiveModelsCatalog()`；支持 `provider/model` 自由切轻量模型，派单前纯校验 |
| **4 会话与权限** | 克隆 `plannerConfig` + EAGER 自动确认 | 默认 `toolPolicies: { "*": { autoApprove: false } }` + 拒绝回调，施工需 `--write`；跨进程 `--reuse` 通过 `readMessages()` 注入 `initialMessages` |
| **5 闭环终态** | `IDLE` + `stepCount` 稳定防抖 | `result.finishReason === "completed"` + 非空 `result.text` + 核对 `result.model` 与请求一致 |

### 坑点 35：`vscode://saoudrizwan.claude-dev/lg-task` URI 路线的四重陷阱（2026-11-16，Cline）
- **现象与根因**：① `cmd.exe /c code.cmd --open-url` 会把 URL 中的 `&` 当命令分隔符拆碎；② 直接调 `Code.exe --open-url` 缺 `ELECTRON_RUN_AS_NODE=1` + `out/cli.js` 会静默 `exit=0` 空退；③ `SharedUriHandler` 要求侧边栏 `getVisibleInstance()` 可见且 VS Code 弹出确认窗；④ `/lg-task` 会覆盖全局 `~/Documents/Cline/webhook_config.json` 与 3 个 PowerShell Hook 脚本，且无法临时覆写默认模型（被迫用易 429 的 `gemini-4-carbon`）。
- **根治方案**：绕过 VS Code GUI URI 链路，直接导入扩展内嵌的 `@cline/core` ESM 核心在无头 Node 进程中运行。

### 坑点 36：Node 22.15.1 原生 `fetch` 忽略代理导致 `oauth2.googleapis.com` 超时（2026-11-16，Cline）
- **现象**：直接跑 `ClineCore` 报错 `ConnectTimeoutError: oauth2.googleapis.com:443 (timeout: 10000ms)`；即便设 `HTTP_PROXY`/`HTTPS_PROXY`/`NODE_USE_ENV_PROXY=1` 仍超时；自己包一层 `fetch` 时若漏处理 `URL` 实例或 `URLSearchParams`（未转 `new Request(input, init)`）又会报 `Invalid URL` 或 `Invalid JSON payload`。
- **根治方案**：构造基于 `new Request(input, init)` + `http.request({ method: "CONNECT" })` + `tls.connect` + `https.request` 的零依赖代理 `fetch`，同时赋给 `globalThis.fetch` 与 `ClineCore.create({ fetch })`。

### 坑点 37：`core.subscribe` 参数顺序倒置崩溃（2026-11-16，Cline）
- **现象**：直觉调用 `core.subscribe(sessionId, listener)` 抛出 `TypeError: d.listener is not a function`。
- **根因**：源码签名为 `subscribe(listener, { sessionId })`，回调在第一参数。
- **根治方案**：严格使用 `core.subscribe(fn, { sessionId })`。

### 坑点 38：非交互单轮报错销毁与跨进程会话复用（2026-11-16，Cline）
- **现象**：`core.start({ interactive: false })` 首轮失败后会话立即从内存中清理，后续 `core.send` 抛 `SessionNotFoundError`；不同进程之间仅传 `sessionId` 也会找不到内存会话。
- **根治方案**：使用 `interactive: true` + `finally` 中显式 `core.stop()` / `core.dispose()`；跨进程 `--reuse` 时先调用 `core.readMessages(sid)` 取出历史消息作为 `initialMessages` 传入 `core.start()`。

---

## 2026-11-16 · Qwen Code 只读研究与千问桌面端方案二备案（坑点 39–41；桥接器环境已按要求卸载移除）

> **状态说明**：本节保留 2026-11-16 对 `@qwen-code/qwen-code` v0.27.4 与千问桌面端 `<QIANWEN_INSTALL_DIR>\Resources\quantum_apps\cowork-agent-host.asar` 的调研与避坑记录；随后已卸载全局 `@qwen-code/qwen-code` 并删除 `qwen-code/` 桥接器目录。

| 五步 | Antigravity 标准做法 | Qwen Code (v0.27.4) 调研落点 |
| :--- | :--- | :--- |
| **1 入口/环境探测** | CIM 找 `language_server.exe` + `--csrf_token` | 定位 `@qwen-code/qwen-code/cli.js`，直跑 `node --expose-gc cli.js`（避开 `cli-entry.js` 二次拉起） |
| **2 协议/接口枚举** | 扫 Go 二进制符号表 `/Service/Method` | 无头 `--bare -o stream-json` 读 `stdin`，输出 `system(init)` / `assistant(message)` / `user(tool_result)` / `result` |
| **3 动态模型注册表** | `GetCascadeModelConfigData({})` | 从 `chunks/chunk-D7FTEPLO.js` 提取 17 个 DashScope 模型 |
| **4 会话与权限** | 克隆 `plannerConfig` + EAGER 自动确认 | 需显式百炼 `DASHSCOPE_API_KEY` 或 OpenAI 兼容端点；`qwen-oauth` 已停用 |
| **5 闭环终态** | `IDLE` + `stepCount` 稳定防抖 | `exit=0` + `result.subtype==="success"` + `is_error===false` + `permission_denials.length===0` |

### 坑点 39：`qwen-oauth` 免费层已于 2026-04-15 停用，且桌面端 `qianwen.exe` 签名不可跨进程伪造（2026-11-16，Qwen）
- **现象与根因**：`@qwen-code/qwen-code` v0.27.4 源码明确返回 `"Qwen OAuth free tier was discontinued on 2026-04-15"`；而桌面端 `qianwen.exe`（5.2.5.301）虽已登录个人账号，但无监听端口且免 Key 请求依赖原生库 `SecurityGuardSDK64.dll` 经 Quantum Mojo（`account.getAuthInfo`）计算 `X-U-SIGN-WG` / `X-U-KPS-WG` / `X-U-VCODE` 动态签名，外部 Node 进程无法构造（且不得提取桌面 Cookie）。
- **根治方案**：改走显式 API Key（如 `DASHSCOPE_API_KEY` 或其他兼容端点），并明确拒绝已废弃的 `qwen-oauth`。

### 坑点 40：`qwen-code` v0.27.4 在 `--auth-type vertex-ai` + 代理环境变量下报 `HttpsProxyAgent is not a constructor`（2026-11-16，Qwen）
- **现象**：设置 `HTTP_PROXY`/`HTTPS_PROXY` 并传 `--auth-type vertex-ai` 时，在首轮请求前立即返回 `is_error: true`、`[API Error: HttpsProxyAgent is not a constructor]`。
- **根治方案**：避免在第三方打包 CLI 中混用 CJS/ESM `HttpsProxyAgent` 冲突分支；Vertex 链路交由 Gemini CLI / Cline / OpenCode 稳定承接。

### 坑点 41：对 `stream-json` 仅看 `exit=0` 会漏判 `permission_denials` 软拒绝（2026-11-16，Qwen）
- **现象**：在 `--approval-mode default` 或 `plan` 下发生工具审批被拒时，`result` 仍可能带有某些说明文本并结束。
- **根治方案**：终态校验必须同时核对 `result.subtype === "success"`、`is_error === false` 与 `permission_denials.length === 0`。

### 千问桌面端「方案二」技术备案（⚠️ 未实际体验过，仅只读源码核验）
- **只读分析结论**：`<QIANWEN_INSTALL_DIR>\Resources\quantum_apps\cowork-agent-host.asar` 中的 `engine/bundle.cjs` 本身是一个完整的 CommonJS 模块（导出 `start`、`stop`、`onChatMessage`、`normalizeLegacyPromptRpcMessage`），并在 `resolveBuiltInModelBinding` 中保留了独立读取环境变量 `DASHSCOPE_API_KEY` / `QWEN_API_KEY` 直连 `https://dashscope.aliyuncs.com/compatible-mode/v1`（默认模型 `qwen3.7-max`）的分支，以及基于 JSON-RPC 2.0 的页内通信入口 `onChatMessage`。
- **边界与未体验声明**：按本方法论事实原则明确标注——**方案二仅停留在 ASAR 源码只读勘探阶段，我们既没有编写 `runtime` 垫片去加载 `engine/bundle.cjs`，也没有传入真实 `DASHSCOPE_API_KEY` 实际体验或实测跑通**。

---

## 2026-11-16 · 主流 Coding Agent 免登录（BYO-Key + 智谱 GLM）通用方法与避坑扩展（坑点 42–49）

> **完整专题文档**：参见同目录 [`AGENT_USAGE_AND_BYPASS_METHODOLOGY.md`](AGENT_USAGE_AND_BYPASS_METHODOLOGY.md)，系统阐述 20 款 Agent 免会员跳过登录、架构区别及环境/代理要求梯度。本节沉淀本次 13 路真机扩展过程中新发现的共性/特性踩坑 42–49。

### 坑点 42：Claude Code `--bare` 与 Copilot CLI `COPILOT_OFFLINE=true` + Anthropic 协议跳过推理续轮 400（2026-11-16）
- **现象与机制**：Claude Code 传 `--bare` 可直接绕过首次引导与 Claude.ai 登录校验（等价于 CC Switch 写入 `~/.claude.json` `hasCompletedOnboarding: true`），配合 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 与智谱 `/api/anthropic` 即可免登录跑通；而 GitHub Copilot CLI 不仅要避开 VS Code `copilot-shim\copilot.exe` 占位符去调用 npm 包内置 `copilot.exe`，若在 BYOK 下走 `openai` 协议连接思考模型，工具续轮不会回传 `reasoning_content` 易触发 400。
- **根治方案**：Copilot CLI 桥接器默认走 `COPILOT_PROVIDER_TYPE=anthropic` + `COPILOT_OFFLINE=true` + 智谱 `/api/anthropic`（实测 `isByok: true, premiumRequests: 0`）。

### 坑点 43：Codex BYO-Key 的空版本目录 `ENOENT`、`Temp` 目录警告与隔离 `CODEX_HOME`（2026-11-16）
- **现象**：`%LOCALAPPDATA%\OpenAI\Codex\bin\` 下可能留存无 `codex.exe` 的空哈希目录导致 `ENOENT`；将隔离 `CODEX_HOME` 放在 `%TEMP%` 会被警告拒绝创建 helper 二进制；而在 BYO-Key 下再加 `--ignore-user-config` 会把隔离 `CODEX_HOME/config.toml` 一并跳过。
- **根治方案**：`findCodexBin()` 逐目录校验 `fs.existsSync(p)`；BYO-Key 模式把隔离 `CODEX_HOME` 建在 `private/codex-bridge/codex-home/`，写入 `env_key` 间接引用与 `models.json`，直连 `https://open.bigmodel.cn/api/v1`（`wire_api = "responses"`）且不传 `--ignore-user-config`。

### 坑点 44：Pi/OMP 对 `supportsDeveloperRole` 的校验差异、Bun ES2025 语法与工具名分叉（2026-11-16）
- **现象**：① Pi 与 OMP 连接 GLM 时默认下发 `role: "developer"` 会被上游拒收；② `@oh-my-pi/pi-coding-agent`（OMP）编译产物包含 ES2025 `using` 语句，用 Node 22 直接启动报 `SyntaxError`；③ 将 Pi 的 `--tools read,bash,edit,write,grep,find,ls` 套给 OMP 直接 exit 2 崩溃（OMP 无 `ls` 且无头下 `find` 不可用）。
- **根治方案**：配置中强制 `compat.supportsDeveloperRole: false`；OMP 桥接器定位原生 `bun.exe` 拉起并使用 OMP 专属工具集 `read,bash,edit,write,grep,glob`。

### 坑点 45：OpenClaw Windows 符号链接 `EPERM` 与向工作区写入 `SOUL.md`/`AGENTS.md`（2026-11-16）
- **现象**：未开启 Windows 开发者模式时，OpenClaw 启用内置插件建目录符号链接报 `EPERM` 阻塞；且默认首次运行会在 `workspace` 写入 `AGENTS.md`、`SOUL.md`、`BOOTSTRAP.md` 等 7 个文件污染用户项目目录。
- **根治方案**：生成隔离 `openclaw.json` 时固定写 `plugins: { enabled: false }` 与 `agents.defaults.skipBootstrap: true`，并走嵌入式 `agent --local --json`。

### 坑点 46：Kimi Code v2.6.2 `.kimi-code` 路径迁移与 `-p` / `-y` 参数互斥（2026-11-16）
- **现象**：`@moonshot-ai/kimi-code` v2.6.2 已从 `.kimi/` 迁至 `.kimi-code/`（写旧目录报 `No model configured`）；且源码显式拒绝 `--prompt` 与 `--yolo` / `--auto` / `--plan` 联用。
- **根治方案**：写隔离 `.kimi-code/config.toml`（`api_key_env` 零明文密钥），无头派单仅传 `--output-format stream-json -p` 与 `-S <session_id>`。

### 坑点 47：Crush 工作区 `crush.json` 残留与 Goose Keyring/分片文本（2026-11-16）
- **现象**：Crush 默认读取工作区根目录 `crush.json` 易污染项目；Goose 在 Windows 无头运行可能触发系统凭据库阻塞且 `stream-json` 按 `message.id` 分片吐出文本。
- **根治方案**：Crush 用 `CRUSH_GLOBAL_CONFIG` + `-D` 全量隔离并事后调 `session last --json`；Goose 注入 `GOOSE_DISABLE_KEYRING=true` + `GOOSE_PATH_ROOT` 并按 `message.id` 拼接文本校验 `type="complete"`。

### 坑点 48：国内直连 GLM 端点被残留境外代理环境变量拖垮或触发同账号并发 429（2026-11-16）
- **现象**：主机终端常带有 `HTTP_PROXY`/`HTTPS_PROXY` 供境外服务使用，而国内直连端点走境外代理延迟大增或超时；同时多个 Bridge 并发请求智谱 Coding Plan 时会触发 `429 Rate limit exceeded`。
- **根治方案**：所有 Bridge 在检测到 `bigmodel.cn`/`z.ai` 基址时自动从子进程 `env` 剥离 `HTTP_PROXY`/`HTTPS_PROXY`；多 Agent 编排采用错峰队列或模型分流（如同时调度 Vertex / OpenCode / DeepSeek 与 GLM），遇 429 置 `uncertain` 并等待配额恢复。

### 坑点 49：Continue CLI Windows `stdin` 静默忽略与 Aider `--no-git` / `--chat-mode ask` 分离（2026-11-16）
- **现象**：`cn -p` 在 Windows 子进程管道下会忽略 stdin 报缺少 prompt；Aider 非通用工具代理，无目标文件时难以下手且默认未加 `--yes-always` 会阻塞交互确认。
- **根治方案**：Continue 显式将工单落地并通过 `--prompt <active-task.md>` 投递、复用走 `--fork`；Aider 用 `--target`/`--read` 明确上下文，默认只读传 `--chat-mode ask`，施工传 `--write`。

### 坑点 50：Cursor 免费版与 Qoder CLI“内置 BYOK 入口仍强绑云端账号/会员门控”（2026-11-16）
- **现象与源码实证**：① 本机 Cursor 3.29.9/3.29.15（`stripeMembershipType = free`）即使开启 `Override OpenAI Base URL` 并填入自定义 Key，请求仍经 `https://api2.cursor.sh` 中转且被套餐门控拦截（`The model ... does not work with your current plan or api key`）；② `@qoder-ai/qodercli` v1.1.89 虽支持 `customModels` BYOK，但 `authType` 仅接受 `qoder-browser` / `qoder-pat`，未登录时启动阶段 `BUd()` 直接抛 `NonInteractiveAuthRequiredError: Not logged in`。
- **根治方案**：对强制云端中转或强先验登录的软件不尝试破解；Cursor IDE 用户改在内部装开源插件（Cline / Kilo / Continue）或从终端直接调用本套件 13 路免登录桥接器；Qoder CLI 如需使用其 BYOK 须先完成账号登录。


