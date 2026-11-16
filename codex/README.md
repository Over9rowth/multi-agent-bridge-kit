# Codex 本地桥接器（ChatGPT 订阅 + BYO-Key 免登录双模式）

日期：2026-11-16 升级。入口：`../dispatch-codex-template.mjs`（与原订阅版接口 100% 兼容，新增 BYO-Key 免登录直连智谱 GLM `https://open.bigmodel.cn/api/v1`）。

## 1. 两种模式对比

| 模式 | 触发条件 | 隔离与配置机制 | 实测结果 |
| :--- | :--- | :--- | :--- |
| **BYO-Key 免登录** | `--byok` 或检测到 `ZAI_API_KEY`/`ZHIPU_API_KEY`/`GLM_API_KEY`/`CODEX_API_KEY` | 在 `state.json` 同级生成隔离 `codex-home/`（`config.toml` 写 `env_key` 引用 + `models.json` 目录，**磁盘零明文密钥**），`wire_api="responses"` | `glm-4.7` R1 `19.8s` 落盘 `343_codex-e2e-20261116`；R2 `--reuse` `19.7s` 召回 |
| **ChatGPT 订阅** | `--subscription` 或无 BYOK 环境变量 | 复用 `~/.codex/auth.json`，默认加 `--ignore-user-config` 跳过重型 MCP/插件 | 原有实测 11/11 全通（见 `../CODEX_BRIDGE_EXPERIENCE.md`） |

## 2. 关键避坑记录

1. **空版本目录 `ENOENT`**：`%LOCALAPPDATA%\OpenAI\Codex\bin\` 下可能残留不含 `codex.exe` 的旧版本哈希目录，`findCodexBin()` 按 mtime 倒序逐一检查 `fs.existsSync(p)`。
2. **避免 `Temp` 目录警告**：将隔离 `CODEX_HOME` 放在非 `Temp` 的工作状态目录（`private/codex-bridge/codex-home`），可消除 `Refusing to create helper binaries under temporary dir` 警告。
3. **非订阅模式不传 `--ignore-user-config`**：隔离 `CODEX_HOME` 下仅有精简 `config.toml` + `models.json`，不带 `--ignore-user-config` 才能读取其中的 `model_providers.ZAI` 与 `models.json`。

## 3. 常用命令

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node ../dispatch-codex-template.mjs --status --byok
node ../dispatch-codex-template.mjs --byok --write --cwd D:\YourProject --file TASK_001.md
node ../dispatch-codex-template.mjs --byok --reuse --write --cwd D:\YourProject --file TASK_002.md
node --test scripts/dispatch-codex.test.mjs
node scripts/verify-no-secrets.mjs
```

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；BYO-Key `glm-4.7` R1 (`19.8s`)、R2 (`19.7s`)、`glm-5.3` 探针与跨目录 `--reuse` 拒单均通过。
- **未验证项**：BYO-Key 下超时 `taskkill` 分支、并发多实例。
