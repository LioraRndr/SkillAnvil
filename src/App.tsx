import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { CSSProperties } from "react";
import { ink } from "ink-mde";
import type { Instance } from "ink-mde";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CloudDownload,
  Copy,
  FileText,
  FolderOpen,
  GitCompare,
  Grid2X2,
  History,
  Languages,
  List,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  Star,
  Trash2,
  X
} from "lucide-react";
import { api } from "./api";
import type { Agent, GithubUpdate, ReadFileResult, ScanIssue, Settings, Skill, SkillFilter, Snapshot, SyncTargetStatus, Tag } from "./types";

type ViewMode = "grid" | "list";
type Pane = "skills" | "settings";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type SelectOption<T extends string> = { value: T; label: string };
type SyncDraft = {
  skill: Skill;
  targets: SyncTargetStatus[];
  selectedAgentIds: string[];
};
type ContextMenu = {
  x: number;
  y: number;
  skill: Skill;
};
type DiffView = {
  snapshot: Snapshot;
  currentContent: string;
  snapshotContent: string;
};
type Tab = {
  skill: Skill;
  selectedFile: string;
  fileState: ReadFileResult | null;
  editorValue: string;
  saveState: SaveState;
  syncTargets: SyncTargetStatus[];
  snapshots: Snapshot[];
};

const defaultSettings: Settings = {
  language: "zh-CN",
  theme: "dark",
  shortcut: navigator.platform.toLowerCase().includes("mac") ? "Cmd+Shift+K" : "Ctrl+Shift+K",
  minimizeToTray: true,
  customAgents: [],
  snapshotsEnabled: true
};

const builtinTags: Tag[] = [
  { id: "writing", name: "写作", color: "#7dd3fc" },
  { id: "coding", name: "开发", color: "#86efac" },
  { id: "review", name: "审查", color: "#fcd34d" }
];

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [filter, setFilter] = useState<SkillFilter>({});
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [pane, setPane] = useState<Pane>("skills");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(-1);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [scanIssues, setScanIssues] = useState<ScanIssue[]>([]);
  const [syncDraft, setSyncDraft] = useState<SyncDraft | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [githubUpdates, setGithubUpdates] = useState<Map<string, GithubUpdate>>(new Map());
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const saveTimerTabId = useRef<string | null>(null);

  const activeTab = activeTabIndex >= 0 && activeTabIndex < tabs.length ? tabs[activeTabIndex] : null;
  const selectedSkill = activeTab?.skill ?? null;

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = skills.filter((skill) => {
      if (filter.agentId && skill.agentId !== filter.agentId) return false;
      if (filter.starred && !skill.starred) return false;
      if (filter.tagId && !skill.tags.some((tag) => tag.id === filter.tagId)) return false;
      if (!q) return true;
      return [skill.displayName, skill.name, skill.description, skill.version, skill.dirPath]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    const seen = new Map<string, Skill>();
    for (const skill of filtered) {
      const existing = seen.get(skill.name);
      if (!existing) {
        seen.set(skill.name, skill);
      } else if (filter.agentId && skill.agentId === filter.agentId) {
        seen.set(skill.name, skill);
      }
    }
    return Array.from(seen.values());
  }, [filter, query, skills]);

  const agentPresenceBySkillName = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const skill of skills) {
      const ids = groups.get(skill.name) ?? [];
      if (!ids.includes(skill.agentId)) ids.push(skill.agentId);
      groups.set(skill.name, ids);
    }
    return groups;
  }, [skills]);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        if (activeTab) closeTab(activeTabIndex);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabIndex, activeTab]);

  async function boot() {
    setError(null);
    try {
      const [settingsResult, scanResult] = await Promise.all([api.getSettings(), api.scanAgents()]);
      setSettings(settingsResult);
      setAgents(scanResult.agents);
      setSkills(scanResult.skills);
      setScanIssues(scanResult.scanErrors ?? []);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function refresh() {
    setError(null);
    try {
      const result = await api.scanAgents();
      setAgents(result.agents);
      setSkills(result.skills);
      setScanIssues(result.scanErrors ?? []);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function tabId(skill: Skill, file: string) {
    return `${skill.id}::${file}`;
  }

  async function openSkill(skill: Skill, relativePath = "SKILL.md") {
    let target = skill;
    if (filter.agentId && skill.agentId !== filter.agentId) {
      const match = skills.find((s) => s.name === skill.name && s.agentId === filter.agentId);
      if (match) target = match;
    }

    // Check if this skill+file is already open in a tab
    const existingIndex = tabs.findIndex((t) => t.skill.id === target.id && t.selectedFile === relativePath);
    if (existingIndex >= 0) {
      setActiveTabIndex(existingIndex);
      setPane("skills");
      return;
    }

    setError(null);
    setDiffView(null);
    try {
      const [result, targets, snaps] = await Promise.all([
        api.readSkillFile(target.id, relativePath),
        api.getSyncTargets(target.id),
        api.getSnapshots(target.id),
      ]);
      const newTab: Tab = {
        skill: target,
        selectedFile: relativePath,
        fileState: result,
        editorValue: result.content,
        saveState: "saved",
        syncTargets: targets,
        snapshots: snaps,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabIndex(tabs.length);
      setPane("skills");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function closeTab(index: number) {
    setTabs((prev) => {
      const next = prev.filter((_, i) => i !== index);
      // Adjust active index
      if (next.length === 0) {
        setActiveTabIndex(-1);
      } else if (index < activeTabIndex) {
        setActiveTabIndex(activeTabIndex - 1);
      } else if (index === activeTabIndex) {
        setActiveTabIndex(Math.min(index, next.length - 1));
      }
      return next;
    });
  }

  function updateActiveTab(patch: Partial<Tab>) {
    setTabs((prev) => prev.map((tab, i) => (i === activeTabIndex ? { ...tab, ...patch } : tab)));
  }

  function changeEditor(value: string) {
    updateActiveTab({ editorValue: value, saveState: "dirty" });
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const currentTabId = activeTab ? tabId(activeTab.skill, activeTab.selectedFile) : null;
    saveTimerTabId.current = currentTabId;
    saveTimer.current = window.setTimeout(() => void saveNow(value), 1000);
  }

  async function saveNow(nextValue?: string) {
    const tab = activeTab;
    if (!tab || !tab.fileState) return;
    const value = nextValue ?? tab.editorValue;
    setTabs((prev) => prev.map((t, i) => (i === activeTabIndex ? { ...t, saveState: "saving" as SaveState } : t)));
    try {
      const result = await api.saveSkillFile(tab.skill.id, tab.selectedFile, value, tab.fileState.encoding);
      setTabs((prev) => prev.map((t, i) => (i === activeTabIndex ? { ...t, fileState: result, saveState: "saved" as SaveState } : t)));
      setSkills(await api.getSkills({}));
    } catch (err) {
      setError(errorMessage(err));
      setTabs((prev) => prev.map((t, i) => (i === activeTabIndex ? { ...t, saveState: "error" as SaveState } : t)));
    }
  }

  async function toggleStar(skill: Skill) {
    try {
      const updated = await api.starSkill(skill.id, !skill.starred);
      setSkills((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      // Update skill in any open tabs
      setTabs((prev) => prev.map((t) => (t.skill.id === updated.id ? { ...t, skill: updated } : t)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function cloneSelected() {
    if (!activeTab) return;
    const newName = window.prompt("输入克隆后的 Skill 名称", `${activeTab.skill.name}-copy`);
    if (!newName) return;
    try {
      const created = await api.cloneSkill(activeTab.skill.id, newName);
      setSkills(await api.getSkills({}));
      await openSkill(created);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function cloneSkillDirect(skill: Skill) {
    const newName = window.prompt("输入克隆后的 Skill 名称", `${skill.name}-copy`);
    if (!newName) return;
    try {
      await api.cloneSkill(skill.id, newName);
      setSkills(await api.getSkills({}));
      setError(`已克隆 ${skill.displayName}。`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function trashSkillDirect(skill: Skill) {
    const agent = agents.find((item) => item.id === skill.agentId);
    const ok = window.confirm(`确认卸载 ${skill.displayName}？\n\n路径：${skill.dirPath}\n将移动到系统回收站。`);
    if (!ok) return;
    try {
      await api.trashSkill(skill.id, [skill.agentId]);
      setSkills(await api.getSkills({}));
      // Close any tabs for this skill
      setTabs((prev) => {
        const next = prev.filter((t) => t.skill.id !== skill.id);
        if (next.length < prev.length) {
          setActiveTabIndex(Math.min(activeTabIndex, next.length - 1));
        }
        return next;
      });
      setError(agent ? `已从 ${agent.name} 移至回收站。` : "已移至回收站。");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openSelectedInFileManager() {
    if (!activeTab) return;
    try {
      await api.openInFileManager(activeTab.skill.dirPath);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function trashSelected() {
    if (!activeTab) return;
    const agent = agents.find((item) => item.id === activeTab.skill.agentId);
    const ok = window.confirm(`确认卸载 ${activeTab.skill.displayName}？\n\n路径：${activeTab.skill.dirPath}\n将移动到系统回收站。`);
    if (!ok) return;
    try {
      await api.trashSkill(activeTab.skill.id, [activeTab.skill.agentId]);
      closeTab(activeTabIndex);
      setSkills(await api.getSkills({}));
      setError(agent ? `已从 ${agent.name} 移至回收站。` : "已移至回收站。");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function syncSelected(target: SyncTargetStatus) {
    if (!activeTab) return;
    if (target.status === "same") return;
    const action = target.status === "missing" ? "新增" : "覆盖";
    const details = [
      `目标 Agent：${target.agentName}`,
      `状态：${statusLabel(target.status)}`,
      `源路径：${activeTab.skill.dirPath}`,
      `目标路径：${target.targetPath}`,
      target.status === "different" ? "目标目录内容不同，继续后旧目录会先移至系统回收站，再复制当前 Skill。" : "目标 Agent 下不存在该 Skill，继续后会复制当前 Skill。"
    ].join("\n");
    const ok = window.confirm(`确认${action} ${activeTab.skill.displayName}？\n\n${details}`);
    if (!ok) return;
    try {
      const nextSkills = await api.syncSkill(activeTab.skill.id, [target.agentId]);
      setSkills(nextSkills);
      const newTargets = await api.getSyncTargets(activeTab.skill.id);
      updateActiveTab({ syncTargets: newTargets });
      setError(`已同步到 ${target.agentName}。`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openSyncPanel(skill: Skill) {
    setError(null);
    setSyncBusy(true);
    try {
      const targets = await api.getSyncTargets(skill.id);
      setSyncDraft({
        skill,
        targets,
        selectedAgentIds: targets
          .filter((target) => target.status !== "same")
          .map((target) => target.agentId)
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncBusy(false);
    }
  }

  function toggleSyncDraftTarget(agentId: string) {
    setSyncDraft((draft) => {
      if (!draft) return draft;
      const selected = new Set(draft.selectedAgentIds);
      if (selected.has(agentId)) {
        selected.delete(agentId);
      } else {
        selected.add(agentId);
      }
      return { ...draft, selectedAgentIds: Array.from(selected) };
    });
  }

  async function confirmSyncDraft() {
    if (!syncDraft || syncDraft.selectedAgentIds.length === 0) return;
    const selectedTargets = syncDraft.targets.filter((target) => syncDraft.selectedAgentIds.includes(target.agentId));
    const overwriteTargets = selectedTargets.filter((target) => target.status === "different");
    const details = [
      `源 Skill：${syncDraft.skill.displayName}`,
      `源路径：${syncDraft.skill.dirPath}`,
      `目标：${selectedTargets.map((target) => `${target.agentName}（${statusLabel(target.status)}）`).join("、")}`,
      overwriteTargets.length > 0 ? "包含内容不同的目标目录，继续后旧目录会先移至系统回收站，再复制当前 Skill。" : "只会向缺失目标新增当前 Skill。"
    ].join("\n");
    const ok = window.confirm(`确认同步？\n\n${details}`);
    if (!ok) return;
    setSyncBusy(true);
    try {
      const nextSkills = await api.syncSkill(syncDraft.skill.id, syncDraft.selectedAgentIds);
      setSkills(nextSkills);
      if (activeTab?.skill.id === syncDraft.skill.id) {
        const newTargets = await api.getSyncTargets(syncDraft.skill.id);
        updateActiveTab({ syncTargets: newTargets });
      }
      setError(`已同步到 ${selectedTargets.map((target) => target.agentName).join("、")}。`);
      setSyncDraft(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncBusy(false);
    }
  }

  async function updateSelectedSkillTags(tags: Tag[]) {
    if (!activeTab) return;
    try {
      const updated = await api.setSkillTags(activeTab.skill.id, tags);
      setTabs((prev) => prev.map((t, i) => (i === activeTabIndex ? { ...t, skill: updated } : t)));
      setSkills((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function restoreSnapshot(snapshotId: string) {
    if (!activeTab) return;
    const ok = window.confirm("确认回滚到该快照？当前文件内容将被覆盖。");
    if (!ok) return;
    try {
      const result = await api.restoreSnapshot(snapshotId);
      const snaps = await api.getSnapshots(activeTab.skill.id);
      setTabs((prev) => prev.map((t, i) =>
        i === activeTabIndex
          ? { ...t, fileState: result, editorValue: result.content, saveState: "saved" as SaveState, snapshots: snaps }
          : t
      ));
      setSkills(await api.getSkills({}));
      setError("已回滚到选定快照。");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function viewSnapshotDiff(snapshot: Snapshot) {
    if (!activeTab) return;
    try {
      const current = await api.readSkillFile(activeTab.skill.id, snapshot.filePath);
      setDiffView({
        snapshot,
        currentContent: current.content,
        snapshotContent: snapshot.content,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function checkGithubUpdatesForSkills() {
    const githubSkills = skills.filter((skill) => skill.source === "github");
    if (githubSkills.length === 0) {
      setError("没有 GitHub 来源的 Skill。");
      return;
    }
    setCheckingUpdates(true);
    try {
      const updates = await api.checkGithubUpdates(githubSkills.map((skill) => skill.id));
      const map = new Map<string, GithubUpdate>();
      for (const update of updates) {
        map.set(update.skillId, update);
      }
      setGithubUpdates(map);
      const hasUpdates = updates.filter((update) => update.hasUpdate);
      setError(hasUpdates.length > 0 ? `发现 ${hasUpdates.length} 个 Skill 有更新。` : "所有 GitHub 来源 Skill 均为最新。");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCheckingUpdates(false);
    }
  }

  const handleContextMenu = useCallback((event: React.MouseEvent, skill: Skill) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, skill });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => closeContextMenu();
    window.addEventListener("click", handler);
    window.addEventListener("contextmenu", handler);
    return () => {
      window.removeEventListener("click", handler);
      window.removeEventListener("contextmenu", handler);
    };
  }, [contextMenu, closeContextMenu]);

  async function updateSettings(next: Settings) {
    const customAgentsChanged = JSON.stringify(settings.customAgents) !== JSON.stringify(next.customAgents);
    setSettings(next);
    try {
      setSettings(await api.updateSettings(next));
      if (customAgentsChanged) {
        await refresh();
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function switchTab(index: number) {
    setActiveTabIndex(index);
  }

  const themeClass = settings.theme === "light" ? "theme-light" : settings.theme === "system" ? "theme-system" : "theme-dark";
  const activeSyncTargets = syncDraft?.targets.filter((target) => target.status !== "same") ?? [];

  return (
    <div className={`app-shell ${themeClass}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Archive size={22} />
          </div>
          <div>
            <strong>SkillAnvil</strong>
          </div>
        </div>

        <label className="search-box">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" />
        </label>

        <div className="section-title">收藏</div>
        <nav className="nav-section">
          <button className={navClass(Boolean(filter.starred))} onClick={() => { setPane("skills"); setFilter({ starred: true }); }}>
            <Star size={16} /> 收藏夹 <span className="nav-count">{new Set(skills.filter((skill) => skill.starred).map((skill) => skill.name)).size}</span>
          </button>
        </nav>

        <div className="section-title">Agents</div>
        <nav className="nav-section grow">
          {agents.map((agent) => (
            <button key={agent.id} className={navClass(filter.agentId === agent.id)} onClick={() => { setPane("skills"); setFilter({ agentId: agent.id }); }}>
              <FolderOpen size={16} /> {agent.name}
              <span className="nav-count">{new Set(skills.filter((skill) => skill.agentId === agent.id).map((skill) => skill.name)).size}</span>
            </button>
          ))}
        </nav>

        <div className="section-title">标签</div>
        <nav className="nav-section">
          {builtinTags.map((tag) => (
            <button key={tag.id} className={navClass(filter.tagId === tag.id)} onClick={() => { setPane("skills"); setFilter({ tagId: tag.id }); }}>
              <span className="tag-dot" style={{ background: tag.color }} /> {tag.name}
            </button>
          ))}
        </nav>

        <div className="sidebar-actions">
          <button className="ghost-button" onClick={refresh}><RefreshCcw size={16} /> 扫描</button>
          <button className="ghost-button" onClick={() => setPane("settings")}><SettingsIcon size={16} /> 设置</button>
        </div>
      </aside>

      <main className="main">
        {tabs.length > 0 && (
          <div className="tab-bar">
            {tabs.map((tab, index) => (
              <button
                key={`${tab.skill.id}-${tab.selectedFile}`}
                className={index === activeTabIndex ? "tab active" : "tab"}
                onClick={() => switchTab(index)}
                title={`${tab.skill.displayName} — ${tab.selectedFile}`}
              >
                <span className="tab-label">{tab.skill.displayName}</span>
                {tab.saveState === "dirty" && <span className="tab-dot" />}
                <span
                  className="tab-close"
                  onClick={(e) => { e.stopPropagation(); closeTab(index); }}
                  title="关闭标签页"
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>
        )}

        <header className="topbar">
          <div>
            <h1>{activeTab ? activeTab.skill.displayName : pane === "settings" ? "设置" : "Skill 总览"}</h1>
            <p>{activeTab ? `${agentName(agents, activeTab.skill.agentId)} > ${activeTab.selectedFile}` : "扫描、编辑和同步本地 Coding Agent Skills"}</p>
          </div>
          {!activeTab && pane === "skills" && (
            <div className="topbar-stats">
              <span>{agents.length} Agents</span>
              <span>{new Set(skills.map((skill) => skill.name)).size} Skills</span>
            </div>
          )}
          {!activeTab && pane === "skills" && (
            <div className="topbar-actions">
              <button className="ghost-button" onClick={checkGithubUpdatesForSkills} disabled={checkingUpdates}>
                <CloudDownload size={15} /> {checkingUpdates ? "检查中..." : "检查更新"}
              </button>
              <div className="segmented">
                <button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")} title="网格"><Grid2X2 size={16} /></button>
                <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} title="列表"><List size={16} /></button>
              </div>
            </div>
          )}
          {activeTab && (
            <div className="editor-actions">
              <button onClick={() => void saveNow()}><Save size={16} /> 保存</button>
              <button onClick={cloneSelected}><Copy size={16} /> 克隆</button>
              <button onClick={trashSelected} className="danger"><Trash2 size={16} /> 卸载</button>
            </div>
          )}
        </header>

        {error && <div className={error.startsWith("已") ? "notice ok" : "notice"}><ShieldAlert size={16} /> {error}</div>}
        {scanIssues.length > 0 && (
          <div className="notice warn" title={scanIssues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}>
            <ShieldAlert size={16} />
            扫描跳过 {scanIssues.length} 个异常 Skill。其他功能可继续使用；悬停查看路径。
          </div>
        )}

        {pane === "settings" && !activeTab ? (
          <SettingsPanel settings={settings} onChange={updateSettings} />
        ) : activeTab ? (
          <section className="editor-layout">
            <div className="editor-card">
              <MarkdownEditor
                key={`${activeTab.skill.id}-${activeTab.selectedFile}`}
                value={activeTab.editorValue}
                onChange={changeEditor}
                theme={settings.theme}
              />
            </div>
            <aside className="inspector">
              <h2>文件树</h2>
              <FileTree
                files={activeTab.skill.files}
                selectedFile={activeTab.selectedFile}
                onOpen={(relativePath) => openSkill(activeTab.skill, relativePath)}
              />
              <h2>元信息</h2>
              <dl className="meta">
                <dt>编码</dt><dd>{activeTab.fileState?.encoding ?? "-"}</dd>
                <dt>版本</dt><dd>{activeTab.skill.version || "-"}</dd>
                <dt>来源</dt><dd>{activeTab.skill.source}</dd>
                <dt>路径</dt><dd title={activeTab.skill.dirPath}>{activeTab.skill.dirPath}</dd>
                <dt>存在于</dt>
                <dd>
                  <AgentPresence
                    agentIds={agentPresenceBySkillName.get(activeTab.skill.name) ?? [activeTab.skill.agentId]}
                    agents={agents}
                  />
                </dd>
              </dl>
              <button className="wide-button" onClick={openSelectedInFileManager}><FolderOpen size={16} /> 在文件管理器中显示</button>
              <h2>标签</h2>
              <TagPicker
                tags={builtinTags}
                value={activeTab.skill.tags}
                onChange={updateSelectedSkillTags}
              />
              <h2>同步到</h2>
              <div className="sync-list">
                {activeTab.syncTargets.map((target) => (
                  <button key={target.agentId} disabled={target.status === "same"} title={target.targetPath} onClick={() => syncSelected(target)}>
                    <span>{target.agentName}</span>
                    <em>{statusLabel(target.status)}</em>
                  </button>
                ))}
              </div>
              <h2><History size={13} /> 版本历史</h2>
              <div className="snapshot-list">
                {activeTab.snapshots.length === 0 ? (
                  <p className="muted-copy">暂无快照。保存时自动创建。</p>
                ) : (
                  activeTab.snapshots.slice(0, 10).map((snap) => (
                    <div key={snap.id} className="snapshot-row">
                      <div className="snapshot-info">
                        <span className="snapshot-time">{formatSnapshotTime(snap.createdAt)}</span>
                        <span className="snapshot-file">{snap.filePath}</span>
                      </div>
                      <div className="snapshot-actions">
                        <button title="查看 diff" onClick={() => viewSnapshotDiff(snap)}><GitCompare size={13} /></button>
                        <button title="回滚到此版本" onClick={() => void restoreSnapshot(snap.id)}><RotateCcw size={13} /></button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </aside>
          </section>
        ) : (
          <section className={viewMode === "grid" ? "skill-grid" : "skill-list"}>
            {visibleSkills.length === 0 ? (
              <div className="empty-state">
                <Sparkles size={28} />
                <h2>没有发现 Skill</h2>
                <p>点击左下角"扫描"，或在设置中添加自定义 Agent Skill 目录。</p>
              </div>
            ) : (
              visibleSkills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  agents={agents}
                  agentIds={agentPresenceBySkillName.get(skill.name) ?? [skill.agentId]}
                  update={githubUpdates.get(skill.id)}
                  onOpen={openSkill}
                  onSync={openSyncPanel}
                  onToggleStar={toggleStar}
                  onContextMenu={handleContextMenu}
                />
              ))
            )}
          </section>
        )}
      </main>

      {syncDraft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !syncBusy && setSyncDraft(null)}>
          <section className="sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2 id="sync-title">同步 {syncDraft.skill.displayName}</h2>
                <p>{syncDraft.skill.dirPath}</p>
              </div>
              <button className="icon-button" onClick={() => setSyncDraft(null)} disabled={syncBusy}><X size={16} /></button>
            </header>
            <div className="sync-target-table">
              {syncDraft.targets.length === 0 ? (
                <p className="muted-copy">没有其他已启用 Agent。可在设置里启用或添加 Agent 目录。</p>
              ) : (
                syncDraft.targets.map((target) => (
                  <label key={target.agentId} className={target.status === "same" ? "sync-target-row disabled" : "sync-target-row"}>
                    <input
                      type="checkbox"
                      disabled={target.status === "same" || syncBusy}
                      checked={syncDraft.selectedAgentIds.includes(target.agentId)}
                      onChange={() => toggleSyncDraftTarget(target.agentId)}
                    />
                    <span>
                      <strong>{target.agentName}</strong>
                      <em title={target.targetPath}>{target.targetPath}</em>
                    </span>
                    <b className={`sync-badge ${target.status}`}>{statusLabel(target.status)}</b>
                  </label>
                ))
              )}
            </div>
            <footer>
              <span>{activeSyncTargets.length} 个可同步目标</span>
              <button onClick={() => setSyncDraft(null)} disabled={syncBusy}>取消</button>
              <button className="primary" onClick={confirmSyncDraft} disabled={syncBusy || syncDraft.selectedAgentIds.length === 0}>
                {syncBusy ? "同步中" : `同步 ${syncDraft.selectedAgentIds.length} 个目标`}
              </button>
            </footer>
          </section>
        </div>
      )}

      {diffView && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDiffView(null)}>
          <section className="diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2 id="diff-title">版本对比</h2>
                <p>{formatSnapshotTime(diffView.snapshot.createdAt)} — {diffView.snapshot.filePath}</p>
              </div>
              <button className="icon-button" onClick={() => setDiffView(null)}><X size={16} /></button>
            </header>
            <div className="diff-content">
              <div className="diff-pane">
                <h3>快照版本</h3>
                <pre>{diffView.snapshotContent}</pre>
              </div>
              <div className="diff-pane">
                <h3>当前版本</h3>
                <pre>{diffView.currentContent}</pre>
              </div>
            </div>
            <footer>
              <button onClick={() => setDiffView(null)}>关闭</button>
              <button className="primary" onClick={() => { void restoreSnapshot(diffView.snapshot.id); setDiffView(null); }}>
                <RotateCcw size={14} /> 回滚到快照版本
              </button>
            </footer>
          </section>
        </div>
      )}

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { openSkill(contextMenu.skill); closeContextMenu(); }}>
            <FileText size={14} /> 编辑
          </button>
          {agents.length > 1 && (
            <button onClick={() => { openSyncPanel(contextMenu.skill); closeContextMenu(); }}>
              <RefreshCcw size={14} /> 同步到...
            </button>
          )}
          <button onClick={() => { toggleStar(contextMenu.skill); closeContextMenu(); }}>
            <Star size={14} /> {contextMenu.skill.starred ? "取消收藏" : "收藏"}
          </button>
          <button onClick={() => { void cloneSkillDirect(contextMenu.skill); closeContextMenu(); }}>
            <Copy size={14} /> 克隆
          </button>
          <button onClick={() => { void trashSkillDirect(contextMenu.skill); closeContextMenu(); }} className="danger">
            <Trash2 size={14} /> 卸载
          </button>
          <div className="context-separator" />
          <button onClick={() => { void api.openInFileManager(contextMenu.skill.dirPath); closeContextMenu(); }}>
            <FolderOpen size={14} /> 在文件管理器中显示
          </button>
        </div>
      )}

      <footer className="statusbar">
        <span>{agents.length} agents</span>
        <span>{new Set(skills.map((skill) => skill.name)).size} skills</span>
        {activeTab && <span>{saveStateText(activeTab.saveState)}</span>}
      </footer>
    </div>
  );
}

function SkillCard({
  skill,
  agents,
  agentIds,
  update,
  onOpen,
  onSync,
  onToggleStar,
  onContextMenu
}: {
  skill: Skill;
  agents: Agent[];
  agentIds: string[];
  update?: GithubUpdate;
  onOpen: (skill: Skill) => void;
  onSync: (skill: Skill) => void;
  onToggleStar: (skill: Skill) => void;
  onContextMenu: (event: React.MouseEvent, skill: Skill) => void;
}) {
  const canSync = agents.length > 1;
  return (
    <article className="skill-card" onDoubleClick={() => onOpen(skill)} onContextMenu={(e) => onContextMenu(e, skill)}>
      {update?.hasUpdate && (
        <div className="update-badge" title={`有更新：${update.summary.join(", ")}`}>
          <CloudDownload size={13} /> 更新可用
        </div>
      )}
      <div className="card-head">
        <button className={skill.starred ? "icon-button starred" : "icon-button"} onClick={() => onToggleStar(skill)} title="收藏">
          <Star size={17} />
        </button>
        <span>{agentName(agents, skill.agentId)}</span>
      </div>
      <h2>{skill.displayName}</h2>
      <p>{skill.description || "未提供描述"}</p>
      <AgentPresence agentIds={agentIds} agents={agents} />
      <div className="tag-row">
        {skill.tags.map((tag) => <span key={tag.id} style={{ borderColor: tag.color }}>{tag.name}</span>)}
      </div>
      <footer>
        <span>v{skill.version || "0.0.0"}</span>
        <div className="card-actions">
          {canSync && <button onClick={() => onSync(skill)}>同步</button>}
          <button onClick={() => onOpen(skill)}>编辑</button>
        </div>
      </footer>
    </article>
  );
}

function AgentPresence({ agentIds, agents }: { agentIds: string[]; agents: Agent[] }) {
  const visibleIds = agentIds.slice(0, 4);
  const hiddenCount = Math.max(0, agentIds.length - visibleIds.length);
  return (
    <div className="agent-presence" title={agentIds.map((id) => agentName(agents, id)).join("、")}>
      {visibleIds.map((id) => {
        const name = agentName(agents, id);
        return <span key={id}>{agentInitials(name)}</span>;
      })}
      {hiddenCount > 0 && <span>+{hiddenCount}</span>}
    </div>
  );
}

function TagPicker({ tags, value, onChange }: { tags: Tag[]; value: Tag[]; onChange: (tags: Tag[]) => void }) {
  const selectedIds = new Set(value.map((tag) => tag.id));
  return (
    <div className="tag-picker">
      {tags.map((tag) => {
        const selected = selectedIds.has(tag.id);
        return (
          <button
            key={tag.id}
            className={selected ? "selected" : ""}
            style={{ "--tag-color": tag.color } as CSSProperties}
            onClick={() => {
              const next = selected ? value.filter((item) => item.id !== tag.id) : [...value, tag];
              onChange(next);
            }}
          >
            <span className="tag-dot" style={{ background: tag.color }} />
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}

function SettingsPanel({ settings, onChange }: { settings: Settings; onChange: (settings: Settings) => void }) {
  function addCustomAgent() {
    const name = window.prompt("Agent 名称", "Custom Agent");
    if (!name) return;
    const path = window.prompt("Skill 目录绝对路径，例如 C:\\Users\\you\\.codex\\skills");
    if (!path) return;
    onChange({
      ...settings,
      customAgents: [
        ...settings.customAgents,
        {
          id: `custom-${crypto.randomUUID()}`,
          name,
          paths: [path],
          enabled: true,
          builtin: false,
          icon: "custom"
        }
      ]
    });
  }

  function updateAgentConfig(id: string, patch: Partial<Settings["customAgents"][number]>) {
    onChange({
      ...settings,
      customAgents: settings.customAgents.map((agent) => agent.id === id ? { ...agent, ...patch } : agent)
    });
  }

  function removeCustomAgent(id: string) {
    onChange({
      ...settings,
      customAgents: settings.customAgents.filter((agent) => agent.id !== id)
    });
  }

  return (
    <section className="settings-panel">
      <div className="setting-row">
        <div className="setting-copy"><Languages size={18} /><strong>界面语言</strong><span>默认跟随系统，当前可手动切换。</span></div>
        <CustomSelect
          value={settings.language}
          options={[
            { value: "zh-CN", label: "中文" },
            { value: "en-US", label: "English" }
          ]}
          onChange={(language) => onChange({ ...settings, language })}
        />
      </div>
      <div className="setting-row">
        <div className="setting-copy"><SettingsIcon size={18} /><strong>主题</strong><span>编辑器配色将随主题调整。</span></div>
        <CustomSelect
          value={settings.theme}
          options={[
            { value: "dark", label: "深色" },
            { value: "light", label: "浅色" },
            { value: "system", label: "跟随系统" }
          ]}
          onChange={(theme) => onChange({ ...settings, theme })}
        />
      </div>
      <div className="setting-row">
        <div className="setting-copy"><ChevronsUpDown size={18} /><strong>全局快捷键</strong><span>macOS 默认 Cmd+Shift+K，Windows/Linux 默认 Ctrl+Shift+K。</span></div>
        <input value={settings.shortcut} onChange={(event) => onChange({ ...settings, shortcut: event.target.value })} />
      </div>
      <label className="toggle-row">
        <input type="checkbox" checked={settings.minimizeToTray} onChange={(event) => onChange({ ...settings, minimizeToTray: event.target.checked })} />
        <span>关闭窗口时最小化到系统托盘</span>
      </label>
      <label className="toggle-row">
        <input type="checkbox" checked={settings.snapshotsEnabled} onChange={(event) => onChange({ ...settings, snapshotsEnabled: event.target.checked })} />
        <span>保存时创建本地快照</span>
      </label>
      <div className="custom-agent-panel">
        <header>
          <div>
            <strong>Agent 目录</strong>
            <span>启用后会显示在左侧 Agents 分组；每行一个 Skill 根目录，支持 ~。</span>
          </div>
          <button onClick={addCustomAgent}>添加路径</button>
        </header>
        {settings.customAgents.length === 0 ? (
          <p>尚未加载 Agent 配置。</p>
        ) : (
          settings.customAgents.map((agent) => (
            <div className="custom-agent-row" key={agent.id}>
              <div className="custom-agent-main">
                <label>
                  <input type="checkbox" checked={agent.enabled} onChange={(event) => updateAgentConfig(agent.id, { enabled: event.target.checked })} />
                  <strong>{agent.name}</strong>
                  <em>{agent.builtin ? "内置" : "自定义"}</em>
                </label>
                <textarea
                  value={agent.paths.join("\n")}
                  onChange={(event) => updateAgentConfig(agent.id, { paths: event.target.value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) })}
                  rows={Math.max(2, Math.min(4, agent.paths.length))}
                />
              </div>
              {!agent.builtin && <button onClick={() => removeCustomAgent(agent.id)}>移除</button>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function CustomSelect<T extends string>({ value, options, onChange }: { value: T; options: SelectOption<T>[]; onChange: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className={`custom-select ${open ? "open" : ""}`} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <button type="button" className="custom-select-trigger" onClick={() => setOpen((current) => !current)}>
        <span>{selected.label}</span>
        <ChevronsUpDown size={15} />
      </button>
      <div className="custom-select-menu" role="listbox">
        {options.map((option) => (
          <button
            type="button"
            role="option"
            aria-selected={option.value === value}
            key={option.value}
            className={option.value === value ? "selected" : ""}
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type FileTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
};

function FileTree({ files, selectedFile, onOpen }: { files: Skill["files"]; selectedFile: string; onOpen: (relativePath: string) => void }) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  return (
    <div className="file-list">
      {tree.map((node) => (
        <FileTreeItem key={node.path || node.name} node={node} selectedFile={selectedFile} onOpen={onOpen} level={0} />
      ))}
    </div>
  );
}

function FileTreeItem({ node, selectedFile, onOpen, level }: { node: FileTreeNode; selectedFile: string; onOpen: (relativePath: string) => void; level: number }) {
  const [expanded, setExpanded] = useState(true);

  if (node.isDir) {
    return (
      <div className="file-tree-group">
        <button type="button" className="file-tree-dir" style={{ paddingLeft: `${level * 12 + 4}px` }} onClick={() => setExpanded((current) => !current)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="file-tree-name">{node.name}</span>
          <span className="file-tree-count">{countFiles(node)}</span>
        </button>
        {expanded && (
          <div className="file-tree-children" style={{ marginLeft: `${level * 12 + 11}px` }}>
            {node.children.map((child) => (
              <FileTreeItem key={child.path || child.name} node={child} selectedFile={selectedFile} onOpen={onOpen} level={level + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button className={node.path === selectedFile ? "file-tree-file-row active" : "file-tree-file-row"} style={{ paddingLeft: `${level * 12 + 4}px` }} onClick={() => onOpen(node.path)}>
      <FileText size={14} />
      <span className="file-tree-name">{node.name}</span>
    </button>
  );
}

function countFiles(node: FileTreeNode): number {
  if (!node.isDir) return 1;
  return node.children.reduce((total, child) => total + countFiles(child), 0);
}

function buildFileTree(files: Skill["files"]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", isDir: true, children: [] };
  const ensureChild = (parent: FileTreeNode, name: string, path: string, isDir: boolean) => {
    let child = parent.children.find((item) => item.name === name);
    if (!child) {
      child = { name, path, isDir, children: [] };
      parent.children.push(child);
    }
    child.isDir = child.isDir || isDir;
    return child;
  };

  for (const file of files) {
    const parts = file.relativePath.split(/[\\/]+/).filter(Boolean);
    let current = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const isDir = index < parts.length - 1 || file.isDir;
      current = ensureChild(current, part, path, isDir);
    });
  }

  const sortTree = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    nodes.forEach((node) => sortTree(node.children));
    return nodes;
  };

  return sortTree(root.children);
}

function MarkdownEditor({ value, onChange, theme }: { value: string; onChange: (value: string) => void; theme: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Instance | null>(null);
  const lastValueRef = useRef(value);
  const mountRunRef = useRef(0);
  const appearance = theme === "light" ? "light" : "dark";

  useEffect(() => {
    let disposed = false;
    const mountRun = ++mountRunRef.current;
    async function mount() {
      if (!hostRef.current) return;
      hostRef.current.replaceChildren();
      const instance = await ink(hostRef.current, {
        doc: value,
        interface: {
          appearance,
          toolbar: true
        },
        hooks: {
          afterUpdate: (doc) => {
            lastValueRef.current = doc;
            onChange(doc);
          }
        }
      });
      if (disposed || mountRunRef.current !== mountRun) {
        instance.destroy();
        return;
      }
      editorRef.current = instance;
    }
    void mount();
    return () => {
      disposed = true;
      if (mountRunRef.current === mountRun) {
        editorRef.current?.destroy();
        editorRef.current = null;
        hostRef.current?.replaceChildren();
      }
    };
  }, [appearance]);

  useEffect(() => {
    if (editorRef.current && value !== lastValueRef.current) {
      lastValueRef.current = value;
      editorRef.current.update(value);
    }
  }, [value]);

  return <div className="markdown-editor-host" ref={hostRef} />;
}

function navClass(active: boolean) {
  return active ? "active" : "";
}

function agentName(agents: Agent[], agentId: string) {
  return agents.find((agent) => agent.id === agentId)?.name ?? "Unknown";
}

function agentInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function statusLabel(status: SyncTargetStatus["status"]) {
  return status === "same" ? "一致" : status === "different" ? "不同" : "新增";
}

function saveStateText(state: SaveState) {
  return state === "dirty" ? "未保存更改" : state === "saving" ? "保存中" : state === "saved" ? "已保存" : state === "error" ? "保存失败" : "就绪";
}

function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatSnapshotTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} 小时前`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays} 天前`;
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return isoString;
  }
}
