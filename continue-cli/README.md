# Continue CLI (`cn`) 本地桥接器（`CONTINUE_GLOBAL_DIR` + YAML `${{ secrets.* }}` 免登录）

日期：2026-11-16。目标 CLI：`@continuedev/cli` v1.5.47（`dist/cn.js`）。

## 1. 关键机制与避坑

- **跳过 Continue Hub 登录**：通过 `--config <yaml>` + 隔离 `CONTINUE_GLOBAL_DIR`，YAML 中 `apiKey: ${{ secrets.ZAI_API_KEY }}` 引用环境变量（磁盘零明文密钥），即可免 Hub 登录直连智谱 GLM。
- **提示词传递必须显式**：Windows 下 `cn -p` 对未接管的 `stdin` 不会自动当成 prompt，必须传 `--prompt <active-task.md>` + 触发语句。
- **会话列表与复用**：执行完毕后调用 `cn ls --json` 匹配当前工作区 `session.id`，`--reuse` 通过 `--fork <sessionId>` 延续会话历史。默认 `--readonly`，施工需 `--write`（`--auto`）。

## 2. 常用命令（在 `continue-cli/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-continue.mjs --status
node scripts/dispatch-continue.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-continue.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-continue.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`34.9s`，落盘 `343_continue-cli-e2e-20261116`）、R2 `--reuse`（`16.2s` 准确召回）及跨目录拒单均通过。
- **未验证项**：`--readonly` 写拦截实测、超时 `taskkill` 分支。
