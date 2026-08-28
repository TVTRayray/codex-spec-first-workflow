# SpecFlow Agent Contract Template

将本文件的内容合并到目标工具的项目指令文件（例如 `AGENTS.md`、`CLAUDE.md` 或 Cursor rules）。项目特定技术栈、测试命令和安全规则应另行补充，不能直接沿用示例。

## 工作流规则

- `.specflow/config.yaml` 是流程策略源；change 的 `state.yaml` 是该 change 的权威状态源；聊天记录不是。
- 只执行当前任务包列出的角色、目标、输入文件与允许路径。
- 不得自行把任务标记为 QA 通过、归档或批准；提交相应报告，交由 runtime 转换状态。
- 默认禁止创建 subagent。只有任务包明确标记为 `role: researcher` 且由 orchestrator 派发时才可作为辅助任务执行。
- 遇到需求歧义、架构取舍、安全风险、权限外修改或阻塞时，写入 result report 并停止。

## 项目特定规则（使用前填写）

- 技术栈：
- 架构边界：
- 测试命令：
- 格式化 / lint 命令：
- 数据、安全与发布约束：
