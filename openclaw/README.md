# OpenClaw 本地桥接器（`agent --local --json` + Windows 插件避坑）

日期：2026-11-16。目标 CLI：`openclaw` v2026.5.7 / npm `2026.11.4`（`openclaw.mjs`）。

## 1. Windows 实测两大关键坑点

1. **`plugins.enabled: false` 避开 Windows 符号链接 `EPERM`**：OpenClaw 默认扫描并尝试在 `stateDir/plugin-skills/` 创建目录符号链接，未开 Windows 开发者模式会抛出 `EPERM: operation not permitted, symlink` 并阻塞。隔离配置中禁用内置插件可秒过。
2. **`agents.defaults.skipBootstrap: true` 防止污染项目根目录**：OpenClaw 首次运行默认在 `workspace` 创建 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`BOOTSTRAP.md` 等 7 个引导文件；桥接器强制开启 `skipBootstrap: true`，实测目标目录完全洁净。
3. **环境变量引用 + 无 Gateway 嵌入式模式**：`openclaw.json` 中写 `apiKey: "${ZAI_API_KEY}"`（磁盘零明文），走 `agent --local --json --session-id <id>` 免启动 Gateway 或登录消息频道，固定 `--session-id` 即实现持久化会话复用。

## 2. 常用命令（在 `openclaw/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-openclaw.mjs --status
node scripts/dispatch-openclaw.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-openclaw.mjs --cwd D:\YourProject --reuse --file TASK_002.md --write
node --test scripts/dispatch-openclaw.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `glm-4.7` R1（`55.9s`，落盘 `343_openclaw-e2e-20261116`，工作区零 `SOUL.md`/`AGENTS.md` 残留、`observedModel=bigmodel/glm-4.7`）、R2 `--reuse`（`39.3s` 准确召回）及跨目录拒单均通过。
- **注**：OpenClaw 冷启动加载框架本身耗时约 15–25s，建议 `--timeout` 保持 ≥ 90s。
- **未验证项**：Gateway 守护进程模式、消息频道投递、超时 `taskkill` 分支。
