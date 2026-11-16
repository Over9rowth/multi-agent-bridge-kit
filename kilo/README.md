# Kilo CLI 本地桥接器（`KILO_CONFIG_CONTENT` 内存注入免登录）

日期：2026-11-16。目标 CLI：`@kilocode/cli` v7.8.27（原生 `kilo.exe`）。

## 1. 关键机制与避坑

- **零落盘自定义 Provider**：通过环境变量 `KILO_CONFIG_CONTENT` 注入 JSON 配置，其中 `options.apiKey` 写 `"{env:ZAI_API_KEY}"`，无需在用户目录改全局 config 即可免 Kilo Gateway 登录直连智谱 GLM。
- **原生二进制定位**：`kilo.cmd` 是 npm 包装脚本，`findKiloBin()` 定位 `@kilocode/cli-windows-x64/bin/kilo.exe`。
- **双段 JSONL 终态检查**：仅把 `step_finish.part.reason === "stop"` 视为结束（排除工具调用中间轮 `"tool-calls"`）。默认开启 `--pure` 屏蔽外部插件；施工显式 `--write`（`--auto`）。

## 2. 常用命令（在 `kilo/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-kilo.mjs --status
node scripts/dispatch-kilo.mjs --models
node scripts/dispatch-kilo.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-kilo.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-kilo.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`36.4s`，`tools=3`，落盘 `343_kilo-e2e-20261116`、`finish=stop`）、R2 `--reuse`（`15.9s` 准确召回）及跨目录拒单均通过。
- **未验证项**：只读（不带 `--write`）阻塞行为、Kilo Cloud 原生额度路径、超时 `taskkill` 分支。
