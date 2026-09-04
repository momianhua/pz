# 裁判执行说明书

## 1. 环境准备

### 环境需Node.js >= v22.19.0, python >= 3.12.10
- 系统：64 位 Windows 10/11
- 网络：首次安装依赖和访问模型服务时可联网
- 初始依赖：Windows PowerShell（无需预装 Node.js、Python、Pi、OpenCode，无需管理员权限）

依赖安装：
在solution/code源代码目录下执行：
```cwd
.\setup.cmd
```

这是唯一的环境准备命令：它优先复用满足要求的现有 Node.js、Python、Pi 和 OpenCode；缺少时自动将固定版本安装到 `.runtime/`；同时检查并安装 Office 测试依赖，它不修改系统 PATH，重复执行安全且会复用已有环境。本项目为原生 Node.js ESM，无编译步骤。

无公网时，可将 `node-v22.23.2-win-x64.zip` 和 `python-3.12.10-amd64.exe` 放入同一内网目录，并在执行前配置：

```powershell
$env:RUNTIME_PACKAGE_DIR = "D:\packages"
$env:NPM_CONFIG_REGISTRY = "http://<内网NPM源>"
$env:PIP_INDEX_URL = "http://<内网PyPI源>/simple"
.\setup.cmd
```

也可通过 `NODE_DOWNLOAD_BASE_URL` 和 `PYTHON_DOWNLOAD_BASE_URL` 指定内网下载根地址。所有 Node/Python 安装包仍执行固定 SHA-256 校验。

## 2. 模型配置

编辑 `.env`。OpenAI 兼容模型的最小真实运行配置如下：

```dotenv
# 模型服务地址
LOCAL_MODEL_BASE_URL=http://aigateway.huawei.com/v1
# 模型名称，连接时需填写的模型名称
LOCAL_MODEL_ID=GLM-V5_1-DX
# API Key；标准鉴权会自动生成 Authorization: Bearer <API Key>
LOCAL_MODEL_API_KEY=sk-7xxxxxxxx
# 会话超时时间，发送消息时未返回结果，最多等待的时间
RUN_TIMEOUT_MS=600000
```

如模型使用自定义鉴权头，再配置：

```dotenv
LOCAL_MODEL_AUTH_HEADER=Auth
LOCAL_MODEL_AUTH_VALUE=<Header 完整值>
```

模型部署在沙箱外时，`LOCAL_MODEL_BASE_URL` 必须填写沙箱可访问的宿主机 IP，不能填写沙箱自身的 `127.0.0.1`。

## 3. 启动服务

环境准备完成后统一使用 `gateway.cmd`，无需区分系统环境和项目私有环境。

```powershell
$env:AGENT_ENGINE = "opencode"
.\gateway.cmd
```

启动 Pi：

```powershell
$env:AGENT_ENGINE = "pi"
.\gateway.cmd
```

也可直接使用参数：

```cwd
.\gateway.cmd --engine opencode --host localhost --port 6217
```
或者
```cwd
.\gateway.cmd --engine pi --host localhost --port 6217
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

`/health` 应返回 `status: ok`。

## 4. 结果交付件

- 完整交互记录：`GET /session/{id}/message`
- 实时 Rollout：`GET /event`
- 会话状态：`GET /session/status`
- 任务生成文件：创建会话时指定的 `directory`
- 会话映射：`data/state.json`
- 测试集报告：`test_runs/<时间>-<引擎>/REPORT.md` 和 `results.json`


网页调测界面：<http://localhost:6217/>。页面直接调用上述评测接口，页面会话和消息可由接口原样查询。
