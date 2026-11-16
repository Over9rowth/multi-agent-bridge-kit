# Aider 本地桥接器（`aider-chat` v0.86.2 隔离 Python venv）

日期：2026-11-16。目标 CLI：`aider-chat` v0.86.2（独立 Python 3.11 虚拟环境 `%USERPROFILE%\.local\aider-venv\Scripts\aider.exe`，不污染系统全局 Python）。

## 1. 与其他 Agent 的定位差异及避坑

- **Repo/Diff 中心型而非通用 Shell 工具型**：Aider 通过 LiteLLM 调用 `openai/<model>` 并直接生成文本 Diff 修改目标文件，默认不执行任意 Shell 工具；因此建议用 `--target <file1,file2>` 显式声明待改文件、用 `--read <file>` 声明只读参考文件。
- **静默模型警告**：未知模型前缀（如 `openai/glm-4.7`）会触发上下文窗口未知警告，桥接器自动生成隔离 `aider.model.metadata.json` 并加 `--no-show-model-warnings --no-check-update --no-analytics`。
- **安全读写切换**：未传 `--write` 时走 `--chat-mode ask`（只读问答，不改磁盘文件）；传 `--write` 时允许创建/编辑文件，并强制 `--no-auto-commits --no-dirty-commits --no-git` 保持非 Git 工作区洁净（若在 Git 仓库需要 repo-map 可追加 `--git`）。
- **记忆复用**：使用隔离 `--chat-history-file`，`--reuse` 时自动附加 `--restore-chat-history`。

## 2. 常用命令（在 `aider/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_GLM_API_KEY>"
node scripts/dispatch-aider.mjs --status
node scripts/dispatch-aider.mjs --cwd D:\YourProject --read fixture.json --target result.txt --file TASK_001.md --write
node scripts/dispatch-aider.mjs --cwd D:\YourProject --reuse --file TASK_002.md
node --test scripts/dispatch-aider.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测证据与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；GLM `openai/glm-4.7` R1（`--read fixture.json --target result.txt --write`，输出 `Applied edit to result.txt`，落盘 `343_aider-e2e-20261116`）、R2 `--reuse`（`--chat-mode ask` 只读问答准确召回 `343_aider-e2e-20261116`）及跨目录拒单均通过。
- **未验证项**：`--git` 开启时大仓库 repo-map 耗时、超时 `taskkill` 分支。
