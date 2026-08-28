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

## 手动交接示例

向 Codex 发送：

```text
你是 SpecFlow Implementer。读取 .specflow/changes/<change-id>/handoffs/<task-id>.yaml，
严格遵守其中的 inputs、allowed_paths 和 subagents 规则。完成后创建对应的
<task-id>.result.yaml；不要自行把 spec 标记为 QA 通过、归档或创建 subagent。
```

随后由 runtime（或用户）检查 result，释放 lease，并向配置的 Reviewer adapter 派发 QA 工作单。

## Codex subagent 策略

即使 Codex 具备并行/委派能力，也必须以 `.specflow/config.yaml` 为准。普通 Implementer 与 Reviewer 任务的 `subagents: forbidden` 是硬边界。需要调查时，将任务升级给 orchestrator，由它签发只读 Researcher 工作单。

跨工具场景、lease 与 QA 修复流程见 [混合多个 Agent 工具](multi-agent.md)。
