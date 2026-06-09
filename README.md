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

