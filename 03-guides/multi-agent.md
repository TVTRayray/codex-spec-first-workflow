# 混合多个 Agent 工具

## 基本规则

可以让不同工具分别承担 Planner、Implementer 和 Reviewer。工具选择不会改变工件格式、状态机或权限；唯一状态源永远在 `.specflow/`。

```yaml
agents:
  claude: { adapter: claude-code }
  codex: { adapter: codex }
  cursor: { adapter: cursor }
routing:
  planner: claude
  implementer: codex
  reviewer: cursor
```

也可按标签覆盖路由：例如 Rust/backend 变更交给 Codex，UI 变更交给 Cursor。每一次路由决定都应写进 change 的 history。

规则按书写顺序匹配，首条命中的 `overrides` 生效：

```yaml
routing:
  implementer: codex
  overrides:
    - when: { change_labels: [ui] }
      use: { implementer: cursor, reviewer: claude }
```

## 三种交接模式

| 模式 | 行为 | 适合场景 |
| --- | --- | --- |
| 手动 | `operator_runtime` 生成 `handoffs/<task-id>.yaml` 和平台提示词；用户在目标工具执行后导入 `<task-id>.result.yaml` | 首个版本、任意工具 |
| 半自动 | 用户选择 adapter，runtime 准备上下文与启动命令 | 具备 CLI/命令集成 |
| 全自动 | adapter 启动工具、收集 result 并回传 runtime | 集成稳定且权限可控 |

不能证明满足权限和结果回传约束的 adapter 必须降级为手动模式。

## 防止跨工具冲突

- 同一 spec 同时只有一个可写 lease；换工具前必须交还或等待 lease 过期。
- Reviewer 不能修改业务代码；其结论以 `reviews/` 中的结构化报告提交。
- Agent 完成工作不等于状态推进；runtime 验证 result 和前置工件后才推进。
- 并行 change 若修改同一 System Spec domain，归档时必须串行并检查冲突。

## Subagent 规则

所有 adapter 必须把 `subagents` 配置传达给目标工具。当前策略为 `orchestrator_only`：只有编排器可派发配置允许的只读、有限时、不可递归的研究或独立审查任务；普通 Planner、Implementer、Reviewer 仍为 `subagents: forbidden`。使用 `specflow dispatch-subagent` 派发，并由 runtime 施加 role 白名单、并发上限、租约时长和空 writable paths。`writable_paths: []` 指子代理不能写项目文件；其返回值由 runtime/adapter 写入交接工件。工具无法限制递归或写权限时，不得将该调用升级为可写 subagent。
