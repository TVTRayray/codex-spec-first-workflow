# Change State Machine

## 默认状态

```text
draft → planning → awaiting_plan_approval → ready
     → implementing ⇄ reviewing ⇄ repairing
     → awaiting_archive_approval → archived
                         ↘ blocked / decision_required / cancelled
```

`ready` 中 runtime 选择依赖已满足的下一个 spec；`repairing` 只能处理最新 QA 报告列出的问题。`decision_required` 在人类记录决定后，依据决定回到 `planning`、`ready`、`repairing`，或转为 `cancelled`。

每个 spec 另有局部状态：`todo → ready → implementing → reviewing → qa_passed`；QA `repair` 时进入 `repairing`，修复完成后回到 `reviewing`。`blocked` 可以从任何非终态进入，解除后回到阻塞前状态。只有所有 spec 均为 `qa_passed` 时，change 才能申请归档。

## 转换规则

| 当前状态 | 允许转换 | 触发者 / 条件 |
| --- | --- | --- |
| `draft` | `planning` / `cancelled` | runtime 创建 change / 人工取消 |
| `draft` / `planning` | `awaiting_plan_approval` | 所需规划工件通过格式校验 |
| `awaiting_plan_approval` | `ready` | 人工批准 |
| `ready` | `implementing` | runtime 创建 implementer lease |
| `implementing` | `reviewing` | completion report 和测试证据齐全 |
| `reviewing` | `ready` | QA 通过；若所有 spec 已通过，runtime 随即申请归档 |
| `reviewing` | `repairing` | QA 的 repair 结论符合自动修复策略 |
| `reviewing` | `decision_required` | 需求歧义、架构/安全风险，或超出重试上限 |
| `repairing` | `reviewing` | 修复报告和测试证据齐全 |
| `ready` | `awaiting_archive_approval` | 全部 spec 达到 QA passed，汇总验证通过 |
| `awaiting_archive_approval` | `archived` | 人工批准并完成 Delta 合并 |
| 任一非终态 | `blocked` / `decision_required` / `cancelled` | 阻塞、升级或人工取消；记录原因与前一状态 |
| `blocked` | 阻塞前状态 | 阻塞已解除且 runtime 验证证据 |
| `decision_required` | `planning` / `ready` / `repairing` / `cancelled` | 人工记录决定和理由 |

## 默认升级策略

普通实现缺陷、缺失测试或回归允许自动修复两次。`qa_attempts` 按**单个 spec**记录已经派发的修复次数：收到 QA `repair` 时，若 `qa_attempts < max_attempts`，runtime 将计数加一并进入 `repairing`；否则生成 `repeated_failure` 并进入 `decision_required`。因此 `max_attempts: 2` 恰好允许两次完整的修复→复审循环。以下情况立即升级：`requirements_conflict`、`ambiguous_requirement`、`architecture_decision`、`security_risk`、`data_migration`、`permission_insufficient`。具体值由 `config.yaml` 覆盖。
