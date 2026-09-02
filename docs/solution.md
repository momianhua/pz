# 解题思路

## 1. 问题拆解

赛题要求同时满足两个方向的稳定性：业务侧的群助手、权限和网关接口持续演进；执行侧的 Agent Harness 快速变化。若业务代码直接调用具体引擎 SDK，新增引擎会把 session、流式事件、错误和工具语义的差异扩散到业务层。

本方案使用反腐适配层把变化收敛在 Engine Adapter 内。业务系统只认识统一请求、统一事件和网关逻辑会话。

## 2. 统一模型

统一请求包含：租户、业务会话、用户输入、目标引擎和允许使用的引擎集合。统一事件包含：

- `run.started`
- `message.delta`
- `reasoning.delta`
- `tool.started`
- `tool.completed`
- `permission.requested`
- `message.completed`
- `run.completed`
- `run.warning`

Pi 的 `message_update` 和 OpenCode 的 `message.part.delta` 均映射为 `message.delta`，前端和业务系统不需要理解原生事件。

## 3. 会话连续性与隔离

网关使用 `(tenantId, conversationId)` 作为业务隔离键，生成与具体引擎无关的 `logicalSessionId`。每个逻辑会话保存多个引擎绑定。

首次切换到新引擎时，网关创建新的原生 session，并将标准消息历史作为迁移上下文注入。切回旧引擎时复用原绑定，因此既能保持业务会话不变，也不会把两个引擎的私有状态混在一起。

同一业务会话内的运行通过 keyed lock 串行化，避免并发创建重复原生 session；不同会话可以并行执行。

## 4. 权限边界

`allowedEngines` 在网关层强制校验，证明权限不是 Prompt 文本。生产接入时，同一位置可进一步校验工具 allowlist、工作目录、网络能力和审批策略。

底层引擎不直接暴露给业务调用方，OpenCode 的 Server 凭据以及 Pi 的进程均由网关持有。

## 5. 可评测性

默认 mock 模式保留两种传输语义和统一事件，可在无模型账号环境下复现切换流程。真实模式启用 Pi RPC 与 OpenCode HTTP/SSE 适配器。契约测试对网关语义进行验证，协议单测则验证原生事件映射。

## 6. 扩展第三个引擎

接入新引擎时：

1. 新建一个 Adapter；
2. 声明 metadata 与 capability；
3. 实现 session 生命周期；
4. 将原生流转换成统一事件；
5. 注册到 `createApp()`；
6. 复用现有契约测试。

业务接口、聊天 UI、路由与会话存储均无需修改。
