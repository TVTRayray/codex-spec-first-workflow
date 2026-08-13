# SpecFlow Protocol Kit

面向 AI 编程工具的跨 Agent、可配置 Spec 驱动开发协议。它不要求团队只使用 Codex、Claude Code 或 Cursor 中的任一种；这些工具只是同一协议的不同执行端。

## 要解决的问题

传统的「Master → Coder → QA」分会话流程有清楚的职责边界，却把调度工作留给了人：反复创建会话、交接上下文、跟进 QA 打回、维护状态，以及控制不受限的 subagent。

SpecFlow 将这些责任收敛到可审计的变更状态与运行时规则中：

```text
PRD → change 规划 → 人工批准 → 实现 → QA → 自动修复（受限）
    → 下一个可执行 spec → 汇总验证 → 人工归档
```

人负责范围、风险和发布决策；运行时负责「下一步是什么」；Agent 只执行一次权限受限的工作单。

## 核心概念

- **System Spec**：已实现、已确认的系统行为，是长期事实源。
- **Change**：一次独立变更的工作区；保存 proposal、Delta Spec、design、tasks、review 和状态。
- **Delta Spec**：明确表达 `ADDED`、`MODIFIED`、`REMOVED` 的需求变化。归档时合并到 System Spec。
- **Task lease**：同一 spec 同一时刻只有一个可写执行者，避免多个 Agent 覆盖彼此改动。
- **Adapter**：将统一工作单转换为具体工具的命令、规则或可复制交接包。
- **设计维度**：项目初始化生成 `docs/design/`（设计宪章、tokens、视觉验收清单）；
  change 的 proposal 声明 Design Impact（none/visual/design_system），视觉变更证据前置，
  设计需求以 MUST 形式进入 Design System Spec 域，QA 按视觉验收清单机械打勾。

完整定义见 [协议说明](01-methodology/specflow-protocol.md) 与 [状态机](01-methodology/state-machine.md)。

## 推荐目录

在业务项目中初始化后，运行时目录为：

```text
.specflow/
  config.yaml
  state.yaml
  system-specs/
  changes/
    <change-id>/
      proposal.md
      design.md
      tasks.md
      state.yaml
      specs/
      reviews/
      handoffs/
  history/
```

仓库模板在 [`02-project-template/`](02-project-template/)；从 [快速上手](03-guides/quickstart.md) 开始。

## 设计原则

- **协议优先，平台可替换**：核心工件均为 Markdown/YAML；不依赖某一家 Agent 的私有会话状态。
- **变更与事实分离**：进行中的需求不污染已实现的长期系统规范。
- **自动化有边界**：低风险缺陷可以自动修复；需求歧义、架构、安全风险和重复失败必须升级给人。
- **默认禁止 subagent**：只有编排器能按配置派发短生命周期、不可递归、能力受限的辅助任务。
- **降级而不失真**：无法自动唤起某工具时，生成同一份交接包，由用户手动运行；状态与验收规则不变。

## 与 OpenSpec 的关系

本项目借鉴 OpenSpec 的 change folder、Delta Spec、同步与归档模型；在此基础上增加跨 Agent 路由、任务租约、QA 修复循环和 subagent 治理。它不是 OpenSpec 的 fork，也不要求安装 OpenSpec。

## v0.1 CLI

本仓库已提供本地 TypeScript runtime 的第一版。安装依赖并构建后，可用 `node dist/cli.js` 运行：

```bash
npm install
npm run build
node dist/cli.js init /path/to/your-project
```

当前命令覆盖 `init`、`new`、`add-spec`、`submit-plan`、`approve`、`resolve`、`status`、`validate`、`dispatch`、`prompt`、`import-result` 与 `archive`。默认 adapter 是 Manual Adapter：它生成可交给任意 Agent 的任务包和可复制提示词。具体用法见 [快速上手](03-guides/quickstart.md)。

`archive` 会把模板支持的 `ADDED / MODIFIED / REMOVED Requirements` 合并进同名 System Spec，生成同步报告并保留审计历史。重复新增、修改/删除不存在的 requirement 会拒绝归档，避免静默覆盖。
