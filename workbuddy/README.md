# WorkBuddy 本地桥接器：实现、实测与经验

日期：2026-11-04（Asia/Shanghai）。实测：Windows、WorkBuddy AI 5.9.4、Node 22.15.1。状态：真实模型回复、隔离文件读取、同会话追加及 HY4→HY3 切换成功；临时调试连接已关闭，WorkBuddy 已恢复正常启动。

## 交付内容

- `scripts/dispatch-workbuddy.mjs`：零第三方依赖的工单派发器。
- `scripts/workbuddy-bridge-session.ps1`：临时启动及恢复正常启动，记录并核实本轮进程身份。
- `scripts/dispatch-workbuddy.test.mjs`：11 项协议、参数、模型切换、隔离及失败处理测试。
- 通用副本：`D:\本地快速部署multi-agent-orchestration桥接\workbuddy\`。

本轮只新增开发工具，没有修改站群业务代码、正式数据库或发布配置。原有未提交修改保留。没有修改 WorkBuddy 安装包、登录配置或持久安全设置。

## 实际采用的连接路径

```text
主 Agent → UTF-8 工单文件 → Node 派发器
         → 127.0.0.1 临时 CDP 连接
         → WorkBuddy 主渲染器的 __wbInvoke
         → 原生本地会话 / 原生模型及工具
         → end_turn + SUCCESS + 最终回复
```

这不是 Antigravity 的 ConnectRPC 协议，也不是 WorkBuddy 官方稳定开放 API。它适配当前安装版本的 Electron 调试通道和原生 IPC，更新后需要重新握手和验收。不能照搬 `language_server.exe`、CSRF 头、Cascade 方法或 Antigravity 模型枚举。

WorkBuddy 原生调用格式是 `__wbInvoke(channel, callerContext, ...businessArgs)`；第二项留 `undefined`，业务参数从第三项开始。本轮使用：

- `wb:conversations:create`：创建带独立稳定 ID、指定工作目录的本地会话；显式保留 `permissionMode: default`。
- `session:get`：核对本桥接器自己保存的会话和目录。
- `session:sendMessage`：派发任务，等待真实结束响应。
- `config:getProductConfiguration`：读取并筛选 CLI 模型注册表；只返回模型 ID、名称及显示倍率，不输出完整配置。
- `wb:conversations:configSetModel` + `session:setModel`：分别更新保存配置与已经加载的执行运行时；两步都需要。
- `_meta["codebuddy.ai"].lastAssistantText`：获取最终回复；同时检查 `stopReason === "end_turn"`，存在 outcome 时必须为 `SUCCESS`。

不读取其他会话、不自动审批命令、不导出账号 Token。不提供任意会话 ID 注入、删除会话、公开监听或自动部署功能。真实任务仍消耗 WorkBuddy 当前账号的模型额度；没有测量或承诺节省比例。

## 下次使用

从项目根目录操作。先通过 WorkBuddy 托盘菜单退出已有实例；关闭窗口或 Ctrl+Q 在本机未使主进程退出。启动脚本遇到已有实例会拒绝启动，避免把参数交给旧进程而产生假连接。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/workbuddy-bridge-session.ps1 -Mode Start -Executable <WORKBUDDY_DIR>\WorkBuddyAI.exe
node scripts/dispatch-workbuddy.mjs --status
node scripts/dispatch-workbuddy.mjs --models
```

启动器使用 `--remote-debugging-port=48173 --remote-debugging-address=127.0.0.1`，并检查监听地址与进程归属。只在工作期间开启：调试连接具有客户端控制能力，不能向公网转发。`--allow-debug` 是派发时对临时调试连接的明确选择，不是跳过 WorkBuddy 权限确认。

先把任务写成 UTF-8 文件，再运行纯 ASCII 短命令：

```powershell
node scripts/dispatch-workbuddy.mjs --file WORKBUDDY_TASK.md --allow-debug
node scripts/dispatch-workbuddy.mjs --reuse --file WORKBUDDY_FOLLOWUP.md --allow-debug

# 同会话由 HY4 切换到 HY3 后继续工单
node scripts/dispatch-workbuddy.mjs --reuse --model hy3 --file WORKBUDDY_FOLLOWUP.md --allow-debug
```

跨模块不带 `--reuse`，以新会话隔离。可用 `--workspace DIR` 指定实际工作目录，默认当前目录。`--mode craft|ask|plan` 仅用于新会话；默认 craft。`--model ID` 先经实时注册表验证，再交给 WorkBuddy，并核对原生保存配置；不存在或被禁用的 ID 在派单前失败，不回退到默认模型。未指定时沿用会话当前选择，新会话采用 WorkBuddy 默认选择。`--reuse --model ID` 现已支持同会话切换，原生权限仍为 default。

本机本次注册表中显示名称 `Hy4` 对应 `hy4free` 和 `hy4std`，`Hy3` 对应 `hy3`；`hy4` 不是本次实际登记的 ID。本轮验证的是 `hy4free`→`hy3`，没有调用 `hy4std`。以后以 `--models` 当场结果为准。

```powershell
# 不连接、不派发：核对工单编码、目录、字节数及 SHA-256
node scripts/dispatch-workbuddy.mjs --file WORKBUDDY_TASK.md --dry-run

# 运行桥接器自己的测试
node --test scripts/dispatch-workbuddy.test.mjs

# 所有任务完成后关闭本轮拥有的调试实例，并正常启动 WorkBuddy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/workbuddy-bridge-session.ps1 -Mode Restore
```

`Restore` 会终止记录中本轮启动的主进程，执行前应完成或停止其任务。脚本按 PID、可执行路径和启动时间三项核对身份；不会通过进程名批量结束其他实例。临时 runtime 记录删除后，重复恢复会拒绝执行。首轮连接是按相同参数手动启动；模型续测轮已实际跑通完整 Start 启动/就绪检查和 Restore 正常恢复，先前“完整 Start 未实测”的限制已解除。

## 返回结果与异常处理

工单必须存在、为合法 UTF-8、非空且不超过 1 MiB；错误在连接前报告。不提供长中文 `--prompt`，避开终端输入和转义问题。

状态默认保存在当前项目 `private/workbuddy-bridge/state.json`，最终结果为同目录 `last-result.json`。本仓库 `private/` 已忽略；移植到其他项目时先把 `private/workbuddy-bridge/` 加入忽略规则。这些运行文件不应提交。可用 `--state FILE` 指定不同状态文件；不同状态应使用不同目录，避免覆盖该目录的 `last-result.json`。

状态的 `model` 和结果的 `configuredModel` 是原生配置确认值，不等同于服务器身份认证。本轮另外独立检查原生运行时 `MODEL_REQUEST` / `requestModelId` 日志，才确认 HY4→HY3 请求选择实际改变；没有依赖模型自报身份。

只有看到 `New session` / `Reusing session` 才表示原生会话已确认；只有最终回复通过结束条件才表示本轮模型请求结束。模型说“测试通过”仍需主 Agent 独立检查产物和测试证据。

- `--reuse` 只能复用本桥接器记下、同一真实目录、上一轮完成的会话，不能借它操作用户原会话。
- 锁文件阻止同一状态的并发派发；不自动清理旧锁。意外退出后，先确认原派发进程与 WorkBuddy 任务状态，再处理锁。
- 超时/断线后的任务可能仍在 WorkBuddy 继续执行；状态记为 `uncertain`，禁止自动重发或直接复用。先在 WorkBuddy 检查结果、停止未完成任务；新任务用新会话。现版没有自动取消与超时后结果恢复功能。
- 切换模型过程中若失败，状态停留在 `switching-model`，不会继续发送工单或自动重试，需先检查保存配置与运行时是否一致。
- 原生权限或问题确认可能使任务等待，桥接器不会替用户点击批准；`--timeout` 默认 600 秒。
- 正常启动后 `--status` 报连接不可用是预期结果，不能因此声称桥接服务仍在后台运行。

## 实测证据与限制

首轮主派发脚本在 `D:\YourProject\private\workbuddy-bridge-test` 创建独立会话，未使用站群正式内容：

1. 初始原生握手请求得到真实 `WORKBUDDY_BRIDGE_OK`，结束原因为 `end_turn`。
2. 工单让 WorkBuddy 只读 `fixture.json`；文件包含 a=137、b=206 以及未写在工单中的校验标记。结果包含 `WORKBUDDY_FILE_OK 343 local-bridge-20261104-cobalt`。
3. 同会话追加要求不调用工具、按上下文返回标记，结果包含 `WORKBUDDY_REUSE_OK local-bridge-20261104-cobalt`；派发器确认两次 sessionId 一致。第二轮未调用工具的说法来自模型回复，没有另做工具事件审计。
4. 首轮 8/8 自动测试通过：非法参数、UTF-8/BOM/空与过大文件、失败终态、跨目录及非自有会话复用、远程 WebSocket 拒绝、响应乱序与 IPC 参数、绝对超时/断线、主渲染器筛选及禁止重定向。
5. PowerShell 脚本解析通过；已有实例启动保护按预期返回非零；Restore 真机成功。
6. 恢复后普通发现接口 `/workbuddy/probe` 返回 `workbuddy-desktop` / 5.9.4；48173 无监听；runtime 记录已移除。

首轮本地证据为 `private/workbuddy-bridge-test/read-result.json`、`reuse-result.json` 和工单；忽略目录不进入 Git 或通用套件。首轮当时未验证模型切换与完整 Start，现由以下续测覆盖。业务代码修改、运行编译/全量测试、跨版本兼容或多任务并发仍未验证。站群检查/构建本轮不重跑，其既有状态不能视为本轮验证。

### 模型续测：HY4→HY3（同日追加，覆盖上文首轮的未测项）

用户明确指定从 HY4 切到 HY3。首先在独立目录 `private/workbuddy-model-test` 创建 `hy4free` 会话，得到 `HY4_READY cobalt-47-hy-switch 43`。仅调用保存配置的 `configSetModel` 后，原生配置虽然显示 hy3，但下一轮 `requestModelId` 仍是 hy4free：这一轮不能算切换成功。

随后补齐原生运行时 `session:setModel`，再次请求的 `requestModelId` 才成为 hy3。根据该事实修正派发器：`--reuse --model` 同时更新两层，并增加实时 `--models`、未知模型提前拒绝、原生错误封装检查。

最终用修改后的 CLI 在**同一 sessionId** 连续切回 `hy4free`、再切到 `hy3`，两轮都真实完成；第二轮从上下文取回相同标记与计算结果。对应日志最后两条 `requestModelId` 依次为 hy4free、hy3，分别位于本次隔离运行时日志第 1188、1316 行。证据仅保存白名单模型字段，没有复制原始完整日志或凭据：

- `private/workbuddy-model-test/hy4-cli-result.json`、`hy3-cli-result.json`：最终 CLI 回复、同一会话 ID、确认的模型配置。
- `private/workbuddy-model-test/model-switch-evidence.json`：回复校验和请求模型记录；保留“只改配置但没改实际运行时”的排障证据。
- 不存在模型 `workbuddy-no-such-model` 在派发前非零退出，状态文件 SHA-256 不变。
- 新增模型注册表白名单、保存配置与运行时双更新、运行时拒绝/配置不一致回归；最终 11/11 测试通过。
- 完整 Start 就绪检查及 Restore 真机通过；普通 WorkBuddy 运行，48173 无监听，runtime 记录已移除。

仍未验证业务代码修改/编译、`hy4std`、其他模型、跨版本兼容或并发派单。产品阶段不变。

## 踩坑：现象、根因、处理

| 现象 | 根因 | 本轮处理 |
| --- | --- | --- |
| CIM 和回环连接在受限终端失败 | 沙箱权限与桌面进程不同 | 只对必要的本地探测/真机验证申请执行权限，未将失败当成软件不存在 |
| 内置 CLI bin 报 Cannot find module ../dist/codebuddy | 安装包只带 lite-wb 的 ESM 产物，默认入口选了另一 bundle | 确认 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 的分流；没有复制或修补安装包 |
| CLI 能输出 help，但派单提示 Authentication required | 独立 CLI 没有自动获得桌面原生认证上下文 | 改走桌面原生 IPC；不从配置文件提取账号凭据 |
| WBIPC endpoint 文件存在，但不适合直接派单 | 其已注册管道主要是带认证的后台请求与授权能力，不是现成聊天任务端点 | 不把“发现了本地端点”写成“已打通派单” |
| 18488 有服务，但 /ping、/healthz 为 404 | 它是 `/workbuddy/probe` 发现接口，不是 eval-proxy | 核对实际源码和健康响应，不能只按监听端口猜协议 |
| 安装包有 eval-proxy，启动却没有服务 | 5.9.4 启动流水线的 evalModeEnabled 被写死为 false；该旧接口还强制 bypassPermissions | 不修改安装包、不启用旧接口，采用临时 CDP + 原生 default 权限 |
| 启动带调试参数的新进程很快退出 | 已有主实例还活着，第二实例只转交唤醒请求；窗口关闭不等于应用退出 | 核对真实主进程和监听端口；启动器发现旧实例即拒绝，避免假启动 |
| 原生 IPC 业务参数容易错位 | 第二参数是调用方 context | 固定传 undefined，业务参数放后面，并提供测试 |
| 保存配置显示 HY3，但实际下一轮仍是 HY4 | 当前派发路径使用已加载的 legacy session runtime；configSetModel 只更新保存层 | 同时调用 configSetModel 和 session:setModel；独立核对实际 requestModelId，不能用模型自述或保存配置代替 |
| 调试时完整进程命令行意外暴露局部配置 | 嵌套 JSON 中的 Bearer 等值没被简单正则遮住 | 后续只输出 PID/路径/参数名等白名单，不再输出完整命令行；不复制到经验文档/套件，也不把此方式用于凭据采集 |
| 单凭“会话不忙”无法确认完成 | 空闲也可能表示等待或尚未开始 | 等待 sendMessage 最终响应并核对终态/最终文本；超时不自动重发 |

用户最初批准了“临时开启测试接口，验证后恢复”；进一步源码验证推翻了旧接口可直接启用的假设。本轮随后采用临时调试连接，原生权限没有被改成自动批准。最后确实关闭调试端口并恢复正常启动。

官方的另一条路径是 [WorkBuddy Open API](https://open.workbuddy.cn/docs/openapi)：需要第三方应用和 OAuth 授权，涵盖本地助理状态、消息及历史。本轮没有注册应用或操作 OAuth；该方案不等于本地免配置桥接。以后要长期无人值守或服务集成，宜单独评估正式接口。

## 可直接交给下一位 Agent 的使用规则

先读本文，确认用户已选择临时桥接模式；从项目根目录启动并跑 `--status`。把具体工作写入 UTF-8 工单，范围和验证标准写清楚；用 `--file` 派发，同模块才 `--reuse`。保留原生权限，不自动同意高风险命令。根据真实最终回复独立验收；遇到超时不重发。完成后用 Restore，确认普通 WorkBuddy 运行且调试端口关闭。不要把旧 Antigravity 模型表、token 节省比例或配置克隆建议当成 WorkBuddy 当前事实。
