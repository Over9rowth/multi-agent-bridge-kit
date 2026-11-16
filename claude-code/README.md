# Claude Code 本地桥接器（`--bare` 免订阅登录 + 智谱 GLM 实测通过）

日期：2026-11-16。目标 CLI：`@anthropic-ai/claude-code` v2.1.325（原生 `claude.exe`）。

## 1. 免订阅登录原理与五步映射

| 步骤 | Claude Code 映射 |
| :--- | :--- |
| **1. 发现入口** | `findClaudeBin()` 定位原生 `claude.exe`（拒绝 `.cmd`/`.bat` 包装器）；剥离父进程 `CLAUDECODE` 防嵌套拦截 |
| **2. 协议契约** | `claude.exe -p --bare --output-format stream-json --verbose`，通过 `stdin` 传 UTF-8 工单，输出 `system(init)` / `assistant` / `result` |
| **3. 跳过登录** | 传 `--bare` 跳过 Claude.ai OAuth 与首次引导（等同 CC-Switch 写 `hasCompletedOnboarding: true`），设 `ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`、`ANTHROPIC_API_KEY` 与 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |
| **4. 权限与模型** | 自动映射 `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`（默认 `glm-4.7`）；默认 `default` 权限，施工显式 `--write`（`bypassPermissions`）；`--reuse` 走 `--resume <session_id>` |
| **5. 三层验收** | `exit=0` + `result.subtype==="success"` + `!is_error` + `permission_denials.length===0` + `modelUsage` 观测模型匹配 |

## 2. 常用命令（在 `claude-code/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-claude.mjs --status
node scripts/dispatch-claude.mjs --models
node scripts/dispatch-claude.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-claude.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-claude.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` Round 1（`23.8s`，`tools=3`，落盘 `343_claude-code-e2e-20261116`、`observedModel=glm-4.7`）、Round 2 `--reuse`（`9.3s` 准确召回）及跨目录 `--reuse` 拒单均通过。
- **未验证项**：超时 `taskkill /T /F` 触发分支、`--with-user-config` 加载个人 hooks/MCP、高并发多进程。
