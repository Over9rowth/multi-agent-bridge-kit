# Kimi Code CLI 本地桥接器（隔离 `.kimi-code/config.toml` + `api_key_env` 免登录）

日期：2026-11-16。目标 CLI：`@moonshot-ai/kimi-code` v2.6.2（Node `dist/main.mjs`）。

## 1. 免登录原理与关键坑点

1. **配置目录变更（v2.6.2）**：TS 重写后的 `@moonshot-ai/kimi-code` 读取 `~/.kimi-code/config.toml` 而非旧版 `~/.kimi/config.toml`；且支持 `api_key_env = "ZAI_API_KEY"` 引用环境变量，磁盘零明文密钥。
2. **参数互斥限制**：源码明确禁止 `--prompt` 与 `--yolo` / `--auto` / `--plan` 同用（`Cannot combine --prompt with --yolo`），`-p` 无头模式默认直接执行任务，桥接器不叠加互斥旗标。
3. **会话复用**：从 `stream-json` 的 `session.resume_hint` 提取 `session_id`，`--reuse` 时传 `-S <session_id>` 延续上下文。

## 2. 常用命令（在 `kimi-code/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-kimi.mjs --status
node scripts/dispatch-kimi.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-kimi.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-kimi.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`23.8s`，`tools=3`，落盘 `343_kimi-code-e2e-20261116`）、R2 `--reuse`（`5.8s` 准确召回）及跨目录拒单均通过。
- **未验证项**：`kimi-for-coding` 官方会员通道、`--provider-type anthropic` 实测、超时 `taskkill` 分支。
