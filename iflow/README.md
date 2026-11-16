# iFlow CLI 本地桥接器（隔离 `.iflow/settings.json` + 环境变量免登录）

日期：2026-11-16。目标 CLI：`@iflow-ai/iflow-cli` v0.5.19（`bundle/iflow.js`）。

## 1. 关键机制与避坑

- **免 iFlow 登录 + 磁盘零明文**：在隔离 `HOME`/`USERPROFILE` 下生成 `.iflow/settings.json`（仅写 `{"selectedAuthType": "openai-compatible"}`），实际 Key、Base URL 与模型均由 `IFLOW_API_KEY`、`IFLOW_BASE_URL`、`IFLOW_MODEL_NAME` 环境变量注入。
- **双通道观测**：`-o exec-info.json` 稳定产出 `session-id`、`assistantRounds` 与 `tokenUsage`；默认 `--plan` 只读，施工显式 `--write`（`-y`）；`--reuse` 走 `-r <session-id>`。

## 2. 常用命令（在 `iflow/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-iflow.mjs --status
node scripts/dispatch-iflow.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-iflow.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-iflow.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`27.3s`，`rounds=4`，落盘 `343_iflow-e2e-20261116`）、R2 `--reuse`（`9.3s`，`rounds=1` 准确召回）及跨目录拒单均通过。
- **未验证项**：`--plan` 模式写拦截、超时 `taskkill` 分支。
