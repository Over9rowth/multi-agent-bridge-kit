# Goose CLI 本地桥接器（`aaif-goose/goose` 原生 `goose.exe`）

日期：2026-11-16。目标 CLI：`aaif-goose/goose` v1.59.2（Rust 原生 `goose.exe`，安装于 `%USERPROFILE%\.local\goose\goose-package\goose.exe`）。

## 1. 关键机制与避坑

- **免 Keyring 与全路径隔离**：Windows 无头执行可能因系统凭据库弹窗卡住，必须设置 `GOOSE_DISABLE_KEYRING=true`；同时隔离 `GOOSE_PATH_ROOT`、`XDG_*`、`APPDATA`、`LOCALAPPDATA`。
- **OpenAI 兼容路径拆分**：Goose 将 Host 与 Path 分开配置，直连智谱须设 `GOOSE_PROVIDER=openai`、`OPENAI_HOST=https://open.bigmodel.cn/api/coding/paas/v4`、`OPENAI_BASE_PATH=chat/completions`。
- **流式分片按 `message.id` 累加**：`-o stream-json` 中助手文本跨多条 `type="message"` 事件分片输出，须按 `message.id` 拼接并校验终态 `type="complete"`。
- **并发限流实测提醒**：当同账号高频并发调用智谱 Coding Plan 时，上游会返回 `429 Rate limit exceeded: 您的账户已达到速率限制`，桥接器能准确捕获并置会话为 `uncertain`。

## 2. 常用命令（在 `goose/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-goose.mjs --status
node scripts/dispatch-goose.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-goose.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-goose.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`20.7s`，`tools=3`，落盘 `343_goose-e2e-20261116`、`observedModel=openai/glm-4.7`）、R2 `--reuse`（`6.0s` 准确召回）及跨目录拒单均通过；并发限流报错拦截实测有效。
- **未验证项**：`anthropic` Provider 分支、不带 `--write` 时 `smart_approve` 交互阻塞行为、超时 `taskkill`。
