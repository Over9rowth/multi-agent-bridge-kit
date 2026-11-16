# DSH 本地桥接器：实现、真机实测与经验

日期：2026-11-04（Asia/Shanghai）。环境：Windows、Node 22.22.2、DSH Desktop 0.1.1（源码 dev 实例）、`@deepseek-ai/dsh@0.1.5-rc.2`。Harness 回环端口本次为 `127.0.0.1:43130`，进程 PID 360；**端口与启动令牌每次启动都可能变化，脚本不写死任何一项**。

状态结论：**桥接器已跑通真机全链握手、真实文件工具调用、同会话追加、模型切换、命令执行与工作区内写文件**；离线单元测试 10/10 通过；交付文件无启动令牌或 Cookie 值泄漏。未验证项与残留环境变化在文末单列，不把没跑过的场景写成通过。

---

## 1. 交付内容

| 文件 | 作用 |
| :--- | :--- |
| `scripts/dispatch-dsh.mjs` | 零第三方依赖的桥接器 CLI：动态发现、认证交换、RPC 派单、终态判定、状态/锁/结果 |
| `scripts/dispatch-dsh.test.mjs` | 10 项离线协议/参数/事件/失败路径测试，不连接 DSH、不调用模型 |
| `scripts/verify-no-secrets.mjs` | 只读审计：检查交付文件是否混入 Harness 启动令牌或签名 Cookie 值，只打印计数 |
| `README.md` | 本文：协议还原、实测证据、使用规则、限制与踩坑 |
| `.gitignore` | 忽略 `private/` 运行态与锁文件 |
| `private/` | 本轮隔离工单、fixture、状态与结果证据；不是交付代码 |

只新增开发工具，未修改 DSH 桌面端源码、安装包、模型凭据或发布配置。

---

## 2. 为什么 DSH 不能套用 Antigravity 或 WorkBuddy 的样本

| | Antigravity 样本 | WorkBuddy 样本 | 本轮 DSH |
| :--- | :--- | :--- | :--- |
| 传输 | `language_server.exe` + ConnectRPC + CSRF 头 | 临时 CDP + 渲染器 `__wbInvoke` IPC | **Harness 自带 Web Server** + `/api/<endpoint>` Connection RPC |
| 凭据 | 进程命令行 `--csrf_token` | 原生登录态，不提取 Token | **`harness.log` 中的每进程 `?token=`**，只在 `GET /` 换取签名 Cookie |
| 配置 | 克隆历史会话 `plannerConfig` | 原生会话 + `permissionMode` | **无需克隆**：`session/create` 直接获得原生工具、文件策略与审批策略 |
| 派单 | `SendUserCascadeMessage` | `session:sendMessage` | `session/prompt`（带 `requestId`） |
| 终态 | Cascade `IDLE` 三重校验 | `end_turn` + `SUCCESS` | `running=false` + `turn/end` + `assistant/message` + 连续两次稳定 `asOfSeq` |
| 自动审批 | 脚本自动确认 `runCommand` | 明确不自动批准 | **明确不自动批准**；只报告 `approval/asked` |

**关键差异**：DSH 的 HTTP API 不接受 `Authorization` 头 Token，也不接受 API 路径上的 query token；`GET /?token=...` 是唯一的令牌交换点，之后靠 authority-bound、HttpOnly、SameSite=Strict 的签名 Cookie。任何把 token 直接塞进 `/api` 请求的尝试都会得到 401。

---

## 3. 五步方法论在 DSH 上的落地

### 第 1 步：进程与动态凭据探测

- 用 PowerShell CIM 找命令行含 `harness-node-entry.mjs` 的 Node 进程，只输出白名单字段 `PID` 与 `--port` 数字，不输出完整命令行（桌面进程命令行可能含嵌套敏感配置）。
- 在 `%APPDATA%\<profile>\logs\harness.log` 中取**最后一次**匹配该端口的 `dsh web: http://127.0.0.1:<port>/?token=...` 行，得到每进程一次性启动令牌。
- 该令牌是 **Web 会话启动令牌，不是账号 API Key / 账号凭据**；不写入磁盘、不打印、不进状态文件。进程重启后旧令牌失效，脚本每次运行重新发现。
- 退化路径：CIM 不可读时，从日志最后一条 URL 推断端口与令牌；仍失败则明确报错并提示 `--log`。

### 第 2 步：协议与接口枚举（只读源码，未反编译）

依据 `dsh-client-connection/lib/index.js` 与生成的 `dsh-api-session-controller/lib/typert.host.js`：

```
POST /api/<endpoint>          Content-Type: application/json    Cookie: <signed>
{ "type": "client-request", "rpcId": "<uuid>",
  "method": "<endpoint>", "payload": { "args": { ... } } }

200 { "type": "server-response", "rpcId": "<same uuid>",
      "result": { "ok": true, "value": ... } | { "ok": false, "error": {...} } }
```

- 请求信任栅栏：`Host` 必须是回环；带 `Origin` 时必须与 Host 一致；跨站请求拒绝。
- 端点来自生成描述符，`endpoint = /api/session/create` 形式。本轮用到：
  `session/modelCatalog`、`session/list`、`session/create`、`session/selectModel`、`session/prompt`、`session/page`。
- **参数外层名必须照描述符写**：`session/list` 用 `_request`；`create`/`prompt`/`page`/`selectModel` 用 `request`；`modelCatalog` 无参数（`args: {}`）。写错会得到 `gateway/bad-request`。

### 第 3 步：动态模型注册表

`session/modelCatalog` 实时返回 `default`、`groups[].models[]`。本轮实测注册了 4 个模型：`deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`（provider 均为 `deepseek-official`）。`--models` 打印实时结果；`--model` **先对实时注册表做纯校验**，未知或不唯一的 ID 在派单前失败，不回退默认模型。

### 第 4 步：不需要克隆 `cascadeConfig`

DSH 的 `session/create` 只接受 `cwd`（或 `workspaceId`），原生组合自动注入工具、系统提示、工作区与权限。实测会话内的运行时上下文记录：

- `Current DSH file policy: workspace-write`：会话工作区内可写；
- `Approval policy: ask`：需要审批的操作仍由 DSH 原生策略决定是否询问，**桥接器不提供自动批准**。

### 第 5 步：闭环与终态判定

```text
主 Agent → UTF-8 工单文件 → Node 桥接器
        → 进程/日志发现 → GET /?token= 换 Cookie
        → session/create(cwd) → session/prompt(requestId, text)
        → 轮询 session/list(running, projections.asOfSeq)
        → session/page(throughSeq=asOfSeq) 取增量事件
        → requestId 关联到 user/message（source.rpcId）
        → turn/end + assistant/message 且 running=false
        → 连续 2 次 asOfSeq 不变才判定完成
        → 只输出最后一条 assistant 文本
```

采用「三重校验 + 稳定防抖」，避免异步工具或后台任务期间瞬时空闲造成提前返回（沿用方法论坑点 04 的思路，但事件类型与字段全部换成 DSH 的）。工单尾部附一行 `[dsh-bridge requestId: ...]` 作为关联标签；轨迹里会出现两条 `user/message`（工单 + 插件注入的运行时上下文），因此**不能按「第一条用户消息」定位**。

---

## 4. 使用规则

从 `dsh/` 目录运行。先确认 DSH Desktop 已启动并进入 Harness 界面；`--status` 应返回 `connected: true`。

```powershell
node scripts/dispatch-dsh.mjs --status
node scripts/dispatch-dsh.mjs --models
node --test scripts/dispatch-dsh.test.mjs
node scripts/verify-no-secrets.mjs
```

**派单铁律**：任务先写成 UTF-8 工单文件，确认写入成功，再执行纯 ASCII 短命令；不要在 `--prompt` 里粘贴长中文（本 CLI 已直接禁用 `--prompt`）。

```powershell
node scripts/dispatch-dsh.mjs --cwd private/my-work --file DSH_TASK.md
node scripts/dispatch-dsh.mjs --reuse --cwd private/my-work --file DSH_FOLLOWUP.md
node scripts/dispatch-dsh.mjs --reuse --model deepseek-v4-flash --cwd private/my-work --file DSH_TASK.md

# 不连接、不派单：核对工单编码、字节数与 SHA-256
node scripts/dispatch-dsh.mjs --file DSH_TASK.md --dry-run
```

- `--cwd DIR`：会话工作目录，默认当前目录；跨模块新任务不带 `--reuse`，同模块小步追加才用 `--reuse`。
- `--reuse` 只能复用本桥接器记录、同一真实目录、上一轮 `completed` 的会话；`uncertain` 状态拒绝复用。
- `--state FILE`：另指定状态文件；结果固定写到同目录 `last-result.json`。默认 `private/dsh-bridge/state.json`。
- `--log FILE`：DSH 用户数据目录不在自动搜索范围时显式指定 `harness.log`。
- `--timeout SECONDS`：默认 600。超时写 `uncertain` 与结果文件，**禁止自动重发**；先在 DSH 界面确认任务状态。
- 锁文件 `state.json.lock` 阻止同一状态并发派发；异常退出后先确认原进程再处理，桥接器不自动清锁。

---

## 5. 真机实测证据（2026-11-04）

隔离目录：`dsh/private/dsh-bridge-test`，`fixture.json` 内含 `a=137`、`b=206` 和未写在工单中的 `tag=dsh-bridge-20261104-indigo-47`。

| # | 场景 | 真实结果 | 证据 |
| :-- | :--- | :--- | :--- |
| 1 | 首次派单，读 fixture 并计算 | `DSH_FILE_OK 343 dsh-bridge-20261104-indigo-47`；7s，轨迹含 `tool/call`(seq16)、`tool/result`(seq17)、`turn/end`(seq22, completed) | 会话 `session-8654a4eb-…5722`，requestId `4f9c5999-…1093`；`private/dsh-bridge/last-result.json` 后续被覆盖，原始输出见本轮终端记录 |
| 2 | 同会话追加，不调用工具 | `DSH_REUSE_OK dsh-bridge-20261104-indigo-47 343`；**同一 sessionId**，5s | `private/dsh-bridge/last-result.json`（追加轮），`asOfSeq=30` |
| 3 | 实时模型注册表 + 模型切换 | `session/selectModel` 返回 `deepseek-official/deepseek-v4-flash`；主机侧 `request/header.header.config.model` **独立确认**同为 `deepseek-v4-flash`（非模型自述）；回复 `DSH_MODEL_OK` | `private/dsh-bridge/last-result.json`（切换轮），`selectedModel` 与 `observedRequestConfig` 一致 |
| 4 | 未知模型拒绝 | 退出码 1；状态文件 SHA-256 前后同为 `8a013b2f…a27bc611` | 本轮终端记录 |
| 5 | 跨目录 `--reuse` 拒绝 | 退出码 1，`cwd mismatch` | 本轮终端记录 |
| 6 | 只读命令执行 | `echo DSH_CMD_OK` 经 `tool/call`/`tool/result` 完成，回复 `DSH_CMD_OK`；9s | 会话 `session-0d096eb7-…2a22a`，`private/dsh-bridge/cmd-state.json` |
| 7 | 工作区内写文件 | `dsh-bridge-write-test.txt`（13 字节）由 DSH 创建，回复 `DSH_WRITE_OK`；8s | 会话 `session-bd0da860-…b444`，`private/dsh-bridge/write-state.json` |
| 8 | 离线协议测试 | 10/10 通过（参数、UTF-8/BOM/空与超大工单、信封、rpcId、错误结果、Cookie 解析、事件投影、模型校验、进程解析） | `node --test scripts/dispatch-dsh.test.mjs` |
| 9 | 密钥审计 | 扫描 1 份 harness.log 中 16 个历史启动令牌，检查 14 个交付文件，`tokenLeaks=[]`、`cookieValueLeaks=[]` | `node scripts/verify-no-secrets.mjs` |
| 10 | 在用户工作区新建对话，`DeepSeek-V41-Flash` 按工单回复指定中文 | `桥接工单已收到`；6s；`turn/end: completed`；主机侧 `observedRequestConfig.model=deepseek-flash`（默认模型，未触发 `selectModel`）；新 `sessionId`，`sessionCount` 15→16 | `private/dsh-bridge/hello41/last-result.json`；会话 `session-0084f640-…9f5`，cwd `<YOUR_CJK_WORKSPACE>` |

说明：表 #1 的 `last-result.json` 会被后续派单覆盖，这是设计行为；每轮结果文件与状态文件各保留最后一轮，逐轮原始输出以本轮终端记录为准。#2 的「未调用工具」来自工单约束与回复内容，**没有做工具事件审计**；#6/#7 则有 `tool/call` 事件证据。

---

## 6. 安全边界

- 不读取账号凭据、不导出 Token、不开启公网监听、不启动第二个 DSH 实例、不修改 DSH 安装包或登录配置。
- 启动令牌与 Cookie 只存在于进程内存；不写 stdout、状态文件、结果文件、日志；错误信息只说「令牌交换被拒绝」，不含令牌。
- 不自动批准任何工具/命令；检测到 `approval/asked` 只提示。原生 `default`/`ask`/`workspace-write` 权限策略保持原样。
- 不实现 `session/delete`、不操作用户原有会话；`--reuse` 不能借状态文件接管别人的会话。
- 真实任务仍消耗 DSH 当前账号的模型额度；**没有测量也不承诺任何 Token 节省比例**。
- 工单必须 ≤1 MiB、合法 UTF-8、非空；BOM 会剥离；非法输入在连接前失败。

---

## 7. 限制与未验证（必须如实区分）

1. **未做长链路开发验收**：只实测了读文件、只读命令、工作区内写文件与纯文本问答；多文件重构、构建/类型检查排错循环、E2E 测试、并发派单未跑。
2. **审批边界未穷尽**：本机 `workspace-write` + `ask` 下，上述三类操作无需人工点击即完成；需要审批的高风险操作（如工作区外写入）未实测。桥接器遇到 `approval/asked` 会等待并可能超时，不会替用户点批准。
3. **模型切换是配置级副作用**：本轮 `session/selectModel` 不仅改变当前会话，还把新建会话的默认模型也改成 `deepseek-v4-flash`（实测新会话 `request/header` 已体现）。测试后已把默认模型 ID 恢复为 `deepseek-official/deepseek-flash`，但默认视图中的 `reasoningEffort` 由原先「未显式给出」变为显式 `"high"`——这是一项**残留配置变化**，请在 DSH 设置中按需调整。`--model` 用于全新会话未单独实测。
4. **会在 DSH 里留下真实会话**：`session/list` 数量从 12 增至 16，新增 4 个测试会话（前 3 个在隔离目录 `dsh/private/dsh-bridge-test`，第 4 个是 2026-11-04 的 41flash 新对话，建在用户工作区 `<YOUR_CJK_WORKSPACE>`）；桥接器不自动删除，可在 DSH 界面自行清理。
5. **版本绑定**：协议来自 `dsh 0.1.5-rc.2` 的生成描述符；DSH/Harness 升级后端点、参数名或事件结构可能变化，需重新握手与验收。
6. **轮询而非事件流**：未使用 `/api/remote.mux` WebSocket 与 `$events` 流；轮询间隔 1.5s，历史页最多回溯 8 页。
7. **单任务、无取消与恢复**：超时后状态为 `uncertain`，不自动重发、不自动取消、不恢复超时后结果；`--timeout` 默认 600 秒。
8. **令牌每进程有效**：DSH 重启后旧令牌失效，脚本会自动从最新日志行重新发现；若日志被清空或路径变化，需要 `--log`。
9. **`--status` 显示的是实时注册表与状态摘要**，不能当成「桥接服务常驻后台」；脚本是一次性进程，退出后不留下监听端口。

---

## 8. 踩坑：现象、根因、处理

| 现象 | 根因 | 处理 |
| :--- | :--- | :--- |
| `GET /` 返回 401 `dsh web authentication required; reopen the URL printed by dsh web.` | DSH 0.1.2-alpha.1 起 API 全局鉴权；只有根路径的 `?token=` 能换取绑定 authority 的签名 Cookie，API 路径和 `Authorization` 头都不收令牌 | 从 `harness.log` 取每进程启动令牌，`GET /?token=` 取 `Set-Cookie`，后续所有 `/api` 请求带 Cookie；不提取账号凭据 |
| `session/page` 传 `throughSeq: 1000000000` 报 `through seq ... is past cursor 1195` | `throughSeq` 是持久化日志游标上界，不是任意大数 | 先 `session/list` 读 `projections.asOfSeq` 作为基线与 `throughSeq`，只取 `seq > baseline` 的增量 |
| `session/list` 用 `args:{}` 或 `request` 报参数错误 | 生成描述符里该端点参数名是 `_request` | 按 `typert.host.js` 的 `parameters[].wire` 逐一核对，不凭直觉猜 |
| 未知模型被拒绝后状态文件哈希变化，导致后续 `--reuse` 失败 | 早期实现先写 `switching-model` 状态再校验模型 | 拆成「纯校验 `resolveModelArg` → 再建会话/写状态」，并引入阶段化失败恢复；复测哈希前后一致 |
| 合法模型首次运行报 `m is not defined` | 模型解析里 `.map(() => ({ model: m.id }))` 闭包漏了参数 | 改为 `.map((m) => ...)`；已由真机切换复测覆盖 |
| `observedModelHint` 一直为 null | 只在用户消息之后的事件里找 `request/header`，而该事件通常在用户消息之前 | 改为在全部增量事件里读 `request/header.header.config`，作为主机侧证据输出 `observedRequestConfig` |
| 误把插件注入的运行时上下文当成用户工单 | 会话里出现两条 `user/message`（seq 8 工单、seq 9 插件上下文） | 用 `requestId` 匹配 `source.rpcId`（工单尾部另附关联标签），不按第一条用户消息定位 |
| PowerShell 探测脚本报「不允许使用空管道元素」 | `foreach (...) { ... } | Format-List` 在 Windows PowerShell 5.1 语法不合法 | CIM 探测改为逐行输出纯文本 `PID PORT`，Node 侧用正则解析；同时避免输出完整命令行 |
| Git Bash 里 `node -e` 的反斜杠正则被 MSYS 改写（`\s` 变 `/s`），且 `/tmp/x.json` 无法被 Windows Node `require` | 路径转换 + 引号层叠转义 | 探测/审计逻辑落成 `.mjs` 文件；临时数据走 stdin 管道，不依赖 `/tmp` 绝对路径 |
| 密钥审计把源码里的假 Cookie 字符串误报为泄漏 | 初版用宽松正则 `dsh_session=v1\.` | 改为匹配签名值形态 `v1.<20+>.<20+>`，复测 14 个文件 `clean` |
| `--model` 后新会话默认模型也变了 | `session/selectModel` 写入的是配置层默认选择，不只是当前会话运行时 | 实测确认并恢复默认模型 ID；在文档中显式标注该副作用与残留 `reasoningEffort` |
| 用户反馈「DSH 界面里没看到桥接器创建的会话」 | 桥接器一直用隔离目录 `dsh/private/dsh-bridge-test` 作 cwd；`session/list` 返回**全部**会话且 item 无 `workspaceId` 字段，但界面很可能按当前工作区过滤（**此为推断，未实测界面渲染**）。实测原有 12 个会话 cwd 均为 `<YOUR_CJK_WORKSPACE>`，与隔离会话不同 | 需要界面可见时，把新会话 `--cwd` 指向用户当前工作区，再用 `session/list` 复核新会话的 cwd 与总数；已实测新会话 `session-0084f640-…9f5` cwd 为 `<YOUR_CJK_WORKSPACE>`。**是否真的出现在界面上仍需用户目视确认** |
| 中文工作区路径无法写进纯 ASCII 派单命令 | 工单文件派单铁律要求命令本身纯 ASCII；`<YOUR_CJK_WORKSPACE>` 直接出现在命令行会引入多字节文本 | 把 cwd 写入 UTF-8 文件 `private/dsh-bridge/cwd.txt`，用 `CWD=$(cat private/dsh-bridge/cwd.txt)` 从文件注入 `--cwd "$CWD"`，命令行保持纯 ASCII；先 `--dry-run` 核对解析出的 cwd 与工单 SHA-256，再正式派单 |

---

## 9. 可直接交给下一位 Agent 的启动提示词

```markdown
请读取 `D:\本地快速部署multi-agent-orchestration桥接\dsh\README.md`，并先运行
`node scripts/dispatch-dsh.mjs --status` 确认本机 DSH Desktop 已启动。
你担任总架构师；具体编码与测试任务一律先写成 UTF-8 工单文件，确认写入成功后
用纯 ASCII 短命令 `node scripts/dispatch-dsh.mjs --file DSH_TASK.md` 派发给 DSH；
同模块小步追加用 `--reuse`，跨模块不带 `--reuse`。
不要使用 `--prompt` 粘贴长中文；不要把 `--status` 的在线结果当成后台常驻服务。
遇到超时先看 DSH 界面与 `private/dsh-bridge/last-result.json`，状态为 uncertain 时禁止自动重发。
模型切换前先看 `--models`；注意 `--model` 会改配置级默认模型，用完按需恢复。
桥接器不会自动批准工具或命令，也不要把「模型说测试通过」当成验收，请独立检查产物。
若遇到新问题并解决，按维护铁律把「现象 + 根因 + 根治方案」追加到本文件第 8 节与套件方法论文档。
```

---

## 10. 与套件的关系

本目录是继 Antigravity → Codex → `workbuddy/` 之后的**第四个目标 Agent 适配样本**：**不复用 Antigravity 的 CSRF/Cascade 协议，不复用 Codex 的 stdio JSONL，也不复用 WorkBuddy 的 CDP/IPC 路径**，走的是 DSH 自带的本地 Web `/api` Connection RPC。方法本身仍是套件《AGENT_BRIDGE_METHODOLOGY.md》的五步法：动态发现 → 协议枚举 → 注册表查询 → 原生配置 → 闭环终态校验；只是每一步的具体契约都按 DSH 实际源码重新还原。每次接入新目标 Agent 时都要重新回答这五步，**不能把上一个目标的端口、头部、字段名或审批策略照抄过来**。
