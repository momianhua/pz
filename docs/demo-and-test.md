# 测试报告与录屏脚本

验证环境：Windows、Node.js 22、OpenCode `1.18.25`、Pi `0.84.4`。真实健康检查、OpenCode session 与 Pi RPC 均已通过。调试模型可自由配置，比赛时可切换到推荐的 GLM5.2；测试报告和提交包不记录任何 provider 凭据。

## 自动测试

执行：

```bash
npm test
```

当前契约覆盖：

| 测试项 | 验证点 |
|---|---|
| 同群连续对话 | 复用 Pi 原生 session，轮次连续 |
| 会话级切换 | logicalSessionId 不变，新增 OpenCode 绑定 |
| 历史迁移 | 新引擎首次执行收到标准消息历史 |
| 跨群隔离 | 逻辑 session 与原生 session 均不同 |
| 权限限制 | 未在 allowlist 的引擎返回 403 |
| 兼容接口 | OpenAI Chat Completions 入口可用 |
| Pi 协议 | 严格 LF JSONL，不误切 Unicode 分隔符 |
| 事件标准化 | Pi 与 OpenCode delta 映射为同一事件 |
| OpenCode 协议 | 支持 SSE、多行 data、session 过滤与最终响应兜底 |

## 6 分钟录屏脚本

### 0:00–0:40 赛题痛点

说明业务网关需要稳定，而 Agent Harness 的 session、协议和工具事件差异很大。作品目标是新增引擎只增加 Adapter。

### 0:40–1:30 架构

展示 README 架构图，重点说明稳定网关协议、逻辑会话、一对多引擎绑定和统一事件模型。

### 1:30–3:20 聊天演示

1. 启动 `npm start`；
2. 打开聊天页；
3. 在 `group-alpha` 用 Pi 发送第一条消息；
4. 打开事件流展示 Pi 原生路径已被标准化；
5. 选择 OpenCode 并点击切换；
6. 继续对话，展示逻辑会话不变、两套绑定共存和历史迁移提示。

### 3:20–4:10 隔离与权限

更换为 `group-beta`，证明创建新的逻辑会话。随后用接口提交 `allowedEngines:["pi"]` 却指定 OpenCode，展示网关返回 `ENGINE_FORBIDDEN`。

### 4:10–5:10 代码结构

展示 `src/adapters`：Pi 是 JSONL/RPC 子进程，OpenCode 是 HTTP/OpenAPI + SSE；二者都实现相同 SPI。展示 controller 与 Adapter 没有业务耦合。

### 5:10–5:50 测试证据

运行 `npm test`，说明契约测试可直接复用于第三个引擎。

### 5:50–6:00 总结

“业务接口未变；同群连续、跨群隔离；Pi 与 OpenCode 可切换；新增引擎只实现 Adapter 并通过契约测试。”

## 建议保留的交互证据

- 聊天页面完整录屏；
- 事件抽屉截图；
- 会话路由侧栏截图；
- `npm test` 完整输出；
- real 模式下 Pi 与 OpenCode 各一次健康检查和真实回复；
- 日志脱敏，不记录 API key 或内部业务数据。
