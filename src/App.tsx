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
  Home,
  Grid2X2,
  History,
  Languages,
  List,
  Plus,
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
import gooseSvg from "./assets/goose.svg";
import hermesagentSvg from "./assets/hermesagent.svg";
import junieColorSvg from "./assets/junie-color.svg";
import kilocodeSvg from "./assets/kilocode.svg";
import kimiSvg from "./assets/kimi.svg";
import openclawColorSvg from "./assets/openclaw-color.svg";
import openhandsColorSvg from "./assets/openhands-color.svg";
import qoderColorSvg from "./assets/qoder-color.svg";
import roocodeSvg from "./assets/roocode.svg";
import traeColorSvg from "./assets/trae-color.svg";
import zencoderColorSvg from "./assets/zencoder-color.svg";
import antigravityColorSvg from "./assets/antigravity-color.svg";
import claudeColorSvg from "./assets/claude-color.svg";
import clineSvg from "./assets/cline.svg";
import codebuddyColorSvg from "./assets/codebuddy-color.svg";
import codexColorSvg from "./assets/codex-color.svg";

const agentIconMap: Record<string, string> = {
  goose: gooseSvg,
  hermes: hermesagentSvg,
  junie: junieColorSvg,
  kilo: kilocodeSvg,
  kimi: kimiSvg,
  openclaw: openclawColorSvg,
  openhands: openhandsColorSvg,
  qoder: qoderColorSvg,
  roo: roocodeSvg,
  trae: traeColorSvg,
  zencoder: zencoderColorSvg,
  antigravity: antigravityColorSvg,
  claude: claudeColorSvg,
  cline: clineSvg,
  codebuddy: codebuddyColorSvg,
  codex: codexColorSvg,
};

function AgentIcon({ icon, size = 16 }: { icon: string; size?: number }) {
  const src = agentIconMap[icon];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="agent-icon"
        style={{ width: size, height: size }}
        width={size}
        height={size}
      />
    );
  }
  return <FolderOpen size={size} />;
}
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
  scrollY: number;
};

const defaultTags: Tag[] = [
  { id: "writing", name: "写作", color: "#7dd3fc" },
  { id: "coding", name: "开发", color: "#86efac" },
  { id: "review", name: "审查", color: "#fcd34d" }
];

const defaultSettings: Settings = {
  language: "zh-CN",
  theme: "dark",
  shortcut: navigator.platform.toLowerCase().includes("mac") ? "Cmd+Shift+K" : "Ctrl+Shift+K",
  minimizeToTray: true,
  customAgents: [],
  snapshotsEnabled: true,
  customTags: defaultTags
};

type ToastType = "success" | "error" | "info";
type Toast = { id: number; message: string; type: ToastType };
let toastIdSeq = 0;

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [filter, setFilter] = useState<SkillFilter>({});
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [pane, setPane] = useState<Pane>("skills");
  const [homeState, setHomeState] = useState<{ pane: Pane; filter: SkillFilter; scrollY: number }>({ pane: "skills", filter: {}, scrollY: 0 });
  const mainRef = useRef<HTMLElement>(null);
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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const saveTimer = useRef<number | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [confirmDeleteCategoryId, setConfirmDeleteCategoryId] = useState<string | null>(null);
  const [confirmDeleteTagId, setConfirmDeleteTagId] = useState<string | null>(null);
  const [cloningSkill, setCloningSkill] = useState<Skill | null>(null);

  function showToast(message: string, type: ToastType = "success") {
    const id = ++toastIdSeq;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }
  const saveTimerTabId = useRef<string | null>(null);

  const activeTab = activeTabIndex >= 0 && activeTabIndex < tabs.length ? tabs[activeTabIndex] : null;
  const selectedSkill = activeTab?.skill ?? null;

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Get category skill names if filtering by category
    let categorySkillNames: Set<string> | null = null;
    if (filter.categoryId && filter.categoryAgentId) {
      const agentConfig = settings.customAgents.find((a) => a.id === filter.categoryAgentId);
      const category = agentConfig?.categories?.find((c) => c.id === filter.categoryId);
      if (category) {
        categorySkillNames = new Set(category.skillNames);
      }
    }
    const filtered = skills.filter((skill) => {
      if (filter.agentId && skill.agentId !== filter.agentId) return false;
      if (filter.starred && !skill.starred) return false;
      if (filter.tagId && !skill.tags.some((tag) => tag.id === filter.tagId)) return false;
      if (categorySkillNames && !categorySkillNames.has(skill.name)) return false;
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
  }, [filter, query, skills, settings.customAgents]);

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

    // Save current home state before opening a tab
    const currentScrollY = mainRef.current?.scrollTop ?? 0;
    setHomeState({ pane, filter, scrollY: currentScrollY });
    // Also save current tab's scroll position if one is active
    if (activeTabIndex >= 0) {
      const currentTab = tabs[activeTabIndex];
      if (currentTab) {
        const key = `${currentTab.skill.name}::${currentTab.selectedFile}`;
        tabScrollRef.current.set(key, currentScrollY);
      }
    }

    // Check if this skill (by name) + file is already open in a tab
    const existingIndex = tabs.findIndex((t) => t.skill.name === target.name && t.selectedFile === relativePath);
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
        scrollY: 0,
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

  async function doCloneSkill(skill: Skill, newName: string) {
    try {
      const created = await api.cloneSkill(skill.id, newName);
      setSkills(await api.getSkills({}));
      if (activeTab && skill.id === activeTab.skill.id) {
        await openSkill(created);
      } else {
        showToast(`已克隆 ${skill.displayName}`);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
    setCloningSkill(null);
  }

  function cloneSelected() {
    if (!activeTab) return;
    setCloningSkill(activeTab.skill);
  }

  function cloneSkillDirect(skill: Skill) {
    setCloningSkill(skill);
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
    const actionLabel = target.status === "missing" ? "新增" : "覆盖";
    try {
      const nextSkills = await api.syncSkill(activeTab.skill.id, [target.agentId]);
      setSkills(nextSkills);
      const refreshed = nextSkills.find((s) => s.name === activeTab.skill.name && s.agentId === activeTab.skill.agentId);
      if (refreshed) {
        updateActiveTab({ skill: refreshed });
        const newTargets = await api.getSyncTargets(refreshed.id);
        updateActiveTab({ syncTargets: newTargets });
      }
      showToast(`${activeTab.skill.displayName} 已${actionLabel}到 ${target.agentName}`);
    } catch (err) {
      setError(`同步失败：${errorMessage(err)}`);
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
    setSyncBusy(true);
    try {
      const nextSkills = await api.syncSkill(syncDraft.skill.id, syncDraft.selectedAgentIds);
      setSkills(nextSkills);
      if (activeTab) {
        const refreshed = nextSkills.find((s) => s.name === activeTab.skill.name && s.agentId === activeTab.skill.agentId);
        if (refreshed) {
          updateActiveTab({ skill: refreshed });
          const newTargets = await api.getSyncTargets(refreshed.id);
          updateActiveTab({ syncTargets: newTargets });
        }
      }
      showToast(`已同步到 ${selectedTargets.map((target) => target.agentName).join("、")}`);
      setSyncDraft(null);
    } catch (err) {
      setError(`同步失败：${errorMessage(err)}`);
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

  const [pendingScrollY, setPendingScrollY] = useState<number | null>(null);
  const tabScrollRef = useRef<Map<string, number>>(new Map());

  function switchTab(index: number) {
    // Save current tab's scroll position synchronously to ref
    if (activeTabIndex >= 0) {
      const currentTab = tabs[activeTabIndex];
      if (currentTab) {
        const key = `${currentTab.skill.name}::${currentTab.selectedFile}`;
        tabScrollRef.current.set(key, mainRef.current?.scrollTop ?? 0);
      }
    }
    // Read target tab's scroll position from ref
    const targetTab = tabs[index];
    const targetScrollY = targetTab
      ? (tabScrollRef.current.get(`${targetTab.skill.name}::${targetTab.selectedFile}`) ?? 0)
      : 0;
    setActiveTabIndex(index);
    setPendingScrollY(targetScrollY);
  }

  // Restore scroll position after render completes
  useEffect(() => {
    if (pendingScrollY !== null) {
      const el = mainRef.current;
      if (!el) return;
      // Try restoring multiple times to handle async editor mount
      let restored = false;
      function restore() {
        if (restored || !mainRef.current) return;
        mainRef.current.scrollTop = pendingScrollY!;
        restored = true;
      }
      restore();
      const t1 = setTimeout(restore, 50);
      const t2 = setTimeout(restore, 200);
      const t3 = setTimeout(() => { restore(); setPendingScrollY(null); }, 350);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
  }, [activeTabIndex, pendingScrollY]);

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
          <button className={navClass(activeTabIndex < 0 && Boolean(filter.starred))} onClick={() => {
            const newFilter = { starred: true };
            if (activeTabIndex >= 0) {
              const currentTab = tabs[activeTabIndex];
              if (currentTab) {
                const key = `${currentTab.skill.name}::${currentTab.selectedFile}`;
                tabScrollRef.current.set(key, mainRef.current?.scrollTop ?? 0);
              }
              setHomeState({ pane: "skills", filter: newFilter, scrollY: 0 });
              setPendingScrollY(0);
            } else {
              setHomeState((prev) => ({ ...prev, filter: newFilter, scrollY: 0 }));
            }
            setActiveTabIndex(-1);
            setPane("skills");
            setFilter(newFilter);
          }}>
            <Star size={16} /> 收藏夹 <span className="nav-count">{new Set(skills.filter((skill) => skill.starred).map((skill) => skill.name)).size}</span>
          </button>
        </nav>

        <div className="section-title">Agents</div>
        <nav className="nav-section grow">
          {agents.map((agent) => {
            const agentConfig = settings.customAgents.find((a) => a.id === agent.id);
            const categories = agentConfig?.categories ?? [];
            return (
              <div key={agent.id} className="agent-nav-group">
                <div className="agent-nav-row">
                  <button className={navClass(activeTabIndex < 0 && filter.agentId === agent.id && !filter.categoryId)} onClick={() => {
                    const newFilter = { agentId: agent.id };
                    if (activeTabIndex >= 0) {
                      const currentTab = tabs[activeTabIndex];
                      if (currentTab) {
                        const key = `${currentTab.skill.name}::${currentTab.selectedFile}`;
                        tabScrollRef.current.set(key, mainRef.current?.scrollTop ?? 0);
                      }
                      setHomeState({ pane: "skills", filter: newFilter, scrollY: 0 });
                      setPendingScrollY(0);
                    } else {
                      setHomeState((prev) => ({ ...prev, filter: newFilter, scrollY: 0 }));
                    }
                    setActiveTabIndex(-1);
                    setPane("skills");
                    setFilter(newFilter);
                  }}>
                    <AgentIcon icon={agent.icon || ""} size={16} /> <span className="agent-name">{agent.name}</span>
                    <span className="nav-count">{new Set(skills.filter((skill) => skill.agentId === agent.id).map((skill) => skill.name)).size}</span>
                  </button>
                  <button className="add-category-icon" onClick={(e) => {
                    e.stopPropagation();
                    const newCat = { id: `cat-${crypto.randomUUID().slice(0, 8)}`, name: nextDefaultName(agentConfig?.categories ?? [], "新分类"), skillNames: [] as string[] };
                    const newCats = [...(agentConfig?.categories ?? []), newCat];
                    updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                    setEditingCategoryId(newCat.id);
                    setConfirmDeleteCategoryId(null);
                  }} title="添加子分类"><Plus size={14} /></button>
                </div>
                <div className="agent-categories">
                  {categories.map((cat) => (
                    <div key={cat.id} className="sidebar-category-item">
                      {editingCategoryId === cat.id ? (
                        <InlineInput
                          placeholder="分类名称"
                          initialValue={cat.name}
                          onSubmit={(name) => {
                            const newCats = (agentConfig?.categories ?? []).map((c) => c.id === cat.id ? { ...c, name } : c);
                            updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                            setEditingCategoryId(null);
                          }}
                          onCancel={() => setEditingCategoryId(null)}
                        />
                      ) : (
                        <>
                          <button
                            className={navClass(activeTabIndex < 0 && filter.categoryId === cat.id && filter.categoryAgentId === agent.id)}
                            onClick={() => {
                              const newFilter = { agentId: agent.id, categoryId: cat.id, categoryAgentId: agent.id };
                              if (activeTabIndex >= 0) {
                                const currentTab = tabs[activeTabIndex];
                                if (currentTab) {
                                  const key = `${currentTab.skill.name}::${currentTab.selectedFile}`;
                                  tabScrollRef.current.set(key, mainRef.current?.scrollTop ?? 0);
                                }
                                setHomeState({ pane: "skills", filter: newFilter, scrollY: 0 });
                                setPendingScrollY(0);
                              } else {
                                setHomeState((prev) => ({ ...prev, filter: newFilter, scrollY: 0 }));
                              }
                              setActiveTabIndex(-1);
                              setPane("skills");
                              setFilter(newFilter);
                            }}
                          >
                            <span className="category-dot" /><span className="agent-name">{cat.name}</span>
                            <span className="nav-count">{cat.skillNames.length}</span>
                          </button>
                          {confirmDeleteCategoryId === cat.id ? (
                            <div className="sidebar-confirm">
                              <span className="sidebar-confirm-label">删除?</span>
                              <button className="icon-btn danger" onClick={(e) => {
                                e.stopPropagation();
                                const newCats = (agentConfig?.categories ?? []).filter((c) => c.id !== cat.id);
                                updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                                setConfirmDeleteCategoryId(null);
                              }} title="确认删除"><Check size={12} /></button>
                              <button className="icon-btn" onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteCategoryId(null);
                              }} title="取消"><X size={12} /></button>
                            </div>
                          ) : (
                            <div className="sidebar-item-actions">
                              <button className="icon-btn" onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteCategoryId(null);
                                setEditingCategoryId(cat.id);
                              }} title="重命名"><SettingsIcon size={12} /></button>
                              <button className="icon-btn danger" onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteCategoryId(cat.id);
                              }} title="删除"><Trash2 size={12} /></button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="section-title">
          <span>标签</span>
          <button className="add-btn" onClick={() => {
            const colors = ["#7dd3fc", "#86efac", "#fcd34d", "#fca5a5", "#c4b5fd", "#fdba74", "#a5b4fc"];
            const color = colors[settings.customTags.length % colors.length];
            const newTag = { id: `tag-${crypto.randomUUID().slice(0, 8)}`, name: nextDefaultName(settings.customTags, "新标签"), color };
            updateSettings({ ...settings, customTags: [...settings.customTags, newTag] });
            setEditingTagId(newTag.id);
            setConfirmDeleteTagId(null);
          }} title="添加标签"><Plus size={14} /></button>
        </div>
        <nav className="nav-section">
          {settings.customTags.map((tag) => (
            <div key={tag.id} className="sidebar-tag-item">
              {editingTagId === tag.id ? (
                <InlineInput
                  placeholder="标签名称"
                  initialValue={tag.name}
                  onSubmit={(name) => {
                    updateSettings({ ...settings, customTags: settings.customTags.map((t) => t.id === tag.id ? { ...t, name } : t) });
                    setEditingTagId(null);
                  }}
                  onCancel={() => setEditingTagId(null)}
                />
              ) : (
                <>
                  <button className={navClass(activeTabIndex < 0 && filter.tagId === tag.id)} onClick={() => {
                    const newFilter = { tagId: tag.id };
                    if (activeTabIndex >= 0) {
                      const currentTab = tabs[activeTabIndex];
                      if (currentTab) {
                        const key = `${currentTab.skill.name}::${currentTab.selectedFile}`;
                        tabScrollRef.current.set(key, mainRef.current?.scrollTop ?? 0);
                      }
                      setHomeState({ pane: "skills", filter: newFilter, scrollY: 0 });
                      setPendingScrollY(0);
                    } else {
                      setHomeState((prev) => ({ ...prev, filter: newFilter, scrollY: 0 }));
                    }
                    setActiveTabIndex(-1);
                    setPane("skills");
                    setFilter(newFilter);
                  }}>
                    <span className="tag-dot" style={{ background: tag.color }} /> <span className="agent-name">{tag.name}</span>
                  </button>
                  {confirmDeleteTagId === tag.id ? (
                    <div className="sidebar-confirm">
                      <span className="sidebar-confirm-label">删除?</span>
                      <button className="icon-btn danger" onClick={(e) => {
                        e.stopPropagation();
                        updateSettings({ ...settings, customTags: settings.customTags.filter((t) => t.id !== tag.id) });
                        setConfirmDeleteTagId(null);
                      }} title="确认删除"><Check size={12} /></button>
                      <button className="icon-btn" onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteTagId(null);
                      }} title="取消"><X size={12} /></button>
                    </div>
                  ) : (
                    <div className="sidebar-item-actions">
                      <button className="icon-btn" onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteTagId(null);
                        setEditingTagId(tag.id);
                      }} title="重命名"><SettingsIcon size={12} /></button>
                      <button className="icon-btn danger" onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteTagId(tag.id);
                      }} title="删除"><Trash2 size={12} /></button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </nav>

        <div className="sidebar-actions">
          <button className="ghost-button" onClick={refresh}><RefreshCcw size={16} /> 扫描</button>
          <button className="ghost-button" onClick={() => {
            if (activeTabIndex >= 0) {
              const currentTab = tabs[activeTabIndex];
              if (currentTab) {
                const key = `${currentTab.skill.name}::${currentTab.selectedFile}`;
                tabScrollRef.current.set(key, mainRef.current?.scrollTop ?? 0);
              }
              setHomeState({ pane: "settings", filter: {}, scrollY: 0 });
              setPendingScrollY(0);
            } else {
              setHomeState((prev) => ({ ...prev, pane: "settings", filter: {}, scrollY: 0 }));
            }
            setActiveTabIndex(-1);
            setPane("settings");
          }}><SettingsIcon size={16} /> 设置</button>
        </div>
      </aside>

      <main className="main" ref={mainRef}>
        <div className="tab-bar">
          <button
            className={activeTabIndex < 0 ? "tab home-tab active" : "tab home-tab"}
            onClick={() => {
              if (activeTabIndex >= 0) {
                // Save current tab scroll to ref
                const currentTab = tabs[activeTabIndex];
                if (currentTab) {
                  const key = `${currentTab.skill.name}::${currentTab.selectedFile}`;
                  tabScrollRef.current.set(key, mainRef.current?.scrollTop ?? 0);
                }
                setPendingScrollY(homeState.scrollY);
              } else {
                // Already on home - save current scroll position
                setHomeState((prev) => ({ ...prev, scrollY: mainRef.current?.scrollTop ?? 0 }));
              }
              setActiveTabIndex(-1);
              setPane(homeState.pane);
              setFilter(homeState.filter);
            }}
            title="Skill 总览"
          >
            <Home size={14} />
          </button>
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
                tags={settings.customTags}
                value={activeTab.skill.tags}
                onChange={updateSelectedSkillTags}
              />
              <h2>子分类</h2>
              <CategoryPicker
                agentId={activeTab.skill.agentId}
                skillName={activeTab.skill.name}
                settings={settings}
                onChange={updateSettings}
              />
              <h2>同步到</h2>
              <div className="sync-list">
                {activeTab.syncTargets.length === 0 ? (
                  <p className="muted-copy">没有其他已启用的 Agent。可在设置中启用更多 Agent。</p>
                ) : activeTab.syncTargets.every((t) => t.status === "same") ? (
                  <>
                    {activeTab.syncTargets.map((target) => {
                      const agent = agents.find((a) => a.id === target.agentId);
                      return (
                        <button key={target.agentId} disabled title={target.targetPath}>
                          <AgentIcon icon={agent?.icon || ""} size={14} />
                          <span>{target.agentName}</span>
                          <em>{statusLabel(target.status)}</em>
                        </button>
                      );
                    })}
                    <p className="muted-copy">所有目标均已同步，无需操作。</p>
                  </>
                ) : (
                  activeTab.syncTargets.map((target) => {
                    const agent = agents.find((a) => a.id === target.agentId);
                    return (
                      <button key={target.agentId} disabled={target.status === "same"} title={target.targetPath} onClick={() => syncSelected(target)}>
                        <AgentIcon icon={agent?.icon || ""} size={14} />
                        <span>{target.agentName}</span>
                        <em>{statusLabel(target.status)}</em>
                      </button>
                    );
                  })
                )}
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
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !syncBusy) setSyncDraft(null); }}>
          <section className="sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-title">
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
              ) : syncDraft.targets.every((t) => t.status === "same") ? (
                <p className="muted-copy">该 Skill 已存在于所有已启用的 Agent 中，且内容一致，无需同步。</p>
              ) : (
                syncDraft.targets.map((target) => {
                  const agent = agents.find((a) => a.id === target.agentId);
                  return (
                    <label key={target.agentId} className={target.status === "same" ? "sync-target-row disabled" : "sync-target-row"}>
                      <input
                        type="checkbox"
                        disabled={target.status === "same" || syncBusy}
                        checked={syncDraft.selectedAgentIds.includes(target.agentId)}
                        onChange={() => toggleSyncDraftTarget(target.agentId)}
                      />
                      <AgentIcon icon={agent?.icon || ""} size={14} />
                      <span>
                        <strong>{target.agentName}</strong>
                        <em title={target.targetPath}>{target.targetPath}</em>
                      </span>
                      <b className={`sync-badge ${target.status}`}>{statusLabel(target.status)}</b>
                    </label>
                  );
                })
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

      {cloningSkill && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setCloningSkill(null)}>
          <section className="sync-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <header>
              <h2>克隆 {cloningSkill.displayName}</h2>
              <button className="icon-button" onClick={() => setCloningSkill(null)}><X size={16} /></button>
            </header>
            <div style={{ padding: 14 }}>
              <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 13 }}>输入克隆后的 Skill 名称：</p>
              <InlineInput
                wide
                placeholder={`${cloningSkill.name}-copy`}
                onSubmit={(name) => void doCloneSkill(cloningSkill, name)}
                onCancel={() => setCloningSkill(null)}
              />
            </div>
          </section>
        </div>
      )}

      <footer className="statusbar">
        <span>{agents.length} agents</span>
        <span>{new Set(skills.map((skill) => skill.name)).size} skills</span>
        {activeTab && <span>{saveStateText(activeTab.saveState)}</span>}
      </footer>

      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>{toast.message}</div>
        ))}
      </div>
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
          {canSync && <button onClick={(e) => { e.stopPropagation(); onSync(skill); }}>同步</button>}
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
        const agent = agents.find((a) => a.id === id);
        return <AgentIcon key={id} icon={agent?.icon || ""} size={14} />;
      })}
      {hiddenCount > 0 && <span className="agent-more">+{hiddenCount}</span>}
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

function CategoryPicker({
  agentId,
  skillName,
  settings,
  onChange
}: {
  agentId: string;
  skillName: string;
  settings: Settings;
  onChange: (settings: Settings) => void;
}) {
  const agentConfig = settings.customAgents.find((a) => a.id === agentId);
  const categories = agentConfig?.categories || [];

  if (categories.length === 0) {
    return <p className="muted-copy">该 Agent 暂无子分类，可在设置中添加。</p>;
  }

  function toggleCategory(categoryId: string, currentlyInCategory: boolean) {
    const newCategories = (agentConfig?.categories || []).map((cat) => {
      if (cat.id !== categoryId) return cat;
      const newSkillNames = currentlyInCategory
        ? cat.skillNames.filter((n) => n !== skillName)
        : [...cat.skillNames, skillName];
      return { ...cat, skillNames: newSkillNames };
    });
    onChange({
      ...settings,
      customAgents: settings.customAgents.map((a) =>
        a.id === agentId ? { ...a, categories: newCategories } : a
      )
    });
  }

  return (
    <div className="category-picker">
      {categories.map((cat) => {
        const isInCategory = cat.skillNames.includes(skillName);
        return (
          <button
            key={cat.id}
            className={isInCategory ? "selected" : ""}
            onClick={() => toggleCategory(cat.id, isInCategory)}
          >
            <span className="category-dot" style={{ background: isInCategory ? "var(--accent)" : "var(--muted)" }} />
            {cat.name}
          </button>
        );
      })}
    </div>
  );
}

function SettingsPanel({ settings, onChange }: { settings: Settings; onChange: (settings: Settings) => void }) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTag, setEditingTag] = useState<Tag>({ id: "", name: "", color: "#7dd3fc" });
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [addingTag, setAddingTag] = useState(false);
  const [addingCategoryForAgent, setAddingCategoryForAgent] = useState<string | null>(null);
  const [addingAgent, setAddingAgent] = useState(false);
  const [addingAgentStep, setAddingAgentStep] = useState<"name" | "path">("name");
  const [addingAgentName, setAddingAgentName] = useState("");

  function addTagWithName(name: string) {
    const colors = ["#7dd3fc", "#86efac", "#fcd34d", "#fca5a5", "#c4b5fd", "#fdba74", "#a5b4fc"];
    const color = colors[settings.customTags.length % colors.length];
    const newTag: Tag = {
      id: `tag-${crypto.randomUUID().slice(0, 8)}`,
      name,
      color
    };
    onChange({ ...settings, customTags: [...settings.customTags, newTag] });
    setAddingTag(false);
  }

  function startEditTag(tag: Tag) {
    setEditingTagId(tag.id);
    setEditingTag({ ...tag });
  }

  function saveTagEdit() {
    if (!editingTag.name.trim()) return;
    onChange({
      ...settings,
      customTags: settings.customTags.map((t) => t.id === editingTagId ? editingTag : t)
    });
    setEditingTagId(null);
  }

  function deleteTag(id: string) {
    onChange({
      ...settings,
      customTags: settings.customTags.filter((t) => t.id !== id)
    });
  }

  function addCategoryWithName(agentId: string, name: string) {
    const newCat = {
      id: `cat-${crypto.randomUUID().slice(0, 8)}`,
      name,
      skillNames: [] as string[]
    };
    onChange({
      ...settings,
      customAgents: settings.customAgents.map((a) =>
        a.id === agentId ? { ...a, categories: [...(a.categories || []), newCat] } : a
      )
    });
    setAddingCategoryForAgent(null);
  }

  function startEditCategory(cat: { id: string; name: string }) {
    setEditingCategoryId(cat.id);
    setEditingCategoryName(cat.name);
  }

  function saveCategoryEdit(agentId: string) {
    if (!editingCategoryName.trim()) return;
    onChange({
      ...settings,
      customAgents: settings.customAgents.map((a) =>
        a.id === agentId
          ? { ...a, categories: (a.categories || []).map((c) => c.id === editingCategoryId ? { ...c, name: editingCategoryName } : c) }
          : a
      )
    });
    setEditingCategoryId(null);
  }

  function deleteCategory(agentId: string, categoryId: string) {
    onChange({
      ...settings,
      customAgents: settings.customAgents.map((a) =>
        a.id === agentId
          ? { ...a, categories: (a.categories || []).filter((c) => c.id !== categoryId) }
          : a
      )
    });
  }

  function updateCategorySkills(agentId: string, categoryId: string, skillNames: string[]) {
    onChange({
      ...settings,
      customAgents: settings.customAgents.map((a) =>
        a.id === agentId
          ? { ...a, categories: (a.categories || []).map((c) => c.id === categoryId ? { ...c, skillNames } : c) }
          : a
      )
    });
  }

  function addCustomAgentWithPath(path: string) {
    onChange({
      ...settings,
      customAgents: [
        ...settings.customAgents,
        {
          id: `custom-${crypto.randomUUID()}`,
          name: addingAgentName,
          paths: [path],
          enabled: true,
          builtin: false,
          icon: "custom",
          categories: []
        }
      ]
    });
    setAddingAgent(false);
    setAddingAgentStep("name");
    setAddingAgentName("");
  }

  function updateAgentConfig(id: string, patch: Partial<Settings["customAgents"][number]>) {
    onChange({
      ...settings,
      customAgents: settings.customAgents.map((agent) => agent.id === id ? { ...agent, ...patch } : agent)
    });
  }

  function removeCustomAgent(id: string) {
    if (selectedAgentId === id) setSelectedAgentId(null);
    onChange({
      ...settings,
      customAgents: settings.customAgents.filter((agent) => agent.id !== id)
    });
  }

  const selectedAgent = selectedAgentId ? settings.customAgents.find((a) => a.id === selectedAgentId) : null;

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
        <ShortcutInput value={settings.shortcut} onChange={(shortcut) => onChange({ ...settings, shortcut })} />
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
            <strong>标签管理</strong>
            <span>管理用于分类 Skill 的标签。</span>
          </div>
          {addingTag ? (
            <InlineInput placeholder="标签名称" onSubmit={addTagWithName} onCancel={() => setAddingTag(false)} />
          ) : (
            <button onClick={() => setAddingTag(true)}>添加标签</button>
          )}
        </header>
        <div className="tag-manager">
          {settings.customTags.map((tag) => (
            <div key={tag.id} className="tag-manager-item">
              <span className="tag-dot" style={{ background: tag.color }} />
              {editingTagId === tag.id ? (
                <>
                  <input
                    className="tag-edit-input"
                    value={editingTag.name}
                    onChange={(e) => setEditingTag({ ...editingTag, name: e.target.value })}
                  />
                  <input
                    type="color"
                    className="tag-edit-color"
                    value={editingTag.color}
                    onChange={(e) => setEditingTag({ ...editingTag, color: e.target.value })}
                  />
                  <button className="tag-edit-save" onClick={saveTagEdit}>保存</button>
                  <button className="tag-edit-cancel" onClick={() => setEditingTagId(null)}>取消</button>
                </>
              ) : (
                <>
                  <span className="tag-manager-name">{tag.name}</span>
                  <button className="tag-edit-btn" onClick={() => startEditTag(tag)}>编辑</button>
                  <button className="tag-delete-btn" onClick={() => deleteTag(tag.id)}>删除</button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="custom-agent-panel">
        <header>
          <div>
            <strong>Agent 目录</strong>
            <span>点击 Agent 图标查看或编辑 Skill 路径；启用后会显示在左侧。</span>
          </div>
          {addingAgent ? (
            addingAgentStep === "name" ? (
              <InlineInput
                placeholder="Agent 名称"
                onSubmit={(name) => { setAddingAgentName(name); setAddingAgentStep("path"); }}
                onCancel={() => { setAddingAgent(false); setAddingAgentStep("name"); setAddingAgentName(""); }}
              />
            ) : (
              <InlineInput
                placeholder="Skill 目录路径"
                onSubmit={addCustomAgentWithPath}
                onCancel={() => { setAddingAgent(false); setAddingAgentStep("name"); setAddingAgentName(""); }}
              />
            )
          ) : (
            <button onClick={() => setAddingAgent(true)}>添加 Agent</button>
          )}
        </header>
        <div className="agent-chips">
          {settings.customAgents.map((agent) => (
            <button
              key={agent.id}
              className={`agent-chip ${selectedAgentId === agent.id ? "active" : ""} ${!agent.enabled ? "disabled" : ""}`}
              onClick={() => setSelectedAgentId(selectedAgentId === agent.id ? null : agent.id)}
              title={agent.name}
            >
              <AgentIcon icon={agent.icon || ""} size={18} />
              <span>{agent.name}</span>
            </button>
          ))}
        </div>
        {selectedAgent && (
          <div className="agent-detail">
            <div className="agent-detail-header">
              <label className="toggle-row">
                <input type="checkbox" checked={selectedAgent.enabled} onChange={(event) => updateAgentConfig(selectedAgent.id, { enabled: event.target.checked })} />
                <span>启用</span>
              </label>
              {!selectedAgent.builtin && (
                <button className="remove-btn" onClick={() => removeCustomAgent(selectedAgent.id)}>移除</button>
              )}
            </div>
            <div className="agent-detail-paths">
              <label>Skill 目录路径（每行一个，支持 ~）</label>
              <textarea
                value={selectedAgent.paths.join("\n")}
                onChange={(event) => updateAgentConfig(selectedAgent.id, { paths: event.target.value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) })}
                rows={Math.max(2, Math.min(4, selectedAgent.paths.length))}
              />
            </div>
            <div className="agent-detail-categories">
              <div className="agent-detail-categories-header">
                <label>Skill 子分类</label>
                {addingCategoryForAgent === selectedAgent.id ? (
                  <InlineInput placeholder="分类名称" compact onSubmit={(name) => addCategoryWithName(selectedAgent.id, name)} onCancel={() => setAddingCategoryForAgent(null)} />
                ) : (
                  <button className="small-btn" onClick={() => setAddingCategoryForAgent(selectedAgent.id)}>添加分类</button>
                )}
              </div>
              <div className="category-list">
                {(selectedAgent.categories || []).map((cat) => (
                  <div key={cat.id} className="category-item">
                    {editingCategoryId === cat.id ? (
                      <>
                        <input
                          className="tag-edit-input"
                          value={editingCategoryName}
                          onChange={(e) => setEditingCategoryName(e.target.value)}
                          placeholder="分类名称"
                        />
                        <button className="tag-edit-save" onClick={() => saveCategoryEdit(selectedAgent.id)}>保存</button>
                        <button className="tag-edit-cancel" onClick={() => setEditingCategoryId(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <span className="category-name">{cat.name}</span>
                        <span className="category-count">{cat.skillNames.length} 个 Skill</span>
                        <button className="tag-edit-btn" onClick={() => startEditCategory(cat)}>编辑</button>
                        <button className="tag-delete-btn" onClick={() => deleteCategory(selectedAgent.id, cat.id)}>删除</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
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

function ShortcutInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [display, setDisplay] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  function handleKeyDown(event: React.KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();

    const parts: string[] = [];
    if (event.metaKey) parts.push("Cmd");
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");

    const key = event.key;
    if (["Meta", "Control", "Alt", "Shift", "Cmd"].includes(key)) {
      setDisplay(parts.join("+") || value);
      return;
    }

    const shortcut = [...parts, key.length === 1 ? key.toUpperCase() : key].join("+");
    setDisplay(shortcut);
    onChange(shortcut);
    setRecording(false);
  }

  function handleFocus() {
    setRecording(true);
    setDisplay("");
  }

  function handleBlur() {
    setRecording(false);
    setDisplay(value);
  }

  return (
    <input
      ref={ref}
      className={recording ? "shortcut-input recording" : "shortcut-input"}
      value={display}
      readOnly
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder="点击后按下组合键"
    />
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

function InlineInput({ placeholder, autoFocus = true, compact = false, wide = false, initialValue = "", onSubmit, onCancel }: {
  placeholder: string;
  autoFocus?: boolean;
  compact?: boolean;
  wide?: boolean;
  initialValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [autoFocus]);

  function handleConfirm() {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  }

  return (
    <span className={`inline-input-wrap${compact ? " compact" : ""}${wide ? " wide" : ""}`}>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="inline-input-field"
        onKeyDown={(e) => {
          if (e.key === "Enter") handleConfirm();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={handleConfirm}
      />
      <button className="inline-input-btn" onMouseDown={(e) => { e.preventDefault(); handleConfirm(); }}>
        <Check size={compact ? 10 : 12} />
      </button>
    </span>
  );
}

function navClass(active: boolean) {
  return active ? "active" : "";
}

function nextDefaultName(existing: { name: string }[], base: string) {
  const names = new Set(existing.map((item) => item.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
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
