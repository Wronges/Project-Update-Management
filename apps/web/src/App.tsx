import {
  Activity,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cpu,
  ExternalLink,
  HardDrive,
  History,
  LayoutDashboard,
  LoaderCircle,
  MemoryStick,
  RefreshCw,
  Search,
  Server,
  Settings,
  X
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import type {
  DashboardSummary,
  ProjectStatus,
  ServerStatusPayload,
  UpdateTask
} from "@pum/shared";

interface DashboardPayload {
  summary: DashboardSummary;
  projects: ProjectStatus[];
  recentTasks: UpdateTask[];
}

const emptySummary: DashboardSummary = {
  projectCount: 0,
  updateAvailableCount: 0,
  runningCount: 0,
  failedCount: 0,
  updatedTodayCount: 0
};

export function App() {
  const [activeView, setActiveView] = useState<"projects" | "server">("projects");
  const [dashboard, setDashboard] = useState<DashboardPayload>({
    summary: emptySummary,
    projects: [],
    recentTasks: []
  });
  const [serverStatus, setServerStatus] = useState<ServerStatusPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyUpdates, setOnlyUpdates] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useEffectEvent(async () => {
    try {
      const response = await fetch("/api/dashboard");
      if (!response.ok) throw new Error("无法读取项目状态");
      setDashboard(await response.json());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  });

  const loadServerStatus = useEffectEvent(async () => {
    try {
      const response = await fetch("/api/server-status");
      if (!response.ok) throw new Error("无法读取服务器状态");
      setServerStatus(await response.json());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  });

  const refreshActiveView = useEffectEvent(async () => {
    setLoading(true);
    if (activeView === "server") {
      await loadServerStatus();
      return;
    }
    await loadDashboard();
  });

  useEffect(() => {
    void refreshActiveView();
    const timer = window.setInterval(() => void refreshActiveView(), 5000);
    return () => window.clearInterval(timer);
  }, [activeView]);

  const selected =
    dashboard.projects.find((project) => project.id === selectedId) ?? null;
  const visibleProjects = dashboard.projects.filter((project) => {
    const matchesQuery = `${project.name} ${project.containerName}`
      .toLowerCase()
      .includes(query.toLowerCase());
    const matchesUpdate =
      !onlyUpdates || project.updateStatus === "update_available";
    return matchesQuery && matchesUpdate;
  });

  async function runAction(projectId: string, action: "check" | "update") {
    let token = window.sessionStorage.getItem("pum-admin-token") ?? "";
    if (!token) {
      token = window.prompt("请输入管理员令牌")?.trim() ?? "";
      if (!token) return;
      window.sessionStorage.setItem("pum-admin-token", token);
    }
    setActionId(projectId);
    try {
      const response = await fetch(`/api/projects/${projectId}/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pum-token": token
        },
        body: "{}"
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? "任务创建失败");
      }
      await loadDashboard();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionId(null);
    }
  }

  async function updateSelected() {
    const ids = visibleProjects
      .filter((project) => project.updateStatus === "update_available")
      .map((project) => project.id);
    for (const id of ids) {
      await runAction(id, "update");
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>项目更新中心</h1>
          <p>Docker 服务版本与更新任务控制台</p>
        </div>
        <div className="topbar-actions">
          <button className="server-select">
            <Server size={16} />
            主服务器
            <ChevronRight size={15} />
          </button>
          <button className="button secondary" onClick={() => void refreshActiveView()}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            刷新
          </button>
          {activeView === "projects" && (
            <>
              <button className="button primary" onClick={() => void updateSelected()}>
                <Boxes size={16} />
                更新全部可更新项
              </button>
              <label className="search">
                <Search size={16} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索项目名 / 容器名"
                />
              </label>
            </>
          )}
        </div>
      </header>

      <aside className="sidebar">
        <NavItem icon={<LayoutDashboard size={18} />} label="总览" disabled />
        <NavItem
          icon={<Boxes size={18} />}
          label="项目更新"
          active={activeView === "projects"}
          onClick={() => {
            setSelectedId(null);
            setActiveView("projects");
          }}
        />
        <NavItem icon={<History size={18} />} label="更新历史" disabled />
        <NavItem
          icon={<Activity size={18} />}
          label="服务器状态"
          active={activeView === "server"}
          onClick={() => {
            setSelectedId(null);
            setActiveView("server");
          }}
        />
        <NavItem icon={<Settings size={18} />} label="设置" disabled />
      </aside>

      <main className="main">
        {error && <div className="error-banner">{error}</div>}
        {activeView === "projects" ? (
          <>
        <section className="summary-grid">
          <SummaryCard label="项目总数" value={dashboard.summary.projectCount} />
          <SummaryCard
            label="需要更新"
            value={dashboard.summary.updateAvailableCount}
            tone="warning"
          />
          <SummaryCard
            label="正在运行"
            value={dashboard.summary.runningCount}
            tone="success"
          />
          <SummaryCard
            label="更新失败"
            value={dashboard.summary.failedCount}
            tone="danger"
          />
          <SummaryCard
            label="今日已更新"
            value={dashboard.summary.updatedTodayCount}
            tone="info"
          />
        </section>

        <section className="panel projects-panel">
          <div className="panel-toolbar">
            <div>
              <h2>项目列表</h2>
              <span>{visibleProjects.length} 个项目</span>
            </div>
            <label className="toggle-control">
              <input
                type="checkbox"
                checked={onlyUpdates}
                onChange={(event) => setOnlyUpdates(event.target.checked)}
              />
              <span className="toggle" />
              只看可更新
            </label>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>项目名称</th>
                  <th>容器名</th>
                  <th>服务器</th>
                  <th>当前镜像</th>
                  <th>最新镜像</th>
                  <th>更新状态</th>
                  <th>运行状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleProjects.map((project) => (
                  <tr key={project.id}>
                    <td className="project-name">{project.name}</td>
                    <td>{project.containerName}</td>
                    <td>{project.server}</td>
                    <td className="hash">{shortId(project.runningImageId)}</td>
                    <td className="hash">{shortId(project.latestImageId)}</td>
                    <td><UpdateBadge status={project.updateStatus} /></td>
                    <td><RuntimeBadge running={project.runtimeStatus === "running"} /></td>
                    <td>
                      <div className="row-actions">
                        <button onClick={() => setSelectedId(project.id)}>查看</button>
                        <button
                          disabled={actionId === project.id}
                          onClick={() => void runAction(project.id, "check")}
                        >
                          检查
                        </button>
                        <button
                          disabled={
                            actionId === project.id ||
                            project.updateStrategy === "manual"
                          }
                          title={project.manualUpdateNote}
                          onClick={() => void runAction(project.id, "update")}
                        >
                          {actionId === project.id ? "执行中" : "更新"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel history-panel">
          <div className="panel-toolbar">
            <div>
              <h2>最近更新记录</h2>
              <span>任务执行结果与版本变化</span>
            </div>
          </div>
          <div className="history-list">
            {dashboard.recentTasks.slice(0, 8).map((task) => (
              <article className="history-item" key={task.id}>
                <TaskIcon status={task.status} />
                <div>
                  <strong>{task.projectId}</strong>
                  <span>{task.kind === "update" ? "更新" : "检查"}</span>
                </div>
                <time>{formatTime(task.finishedAt ?? task.createdAt)}</time>
                <code>{shortId(task.previousImageId)} → {shortId(task.nextImageId)}</code>
                <TaskStatus status={task.status} />
              </article>
            ))}
            {!dashboard.recentTasks.length && (
              <div className="empty-state">还没有更新任务记录</div>
            )}
          </div>
        </section>
          </>
        ) : serverStatus ? (
          <ServerStatusView status={serverStatus} />
        ) : (
          <div className="empty-state">正在读取服务器状态...</div>
        )}
      </main>

      {activeView === "projects" && selected && (
        <aside className="detail-panel">
          <div className="detail-header">
            <div>
              <span>项目详情</span>
              <h2>{selected.name}</h2>
            </div>
            <button className="icon-button" onClick={() => setSelectedId(null)}>
              <X size={18} />
            </button>
          </div>
          <DetailRow label="GitHub 仓库">
            <a href={selected.repository} target="_blank" rel="noreferrer">
              {selected.repository.replace("https://github.com/", "")}
              <ExternalLink size={13} />
            </a>
          </DetailRow>
          <DetailRow label="Docker 镜像"><code>{selected.image}</code></DetailRow>
          <DetailRow label="当前镜像 ID">
            <code>{selected.runningImageId ?? "未知"}</code>
          </DetailRow>
          <DetailRow label="最新镜像 ID">
            <code>{selected.latestImageId ?? "尚未检查"}</code>
          </DetailRow>
          <DetailRow label="部署目录"><code>{selected.composeDirectory}</code></DetailRow>
          <DetailRow label="Compose 服务"><code>{selected.composeService}</code></DetailRow>
          <DetailRow label="更新策略">
            <code>{selected.updateStrategy === "image" ? "镜像自动更新" : "人工合并更新"}</code>
          </DetailRow>
          {selected.manualUpdateNote && (
            <DetailRow label="更新说明">{selected.manualUpdateNote}</DetailRow>
          )}
          <div className="detail-actions">
            <button
              className="button secondary"
              onClick={() => void runAction(selected.id, "check")}
            >
              <RefreshCw size={16} />
              检查更新
            </button>
            <button
              className="button primary"
              disabled={selected.updateStrategy === "manual"}
              title={selected.manualUpdateNote}
              onClick={() => void runAction(selected.id, "update")}
            >
              <Boxes size={16} />
              执行更新
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}

function NavItem({
  icon,
  label,
  active = false,
  disabled = false,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`nav-item ${active ? "active" : ""}`}
      disabled={disabled}
      title={disabled ? "该页面尚未实现" : undefined}
      onClick={onClick}
    >
      {icon}{label}
    </button>
  );
}

function ServerStatusView({ status }: { status: ServerStatusPayload }) {
  return (
    <div className="server-status-page">
      <section className="server-hero">
        <div>
          <span className="eyebrow">PRIMARY SERVER</span>
          <h2>{status.hostname}</h2>
          <p>{status.platform}</p>
        </div>
        <div className="server-live">
          <i />
          在线
          <span>采集于 {formatTime(status.collectedAt)}</span>
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard
          icon={<Cpu size={19} />}
          label="CPU 负载"
          value={`${status.loadPercent.toFixed(1)}%`}
          detail={`${status.cpuCount} 核 · Load ${status.loadAverage[0].toFixed(2)}`}
          percent={status.loadPercent}
        />
        <MetricCard
          icon={<MemoryStick size={19} />}
          label="内存"
          value={`${status.memory.usedPercent.toFixed(1)}%`}
          detail={`${formatBytes(status.memory.usedBytes)} / ${formatBytes(status.memory.totalBytes)}`}
          percent={status.memory.usedPercent}
        />
        <MetricCard
          icon={<HardDrive size={19} />}
          label="根磁盘"
          value={`${status.disk.usedPercent.toFixed(1)}%`}
          detail={`${formatBytes(status.disk.usedBytes)} / ${formatBytes(status.disk.totalBytes)}`}
          percent={status.disk.usedPercent}
        />
        <MetricCard
          icon={<Boxes size={19} />}
          label="Docker 容器"
          value={`${status.containers.running} / ${status.containers.total}`}
          detail={`${status.containers.stopped} 个已停止 · 运行 ${formatDuration(status.uptimeSeconds)}`}
          percent={
            status.containers.total
              ? (status.containers.running / status.containers.total) * 100
              : 0
          }
        />
      </section>

      <section className="panel server-containers">
        <div className="panel-toolbar">
          <div>
            <h2>容器资源占用</h2>
            <span>按内存占用从高到低排列</span>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>容器</th>
                <th>状态</th>
                <th>CPU</th>
                <th>内存</th>
                <th>内存占比</th>
                <th>网络 I/O</th>
                <th>磁盘 I/O</th>
                <th>进程数</th>
              </tr>
            </thead>
            <tbody>
              {status.containers.items.map((container) => (
                <tr key={container.id || container.name}>
                  <td className="project-name">{container.name}</td>
                  <td>
                    <RuntimeBadge running={container.state === "running"} />
                  </td>
                  <td>{container.cpuPercent.toFixed(2)}%</td>
                  <td className="hash">{container.memoryUsage}</td>
                  <td>{container.memoryPercent.toFixed(2)}%</td>
                  <td className="hash">{container.networkIo}</td>
                  <td className="hash">{container.blockIo}</td>
                  <td>{container.pids}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  percent
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  percent: number;
}) {
  return (
    <article className="metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
      <div className="metric-track">
        <i style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} />
      </div>
    </article>
  );
}

function SummaryCard({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: number;
  tone?: "default" | "warning" | "success" | "danger" | "info";
}) {
  return (
    <article className={`summary-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function UpdateBadge({ status }: { status: ProjectStatus["updateStatus"] }) {
  const labels = {
    unknown: "未检查",
    checking: "检查中",
    latest: "已最新",
    update_available: "可更新",
    updating: "更新中",
    failed: "失败"
  };
  return <span className={`badge ${status}`}>{labels[status]}</span>;
}

function RuntimeBadge({ running }: { running: boolean }) {
  return <span className={`runtime ${running ? "running" : "stopped"}`}>
    <i />{running ? "运行中" : "未运行"}
  </span>;
}

function TaskIcon({ status }: { status: UpdateTask["status"] }) {
  if (status === "succeeded") return <CheckCircle2 className="task-icon success" />;
  if (status === "failed") return <CircleAlert className="task-icon danger" />;
  if (status === "running") return <LoaderCircle className="task-icon spin" />;
  return <Clock3 className="task-icon" />;
}

function TaskStatus({ status }: { status: UpdateTask["status"] }) {
  const labels = {
    queued: "等待中",
    running: "执行中",
    succeeded: "成功",
    failed: "失败"
  };
  return <span className={`task-status ${status}`}>{labels[status]}</span>;
}

function DetailRow({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return <div className="detail-row"><span>{label}</span><div>{children}</div></div>;
}

function shortId(value: string | null): string {
  if (!value) return "—";
  return value.replace("sha256:", "").slice(0, 12);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1
  );
  return `${(value / 1024 ** unitIndex).toFixed(unitIndex > 2 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}
