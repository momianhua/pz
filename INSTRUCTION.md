# 裁判执行说明书

## 1. 环境准备

### 环境需Node.js >= v22.19.0, python >= 3.12.10
- 系统：64 位 Windows 10/11
- 网络：首次安装依赖和访问模型服务时可联网
- 初始依赖：Windows PowerShell（无需预装 Node.js、Python、Pi、OpenCode，无需管理员权限）

如果已有对应环境，则执行：
npm install -g @earendil-works/pi-coding-agent@0.84.4
npm install -g opencode-ai@1.18.25

如果没有对应环境，已连接外网可直接下载环境，则执行：
```powershell
.\setup.cmd
```

`setup.cmd` 会将固定版本的 Node.js、Python、Pi、OpenCode 和 Office 测试依赖安装到 `.runtime/`，不修改系统 PATH。再次执行会复用已有环境。本项目为原生 Node.js ESM，无编译步骤。

## 2. 模型配置

编辑 `.env`。OpenAI 兼容模型的最小真实运行配置如下：

```dotenv
// 真实环境
ENGINE_MODE=real
// 默认启动模式，也可用命令行指定
AGENT_ENGINE=opencode

// 模型服务地址
LOCAL_MODEL_BASE_URL=http://<模型服务IP>:<端口>/v1
// Provider ID，无填写要求，固定值即可，例如：local-8017
LOCAL_MODEL_PROVIDER_ID=<Provider ID>
// 模型名称，连接时需填写的模型名称，例如：GLM-V5_1-DX
LOCAL_MODEL_ID=<评测模型ID>
// 请求头Authorization的值，用于鉴权
LOCAL_MODEL_API_KEY=<API Key>

// 为true则opencode会自动使用同一个模型启动服务
OPENCODE_AUTOSTART=true
// opencode权限申请，allow为全部同意，ask为询问
OPENCODE_PERMISSION_MODE=allow
// 会话超时时间，发送消息时未返回结果，最多等待的时间
RUN_TIMEOUT_MS=600000
```

正式评测使用赛事提供或允许的内部部署模型，并将其实际 ID 配置到 `LOCAL_MODEL_ID`。`PI_PROVIDER/PI_MODEL` 和 `OPENCODE_PROVIDER_ID/OPENCODE_MODEL_ID` 留空即可继承统一模型配置。

如模型使用自定义鉴权头，再配置：

```dotenv
LOCAL_MODEL_AUTH_HEADER=Auth
LOCAL_MODEL_AUTH_VALUE=<Header 完整值>
```

模型部署在沙箱外时，`LOCAL_MODEL_BASE_URL` 必须填写沙箱可访问的宿主机 IP，不能填写沙箱自身的 `127.0.0.1`。

## 3. 启动服务

3.1 如果已有对应环境（未使用setup.cwd），则使用：
npm start --engine opencode
或者 npm start --engine opencode --host localhost --port 6217
启动服务并指定引擎

3.2 如果执行过setup.cwd安装环境，则使用：
.\start.cmd --engine pi
或者 .\start.cmd --engine pi --host localhost --port 6217
启动服务并指定引擎


切换引擎前先按 `Ctrl+C` 停止上一轮。出现以下日志即启动成功：

```text
Agent Gateway engine=<pi|opencode> mode=real listening on http://localhost:6217
```

健康检查：

```powershell
Invoke-RestMethod http://localhost:6217/health
Invoke-RestMethod http://localhost:6217/api/engines
```

`/health` 应返回 `status: ok`。

## 4. 结果交付件

- 完整交互记录：`GET /session/{id}/message`
- 实时 Rollout：`GET /event`
- 会话状态：`GET /session/status`
- 任务生成文件：创建会话时指定的 `directory`
- 会话映射：`data/state.json`
- 测试集报告：`test_runs/<时间>-<引擎>/REPORT.md` 和 `results.json`


网页调测界面：<http://localhost:6217/>。页面直接调用上述评测接口，页面会话和消息可由接口原样查询。
