import {
  Activity,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cpu,
  ExternalLink,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  RefreshCw,
  Search,
  Server,
  X
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import type {
  DashboardSummary,
  ProjectReleasesPayload,
  ProjectStatus,
  RuntimeStatus,
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
  const [actionIds, setActionIds] = useState<Set<string>>(() => new Set());
  const [pruning, setPruning] = useState(false);
  const [pruneMessage, setPruneMessage] = useState<string | null>(null);
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

  const refreshActiveView = useEffectEvent(async (showLoading = false) => {
    if (showLoading) setLoading(true);
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
  const visibleRecentTasks = dashboard.recentTasks
    .filter(
      (task) =>
        !(
          task.trigger === "scheduled" &&
          task.kind === "check" &&
          task.status === "succeeded"
        )
    )
    .slice(0, 8);

  async function runAction(
    projectId: string,
    action: "check" | "update",
    waitForCompletion = false
  ): Promise<boolean> {
    setActionIds((current) => new Set(current).add(projectId));
    try {
      const task = await createTaskWithTokenRetry(projectId, action);
      if (!task) return false;
      if (waitForCompletion) await waitForTask(task.id);
      await loadDashboard();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setActionIds((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
    }
  }

  async function updateSelected() {
    const ids = visibleProjects
      .filter((project) => project.updateStatus === "update_available")
      .map((project) => project.id);
    if (!ids.length) return;
    if (!window.confirm(`确定依次更新 ${ids.length} 个项目吗？`)) return;
    for (const id of ids) {
      const succeeded = await runAction(id, "update", true);
      if (!succeeded) break;
    }
  }

  async function createTaskWithTokenRetry(
    projectId: string,
    action: "check" | "update"
  ): Promise<UpdateTask | null> {
    const response = await authorizedFetch(
      `/api/projects/${projectId}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }
    );
    if (!response) return null;
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error ?? "任务创建失败");
    }
    return response.json();
  }

  async function pruneImages(): Promise<void> {
    if (!window.confirm("确定清理宿主机上的全部悬空镜像吗？")) return;
    setPruning(true);
    setPruneMessage(null);
    try {
      const response = await authorizedFetch("/api/server/prune", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      if (!response) return;
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "清理镜像失败");
      setPruneMessage(`已回收 ${formatBytes(payload.reclaimedBytes ?? 0)}`);
      await loadServerStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPruning(false);
    }
  }

  async function waitForTask(taskId: string): Promise<void> {
    const deadline = Date.now() + 25 * 60_000;
    while (Date.now() < deadline) {
      const response = await fetch(`/api/tasks/${taskId}`);
      if (!response.ok) throw new Error("无法读取任务状态");
      const task = (await response.json()) as UpdateTask;
      if (task.status === "succeeded") return;
      if (task.status === "failed") {
        throw new Error(task.error ?? "更新任务失败");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
    throw new Error("等待任务完成超时，请在更新历史中检查最终结果");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>项目更新中心</h1>
          <p>Docker 服务版本与更新任务控制台</p>
        </div>
        <div className="topbar-actions">
          <div className="server-select">
            <Server size={16} />
            主服务器
          </div>
          <button className="button secondary" onClick={() => void refreshActiveView(true)}>
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
        <NavItem
          icon={<Boxes size={18} />}
          label="项目更新"
          active={activeView === "projects"}
          onClick={() => {
            setSelectedId(null);
            setActiveView("projects");
          }}
        />
        <NavItem
          icon={<Activity size={18} />}
          label="服务器状态"
          active={activeView === "server"}
          onClick={() => {
            setSelectedId(null);
            setActiveView("server");
          }}
        />
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
                  <th>上次检查</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleProjects.map((project) => (
                  <tr key={project.id}>
                    <td className="project-name">{project.name}</td>
                    <td>{project.containerName}</td>
                    <td>{project.server}</td>
                    <td
                      className="hash image-version"
                      title={imageTitle(
                        project.runningImageId,
                        project.runningImageCreatedAt
                      )}
                    >
                      {project.runningVersion ?? shortId(project.runningImageId)}
                    </td>
                    <td
                      className="hash image-version"
                      title={imageTitle(
                        project.latestImageId,
                        project.latestImageCreatedAt
                      )}
                    >
                      {project.latestVersion ?? shortId(project.latestImageId)}
                    </td>
                    <td><UpdateBadge status={project.updateStatus} /></td>
                    <td><RuntimeBadge status={project.runtimeStatus} /></td>
                    <td>{formatRelativeTime(project.lastCheckedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button onClick={() => setSelectedId(project.id)}>查看</button>
                        <button
                          disabled={actionIds.has(project.id)}
                          onClick={() => void runAction(project.id, "check")}
                        >
                          检查
                        </button>
                        <button
                          disabled={
                            actionIds.has(project.id) ||
                            project.updateStrategy === "manual"
                          }
                          title={project.manualUpdateNote}
                          onClick={() => void runAction(project.id, "update")}
                        >
                          {actionIds.has(project.id) ? "执行中" : "更新"}
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
            {visibleRecentTasks.map((task) => (
              <article className="history-item" key={task.id}>
                <TaskIcon status={task.status} />
                <div>
                  <strong>{task.projectId}</strong>
                  <span>
                    {task.kind === "update" ? "更新" : "检查"}
                    {task.trigger === "scheduled" && (
                      <em className="task-trigger">自动</em>
                    )}
                  </span>
                </div>
                <time>{formatTime(task.finishedAt ?? task.createdAt)}</time>
                <code>{shortId(task.previousImageId)} → {shortId(task.nextImageId)}</code>
                <TaskStatus status={task.status} />
              </article>
            ))}
            {!visibleRecentTasks.length && (
              <div className="empty-state">还没有更新任务记录</div>
            )}
          </div>
        </section>
          </>
        ) : serverStatus ? (
          <ServerStatusView
            status={serverStatus}
            pruning={pruning}
            pruneMessage={pruneMessage}
            onPrune={() => void pruneImages()}
          />
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
          <ReleaseNotesPanel project={selected} />
          <div className="detail-actions">
            <button
              className="button secondary"
              disabled={actionIds.has(selected.id)}
              onClick={() => void runAction(selected.id, "check")}
            >
              <RefreshCw size={16} />
              检查更新
            </button>
            <button
              className="button primary"
              disabled={
                actionIds.has(selected.id) ||
                selected.updateStrategy === "manual"
              }
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
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`nav-item ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {icon}{label}
    </button>
  );
}

function ServerStatusView({
  status,
  pruning,
  pruneMessage,
  onPrune
}: {
  status: ServerStatusPayload;
  pruning: boolean;
  pruneMessage: string | null;
  onPrune: () => void;
}) {
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

      <section className="panel docker-disk-panel">
        <div className="docker-disk-header">
          <div>
            <h2>Docker 磁盘占用</h2>
            <span>镜像清理仅删除无标签且未被容器引用的悬空镜像</span>
          </div>
          <div className="docker-disk-action">
            {pruneMessage && <strong>{pruneMessage}</strong>}
            <button
              className="button secondary"
              disabled={pruning}
              onClick={onPrune}
            >
              <HardDrive size={15} />
              {pruning ? "正在清理" : "清理悬空镜像"}
            </button>
          </div>
        </div>
        {status.dockerDisk ? (
          <div className="docker-disk-grid">
            {status.dockerDisk.map((item) => (
              <article key={item.type}>
                <span>{dockerDiskLabel(item.type)}</span>
                <strong>{formatBytes(item.sizeBytes)}</strong>
                <small>
                  可回收 {formatBytes(item.reclaimableBytes)} · {item.active}/{item.totalCount} 活跃
                </small>
              </article>
            ))}
          </div>
        ) : (
          <div className="docker-disk-unavailable">Docker 磁盘统计暂不可用</div>
        )}
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
                    <RuntimeBadge status={container.state} />
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

function RuntimeBadge({ status }: { status: RuntimeStatus | string }) {
  const labels: Record<string, string> = {
    running: "运行中",
    paused: "已暂停",
    restarting: "重启中",
    stopped: "未运行",
    exited: "未运行",
    created: "未启动",
    missing: "不存在",
    unknown: "未知"
  };
  return (
    <span className={`runtime ${status}`}>
      <i />{labels[status] ?? status}
    </span>
  );
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

function ReleaseNotesPanel({ project }: { project: ProjectStatus }) {
  const [payload, setPayload] = useState<ProjectReleasesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTags, setExpandedTags] = useState<Set<string>>(
    () => new Set()
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPayload(null);
    setError(null);
    setExpandedTags(new Set());
    void fetch(`/api/projects/${project.id}/releases`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取版本更新内容");
        return response.json() as Promise<ProjectReleasesPayload>;
      })
      .then((result) => {
        setPayload(result);
        setError(result.error ?? null);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [project.id]);

  const latestRelease = payload?.releases[0];
  const currentDisplay = versionOrBuildDate(
    payload?.currentVersion ?? project.runningVersion,
    project.runningImageCreatedAt
  );
  const latestDisplay = versionOrBuildDate(
    payload?.latestLocalVersion ?? project.latestVersion,
    project.latestImageCreatedAt
  );

  return (
    <section className="release-section">
      <div className="release-heading">
        <span>版本与更新内容</span>
        {payload?.stale && (
          <small>缓存于 {formatTime(payload.fetchedAt)}</small>
        )}
      </div>
      <div className="version-route">
        <strong>{currentDisplay}</strong>
        <span>→</span>
        <strong>{latestDisplay}</strong>
        {latestRelease?.publishedAt && (
          <small>发布于 {formatRelativeTime(latestRelease.publishedAt)}</small>
        )}
      </div>

      {loading && (
        <div className="release-skeleton" aria-label="正在加载更新内容">
          <i /><i /><i />
        </div>
      )}
      {error && (
        <div className="release-warning">
          GitHub 暂不可达或触发限流
          {payload?.stale ? "，当前显示缓存数据。" : "，更新功能不受影响。"}
        </div>
      )}
      {!loading && payload && !payload.releases.length && (
        <div className="release-empty">
          暂无 Release Notes。
          <a href={payload.repository} target="_blank" rel="noreferrer">
            查看仓库 <ExternalLink size={12} />
          </a>
        </div>
      )}
      {!!payload?.releases.length && (
        <div className="release-list">
          {payload.releases.map((release) => {
            const expanded = expandedTags.has(release.tagName);
            const collapsible = release.body.length > 1200;
            const body =
              collapsible && !expanded
                ? `${release.body.slice(0, 1200)}…`
                : release.body;
            return (
              <article className="release-item" key={release.tagName}>
                <div className="release-title">
                  <div>
                    <code>{release.tagName}</code>
                    {release.isNewerThanCurrent === true && (
                      <em>新</em>
                    )}
                  </div>
                  {release.publishedAt && (
                    <time>{formatTime(release.publishedAt)}</time>
                  )}
                </div>
                <h3>{release.name}</h3>
                {body && <pre>{body}</pre>}
                <div className="release-links">
                  {collapsible && (
                    <button
                      onClick={() =>
                        setExpandedTags((current) => {
                          const next = new Set(current);
                          if (expanded) next.delete(release.tagName);
                          else next.add(release.tagName);
                          return next;
                        })
                      }
                    >
                      {expanded ? "收起" : "展开"}
                    </button>
                  )}
                  <a href={release.htmlUrl} target="_blank" rel="noreferrer">
                    在 GitHub 查看 <ExternalLink size={12} />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="release-note">
        更新内容来自 GitHub Releases，实际拉取版本取决于镜像标签。
      </p>
    </section>
  );
}

function shortId(value: string | null): string {
  if (!value) return "—";
  return value.replace("sha256:", "").slice(0, 12);
}

async function authorizedFetch(
  path: string,
  init: RequestInit
): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let token = window.sessionStorage.getItem("pum-admin-token") ?? "";
    if (!token) {
      token = window.prompt("请输入管理员令牌")?.trim() ?? "";
      if (!token) return null;
      window.sessionStorage.setItem("pum-admin-token", token);
    }
    const headers = new Headers(init.headers);
    headers.set("x-pum-token", token);
    const response = await fetch(path, { ...init, headers });
    if (response.status !== 401) return response;
    window.sessionStorage.removeItem("pum-admin-token");
  }
  throw new Error("管理员令牌无效");
}

function dockerDiskLabel(type: string): string {
  const labels: Record<string, string> = {
    Images: "镜像",
    Containers: "容器",
    "Local Volumes": "本地卷",
    "Build Cache": "构建缓存"
  };
  return labels[type] ?? type;
}

function imageTitle(imageId: string | null, createdAt: string | null): string {
  return [
    imageId ? `镜像 ID：${imageId}` : "镜像 ID：未知",
    createdAt ? `构建时间：${formatFullTime(createdAt)}` : "构建时间：未知"
  ].join("\n");
}

function versionOrBuildDate(
  version: string | null | undefined,
  createdAt: string | null
): string {
  if (version) return version;
  return createdAt ? `构建于 ${formatDate(createdAt)}` : "版本未知";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatFullTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
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

function formatRelativeTime(value: string | null): string {
  if (!value) return "尚未检查";
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000)
  );
  if (elapsedSeconds < 60) return "刚刚";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
