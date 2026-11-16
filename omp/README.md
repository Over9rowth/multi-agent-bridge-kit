# Oh My Pi (`omp`) 本地桥接器（原生 `bun.exe` + `models.yml` 免登录）

日期：2026-11-16。目标 CLI：`@oh-my-pi/pi-coding-agent` v18.20.3（需要 Bun 运行时 `bun.exe` v1.4.4）。

## 1. 运行时与工具名差异（关键踩坑）

1. **必须用原生 `bun.exe`，不能用 Node 22 或 `bun.cmd`**：`dist/cli.js` 编译产物包含 ES2025 `using` 语句（Node 22 报 `SyntaxError: Unexpected identifier`）；Windows 下 `spawn("bun")` 无 `shell` 时也会 `ENOENT`，必须定位 `%APPDATA%\npm\node_modules\bun\bin\bun.exe`。
2. **`models.yml` 而非仅 `models.json`**：OMP 遵循其 YAML Schema，写隔离 `PI_CODING_AGENT_DIR/models.yml`（`apiKey: ZAI_API_KEY`、`compat.supportsDeveloperRole: false`）。
3. **内置工具名与上游 Pi 不同**：OMP 没有 `ls`，且无头沙箱下 `find` 可能不可用，应使用 `glob` 替代（施工：`read,bash,edit,write,grep,glob`；只读：`read,grep,glob`）。若套用 Pi 的 `find,ls` 会直接以 exit 2 报错退出。

## 2. 常用命令（在 `omp/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-omp.mjs --status
node scripts/dispatch-omp.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-omp.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-omp.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`17.7s`，`tools=3`，落盘 `343_omp-e2e-20261116`、`observedModel=bigmodel/glm-4.7`）、R2 `--reuse`（`5.9s` 准确召回）及跨目录拒单均通过。
- **未验证项**：`--thinking` 各档位实测、LSP/PTY 开启模式、超时 `taskkill` 分支。
