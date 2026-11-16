# GitHub Copilot CLI 本地桥接器（BYOK + `COPILOT_OFFLINE=true` 免 GitHub 订阅）

日期：2026-11-16。目标 CLI：`@github/copilot` v1.0.112（原生 `copilot.exe`）。

## 1. 免登录原理与关键坑点

- **绕过 `copilot-shim`**：VS Code 自带的 `D:\VS Code\bin\copilot-shim\copilot.exe` 仅是安装提示占位符，必须定位 npm 安装的原生 `@github/copilot-win32-x64\copilot.exe`。
- **BYOK + 离线模式**：设置 `COPILOT_HOME`（隔离状态）、`COPILOT_OFFLINE=true`（不连接 GitHub 服务器）、`COPILOT_PROVIDER_TYPE=anthropic`、`COPILOT_PROVIDER_BASE_URL=https://open.bigmodel.cn/api/anthropic`、`COPILOT_PROVIDER_API_KEY`、`COPILOT_MODEL=glm-4.7`。
- **为什么默认用 `anthropic` 而非 `openai`**：部分思考模型在下一轮工具调用要求回传 `reasoning_content`，Copilot CLI 的 OpenAI 兼容客户端未透传该字段会报 HTTP 400；走智谱 Anthropic 端点可彻底规避。

## 2. 常用命令（在 `copilot/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-copilot.mjs --status
node scripts/dispatch-copilot.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-copilot.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-copilot.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`21.9s`，`isByok=true`，`premiumRequests=0`，`tools=3`，落盘 `343_copilot-e2e-20261116`）、R2 `--reuse`（`6.8s` 准确召回）及跨目录拒单均通过。
- **未验证项**：`--provider-type openai` 与 Azure 分支、`--no-offline` 行为、超时 `taskkill` 分支。
