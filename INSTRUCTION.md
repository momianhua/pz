# 裁判执行说明书

## 1. 环境准备

- 系统：64 位 Windows 10/11
- 网络：首次安装依赖和访问模型服务时可联网
- 初始依赖：Windows PowerShell（无需预装 Node.js、Python、Pi、OpenCode，无需管理员权限）

解压 `solution.zip` 后进入 `code/`（直接使用源码仓库时进入仓库根目录），执行：

```powershell
.\setup.cmd
Copy-Item .env.example .env
```

`setup.cmd` 将固定版本的 Node.js、Python、Pi、OpenCode 和 Office 测试依赖安装到 `.runtime/`，不修改系统 PATH。再次执行会复用已有环境。本项目为原生 Node.js ESM，无编译步骤。

## 2. 模型配置

编辑 `.env`。OpenAI 兼容模型的最小真实运行配置如下：

```dotenv
ENGINE_MODE=real
AGENT_ENGINE=opencode

LOCAL_MODEL_BASE_URL=http://<模型服务IP>:<端口>/v1
LOCAL_MODEL_PROVIDER_ID=<Provider ID>
LOCAL_MODEL_ID=<评测模型ID>
LOCAL_MODEL_API_KEY=<API Key>

OPENCODE_AUTOSTART=true
OPENCODE_PERMISSION_MODE=allow
RUN_TIMEOUT_MS=600000
```

正式评测时将 `LOCAL_MODEL_ID` 配置为赛题指定的 GLM5.2 实际模型 ID。`PI_PROVIDER/PI_MODEL` 和 `OPENCODE_PROVIDER_ID/OPENCODE_MODEL_ID` 留空即可继承统一模型配置。

如模型使用自定义鉴权头，再配置：

```dotenv
LOCAL_MODEL_AUTH_HEADER=Auth
LOCAL_MODEL_AUTH_VALUE=<Header 完整值>
```

模型部署在沙箱外时，`LOCAL_MODEL_BASE_URL` 必须填写沙箱可访问的宿主机 IP，不能填写沙箱自身的 `127.0.0.1`。

## 3. 自检与启动

执行全部契约测试：

```powershell
.\test.cmd
```

每个引擎单独启动和评测。启动 OpenCode：

```powershell
$env:AGENT_ENGINE = "opencode"
.\start.cmd
```

启动 Pi：

```powershell
$env:AGENT_ENGINE = "pi"
.\start.cmd
```

也可直接使用参数：

```powershell
.\start.cmd --engine opencode --host localhost --port 6217
.\start.cmd --engine pi --host localhost --port 6217
```

切换引擎前先按 `Ctrl+C` 停止上一轮。出现以下日志即启动成功：

```text
Agent Gateway engine=<pi|opencode> mode=real listening on http://localhost:6217
```

健康检查：

```powershell
Invoke-RestMethod http://localhost:6217/health
Invoke-RestMethod http://localhost:6217/api/engines
```

`/health` 应返回 `status: ok`，当前引擎应为 `healthy`。

## 4. 评测接口调用顺序

1. 创建会话：`POST /session?directory=<受控工作目录>`。
2. 后台连接 `GET /event`，记录完整 SSE Rollout。
3. 发送任务：`POST /session/{id}/prompt_async`。
4. 等待接口返回 HTTP 204，并等待会话变为 `idle`。
5. 查询结果：`GET /session/{id}/message`。

PowerShell 最小示例：

```powershell
$base = "http://localhost:6217"
$workdir = [uri]::EscapeDataString((Get-Location).Path)
$session = Invoke-RestMethod -Method Post -Uri "$base/session?directory=$workdir" -ContentType "application/json" -Body '{"title":"评测会话"}'

$request = @{
  parts = @(@{ type = "text"; text = "请完成评测任务" })
  model = @{ providerID = "<Provider ID>"; modelID = "<评测模型ID>" }
  agent = "assistant"
} | ConvertTo-Json -Depth 5

Invoke-WebRequest -Method Post -Uri "$base/session/$($session.id)/prompt_async" -ContentType "application/json" -Body $request
Invoke-RestMethod "$base/session/$($session.id)/message"
```

无人值守评测保持 `OPENCODE_PERMISSION_MODE=allow`。需要测试交互时：

- 反问：`GET /question`，然后 `POST /question/{requestId}/reply`，Body 为 `{"answers":[["回答"]]}`。
- 权限：`GET /permission`，然后 `POST /permission/{requestId}/reply`，Body 为 `{"reply":"once"}`；`reply` 可取 `once`、`always`、`reject`。
- 中止：`POST /session/{id}/abort`，兼容路径为 `/stop`。

## 5. 完成判定

一次任务完成需同时满足：

1. `prompt_async` 返回 HTTP 204；
2. `GET /session/status` 或 SSE 显示会话为 `idle`；
3. `GET /session/{id}/message` 最后一条为 `assistant`，且 `info.finish=stop`、`parts` 包含 `step-finish`；
4. 文件类任务在创建会话时指定的工作目录生成目标文件。

失败时 SSE 会产生 `session.error`，HTTP 返回 `{code,message}`。

## 6. 结果交付件

- 完整交互记录：`GET /session/{id}/message`
- 实时 Rollout：`GET /event`
- 会话状态：`GET /session/status`
- 任务生成文件：创建会话时指定的 `directory`
- 会话映射：`data/state.json`
- 测试集报告：`test_runs/<时间>-<引擎>/REPORT.md` 和 `results.json`

内置测试集可分别执行：

```powershell
.\test-data.cmd --engine opencode
.\test-data.cmd --engine pi
```

网页调测界面：<http://localhost:6217/>。页面直接调用上述评测接口，页面会话和消息可由接口原样查询。
