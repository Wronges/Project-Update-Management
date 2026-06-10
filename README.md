# Project Update Management

面向自托管 Docker 服务的项目更新控制台。它负责发现镜像更新、执行受控更新、记录更新历史，并提供统一的 Web 管理界面。

## 当前能力

- 从项目清单读取 Docker Compose 部署信息
- 检查容器运行状态和镜像差异
- 通过白名单参数执行镜像拉取与容器重建
- 使用 SQLite 保存更新任务及日志
- 提供项目总览、筛选、批量更新和更新历史界面

## 本地启动

```powershell
npm.cmd install
npm.cmd run dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:8787`

复制 `.env.example` 为 `.env` 后，可调整监听地址、项目清单和数据库路径。

## 部署原则

服务应部署在 Docker 主机本机，或由后续 Agent 部署在每台被管理服务器上。API 不接受任意 Shell 命令，只执行项目清单中已登记的 Docker Compose 操作。

## 生产部署

先生成管理员令牌并写入 `.env`：

```powershell
$token = [Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
"PUM_ADMIN_TOKEN=$token" | Set-Content .env
```

然后启动：

```powershell
docker compose -f docker-compose.production.yml up -d --build
```

服务默认只监听 `127.0.0.1:8787`。公网访问必须通过反向代理，并建议在反向代理层继续启用登录认证。

生产容器只读挂载宿主机 `/opt`，用于读取各项目的 Compose 配置；Docker 操作通过 `/var/run/docker.sock` 执行。容器使用 host 网络但应用仅监听 `127.0.0.1:8787`，以便健康检查访问同样仅绑定宿主机回环地址的服务。网页写操作还需要 `PUM_ADMIN_TOKEN`。

更新后健康检查失败时默认自动把镜像标签恢复到更新前的镜像 ID 并重建服务。可通过 `PUM_ROLLBACK_ON_FAILURE=false` 关闭；“今日已更新”默认按 `PUM_TIME_ZONE=Asia/Shanghai` 统计。

公网接入示例位于 `deploy/nginx/`。管理页面应至少启用 HTTPS 和 Basic Auth，应用层写操作仍由 `PUM_ADMIN_TOKEN` 二次保护。

## 更新策略

- `image`：允许平台拉取镜像并强制重建 Compose 服务。
- `manual`：只展示项目状态，禁用通用更新按钮。适用于有本地补丁或源码构建流程的项目。
