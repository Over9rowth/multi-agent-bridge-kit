# Gemini CLI 本地桥接器：实现、真机实测与经验

日期：2026-11-16（Asia/Shanghai）。环境：Windows、Node 22.15.1、`@google/gemini-cli` v0.68.0（原生入口 `bundle/gemini.js`，无需 `.cmd`/`.ps1` 包装器）。

状态结论：**桥接器已跑通真机无头握手、原生 `gemini-4-argon`（炫彩猫猫）读写文件工具调用、同会话 `--resume` 上下文召回、`stats.models` 主机侧独立模型观测、以及无效模型前置拒绝（零状态污染）**；同时实测暴露 `oauth-personal` 凭据过期弹窗退出 0 陷阱，以及 `gemini-4-carbon` 当前与主会话共享 Vertex 429 限流边界。离线单元测试 7/7 通过；密钥审计 `clean`。

---

## 1. 交付内容

| 文件 | 作用 |
| :--- | :--- |
| `scripts/dispatch-gemini.mjs` | 零第三方依赖桥接 CLI：直接拉起 `bundle/gemini.js`、禁二次拉起（`GEMINI_CLI_NO_RELAUNCH=true`）、禁扩展干扰（`-e none`）、前置模型校验、`stream-json` delta 拼接与 `stats.models` 复核 |
| `scripts/dispatch-gemini.test.mjs` | 7 项离线单元测试（参数守卫、ASCII 校验、BOM/SHA-256、模型前置校验、delta 拼接、静默认证提示拒绝） |
| `scripts/verify-no-secrets.mjs` | 只读安全审计：检查是否混入 `AIza` / `ya29.` / `1//` / GCP 私钥等凭据 |
| `.gitignore` | 忽略 `private/`、状态 JSON、锁文件与临时文件 |

---

## 2. 五步方法论在 Gemini CLI 上的映射

| 步骤 | 映射到 Gemini CLI v0.68.0 |
| :--- | :--- |
| **1. 发现入口与凭据** | 定位 `%APPDATA%\npm\node_modules\@google\gemini-cli\bundle\gemini.js`，由 `process.execPath` 直接运行；设 `GEMINI_CLI_NO_RELAUNCH=true` 阻止二次派生子进程；若 `~/.gemini/settings.json` 为 `vertex-ai`，自动从 env / `gcloud` 默认配置 / `opencode.json` 补齐 `GOOGLE_CLOUD_PROJECT` 与 `GOOGLE_CLOUD_LOCATION`（注意不是 `VERTEX_LOCATION`！） |
| **2. 还原契约** | 只读 `--help` 与 `bundle/*.js`：`gemini -p "" -o stream-json` 从 `stdin` 读 UTF-8 工单，输出 `init` / `message(delta:true)` / `tool_use` / `tool_result` / `result(status, stats.models)` |
| **3. 动态模型目录** | 合并 `gemini models --output-format json` 与 `bundle/chunk-*.js` 声明的模型常量（含 `gemini-4-argon`、`gemini-4-carbon`、`gemini-3.5-flash`、`gemini-2.5-pro` 等）；派单前先纯校验，防止无效模型留下空会话 |
| **4. 会话与权限** | 默认 `--approval-mode default`（保留审批安全，不静默越权），施工需显式传 `--write`（`= --approval-mode yolo`）；默认 `-e none` 屏蔽重扩展（避免注入 18KB 系统提示导致输入 Token 暴涨）；支持 `--reuse` 同目录已完成复用 |
| **5. 三层验收** | `exit=0` + `result.status === "success"` + 非空拼接文本 + 拒绝交互登录提示假成功 + 独立记录 `result.stats.models` 实际执行模型 |

---

## 3. 常用命令（在 `gemini-cli/` 目录下执行）

```powershell
node scripts/dispatch-gemini.mjs --status
node scripts/dispatch-gemini.mjs --models
node --test scripts/dispatch-gemini.test.mjs
node scripts/verify-no-secrets.mjs

# 派发 UTF-8 工单（炫彩猫猫 gemini-4-argon）
node scripts/dispatch-gemini.mjs --cwd D:\YourProject --file TASK_001.md --model gemini-4-argon --write

# 同目录同模块复用会话
node scripts/dispatch-gemini.mjs --cwd D:\YourProject --reuse --file TASK_002.md --model gemini-4-argon --write
```

---

## 4. 真机实测结果与重要边界（如实单列）

1. **炫彩猫猫（`gemini-4-argon`）实测跑通**：
   - Round 1（`-m gemini-4-argon -e none --approval-mode yolo`）：`12.3s` 完成 `read_file` (`fixture.json`) + `write_file` (`result.txt` 写入 `343_gemini-cli-20261116`)，返回 `GEMINI_R1_OK`，`stats.models` 独立证实为 `gemini-4-argon`。
   - Round 2（`--reuse` + `--model gemini-4-argon`）：`7.7s` 复用同一 `session_id` 未重读文件准确答出 `343_gemini-cli-20261116`（实测捕捉到 `delta: true` 分片输出 `"343_"` + `"gemini-cli-20261116"`）。
2. **重要配额与鉴权发现（必须明确）**：
   - 本机 `~/.gemini/settings.json` 当前为 `"selectedType": "vertex-ai"`，因此 Gemini CLI 走的是**与 OpenCode 相同的 GCP Vertex 项目配额**（不是独立的免费个人账号额度！）；实测 **`gemini-4-carbon` 立即撞上 429 限流**，而 **`gemini-4-argon`（炫彩猫猫）在独立桶下成功跑通**。
   - 本机 `~/.gemini/oauth_creds.json` 过期时间为 `2026-10-20`；若想切换到 Google 个人账号免费额度（`oauth-personal`）错峰避开 Vertex 限流，需用户在终端交互运行一次 `gemini` 登录刷新 OAuth 并切回 Google 登录。
3. **新桥接器端到端复核（2026-11-16 已实测）**：
   - 离线测试 `7/7` 通过；密钥审计 `clean`；`--status` 与 `--models`（16 个过滤后聊天模型）正常；
   - `--dry-run` 与无效模型 `fake-model-999` 前置拒绝（`exit=1`、`state.json` 未创建）通过；
   - 隔离工单 Round 1（`gemini-4-argon`、`--write`）：`25.8s` 完成 `read_file` + `write_file` (`343_gemini-bridge-20261116` 写入 `result.txt`)，返回 `GEMINI_E2E_ROUND1_OK`，`observedModels=gemini-4-argon`；
   - 隔离工单 Round 2（`--reuse`）：`7.4s` 复用会话 `39d72e67-e7d3-4e9e-8b19-c034ce88e493` 不重读文件准确答出 `343_gemini-bridge-20261116`；
   - 跨目录 `--reuse` 拒绝、`--history` 均通过。
   - **未验证项**：超时 `taskkill /T /F` 分支、并发多实例、`--with-extensions`、刷新 OAuth 后切换 `oauth-personal` 免费额度路线。
