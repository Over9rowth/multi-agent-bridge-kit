# Crush CLI 本地桥接器（`CRUSH_GLOBAL_CONFIG` + `session last --json`）

日期：2026-11-16。目标 CLI：`@charmland/crush` v0.101.0（原生 Go 单二进制 `crush.exe`）。

## 1. 关键机制与避坑

- **零工作区污染**：`crush.exe` 默认在 `-c <cwd>` 或全局配置找 `crush.json`；桥接器通过 `CRUSH_GLOBAL_CONFIG` 将配置隔离在 `private/crush-bridge/crush-config/crush.json`（内部写 `api_key: "$ZAI_API_KEY"`，磁盘零明文密钥），`-D` 隔离 SQLite 会话库 `crush.db`，**目标仓库不产生任何残留配置文件**。
- **事后结构化验真**：`crush run -q` 仅向 stdout 打印文本答复；桥接器在退出后紧接着调用 `crush session last|show -D <dataDir> --json` 核验 `meta.id`、`assistant.model`、`tool_call` 列表及 `finish.reason === "end_turn"`。
- **权限与复用**：施工显式 `--write`（`-y` yolo）；`--reuse` 走 `-s <sessionId>`。

## 2. 常用命令（在 `crush/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-crush.mjs --status
node scripts/dispatch-crush.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-crush.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-crush.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`30.4s`，`tools=3`，落盘 `343_crush-e2e-20261116`，工作区零 `crush.json` 残留）、R2 `--reuse`（`11.8s` 准确召回）及跨目录拒单均通过。
- **未验证项**：不带 `--write` 交互阻塞超时行为、`--reasoning-effort` 分支、超时 `taskkill`。
