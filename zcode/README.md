# ZCode 桥接套件 (ZCode Local Bridge)

基于《本地 Multi-Agent 编排与客户端桥接工程手册》方法论构建的 **ZCode** 本地多智能体桥接适配器。

- **目标软件**：ZCode Desktop `3.17.2` / ZCode CLI `0.17.1`
- **执行环境**：Windows / Node.js `22.15.1`
- **默认供应商**：`zai-standard-api` (Z.ai API)
- **模型机制**：支持自主配置任意平台模型（自选旗舰推理大模型或轻量级执行工兵模型，支持指定思考等级）

---

## 1. 五步法的实际映射

| 步骤 | 映射到 ZCode | 实现与证据 |
| --- | --- | --- |
| **1. 发现入口** | 定位 `<ZCODE_INSTALL_DIR>` 及 `resources/glm/zcode.cjs`；补齐内建配置缺失路径 | 静态检查安装根目录与核心 bundle |
| **2. 还原契约** | `node -r patch-sqlite.cjs zcode.cjs --prompt <text> --json` | stdio JSON 输出，解析 `result` 与 `turn.completed` 终态 |
| **3. 确认模型** | 语法：`${providerId}/${modelId}$${reasoningLevel}` | 写入 `defaultModelSelection`，指定 `zai-standard-api/GLM-5.3-Flash$high` |
| **4. 会话与权限** | `--mode yolo`，会话复用通过 `--resume <sessionId>` | 状态文件记录当前工作区与最后一次成功的 `sessionId` |
| **5. 验收闭环** | 三层核验：进程拉起 -> 协议终态 -> 业务输出匹配 | 支持 `--dry-run` 离线预检工单哈希与参数拼装 |

---

## 2. 核心坑点与适配突破（坑点 21–24）

### 坑点 21：内建 Provider 配置缺失 (CLI 路径查找回退失败)
- **现象**：直接调用 `zcode.cjs` 报错：`无法定位 CLI ZCode Built-in Provider Config：<ZCODE_INSTALL_DIR>\resources\glm\provider\zcode-builtin.json, D:\config\provider\zcode-builtin.json`。
- **原因**：打包路径与源码 `../../../../../config/provider` 结构脱节，发布包放置在 `resources/config/provider`。
- **解决**：在 `<ZCODE_INSTALL_DIR>\resources\glm\provider\` 下补齐 `zcode-builtin.json` 软链接或副本。

### 坑点 22：Node 22 内置 `node:sqlite` 迁移事务所有权断言失败
- **现象**：Node v22.15.1 下启动 CLI 报错：`SqliteSessionMigrationError: SQLite migration initialization failed ... Cause: Error: Migration transaction ownership mismatch`。
- **原因**：源码中使用了 `if (e.isTransaction !== !!n.transactionOpen) throw ...`，而在 Node v22.15.1 中 `DatabaseSync.prototype.isTransaction` 为 `undefined`，导致 `undefined !== false` 恒成立。
- **解决**：编写 `patch-sqlite.cjs` 前置 preload 脚本，定义 `isTransaction` 属性及其根据 `exec('begin')` / `commit` 的自动拦截。

### 坑点 23：模型选择器与思考强度语法还原
- **逆向分析**：AST 反编译查明模型选择表达式格式为 `${providerId}/${modelId}$${reasoningLevel}`，模型选项支持 `low`、`high`、`max`。
- **配置固化**：在 `provider_config.json` 的 `config.defaultModelSelection` 下注入：
  ```json
  {
    "providerId": "zai-standard-api",
    "modelId": "GLM-5.3-Flash",
    "options": {
      "reasoningLevel": "high"
    }
  }
  ```

### 坑点 24：Z.ai 独立 API 与 BigModel 套餐及 Client Signing 边界
- **现象**：默认若未配置或账号关联到 BigModel，会触发 `ClientRequestSigningV4` 签名握手。
- **鉴权差异**：用户指定使用 Z.ai 的 API 调用（而非 BigModel 套餐）。Z.ai 平台调用需要合法的 API Key，若传入无效 Key（如单纯的 `apiKeyId`）远端会返回 `401 token expired or incorrect`。桥接器支持通过 `--api-key` 或环境变量 `ZAI_API_KEY` 随时注入或更新凭证，格式必须为两段式 `{apiKeyId}.{secret}`。

### 坑点 25：无参数 `--resume` 误触交互式 TUI 导致 `@zcode/tui` 缺失崩溃
- **现象**：在终端直接运行 `zcode.cjs --resume <sessionId>` 报错：`Error: Cannot find package '@zcode/tui' imported from <ZCODE_INSTALL_DIR>\resources\glm\zcode.cjs`。
- **原因**：ZCode 桌面版安装包未打包终端字符 UI（TUI）依赖包。当不提供 `--prompt` 时，引擎默认尝试拉起全屏交互式终端界面而导致导入失败。
- **解决**：无头批处理调用必须传递 `--prompt` 或 `--file`；查看历史会话与思考链改用桥接器内置的 `--show [sessionId|latest]` 或 `--history` 命令，直接从本地 SQLite 解析。

---

## 3. 使用方法与操作命令

### 状态检查与可用模型列表
```powershell
node zcode/scripts/dispatch-zcode.mjs --status
node zcode/scripts/dispatch-zcode.mjs --models
```

### 历史会话与思考链直读（免 TUI 依赖）
```powershell
# 查看历史会话概要列表
node zcode/scripts/dispatch-zcode.mjs --history

# 直读最新会话详情（包含 GLM 思考过程与输出）
node zcode/scripts/dispatch-zcode.mjs --show latest
```

### 预演核对（Dry-Run）
```powershell
node zcode/scripts/dispatch-zcode.mjs --file TASK-001.md --dry-run
```

### 派发工单（指定高思考强度 GLM-5.3-Flash）
```powershell
node zcode/scripts/dispatch-zcode.mjs --file TASK-001.md --model GLM-5.3-Flash --thinking high
```

### 会话复用
```powershell
node zcode/scripts/dispatch-zcode.mjs --reuse --file TASK-002.md
```

### 运行单元测试
```powershell
node zcode/scripts/dispatch-zcode.test.mjs
```
