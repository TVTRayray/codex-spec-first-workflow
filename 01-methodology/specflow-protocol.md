# SpecFlow Protocol v0.1

## 边界

协议定义工件、状态、权限与交接格式；它不定义某个工具如何启动会话。Codex、Claude Code、Cursor 等平台通过 adapter 使用同一协议。没有 adapter 时也必须能生成可复制的人工交接包。

## 事实源

| 工件 | 责任 | 可写角色 |
| --- | --- | --- |
| `.specflow/system-specs/` | 当前已实现行为 | archive runtime |
| `changes/<id>/proposal.md` | 为什么做、范围与非目标 | planner |
| `changes/<id>/specs/` | 本次变更的 Delta Spec | planner；经控制的 implementer 更新 |
| `changes/<id>/tasks.md` | 可执行任务与完成状态 | planner、implementer |
| `changes/<id>/reviews/` | QA 证据与结论 | reviewer |
| `changes/<id>/state.yaml` | change 状态、租约、尝试次数 | runtime |

项目级 `.specflow/state.yaml` 只是 active changes、运行模式和最近事件的**派生索引**；单个 change 的 `state.yaml` 才是该 change 的权威状态。发生不一致时，以 change state 为准并重建项目索引。

Agent 不得仅凭聊天结论改变状态；必须提交协议工件，runtime 验证后才能转换状态。

## Change 工件依赖

```text
proposal → delta specs → design / tasks → implementation → QA → archive
                  ↑                 │          │           │
                  └─────────────────┴──────────┴───────────┘
                             实施发现可回写并重新验证
```

`proposal` 解释 why/what；Delta Spec 表达行为变化与场景；`design` 解释技术取舍；`tasks` 是实施清单。并非每个小变更都必须有独立 design，但配置必须明确允许省略它。

## 设计维度

产品设计（视觉/体验）与架构设计同权，遵循以下规则：

1. **Design Impact 申报**：每个 change 的 `proposal.md` 必须声明 Design Impact：
   `none`（无视觉影响，声明即可）、`visual`（界面调整）、`design_system`（修改宪章/tokens）。
2. **证据前置**：Design Impact ≠ `none` 时，实施前必须存在 `ux-design.md`（或 design.md 的 UX 节）
   与视觉证据（参考 mockup/截图路径）；缺失时不得派发实现任务。
3. **宪章即需求**：`docs/design/design-charter.md` 是项目的设计 PRD。
   `design_system` 档的变更必须附带宪章变更说明，升级给人审批。
4. **设计需求进 Delta Spec**：视觉/体验约束写成 MUST 需求（如"按钮对比度 ≥ 4.5:1"），
   归档时合并进 `system-specs/design-system.md` 域，与行为需求同生命周期。
5. **QA 视觉验收**：Design Impact ≠ `none` 的 change，QA 必须执行 `docs/design/visual-qa-checklist.md`
   并写入 QA Report 的 Design Conformance 节；finding 分类含
   `visual_defect` / `design_conformance` / `accessibility` / `visual_regression`。

## 任务包与交接

每次角色执行由 `handoffs/<task-id>.yaml` 描述，至少含：角色、目标 spec、输入文件、允许路径、预期产物、测试命令、租约 ID、下一步。adapter 只转换任务包，不改变其语义。

执行者完成后写 `handoffs/<task-id>.result.yaml`：

- `outcome`: `completed`、`blocked` 或 `needs_decision`
- 修改摘要与证据路径；Implementer 的 `completed` 必须提供 `changed_files`
- 测试命令与结果；Implementer 的 `completed` 必须提供 `test_results`
- 未解决问题

## 权限与租约

- 每个可写 spec 必须有未过期的 task lease；同一目标同时最多一名 writer。
- Reviewer 默认只写 review；Researcher 始终只读。
- runtime 是唯一能创建/释放 lease、推进状态和归档的主体。
- 发生中断时，lease 到期后才可重新派发，并保留旧交接记录；runtime 必须恢复 lease 创建前的 spec/change 状态，拒绝过期 lease 的迟到结果。

### 无自动 runtime 的手动模式

手动模式不是允许任意编辑状态。用户指定一名 `operator_runtime`（通常是人）代行 runtime：它使用检查清单验证前置工件和 result report，记录 history，随后才更新 state/lease。普通 Planner、Implementer、Reviewer 仍不得编辑状态。手动模式的交接包必须保存为 `handoffs/<task-id>.yaml`，结果保存为 `handoffs/<task-id>.result.yaml`；QA 工件保存为 `reviews/<task-id>.md`。

## 跨 Agent 执行模式

1. **手动交接**：`operator_runtime` 写出任务包；用户在目标工具粘贴 adapter 生成的提示词，再导入结果。
2. **半自动交接**：用户选择目标 adapter；runtime 创建上下文与命令。
3. **全自动交接**：adapter 能可靠启动工具、收集结果并回传 runtime。

### Herdr adapter

当配置将 role 路由到 `herdr` 且 runtime 运行在 `HERDR_ENV=1` 的 Herdr pane 中时，adapter 可以创建兄弟 pane、主动启动受支持的 Agent，并发送任务包提示词。Herdr 不可用或启动失败时必须降级为 Manual Adapter，不能阻断协议状态流转。

由于 Herdr 对后台会话和权限界面可能懒加载，adapter 必须提供主动探查/监控，并把 Agent 状态写入 handoff 和 history。`blocked` 状态只表示需要人工检查；权限批准必须经过明确的人类确认后才能注入按键，adapter 不得自动批准未知命令或权限请求。

三种模式的工件、状态机与安全规则完全相同。
