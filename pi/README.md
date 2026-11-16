# Pi Coding Agent 本地桥接器（`PI_CODING_AGENT_DIR` + `models.json` 免登录）

日期：2026-11-16。目标 CLI：`@mariozechner/pi-coding-agent` v0.73.0（Node `dist/cli.js`）。

## 1. 关键机制与避坑

- **隔离配置与磁盘零明文**：通过 `PI_CODING_AGENT_DIR` 指向 `private/pi-bridge/pi-agent/`，写入 `models.json`，其中 `apiKey` 字段仅写环境变量名（如 `"ZAI_API_KEY"`）。
- **`compat.supportsDeveloperRole: false`**：智谱 GLM / 部分 OpenAI-compatible 端点不识别 `role: "developer"` 消息，必须在 `models.json` 显式关闭该兼容项。
- **安全只读默认与离线开关**：默认传 `--tools read,grep,find,ls`（只读），`--write` 开放 `read,bash,edit,write,grep,find,ls`；加 `--offline`（`PI_OFFLINE=1`）禁止启动联网检查。
- **会话复用**：Pi 将会话写入 `--session-dir` 下的 `*.jsonl`，`--reuse` 时传 `--session <sessionFile>`。

## 2. 常用命令（在 `pi/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-pi.mjs --status
node scripts/dispatch-pi.mjs --models
node scripts/dispatch-pi.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-pi.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-pi.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`17.8s`，`tools=3`，落盘 `343_pi-e2e-20261116`、`observedModel=bigmodel/glm-4.7`）、R2 `--reuse`（`7.1s` 准确召回）及跨目录拒单均通过。
- **未验证项**：只读模式拒写拦截、超时 `taskkill` 分支、并发会话。
