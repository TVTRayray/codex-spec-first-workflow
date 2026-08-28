# 快速上手：一个变更，无需手动切换角色

本指南描述 SpecFlow v0.1 的实际交互。它提供本地 runtime 与 Manual Adapter；仍可由 `operator_runtime` 代表团队完成跨工具的人工交接。

先在本仓库构建 CLI：

```bash
npm install
npm run build
```

## 1. 初始化项目

在业务仓库创建 `.specflow/`，复制以下模板：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js init .
```

```text
.specflow/config.yaml                 ← config.template.yaml
.specflow/state.yaml                  ← 派生项目索引，复制 project-state.template.yaml
.specflow/system-specs/
.specflow/changes/
```

将 [`AGENT.md`](../02-project-template/AGENT.md) 的约束合并到你使用的每个工具的项目指令文件中，并填写项目技术规则。

## 2. 创建并规划变更

创建 change：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js new add-team-permissions --prd docs/prd.md --prd docs/admin-prd.md --label security
```

Planner 创建或完善 proposal、Delta Specs、tasks，以及必要时的 design。然后由 runtime/operator 登记 Planner 拆出的 spec 并提交计划：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js add-spec add-team-permissions roles "角色与权限模型"
node /path/to/specflow-protocol-kit/dist/cli.js add-spec add-team-permissions member-ui "成员管理界面" --depends-on roles
node /path/to/specflow-protocol-kit/dist/cli.js submit-plan add-team-permissions
```

状态此时变为 `awaiting_plan_approval`。

用户只需审阅摘要并批准：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js approve add-team-permissions
```

`operator_runtime` 是命令的操作者，不是普通 Planner/Implementer/Reviewer；它负责检查工件、记录 history、签发 lease 和推进状态。

## 3. 实现、验收与修复

runtime 选择依赖已满足的 spec，签发 implementer lease，并按 `routing` 选择 Agent。Implementer 只提交 result report；随后 Reviewer 验证 Delta Spec、diff 和测试证据。

派发后可生成适用于任意 Agent 工具的提示词：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js dispatch add-team-permissions implementer --spec roles
node /path/to/specflow-protocol-kit/dist/cli.js prompt add-team-permissions <task-id>
```

将 `prompt` 的输出粘贴到 Codex、Claude Code、Cursor 或其他工具中。若将对应 role 的 adapter 配置为 `herdr`，且当前命令运行在 Herdr pane（`HERDR_ENV=1`），dispatch 会自动创建兄弟 pane、唤起 Agent 并发送任务提示词；否则安全降级为上述手动流程。

Herdr 会话可能懒加载，运行时可主动探查并记录状态：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js monitor add-team-permissions <task-id>
```

Herdr 启动后 runtime 会先等待 Agent 进入 `idle` 再发送任务，避免会话懒加载时丢失 prompt。若返回 `blocked`，先在 Herdr 中检查权限请求：

```bash
herdr agent read <agent-name>
```

确认权限后再显式批准（默认发送 Enter）：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js approve-agent add-team-permissions <task-id> --confirm
```

执行者完成后，operator_runtime 导入其 result：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js import-result add-team-permissions <task-id> /path/to/result.yaml
```

- QA `pass`：该 spec 成为 `qa_passed`，runtime 自动开始下一个可执行 spec。
- QA `repair`：若原因符合 `auto_repair` 且未超过次数，runtime 只把 QA 缺陷回交给 Implementer。
- QA `escalation`：状态变为 `decision_required`，用户决定后才继续。

用户随时查看：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js status
```

若状态进入 `blocked` 或 `decision_required`，人类给出决定后由 operator_runtime 显式恢复：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js resolve add-team-permissions ready --reason "采用兼容旧 token 的方案"
```

## 4. 汇总验证与归档

所有 spec 通过后：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js validate add-team-permissions
node /path/to/specflow-protocol-kit/dist/cli.js archive add-team-permissions
```

归档前必须先填写 change 下的 `test_report.md`，并保留人工批准点。若需要只读调查，可由 orchestrator 派发：

```bash
node /path/to/specflow-protocol-kit/dist/cli.js dispatch-subagent add-team-permissions codebase_researcher --task "分析权限模块调用关系"
node /path/to/specflow-protocol-kit/dist/cli.js prompt add-team-permissions <subagent-task-id>
```

Subagent 只能读取输入工件并返回分析结果，不改变主 change 状态。v0.1 会将每个 Delta Spec 中模板支持的 `ADDED / MODIFIED / REMOVED Requirements` 合并到同名的 `.specflow/system-specs/<domain>.md`，生成 `sync_report`，再把完整 change 移到 `.specflow/history/`。若新增重复 requirement，或修改/删除不存在的 requirement，归档会失败且不移动 change；`sync_report` 是归档产物，不是归档前置条件。

## 用户真正需要处理的事

1. 提供/澄清需求；
2. 批准变更拆分与范围；
3. 处理 `decision_required` 中的高风险决策；
4. 批准最终归档。

不需要手动创建 Master、Coder、QA，也不需要在普通 QA 打回时搬运上下文。
