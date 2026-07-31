# FastGPT 二次开发指南 (CLAUDE.md)

> 本文件为 Claude Code 在本仓库进行二次开发提供项目级导航与关键约束提炼。
> 权威代码规范以 `.agents/code/syntax.md`、`.agents/code/commands.md` 和 `AGENTS.md` 为准；本文件不重复其全部内容，冲突时以这三者为权威。
> 梳理或理解某个模块前，先查 `custom-docs/<module>.md`（本 fork 已有梳理，避免重复扫描代码）。

## 项目概述

FastGPT（当前版本 **v4.15.2**，已 fork 自 labring/FastGPT 进行二次开发）是一个基于 LLM 的 AI Agent 构建平台，提供知识库问答（RAG）、可视化工作流编排、插件、双向 MCP、代码沙箱等能力。

**技术栈**：NextJS 16 + TypeScript + Chakra UI 2 + MongoDB (Mongoose 8) + 向量数据库 (pgvector / Milvus / Zilliz / OceanBase 等) + pnpm workspace monorepo + Turborepo + Vitest。

## 仓库结构（monorepo）

### 共享包 `packages/`（workspace 引用）
- `packages/global/` → `@fastgpt/global`：前后端共享的类型、常量、工具函数、OpenAPI 契约。`core/` 只放类型/常量，**禁止**引入 mongoose 或服务端 SDK。
- `packages/service/` → `@fastgpt/service`：后端业务逻辑、Mongoose 模型、API 控制器、工作流引擎。`core/` 仅服务端可用，**禁止**被 `packages/web` 或前端页面直接引用。
- `packages/web/` → `@fastgpt/web`：共享前端组件、hooks、Chakra 主题 (`styles/theme.ts`)、i18n。
- `packages/next/`：NextJS 中间件。
- `packages/service/worker/`：CPU 密集型后台线程（token 计数、文件读取、文本切片、html→md），用于避免阻塞主循环。

### 应用 `projects/`
- `projects/app/` → `@fastgpt/app`：主 NextJS 应用（前端 `src/pageComponents`、`src/components` + 后端 `src/pages/api` API 路由 + `src/service` 业务逻辑）。**二次开发主战场**。
- `projects/code-sandbox/`：Bun + Hono 代码执行沙箱。
- `projects/mcp_server/`：MCP 服务器（Bun）。
- `projects/marketplace/`、`projects/volume-manager/`、`projects/agent-sandbox/`、`projects/agent-sandbox-proxy/`、`projects/fastgpt-ide-agent/`：辅助服务。

### 其他
- `pro/`：商业版，git submodule → `github.com/labring/fastgpt-pro`，**当前为空未拉取**，独立授权，二次开发一般不涉及。
- `sdk/`：`@fastgpt-sdk/storage`、`otel`、`sandbox-adapter`；构建产物被主应用依赖，需先 `pnpm build:sdks`。
- `deploy/`：Docker Compose / Helm / k8s 部署配置；`deploy/version/v4.15/` 为当前版本部署参数与 `docker-compose.template.yml`。
- `document/`：文档站点；`test/`：集中测试；`scripts/`：图标、i18n、测试脚本。
- `.agents/design/`、`.agents/issue/`：既有设计文档与问题分析（改动前值得检索参考）。
- `custom-docs/`：**本 fork 二次开发梳理文档**（与上游隔离）。梳理/理解某模块前先查这里，如 `dataset.md`（知识库）；新增按 `<module>.md` 命名，勿放 `.agents/`。

## 开发命令

环境要求：**Node >= 20.19.0，pnpm 10.x**（packageManager 锁定 `pnpm@10.33.4`）。

```bash
pnpm i                          # 安装全部 workspace 依赖（postinstall 自动构建 sdks + 生成主题类型）
pnpm build:sdks                 # 手动构建 sdk 依赖（主应用依赖其产物）
cd projects/app && pnpm dev     # 启动主应用开发服务器（或 make dev name=app）
pnpm lint                       # ESLint 全量并自动修复
pnpm test                       # 运行测试（脚本内置 mongodb-memory-server）
pnpm test:workspace             # app/admin/global/service 测试
pnpm test:service               # 仅 service
pnpm test:vector                # 向量库集成测试
```

## 配置与环境

- 环境变量模板：`projects/app/.env.template` → 复制为 `.env.local` 修改（API Key、数据库地址端口账号密码须与 docker 配置一致，不能只改一处）。
- 模型配置：`packages/service/core/ai/config/`。
- **MongoDB 必须以副本集（replica set）模式运行**，否则事务（`mongoSessionRun`）无法工作；首次部署需 `rs.initiate`。
- 本地默认账号 `root` / 密码 `1234`（仅本地，生产必改）。

## 代码规范（关键约束，详见 `.agents/code/syntax.md`）

### DDD 分层与固定文件
业务域 → 子功能 → 固定文件。叶子目录固定文件职责：
- `schema.ts`：Mongoose Schema / Model 定义
- `entity.ts`：数据访问（`findById`/`create`/`updateById`），不含业务判断
- `service.ts`：业务逻辑，调 entity，跨模块协调；service 间**单向依赖**，跨 service 协调由上层通过 props 传入
- `utils.ts`：纯函数工具，无副作用，可独立单测

### 风格要点
- 用 `type` 不用 `interface`
- 条件赋值用 IIFE 取代 if/else
- Zod schema 同时承担校验与类型（`z.infer`），不重复手写同构 type
- 入参/分页/布尔配置优先用 `@fastgpt/global/common/zod` 的 `IntSchema`/`NumSchema`/`BoolSchema`，不直接 `z.coerce.number()`
- 可选回调用 `?.()`；默认值用 `??` 不用 `||`
- 类型收窄用 `is` 守卫，不用 `as` 强断言
- 非关键清理用 `.catch(() => {})`，不污染主 try/catch
- 函数独立参数不超过 2 个，多了用对象传参
- DB 写操作函数统一支持可选 `session` 参数；事务用 `mongoSessionRun` 包裹

### API 路由入参校验（重要）
- NextJS API 路由校验 `req.body`/`req.query`/`req.params` **必须用 `parseApiInput`**（来自 `@fastgpt/service/common/zod/requestParseError`），**不要**直接 `SomeSchema.parse(req.body)`。
- 内部业务数据、数据库记录、模型返回、工具调用参数等仍用普通 `Schema.parse(...)`（属内部 bug，应上报而非给用户降噪）。

### 注释
- 文件开头加文件级注释说明用途。
- 导出函数、核心业务函数、hook、复杂工具函数、跨模块复用函数用 `/** */` 补函数级注释（职责、入参出参、关键分支、边界、设计原因；尤关注计费/权限/requestId/错误处理/流式/缓存/并发/兼容）。
- 非显而易见逻辑加简短中文行内注释，说明"为什么"而非逐行复述代码。

## 安全要求（二次开发红线）

- 遵循企业级安全：防 SQL/NoSQL 注入、防 SSRF、防越权、防路径穿越；改动涉及文件读写、URL 抓取、命令/代码执行、权限校验时尤其谨慎。
- **仅操作项目相关文件**；删除或越权类危险操作须先经用户确认。
- 改动前检索 `.agents/issue/` 下既有安全分析（如 `ssrf-vulnerability-fix.md`、`sandbox/opensandbox-docker-security-review.md`）。

## 工作流（复杂任务）

参考 `AGENTS.md`：需求文档 → 开发文档 → TODO → 执行 TODO。设计文档输出到 `.agents/design/`（todo 跟在后面），问题分析输出到 `.agents/issue/`。简单任务可直接实现。改动前先查 `.agents/code/syntax.md` 相关规范；规范与现状冲突时优先按规范，仅在确有业务/兼容理由时说明例外。

## Subagent 分工约定（本 fork 自定义）

本仓库在 `.claude/agents/` 下配置了两个子 agent，主 agent（Claude Code）按如下分工协作：
- **主 agent**：负责理解用户需求、解读相关代码、拆解任务、综合与验收；非简单任务时不直接写实现代码。
- **`designer`**（只读工具 Read/Grep/Glob/Bash）：负责分析需求、技术选型、产出结构化设计方案（概述/影响范围/技术决策/实施步骤/风险）。方案文档输出到 `custom-docs/`（本 fork 隔离约定，**不写上游 `.agents/design/`**）。
- **`implementer`**（读写工具 Read/Write/Edit/Bash/Grep/Glob）：按设计方案执行编码、重构与测试，遵守 `.agents/code/syntax.md` 规范。

调用方式：主 agent 通过 Agent 工具以 `subagent_type: "designer"` / `"implementer"` 派发。简单任务（改错字、单行修复、查文档）由主 agent 直接处理，无需派发。注意：subagent 不能再嵌套派生子 agent。

## 已知差异与注意

- `AGENTS.md` 中 projects 列表已过时（实际还包括 marketplace、volume-manager、agent-sandbox、agent-sandbox-proxy、fastgpt-ide-agent）。
- `dev.md` 中 Docker 示例版本号（v4.8.1）过时，当前为 v4.15.2。
- `pro/` 为空 submodule；如需商业版能力需单独拉取并遵守其独立授权。
- 上游仓库：`github.com/labring/FastGPT`；官方文档：`doc.fastgpt.io`；OpenAPI 文档：`cloud.fastgpt.io/apidoc`。
