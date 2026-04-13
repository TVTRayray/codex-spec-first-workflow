# Codex CLI 操作手册

这份手册说明如何在 Codex CLI 中执行 spec-first 的多阶段开发流程。

适用场景：

- 你先给出完整需求文档
- 希望先拆 spec，再进入编码
- 希望开发、验收、状态更新都可追踪

## 1. 推荐工作模式

推荐模式不是“一个长期会话包办所有角色”，而是：

- 你自己担任 `Orchestrator`
- 用一个 Codex 会话承担 `Master`
- 用一个 Codex 会话承担 `Coder`
- 用一个 Codex 会话承担 `QA`

不建议把主流程长期建立在 subagent 之上。

subagent 更适合：

- 并行搜索代码影响面
- 帮你列测试缺口
- 辅助做局部风险审查

subagent 不适合：

- 充当唯一的项目状态持有者
- 替代正式的 Master / Coder / QA 流程

## 2. 项目初始化

在真实项目仓库中准备以下结构：

```text
.agent/
  AGENT.md
  master_plan.md
  specs/
```

初始化步骤：

1. 把项目需求文档放入仓库，例如 `docs/prd.md`。
2. 将模板目录中的 `AGENT.md` 放入 `.agent/AGENT.md`。
3. 将 `master_plan.template.md` 复制为 `.agent/master_plan.md`。
4. 在 `.agent/specs/` 中准备后续的 spec 文件。

## 3. Master 阶段

### 目标

把原始需求拆成可以独立开发和验收的 vertical slices。

### 输入文件

- `docs/prd.md` 或等价需求文档
- `.agent/AGENT.md`
- `.agent/master_plan.md`

### 会话约束

- 只允许修改 `.agent/`
- 不允许修改业务代码

### 推荐开场指令

```text
你现在承担 Master 角色。先阅读 docs/prd.md、.agent/AGENT.md、.agent/master_plan.md。你的任务是把需求拆解为可独立开发和验收的 vertical slices，并更新 master_plan.md 与 specs/*.md。禁止修改业务源码。
```

### 输出结果

- 更新 `.agent/master_plan.md`
- 生成一个或多个 `.agent/specs/*.md`

### 验收点

- 每个 spec 都是独立闭环
- `master_plan.md` 已反映当前阶段和活跃任务
- 没有越权修改业务代码

## 4. Coder 阶段

### 目标

只实现一个已被分配的 spec。

### 输入文件

- `.agent/AGENT.md`
- `.agent/master_plan.md`
- 当前目标 `.agent/specs/xx.md`

### 会话约束

- 只实现当前 spec
- 不扩展到其他功能

### 推荐开场指令

```text
你现在承担 Coder 角色。先阅读 .agent/AGENT.md、.agent/master_plan.md 和我指定的单个 spec。你的任务是只实现该 spec 范围内的代码与测试，不要扩展到其他功能。完成后更新必要的 spec 状态并汇报验收结果。
```

### 输出结果

- 代码实现
- 测试或测试说明
- spec 状态更新

### 验收点

- 实现与 spec 一致
- 无越权需求扩张
- 关键测试已补齐或说明原因

## 5. QA 阶段

### 目标

对照 spec 审查实现质量，而不是只做表面体验检查。

### 输入文件

- `.agent/AGENT.md`
- 当前 spec
- git diff
- 测试结果

### 会话约束

- 以 review 为主
- 默认不直接改业务代码

### 推荐开场指令

```text
你现在承担 QA 角色。先阅读 .agent/AGENT.md、目标 spec、当前 diff 和测试结果。请先列出缺陷、风险和缺失的测试，再给出是否验收通过的结论。除非我明确授权，否则不要修改业务代码。
```

### 输出结果

- 结论：通过 / 退回
- 缺陷清单
- 回写状态建议

### 验收点

- 结论对应 spec 的完成定义
- 风险项被明确记录
- 未通过时退回原因足够具体

## 6. 你作为 Orchestrator 需要做什么

你不需要把自己也“做成一个 agent”。

你需要做的是：

- 提供需求文档
- 指定当前阶段
- 指定当前允许修改的文件范围
- 明确当前只读哪个 spec
- 决定何时从 Master 切到 Coder，再切到 QA

一句话说，Orchestrator 是流程控制者，不是代码执行者。

## 7. 什么时候用 subagent

可以用 subagent 的情况：

- 主任务已经明确，但你想并行收集信息
- 想让一个辅助代理检查测试遗漏
- 想让一个辅助代理扫描影响面或风险点

不建议用 subagent 的情况：

- 让 subagent 代替 `master_plan.md`
- 让 subagent 成为唯一的决策记录来源
- 让 subagent 长期承担正式角色并跨很多阶段维持状态

## 8. 最小闭环示例

一个最小的可运行流程如下：

1. 你把需求写进 `docs/prd.md`。
2. 启动 Master 会话，更新 `master_plan.md` 并生成两个 specs。
3. 启动 Coder 会话，只实现第一个 spec。
4. 启动 QA 会话，对照第一个 spec 做 review。
5. 通过后，再进入第二个 spec。

这套模式的重点不是“自动化到极限”，而是“状态稳定、边界清楚、可以持续迭代”。
