# Trae Agent (`bytedance/trae-agent`) 本地桥接器

日期：2026-11-16。目标：开源 MIT 版 [`bytedance/trae-agent`](https://github.com/bytedance/trae-agent)（`trae-cli` / Python 3.12 + `uv` 隔离虚拟环境）。

> **与 Trae 商业产品的区分**：商业版 Trae IDE 走云端 `/custom_model` WebSocket 中转且对 Free 账号限制自定义模型、`TraeCode CLI (traecli)` 仅限企业旗舰版；本桥接器面向 **100% 开源免登录、可直连任意兼容 API 的 `bytedance/trae-agent`**。

## 1. 建桥核心机制与避坑（三个关键真实踩坑）

1. **安装必须带 `--extra evaluation`**：`trae_agent/agent/base_agent.py` 顶层无条件 `import docker`（来自 `docker_manager.py`），而 `docker` 被放进了 `pyproject.toml` 的 `[project.optional-dependencies].evaluation`；仅跑 `uv sync --no-dev` 启动即报 `ModuleNotFoundError: No module named 'docker'`。
2. **Windows 中文系统 `cmd.exe` GBK 字节毒化 `_buffer` 补丁（`scripts/trae-launcher.py`）**：
   - 上游 `trae_agent/tools/bash_tool.py` 在 Windows 下启动 `cmd.exe /v:on`，并直接调用 `self._process.stdout._buffer.decode()`（严格 UTF-8）。一旦遇到中文系统报错（如 GBK 字节 `0xb0`），在清空 `_buffer` 前就抛出 `UnicodeDecodeError`，导致该失效字节永久滞留在 `_buffer` 中毒化后续所有工具调用。
   - **根治方案**：桥接器通过 `scripts/trae-launcher.py` 预加载补丁（不改动上游仓库任何源码），在启动后发送 `chcp 65001` 并清缓冲，且捕获 `UnicodeDecodeError` 时改用 `mbcs` 解码并清空 `_buffer`。同时设 `PYTHONUTF8=1` 确保 `Path.read_text()` 正确读取 UTF-8 工单。
3. **`exit=0` 假成功与 `task_done` 空 `final_result`**：
   - `trae-cli run` 即使超步数失败（`success: false`）进程仍以 `exit=0` 退出；而当模型调用零参数的 `task_done` 结束时，`traj.json` 里 `success=true` 但 `final_result` 可能为空字符串。
   - **根治方案**：强制解析 `--trajectory-file` 中的 `traj.json`，要求 `success === true`，并在 `final_result` 为空时按逆序提取最后一条有效 `llm_response.content` 或 `sequentialthinking` 结论。
4. **OpenAI Responses vs Anthropic Messages**：`trae-agent` 的 `--provider openai` 走 `client.responses.create()`（Responses API，如 `/api/v1`）；若目标兼容端点提供 Anthropic Messages，应使用 `--provider anthropic`（默认）。

## 2. 常用命令（在 `trae-agent/` 目录下执行）

```powershell
$env:ZAI_API_KEY = "<YOUR_COMPAT_API_KEY>"
node scripts/dispatch-trae.mjs --status
node scripts/dispatch-trae.mjs --models
node scripts/dispatch-trae.mjs --cwd D:\YourProject --file TASK_001.md --write
node scripts/dispatch-trae.mjs --cwd D:\YourProject --reuse --file TASK_002.md
node --test scripts/dispatch-trae.test.mjs
node scripts/verify-no-secrets.mjs
```

## 3. 真机实测与边界

- **已实测**：离线单测 **6/6** 通过；密钥审计 **`clean`**；在 Python 3.12.16 + `uv` 隔离环境跑通 `--status`、`--dry-run`、Round 1（`33.2s` 落盘 `result.txt` 为 `343_trae-e2e-20261116`，`success=true, steps=7, tools=6`）、Round 2 `--reuse`（桥接层上下文传递）及跨目录 `--reuse` 拒单。
- **未验证项**：`--provider openai`（Responses API `/api/v1`）完整多步工具调用、Docker 沙箱模式、超时 `taskkill /T /F` 触发分支。
