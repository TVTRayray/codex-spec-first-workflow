# 配置参考

`.specflow/config.yaml` 用于调整流程，而不是绕过审计与安全边界。以 [`config.template.yaml`](../02-project-template/config.template.yaml) 为起点。

## 可配置项

| 区域 | 用途 | 默认建议 |
| --- | --- | --- |
| `workflow` | 变更模型与人工批准状态 | 使用 `delta_spec`，批准计划和归档 |
| `artifacts` | 各阶段必须存在的工件 | 实施前要求 proposal、Delta Spec、tasks |
| `execution` | 串/并行、活跃 change、lease 时长和 runtime 模式 | 一个活跃 change、spec 串行；其余 worker 仅可为只读辅助任务 |
| `quality.test_commands` | 写入 Implementer 任务包的项目测试命令 | 填入项目实际可运行的命令 |
| `quality.auto_repair` | 哪些 QA 结论可自动修复、最大次数 | 只处理普通缺陷，最多 2 次 |
| `agents` / `routing` | 角色到 adapter 的映射 | Planner、Implementer、Reviewer 分离 |
| `herdr` | Herdr pane、Agent kind 和启动超时 | 仅在 `HERDR_ENV=1` 时启用 |
| `subagents` | 可派发者、角色、嵌套、并发、时长 | 默认禁止，深度最多 1 |

## 一个混合 Agent 配置

```yaml
execution:
  sequential_specs: true
  max_parallel_workers: 2

agents:
  claude: { adapter: claude-code }
  codex: { adapter: codex }
  cursor: { adapter: cursor }
routing:
  planner: claude
  implementer: codex
  reviewer: cursor
  overrides:
    - { role: reviewer, label: security, route: claude }

# 创建 change 时可附加 --label security；覆盖规则按文件顺序取第一条匹配项。
# 将某个 role 的 adapter 改成 herdr，即可在 Herdr 中自动唤起 Agent。
# 不在 Herdr pane 中运行时会安全降级为 Manual Adapter。
herdr:
  kind: { planner: codex, implementer: codex, reviewer: codex }
  direction: right
  start_timeout_ms: 30000

quality:
  auto_repair:
    enabled: true
    max_attempts: 2
    only_for: [implementation_defect, missing_test, regression]
    escalate_for: [ambiguous_requirement, architecture_decision, security_risk]
```

## 不可降级的不变量

runtime 必须拒绝以下配置或执行行为：

- 两个 writer 同时持有同一 spec 的有效 lease；
- Implementer 自行声明 QA 通过或归档；
- 没有 QA 证据就满足要求 QA 的归档条件；
- 子代理超过允许深度，或子代理再次派生任务；
- 超出任务允许路径的写入；
- 在 `decision_required` 状态绕过人工批准继续执行。

这些规则保护的是协议可信度，不属于用户偏好。

`execution.max_parallel_workers` 限制同一 change 的有效 lease 数量；`auto_start_next_ready_spec: true` 时，QA 通过后 runtime 会自动派发下一个已 ready 的 implementer。`routing.overrides` 可按 role 和 change label 选择特殊 adapter，命中规则及最终 route 会写入 history。

当前 runtime 将 subagent 改为 `orchestrator_only`：仅编排器可派发配置允许的只读辅助任务。仍必须保持零 writable paths、深度不超过 1、有限时长，并禁止递归创建。使用 `specflow dispatch-subagent` 派发，结果只写入 handoff，不改变主 change 状态。

## Herdr 主动探查与权限审批

当 role 的 adapter 为 `herdr` 时，runtime 会在当前 Herdr pane 的兄弟 pane 中启动 Agent，并发送统一任务提示词。若 Herdr 未检测到可用环境（`HERDR_ENV != 1`），自动降级为人工交接，不改变任务状态。

Herdr 对后台会话可能懒加载，因此 runtime 提供主动探查：

```bash
specflow monitor <change-id> <task-id>
```

该命令读取 Agent 的实时状态并写入 handoff/runtime 和 change history。需要等待 Agent 进入稳定状态时，在 Herdr 中使用 `herdr agent wait`，再运行 `monitor` 更新审计记录。

如果状态为 `blocked`，先使用 `herdr agent read <agent-name>` 检查具体权限请求或问题。确认请求安全且在任务允许范围内后，显式批准：

```bash
specflow approve-agent <change-id> <task-id> --key enter --confirm
```

`--confirm` 是有意保留的人类审批门；SpecFlow 不会自动回答权限请求，也不会在未确认时向 Agent 注入按键。
