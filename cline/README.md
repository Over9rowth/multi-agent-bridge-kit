# VS Code Cline 本地桥接器：实现、真机实测与经验

日期：2026-11-16（Asia/Shanghai）。环境：Windows、Node 22.15.1、VS Code Cline 扩展 `saoudrizwan.claude-dev-4.1.26`（内置 `@cline/core` v0.2.0）。

状态结论：**放弃易被 VS Code 弹窗和全局 Hook 副作用卡住的 `vscode://` URI 路线，改用 Cline 扩展自带的纯 ESM 无头核心 `@cline/core`（`ClineCore.create({ backendMode: "local" })`）直连驱动**；已跑通真机工具读写文件、`vertex/gemini-3.5-flash` 与 `vertex/gemini-3.5-flash-lite` 轻量模型秒切、跨进程 `--reuse` 会话恢复与上下文召回、无效模型前置拒绝，离线测试 6/6 通过，密钥审计 `clean`。

---

## 1. 为什么放弃 `vscode://.../lg-task` URI 改用 `@cline/core`

1. **实测过两条路线**：
   - **路线 A（`vscode://saoudrizwan.claude-dev/lg-task`）**：存在四大工程隐患——① `cmd.exe /c code.cmd --open-url` 会把 URL 中的 `&` 当命令分隔符拆碎；② `Code.exe --open-url` 未带 `ELECTRON_RUN_AS_NODE=1` + `cli.js` 会静默空退；③ 触发时 VS Code 会弹出交互确认框且要求 Cline 侧边栏处于可见状态；④ `/lg-task` 会在 `~/Documents/Cline/` 强行覆盖写入 `webhook_config.json` 与 3 个全局 PowerShell Hook，且只能被动沿用 `globalState.json` 中的默认大模型（如易 429 的 `gemini-4-carbon`）。
   - **路线 B（直接加载扩展内嵌 `@cline/core` ESM 核心）**：无需弹窗、不污染全局 Hooks、可直接传入任意 `--cwd` 与 `--model`（例如切到轻量 `gemini-3.5-flash` / `gemini-3.5-flash-lite`），同时复用 `~/.cline/data/` 下已登录的 Provider、凭据、模型目录与 `sessions.db`！

---

## 2. 五步方法论在 Cline 上的映射

| 步骤 | 映射到 VS Code Cline v4.1.26 |
| :--- | :--- |
| **1. 发现入口与代理** | 按 Semver 倒序扫描 `~/.vscode/extensions/saoudrizwan.claude-dev-*/dist/plugin-runtime/node_modules/@cline/core/dist/index.js`；自动读取环境变量或 VS Code `settings.json` 中的 `http.proxy` 并注入 `CONNECT` 隧道 `fetch`（解决 Node 22.15.1 原生 `fetch` 忽略代理导致 `oauth2.googleapis.com` 超时） |
| **2. 还原契约** | 只读 `ClineCore`、`LocalRuntimeHost`、`ProviderSettingsManager`：用 `core.start({ interactive: true, ... })` + `core.send({ sessionId, prompt })` + `core.subscribe(listener, { sessionId })`（注意 `subscribe` 第一参数才是回调，第二参数为 `{ sessionId }`） |
| **3. 动态模型目录** | 通过 `ProviderSettingsManager.getProviderConfig()` 与 `getLiveModelsCatalog()` 获取实时 Provider（如 `vertex` / `gemini`）与模型清单，派单前纯校验拒绝无效模型 |
| **4. 会话与权限** | 默认 `toolPolicies: { "*": { autoApprove: false } }` + 拒绝未授权工具回调（不静默越权），施工需显式传 `--write`；跨进程 `--reuse` 通过 `core.readMessages(sid)` 传入 `initialMessages` 恢复会话 |
| **5. 三层验收** | `finishReason === "completed"` + 非空 `result.text` + 核对 `result.model` 与请求模型一致，并独立核验磁盘产物 |

---

## 3. 常用命令（在 `cline/` 目录下执行）

```powershell
node scripts/dispatch-cline.mjs --status
node scripts/dispatch-cline.mjs --models
node --test scripts/dispatch-cline.test.mjs
node scripts/verify-no-secrets.mjs

# 派发 UTF-8 工单（使用轻量级模型 gemini-3.5-flash 避开 429）
node scripts/dispatch-cline.mjs --cwd D:\YourProject --file TASK_001.md --model vertex/gemini-3.5-flash --write

# 跨进程 --reuse 复用并切换到 gemini-3.5-flash-lite
node scripts/dispatch-cline.mjs --cwd D:\YourProject --reuse --file TASK_002.md --model vertex/gemini-3.5-flash-lite --write

# 查看历史与详情
node scripts/dispatch-cline.mjs --cwd D:\YourProject --history --here
node scripts/dispatch-cline.mjs --cwd D:\YourProject --show latest
```

---

## 4. 真机实测证据与边界（如实单列）

- **离线检查**：`dispatch-cline.test.mjs` **6/6 通过**；`verify-no-secrets.mjs` 输出 **`clean`**。
- **真机实测**（2026-11-16 隔离目录 `%TEMP%\opencode\cline-e2e`）：
  - `--status`（`connected: true`、识别 `gemini` 27 模型与 `vertex` 40 模型）、`--models --provider vertex`（43 项）、`--dry-run`、无效模型 `vertex/fake-model-999` 前置拒绝（`exit=1`、`state.json` 未创建）全部通过；
  - Round 1（`vertex/gemini-3.5-flash`、`--write`）：`23.1s` 完成 `read_files -> editor -> read_files`，落盘 `result.txt` 为 `343_cline-bridge-20261116`，返回 `CLINE_E2E_ROUND1_OK`，`observedModel=vertex/gemini-3.5-flash`；
  - Round 2（跨进程 `--reuse` + 切轻量模型 `vertex/gemini-3.5-flash-lite`）：`5.6s` 恢复 `1794816648346_wzim7`（10 条消息）准确召回 `343_cline-bridge-20261116`，`--show latest` 核实 `lastMessage.modelInfo.id === "gemini-3.5-flash-lite"`；
  - 跨目录 `--reuse` 拒单、`--history --here` 均通过。
- **未验证项**：超时 `core.abort` 分支、`--mode plan`、`gemini` Provider（非 `vertex`）实测、`--write` 未开启时对写操作被拒后的实际中断行为、并发多实例。
