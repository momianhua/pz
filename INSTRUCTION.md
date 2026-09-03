# 裁判执行说明书

## 1. 全新沙箱环境准备

- 操作系统：Windows 10/11
- 初始依赖：可访问互联网、Windows PowerShell（系统自带）
- 模型：任意已接入模型均可用于调试，GLM5.2 为比赛推荐模型

项目提供私有环境安装器，不需要预装 Node/Python、不需要管理员权限，也不修改系统 PATH：

```powershell
.\setup.cmd
Copy-Item .env.example .env
```

安装结果位于被 Git 忽略的 `.runtime/`：Node `22.23.2`、Python `3.12.10`、OpenCode `1.18.25`、Pi Agent `0.84.4`，以及 `requirements-test.txt` 中的 Office/检索依赖。官方安装包均校验固定 SHA-256，Python 在 PowerShell 支持时额外校验 Authenticode 签名。重复执行 `setup.cmd` 可安全复用缓存。

编辑 `.env`，把 `PI_PROVIDER`、`PI_MODEL`、`OPENCODE_PROVIDER_ID`、`OPENCODE_MODEL_ID` 配置为实际可用的 Provider/Model ID，并按模型服务说明配置对应 API Key。调试阶段可使用任意模型，正式比赛可切换到推荐的 GLM5.2。禁止把真实密钥写入提交包。

若使用 OpenAI 兼容的本地模型，无需编辑用户目录配置，只设置 `LOCAL_MODEL_BASE_URL`、`LOCAL_MODEL_PROVIDER_ID`、`LOCAL_MODEL_ID`、`LOCAL_MODEL_API_KEY`。设置 `OPENCODE_AUTOSTART=true` 后，`start.cmd` 会同时准备 Pi 配置并自动启动 OpenCode Server。

普通自动化评测建议设置 `OPENCODE_PERMISSION_MODE=allow`。测试权限反问时改为 `ask`，并确保评测客户端在阻塞的 `prompt_async` 之外并发监听和回复 `/permission`。

推荐让 `start.cmd` 自动启动 OpenCode Server。如需手工启动，先加载私有环境后运行：

```powershell
$env:PATH = "$PWD\.runtime\node;$PWD\.runtime\npm-global;$env:PATH"
$env:OPENCODE_SERVER_PASSWORD = "评测环境中的本地服务密码"
.\.runtime\npm-global\opencode.cmd serve --hostname 127.0.0.1 --port 4096
```

另一个 PowerShell 中令 `.env` 的 `OPENCODE_SERVER_PASSWORD` 与上面一致。

## 2. 编译与自检

本项目为原生 Node.js ESM，无编译步骤。使用私有 Node 执行：

```powershell
.\test.cmd
```

全部测试通过即完成自检。测试包含官方 Agent 网关接口契约。

## 3. 启动方式

命令行参数优先级高于环境变量。

```powershell
# OpenCode 轮次
.\start.cmd --engine opencode --port 6217 --host localhost

# Pi Agent 轮次（先停止上一轮网关）
.\start.cmd --engine pi --port 6217 --host localhost
```

也可以通过任务书要求的环境变量切换：

```powershell
$env:AGENT_ENGINE = "opencode" # 或 pi
.\start.cmd
```

日志出现 `Agent Gateway engine=<引擎> ... localhost:6217` 表示启动完成。`GET http://localhost:6217/health` 返回 `status=ok` 可作为健康检查。

OpenCode 轮次建议配置 `OPENCODE_AUTOSTART=true`，并确保 4096 端口没有旧的手工 OpenCode 进程。`OPENCODE_PERMISSION_MODE=allow` 会自动处理权限请求且不加入 `/permission` 队列；需要评测权限交互时使用 `ask`。长任务默认允许执行 10 分钟，可通过 `RUN_TIMEOUT_MS` 调整。

模型服务使用标准 Bearer 鉴权时填写 `LOCAL_MODEL_API_KEY` 即可。若要求自定义 Header（例如 `Auth`），设置 `LOCAL_MODEL_AUTH_HEADER=Auth`；Header 值默认复用 `LOCAL_MODEL_API_KEY`，也可通过 `LOCAL_MODEL_AUTH_VALUE` 填写包含前缀的完整值。

## 4. 官方接口执行顺序

1. `POST /session?directory=<工作目录>`，请求体 `{"title":"评测会话"}`。
2. 后台持续连接 `GET /event`（SSE）。
3. 调用 `POST /session/{id}/prompt_async`；`model.providerID/modelID` 会透传给当前引擎，该请求会阻塞至本轮结束并返回 204。
4. 如收到 `question.asked`，通过 `GET /question` 获取并调用 `POST /question/{id}/reply`。
5. 如收到 `permission.asked`，通过 `GET /permission` 获取并调用 `POST /permission/{id}/reply`。
6. 收到 `session.status=idle`、`session.idle` 或 `session.error` 后，可用 `GET /session/{id}/message` 获取完整轨迹。

示例请求：

```powershell
$session = Invoke-RestMethod -Method Post -Uri "http://localhost:6217/session?directory=$([uri]::EscapeDataString((Get-Location).Path))" -ContentType "application/json" -Body '{"title":"评测会话"}'
$body = '{"parts":[{"type":"text","text":"请完成评测任务"}],"model":{"providerID":"<Provider ID>","modelID":"<Model ID>"},"agent":"assistant"}'
Invoke-WebRequest -Method Post -Uri "http://localhost:6217/session/$($session.id)/prompt_async" -ContentType "application/json" -Body $body
Invoke-RestMethod "http://localhost:6217/session/$($session.id)/message"
```

## 5. 执行完成判定

- `prompt_async` 返回 HTTP 204；并且
- SSE 收到 `session.status` 的 `idle` 或 `session.idle`；并且
- 最后一条消息是 `assistant`，`info.finish=stop`，`parts` 包含 `step-finish`。

遇到异常时 SSE 推送 `session.error`，HTTP 使用 `{code,message}` 标准错误结构。中止接口为 `POST /session/{id}/abort`，兼容路径为 `/stop`。

## 6. 结果交付件

- 完整交互消息：`GET /session/{id}/message`
- 实时 Rollout 事件：`GET /event`
- 会话状态：`GET /session/status`
- 本地会话映射（运行时生成，可选）：`data/state.json`

网页展示界面位于 `http://localhost:6217/`。它直接使用官方评测接口，因此页面创建的 Session ID、消息、状态、反问和权限申请都可通过对应评测接口查询；页面本身不影响自动评测。
