# Codex Adapter 操作手册

Codex 是 SpecFlow 的一个执行端，不再被假定为整个工作流的唯一承载者。

## 接入

1. 将项目的 [Agent Contract](../02-project-template/AGENT.md) 合并到 `AGENTS.md`。
2. 在 `.specflow/config.yaml` 注册 adapter：

```yaml
agents:
  codex:
    adapter: codex
routing:
  implementer: codex
```

3. 为每个工作单生成 Codex 提示词：角色、`handoff.yaml` 路径、输入工件、允许路径、测试命令与明确的 subagent 策略必须同时出现。

如果当前 runtime 在 Herdr pane 中，可将对应 role 路由到 `herdr`；runtime 会创建兄弟 pane，等待 Agent 进入 `idle` 后再发送提示词。Herdr 未提供可用环境或启动失败时，会回退到手动交接。

## 手动交接示例

向 Codex 发送：

```text
你是 SpecFlow Implementer。读取 .specflow/changes/<change-id>/handoffs/<task-id>.yaml，
严格遵守其中的 inputs、allowed_paths 和 subagents 规则。完成后创建对应的
<task-id>.result.yaml；不要自行把 spec 标记为 QA 通过、归档或创建 subagent。
```

随后由 runtime（或用户）检查 result，释放 lease，并向配置的 Reviewer adapter 派发 QA 工作单。

若所有 spec 已通过 QA、change 正待归档批准，但某个已通过的 spec 需要再修复，operator 明确确认并说明原因：

```bash
specflow reopen-qa <change-id> --spec <spec-id> --reason "发现回归" --confirm
specflow dispatch <change-id> implementer --spec <spec-id>
```

重开要求没有任何 lease；旧 QA 文件和审计历史不删除，原 `qa_report` 指针清空，修复次数不重置。Implementer 完成后照常导入结果、派发 Reviewer 并重新 QA；不自动批准权限或归档。

## Codex subagent 策略

即使 Codex 具备并行/委派能力，也必须以 `.specflow/config.yaml` 为准。普通 Implementer 与 Reviewer 任务的 `subagents: forbidden` 是硬边界。需要调查时，由 orchestrator 签发只读辅助工作单：

```bash
specflow dispatch-subagent <change-id> codebase_researcher --task "分析现有调用关系"
specflow prompt <change-id> <subagent-task-id>
```

Subagent 的 `allowed_paths` 必须为空、不可递归创建 Agent，并受 role 白名单、并发上限和 lease 时长限制。结果导入后只写入 handoff/history，不推进主 change。

跨工具场景、lease 与 QA 修复流程见 [混合多个 Agent 工具](multi-agent.md)。
