import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { CSSProperties } from "react";
import { ink } from "ink-mde";
import type { Instance } from "ink-mde";
import {
  Archive,
  AlertTriangle,
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  FileText,
  FolderOpen,
  GitCompare,
  ChevronLeft,
  Folder,
  Github,
  HelpCircle,
  Home,
  Grid2X2,
  History,
  Languages,
  Laptop,
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
  Tags,
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
import type { Agent, ProvenanceStatus, ReadFileResult, ScanIssue, Settings, Skill, SkillCategory, SkillFilter, SkillProvenance, Snapshot, SyncTargetStatus, Tag, TranslationConfig, UpdateInfo } from "./types";

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
type TabTranslation = {
  status: "idle" | "loading" | "done" | "error";
  text: string;
  error: string;
  showing: boolean;
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
  translation?: TabTranslation;
};

const defaultTags: Tag[] = [
  { id: "writing", name: "写作", color: "#7dd3fc" },
  { id: "coding", name: "开发", color: "#86efac" },
  { id: "review", name: "审查", color: "#fcd34d" }
];

const defaultSettings: Settings = {
  theme: "dark",
  shortcut: navigator.platform.toLowerCase().includes("mac") ? "Cmd+Shift+K" : "Ctrl+Shift+K",
  minimizeToTray: true,
  customAgents: [],
  snapshotsEnabled: true,
  customTags: defaultTags,
  provenanceAgentId: null,
  translation: { protocol: "openai", baseUrl: "", apiKey: "", model: "", targetLang: "zh-CN" }
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
  const [translateCards, setTranslateCards] = useState(false);
  const [cardZh, setCardZh] = useState<Record<string, string>>({});
  const cardQueue = useRef<{ queue: Skill[]; active: number; seen: Set<string> }>({ queue: [], active: 0, seen: new Set() });
  const [openFolder, setOpenFolder] = useState<FolderRef | null>(null);
  const dragSkillRef = useRef<Skill | null>(null);
  const mouseDragRef = useRef<{ skill: Skill; chipEl: HTMLElement } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [folderToggle, setFolderToggle] = useState<Map<string, boolean>>(new Map());
  const [pane, setPane] = useState<Pane>("skills");
  const [homeState, setHomeState] = useState<{ pane: Pane; filter: SkillFilter; scrollY: number }>({ pane: "skills", filter: {}, scrollY: 0 });
  const mainRef = useRef<HTMLElement>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(-1);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [scanIssues, setScanIssues] = useState<ScanIssue[]>([]);
  const [syncDraft, setSyncDraft] = useState<SyncDraft | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [provenance, setProvenance] = useState<Map<string, SkillProvenance>>(new Map());
  const [traceProgress, setTraceProgress] = useState<{ done: number; total: number } | null>(null);
  const [provFilter, setProvFilter] = useState<ProvenanceStatus | "all">("all");
  const [showProvenanceInfo, setShowProvenanceInfo] = useState(false);
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
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Check for updates on startup (after a short delay so the UI settles)
  useEffect(() => {
    const timer = setTimeout(() => {
      api.checkForUpdates().then((info) => {
        setUpdateInfo(info);
      }).catch(() => {
        // Silently ignore — GitHub may be unreachable
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  function dismissUpdatePanel() {
    if (updateInfo) {
      api.dismissUpdate(updateInfo.latestVersion).catch(() => {});
      setUpdateDismissed(true);
    }
  }

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
      if (provFilter !== "all" && (provenance.get(skill.name)?.status ?? "unknown") !== provFilter) return false;
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
  }, [filter, query, skills, settings.customAgents, provFilter, provenance]);

  // Skills that live inside any manual folder should NOT appear in the overview.
  const classifiedNames = useMemo(() => {
    const names = new Set<string>();
    for (const agent of settings.customAgents) {
      for (const cat of agent.categories ?? []) {
        for (const n of cat.skillNames) names.add(n);
      }
    }
    return names;
  }, [settings.customAgents]);

  const overviewSkills = useMemo(
    () => visibleSkills.filter((s) => !classifiedNames.has(s.name)),
    [visibleSkills, classifiedNames],
  );

  // T2 directory clustering + T5 majority-vote repo: group the visible skills by
  // their shared install-root directory (e.g. `skills/gstack/...`). A root that
  // holds ≥2 distinct skills is a bundle; singletons fall through to standalone.
  const { bundleGroups, standaloneSkills } = useMemo(() => {
    const groups = new Map<string, { root: string; agentId: string; skills: Skill[] }>();
    for (const skill of overviewSkills) {
      const root = bundleRootOf(skill, agents);
      const key = `${skill.agentId}::${root}`;
      let g = groups.get(key);
      if (!g) { g = { root, agentId: skill.agentId, skills: [] }; groups.set(key, g); }
      g.skills.push(skill);
    }
    const bundleGroups: BundleGroup[] = [];
    const standalone: Skill[] = [];
    for (const [key, g] of groups) {
      if (g.skills.length < 2) { standalone.push(...g.skills); continue; }
      const repoCount = new Map<string, number>();
      for (const s of g.skills) {
        const repo = provenance.get(s.name)?.repo;
        if (repo) repoCount.set(repo, (repoCount.get(repo) ?? 0) + 1);
      }
      let repo: string | null = null;
      let repoShare = 0;
      for (const [r, c] of repoCount) { if (c > repoShare) { repoShare = c; repo = r; } }
      bundleGroups.push({
        key,
        name: g.root,
        agentId: g.agentId,
        repo,
        repoShare,
        total: g.skills.length,
        skills: g.skills.slice().sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    bundleGroups.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    standalone.sort((a, b) => a.name.localeCompare(b.name));
    return { bundleGroups, standaloneSkills: standalone };
  }, [overviewSkills, agents, provenance]);

  // Clear the open folder when the user switches starred / tag via the sidebar
  // (agent switch is handled by each handler's setOpenFolder(null) directly).
  useEffect(() => {
    setOpenFolder(null);
  }, [filter.starred, filter.tagId]);

  // Folder cards shown at the top of the overview: auto clusters (from the
  // current view) + manual categories (agent-filtered, includes empty ones so
  // they can be drop targets). Auto first, then categories.
  const folderCards = useMemo<FolderCardModel[]>(() => {
    const autoCards: FolderCardModel[] = bundleGroups.map((b) => ({
      ref: { kind: "auto", key: b.key },
      kind: "auto",
      name: b.name,
      count: b.total,
      agentId: b.agentId,
      repo: b.repo,
      repoShare: b.repoShare,
      total: b.total,
    }));
    const catCards: FolderCardModel[] = [];
    for (const agent of settings.customAgents) {
      if (filter.agentId && agent.id !== filter.agentId) continue;
      for (const cat of agent.categories ?? []) {
        catCards.push({
          ref: { kind: "category", agentId: agent.id, categoryId: cat.id },
          kind: "category",
          name: cat.name,
          count: cat.skillNames.length,
          agentId: agent.id,
          categoryId: cat.id,
          repo: null,
          repoShare: 0,
          total: cat.skillNames.length,
        });
      }
    }
    catCards.sort((a, b) => a.name.localeCompare(b.name));
    return [...autoCards, ...catCards];
  }, [bundleGroups, settings.customAgents, filter.agentId]);

  // Auto-detected folders per agent for the sidebar (computed from ALL skills,
  // independent of the current filter). Keyed identically to bundleGroups.
  const autoFoldersByAgent = useMemo(() => {
    const byAgent = new Map<string, Map<string, Set<string>>>();
    for (const skill of skills) {
      const root = bundleRootOf(skill, agents);
      if (!byAgent.has(skill.agentId)) byAgent.set(skill.agentId, new Map());
      const roots = byAgent.get(skill.agentId)!;
      if (!roots.has(root)) roots.set(root, new Set());
      roots.get(root)!.add(skill.name);
    }
    const out = new Map<string, { key: string; name: string; count: number }[]>();
    for (const [agentId, roots] of byAgent) {
      const list: { key: string; name: string; count: number }[] = [];
      for (const [root, names] of roots) {
        if (names.size >= 2) list.push({ key: `${agentId}::${root}`, name: root, count: names.size });
      }
      list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      out.set(agentId, list);
    }
    return out;
  }, [skills, agents]);

  const provFilterOptions = useMemo<SelectOption<ProvenanceStatus | "all">[]>(() => {
    const counts: Record<string, number> = { all: 0, verified: 0, likely: 0, ambiguous: 0, local: 0, unknown: 0 };
    const seen = new Set<string>();
    for (const skill of skills) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      const status = provenance.get(skill.name)?.status ?? "unknown";
      counts.all += 1;
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return [
      { value: "all", label: `全部来源 (${counts.all})` },
      { value: "verified", label: `已验证 (${counts.verified})` },
      { value: "likely", label: `疑似 (${counts.likely})` },
      { value: "ambiguous", label: `歧义 (${counts.ambiguous})` },
      { value: "local", label: `仅本地 (${counts.local})` },
      { value: "unknown", label: `未溯源 (${counts.unknown})` },
    ];
  }, [skills, provenance]);

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

  // Keep the native window appearance in sync with the in-app theme so the macOS
  // sidebar vibrancy renders light/dark to match (it follows NSAppearance, not CSS).
  useEffect(() => {
    void api.setWindowTheme(settings.theme);
  }, [settings.theme]);

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
      const [settingsResult, scanResult, provList] = await Promise.all([
        api.getSettings(),
        api.scanAgents(),
        api.getProvenance().catch(() => [] as SkillProvenance[]),
      ]);
      setSettings(settingsResult);
      setAgents(scanResult.agents);
      setSkills(scanResult.skills);
      setScanIssues(scanResult.scanErrors ?? []);
      const idToName = new Map(scanResult.skills.map((skill) => [skill.id, skill.name]));
      const provMap = mergeProvByName(new Map(), provList, idToName);
      setProvenance(provMap);
      void autoTraceProvenance(scanResult.skills, provMap, false, settingsResult.provenanceAgentId);
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
      void autoTraceProvenance(result.skills, provenance, false, settings.provenanceAgentId);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /// Trace skills whose provenance is missing or unresolved (or all, when forced).
  /// Deduplicates by name — one representative install per name — so duplicate
  /// installs across agents don't multiply network requests.
  async function autoTraceProvenance(
    skillList: Skill[],
    baseMap: Map<string, SkillProvenance>,
    force = false,
    scopeAgentId?: string | null,
  ) {
    // Optionally limit tracing to a single agent's skills (user-chosen scope).
    const scoped = scopeAgentId ? skillList.filter((skill) => skill.agentId === scopeAgentId) : skillList;
    const idToName = new Map(scoped.map((skill) => [skill.id, skill.name]));
    // One representative install per name. Names can collide across agents on
    // genuinely different content, so prefer the canonical copy whose directory
    // is named after the skill (e.g. `skills/frontend-design/` over an import
    // like `frontend-design-3-0.1.0/`) — that's the one we compare upstream.
    const isCanonical = (skill: Skill) => skill.dirPath.split(/[\\/]/).pop() === skill.name;
    const repByName = new Map<string, string>();
    const repCanonical = new Map<string, boolean>();
    for (const skill of scoped) {
      if (!force) {
        const existing = baseMap.get(skill.name);
        if (existing && existing.status !== "unknown") continue;
      }
      const canonical = isCanonical(skill);
      if (!repByName.has(skill.name)) {
        repByName.set(skill.name, skill.id);
        repCanonical.set(skill.name, canonical);
      } else if (canonical && !repCanonical.get(skill.name)) {
        repByName.set(skill.name, skill.id);
        repCanonical.set(skill.name, true);
      }
    }
    const ids = Array.from(repByName.values());
    if (ids.length === 0) return;
    setTraceProgress({ done: 0, total: ids.length });
    const BATCH = 6;
    let done = 0;
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        // A failed batch must not abort the whole job — log and keep going.
        try {
          const results = await api.traceProvenance(batch);
          setProvenance((prev) => mergeProvByName(prev, results, idToName));
        } catch (err) {
          setError(errorMessage(err));
        }
        done += batch.length;
        setTraceProgress({ done, total: ids.length });
      }
    } finally {
      setTraceProgress(null);
    }
  }

  async function retraceSkill(skill: Skill) {
    try {
      const results = await api.traceProvenance([skill.id]);
      const idToName = new Map(skills.map((item) => [item.id, item.name]));
      setProvenance((prev) => mergeProvByName(prev, results, idToName));
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
    // Editing invalidates any cached translation for this tab.
    updateActiveTab({ editorValue: value, saveState: "dirty", translation: undefined });
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

  async function toggleTranslation() {
    const tab = activeTab;
    if (!tab) return;
    const tr = tab.translation;
    // Already translated → just flip between 原文 / 译文 (instant, no API call).
    if (tr && tr.status === "done") {
      updateActiveTab({ translation: { ...tr, showing: !tr.showing } });
      return;
    }
    if (tr && tr.status === "loading") return;
    const sourceId = tabId(tab.skill, tab.selectedFile);
    updateActiveTab({ translation: { status: "loading", text: "", error: "", showing: true } });

    // Throttle live updates: buffer deltas, flush to state at most ~every 90ms.
    let pending = "";
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      const add = pending;
      pending = "";
      setTabs((prev) =>
        prev.map((t) =>
          tabId(t.skill, t.selectedFile) === sourceId
            ? { ...t, translation: { status: "loading", text: (t.translation?.text ?? "") + add, error: "", showing: true } }
            : t
        )
      );
    };

    try {
      const res = await api.translateStream(tab.editorValue, (delta) => {
        pending += delta;
        if (timer === null) timer = window.setTimeout(flush, 90);
      });
      if (timer !== null) window.clearTimeout(timer);
      setTabs((prev) =>
        prev.map((t) =>
          tabId(t.skill, t.selectedFile) === sourceId
            ? { ...t, translation: { status: "done", text: res.text, error: "", showing: true } }
            : t
        )
      );
    } catch (err) {
      if (timer !== null) window.clearTimeout(timer);
      const message = errorMessage(err);
      setTabs((prev) =>
        prev.map((t) =>
          tabId(t.skill, t.selectedFile) === sourceId
            ? { ...t, translation: { status: "error", text: "", error: message, showing: false } }
            : t
        )
      );
      setError(message);
    }
  }

  // Lazily translate card descriptions, max 3 in flight, only for cards that
  // actually render (the grid only mounts visible/filtered cards).
  const pumpCardZh = useCallback(() => {
    const c = cardQueue.current;
    while (c.active < 3 && c.queue.length > 0) {
      const skill = c.queue.shift()!;
      c.active++;
      api
        .translateMarkdown(skill.description)
        .then((res) => setCardZh((m) => ({ ...m, [skill.id]: res.text })))
        .catch(() => c.seen.delete(skill.id))
        .finally(() => {
          c.active--;
          pumpCardZh();
        });
    }
  }, []);

  const requestCardZh = useCallback(
    (skill: Skill) => {
      const c = cardQueue.current;
      if (c.seen.has(skill.id) || !skill.description.trim()) return;
      c.seen.add(skill.id);
      c.queue.push(skill);
      pumpCardZh();
    },
    [pumpCardZh]
  );

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
    // Only a change to agent paths / enabled-set / agent-set needs a disk
    // rescan. Category, tag, and name edits are pure metadata — skip the rescan
    // (avoids flicker and clobbering folder state mid-drag).
    const sig = (list: Settings["customAgents"]) =>
      JSON.stringify(list.map((a) => [a.id, a.paths, a.enabled]).sort());
    const needsRescan = sig(settings.customAgents) !== sig(next.customAgents);
    setSettings(next);
    try {
      setSettings(await api.updateSettings(next));
      if (needsRescan) {
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
  const isMacChrome = document.documentElement.classList.contains("is-macos");
  const activeSyncTargets = syncDraft?.targets.filter((target) => target.status !== "same") ?? [];

  // Resolve a folder ref to its display data + member skills (self-contained,
  // independent of the current sidebar filter). Auto folders recompute from disk
  // structure; category folders from the saved skillNames.
  function resolveFolderView(ref: FolderRef): {
    name: string;
    kind: "auto" | "category";
    repo: string | null;
    repoShare: number;
    total: number;
    skills: Skill[];
  } | null {
    const q = query.trim().toLowerCase();
    const matchQ = (s: Skill) => !q || [s.displayName, s.name, s.description].join(" ").toLowerCase().includes(q);
    if (ref.kind === "auto") {
      const sep = ref.key.indexOf("::");
      const agentId = ref.key.slice(0, sep);
      const root = ref.key.slice(sep + 2);
      const seen = new Map<string, Skill>();
      for (const s of skills) {
        if (s.agentId !== agentId || bundleRootOf(s, agents) !== root) continue;
        if (!seen.has(s.name)) seen.set(s.name, s);
      }
      if (seen.size === 0) return null;
      const repoCount = new Map<string, number>();
      for (const s of seen.values()) {
        const r = provenance.get(s.name)?.repo;
        if (r) repoCount.set(r, (repoCount.get(r) ?? 0) + 1);
      }
      let repo: string | null = null;
      let repoShare = 0;
      for (const [r, c] of repoCount) if (c > repoShare) { repoShare = c; repo = r; }
      const members = [...seen.values()].filter(matchQ).sort((a, b) => a.name.localeCompare(b.name));
      return { name: root, kind: "auto", repo, repoShare, total: seen.size, skills: members };
    }
    const cat = settings.customAgents.find((a) => a.id === ref.agentId)?.categories?.find((c) => c.id === ref.categoryId);
    if (!cat) return null;
    const names = new Set(cat.skillNames);
    const seen = new Map<string, Skill>();
    for (const s of skills) {
      if (s.agentId !== ref.agentId || !names.has(s.name)) continue;
      if (!seen.has(s.name)) seen.set(s.name, s);
    }
    const members = [...seen.values()].filter(matchQ).sort((a, b) => a.name.localeCompare(b.name));
    return { name: cat.name, kind: "category", repo: null, repoShare: 0, total: seen.size, skills: members };
  }

  // Drag-to-classify: move a skill into a manual folder. A skill lives in at
  // most ONE folder per agent, so it is removed from sibling categories and
  // added to the target.
  function addSkillToCategory(skill: Skill, agentId: string, categoryId: string) {
    const customAgents = settings.customAgents.map((a) => {
      if (a.id !== agentId) return a;
      return {
        ...a,
        categories: (a.categories ?? []).map((c) => {
          const without = c.skillNames.filter((n) => n !== skill.name);
          return c.id === categoryId ? { ...c, skillNames: [...without, skill.name] } : { ...c, skillNames: without };
        }),
      };
    });
    updateSettings({ ...settings, customAgents });
  }

  // Remove a skill from a manual folder (category).
  function removeSkillFromCategory(skill: Skill, agentId: string, categoryId: string) {
    const customAgents = settings.customAgents.map((a) => {
      if (a.id !== agentId) return a;
      return {
        ...a,
        categories: (a.categories ?? []).map((c) =>
          c.id === categoryId ? { ...c, skillNames: c.skillNames.filter((n) => n !== skill.name) } : c,
        ),
      };
    });
    updateSettings({ ...settings, customAgents });
  }

  // Drag-to-classify: attach a tag to a skill (persisted in DB via setSkillTags).
  async function addTagToSkill(skill: Skill, tag: Tag) {
    if (skill.tags.some((t) => t.id === tag.id)) return;
    try {
      const updated = await api.setSkillTags(skill.id, [...skill.tags, tag]);
      setSkills((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setTabs((prev) => prev.map((t) => (t.skill.id === updated.id ? { ...t, skill: updated } : t)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // ── Mouse-based drag (replaces HTML5 DnD which is broken in Tauri WKWebView) ──
  // Drop targets self-report via onMouseEnter/onMouseLeave during drag.

  const hoveredDropTarget = useRef<{ type: string; agentId?: string; id: string } | null>(null);

  function onDropTargetEnter(type: string, id: string, agentId?: string) {
    if (!mouseDragRef.current) return;
    hoveredDropTarget.current = { type, id, agentId };
    setDropTarget(`${type}:${id}`);
  }

  function onDropTargetLeave() {
    if (!mouseDragRef.current) return;
    hoveredDropTarget.current = null;
    setDropTarget(null);
  }

  function onSkillMouseDown(skill: Skill, e: React.MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const chip = document.createElement("div");
    chip.className = "drag-chip";
    chip.textContent = skill.displayName || skill.name;
    document.body.appendChild(chip);
    chip.style.left = `${e.clientX - 40}px`;
    chip.style.top = `${e.clientY - 16}px`;
    mouseDragRef.current = { skill, chipEl: chip };
    dragSkillRef.current = skill;
    document.addEventListener("mousemove", onDocMouseMove);
    document.addEventListener("mouseup", onDocMouseUp);
  }

  function onDocMouseMove(e: MouseEvent) {
    const d = mouseDragRef.current;
    if (!d) return;
    d.chipEl.style.left = `${e.clientX - 40}px`;
    d.chipEl.style.top = `${e.clientY - 16}px`;
  }

  function onDocMouseUp(e: MouseEvent) {
    document.removeEventListener("mousemove", onDocMouseMove);
    document.removeEventListener("mouseup", onDocMouseUp);
    const d = mouseDragRef.current;
    if (!d) return;
    d.chipEl.remove();
    mouseDragRef.current = null;
    const target = hoveredDropTarget.current;
    if (target) {
      if (target.type === "cat") {
        addSkillToCategory(d.skill, target.agentId ?? "", target.id);
      } else if (target.type === "tag") {
        const tag = settings.customTags.find((t) => t.id === target.id);
        if (tag) void addTagToSkill(d.skill, tag);
      }
    }
    hoveredDropTarget.current = null;
    dragSkillRef.current = null;
    setDropTarget(null);
  }

  function renderSkillCard(skill: Skill) {
    const folderRemove = openFolder?.kind === "category"
      ? () => removeSkillFromCategory(skill, openFolder.agentId, openFolder.categoryId)
      : undefined;
    const compact = viewMode === "list";
    return (
      <SkillCard
        key={skill.id}
        skill={skill}
        agents={agents}
        agentIds={agentPresenceBySkillName.get(skill.name) ?? [skill.agentId]}
        provenance={provenance.get(skill.name)}
        onOpen={openSkill}
        onSync={openSyncPanel}
        onToggleStar={toggleStar}
        onContextMenu={handleContextMenu}
        compact={compact}
        onMouseDown={(e) => onSkillMouseDown(skill, e)}
        onRemoveFromFolder={folderRemove}
        translateOn={translateCards}
        descriptionZh={cardZh[skill.id]}
        onRequestZh={requestCardZh}
      />
    );
  }

  return (
    <div className={`app-shell ${themeClass}`}>
      <aside className="sidebar">
        {isMacChrome && <div className="titlebar-drag" data-tauri-drag-region />}
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
            setOpenFolder(null);
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
              <AgentNavGroup
                key={agent.id}
                agent={agent}
                categories={categories}
                autoFolders={autoFoldersByAgent.get(agent.id) ?? []}
                skillCount={new Set(skills.filter((skill) => skill.agentId === agent.id).map((skill) => skill.name)).size}
                expanded={folderToggle.get(agent.id) ?? ((autoFoldersByAgent.get(agent.id) ?? []).length <= 8)}
                onToggleExpand={() => setFolderToggle((m) => {
                  const cur = m.get(agent.id) ?? ((autoFoldersByAgent.get(agent.id) ?? []).length <= 8);
                  const n = new Map(m); n.set(agent.id, !cur); return n;
                })}
                isAgentActive={activeTabIndex < 0 && filter.agentId === agent.id && !openFolder}
                openFolder={activeTabIndex < 0 ? openFolder : null}
                editingCategoryId={editingCategoryId}
                confirmDeleteCategoryId={confirmDeleteCategoryId}
                dragSkill={dragSkillRef.current}
                dropTarget={dropTarget}
                navClass={navClass}
                onSelectAgent={() => {
                  setOpenFolder(null);
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
                }}
                onOpenFolder={(ref) => { setActiveTabIndex(-1); setPane("skills"); setOpenFolder(ref); }}
                onAddCategory={() => {
                  const newCat = { id: `cat-${crypto.randomUUID().slice(0, 8)}`, name: nextDefaultName(agentConfig?.categories ?? [], "新分类"), skillNames: [] as string[] };
                  const newCats = [...(agentConfig?.categories ?? []), newCat];
                  updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                  setEditingCategoryId(newCat.id);
                  setConfirmDeleteCategoryId(null);
                }}
                onRenameCategory={(catId, name) => {
                  const newCats = (agentConfig?.categories ?? []).map((c) => c.id === catId ? { ...c, name } : c);
                  updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                  setEditingCategoryId(null);
                }}
                onDeleteCategory={(catId) => {
                  const newCats = (agentConfig?.categories ?? []).filter((c) => c.id !== catId);
                  updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                  setConfirmDeleteCategoryId(null);
                }}
                onStartEdit={(catId) => { setConfirmDeleteCategoryId(null); setEditingCategoryId(catId); }}
                onAskDelete={(catId) => setConfirmDeleteCategoryId(catId)}
                onCancelEdit={() => setEditingCategoryId(null)}
                onCancelDelete={() => setConfirmDeleteCategoryId(null)}
                setDropTarget={setDropTarget}
                onDropTargetEnter={onDropTargetEnter}
                onDropTargetLeave={onDropTargetLeave}
              />
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
          {settings.customTags.map((tag) => {
            const dropKey = `tag:${tag.id}`;
            return (
            <div
              key={tag.id}
              className={`sidebar-tag-item${dropTarget === dropKey ? " drop-active" : ""}`}
              onMouseEnter={() => onDropTargetEnter("tag", tag.id)}
              onMouseLeave={onDropTargetLeave}
            >
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
            );
          })}
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
            <h1 className={activeTab ? "skill-title-serif" : undefined}>{activeTab ? activeTab.skill.displayName : pane === "settings" ? "设置" : "Skill 总览"}</h1>
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
              <div className="prov-filter">
                <CustomSelect value={provFilter} options={provFilterOptions} onChange={setProvFilter} />
              </div>
              {traceProgress && (
                <span className="trace-progress"><BadgeCheck size={14} /> 溯源中 {traceProgress.done}/{traceProgress.total}</span>
              )}
              <button
                className={translateCards ? "ghost-button active" : "ghost-button"}
                onClick={() => setTranslateCards((v) => !v)}
                title="翻译卡片描述（只读）"
              >
                <Languages size={15} /> {translateCards ? "原文" : "译"}
              </button>
              <div className="segmented">
                <button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")} title="网格"><Grid2X2 size={16} /></button>
                <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} title="紧凑"><List size={16} /></button>
              </div>
            </div>
          )}
          {activeTab && (
            <div className="editor-actions">
              <button
                onClick={() => void toggleTranslation()}
                className={activeTab.translation?.showing ? "active" : ""}
                disabled={activeTab.translation?.status === "loading"}
                title="机器翻译（只读，不改原文件）"
              >
                <Languages size={16} />{" "}
                {activeTab.translation?.status === "loading"
                  ? "翻译中…"
                  : activeTab.translation?.showing
                    ? "原文"
                    : "译"}
              </button>
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

        {updateInfo && !updateDismissed && updateInfo.hasUpdate && (
          <div className="update-banner">
            <div className="update-banner-body">
              <Sparkles size={18} />
              <div className="update-banner-text">
                <strong>SkillAnvil {updateInfo.latestVersion} 已发布</strong>
                <span>当前版本 {updateInfo.currentVersion} — 建议更新以获取最新功能和修复。</span>
              </div>
            </div>
            <div className="update-banner-actions">
              <button className="ghost-button" onClick={() => { api.openUrl(updateInfo.assetUrl || updateInfo.releaseUrl); }}>
                下载
              </button>
              <button className="ghost-button" onClick={dismissUpdatePanel}>
                忽略此版本
              </button>
            </div>
          </div>
        )}

        {pane === "settings" && !activeTab ? (
          <SettingsPanel
            settings={settings}
            onChange={updateSettings}
            agents={agents}
            traceProgress={traceProgress}
            onTraceScoped={() => void autoTraceProvenance(skills, provenance, true, settings.provenanceAgentId)}
            onShowProvenanceInfo={() => setShowProvenanceInfo(true)}
            updateInfo={updateInfo}
            updateDismissed={updateDismissed}
            onDismissUpdate={dismissUpdatePanel}
          />
        ) : activeTab ? (
          <section className="editor-layout">
            <div className="editor-card">
              {activeTab.translation?.showing &&
              (activeTab.translation.status === "loading" || activeTab.translation.status === "done") ? (
                <div className="translation-view">
                  <div className="translation-banner">
                    <Languages size={13} />{" "}
                    {activeTab.translation.status === "loading"
                      ? "翻译中…（流式）"
                      : "机器翻译 · 只读 · 点「原文」切回"}
                  </div>
                  {activeTab.translation.status === "loading" ? (
                    <StreamingText text={activeTab.translation.text} />
                  ) : (
                    <MarkdownEditor
                      key={`${activeTab.skill.id}-${activeTab.selectedFile}-zh`}
                      value={activeTab.translation.text}
                      onChange={() => {}}
                      theme={settings.theme}
                      readOnly
                    />
                  )}
                </div>
              ) : (
                <MarkdownEditor
                  key={`${activeTab.skill.id}-${activeTab.selectedFile}`}
                  value={activeTab.editorValue}
                  onChange={changeEditor}
                  theme={settings.theme}
                />
              )}
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
                <dt>路径</dt><dd title={activeTab.skill.dirPath}>{activeTab.skill.dirPath}</dd>
                <dt>存在于</dt>
                <dd>
                  <AgentPresence
                    agentIds={agentPresenceBySkillName.get(activeTab.skill.name) ?? [activeTab.skill.agentId]}
                    agents={agents}
                  />
                </dd>
              </dl>
              <h2>来源</h2>
              <ProvenanceCard
                provenance={provenance.get(activeTab.skill.name)}
                onOpenRepo={(repo) => void api.openUrl(`https://github.com/${repo}`)}
                onRetrace={() => void retraceSkill(activeTab.skill)}
              />
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
          openFolder ? (
            (() => {
              const fv = resolveFolderView(openFolder);
              if (!fv) {
                return (
                  <section className={viewMode === "grid" ? "skill-grid" : "skill-list"}>
                    <div className="empty-state">
                      <Sparkles size={28} />
                      <h2>文件夹不存在</h2>
                      <p>可能已被删除或重命名。<button className="link-button" onClick={() => setOpenFolder(null)}>返回总览</button></p>
                    </div>
                  </section>
                );
              }
              const confident = !!fv.repo && fv.repoShare / fv.total >= 0.5;
              return (
                <>
                  <div className="folder-bar">
                    <button className="folder-back" onClick={() => setOpenFolder(null)}>
                      <ChevronLeft size={16} /> 返回
                    </button>
                    <Folder size={16} className={fv.kind === "category" ? "folder-icon-cat" : undefined} />
                    <span className="folder-bar-name">{fv.name}</span>
                    {fv.kind === "category" && <span className="folder-bar-tag">我的分类</span>}
                    {fv.repo && (confident ? (
                      <button className="bundle-repo" onClick={() => void api.openUrl(`https://github.com/${fv.repo}`)} title={`多数来源：${fv.repoShare}/${fv.total} 个 Skill 指向此仓库`}>
                        <Github size={12} /> {fv.repo}
                      </button>
                    ) : (
                      <button className="bundle-repo mixed" onClick={() => void api.openUrl(`https://github.com/${fv.repo}`)} title={`混合来源：最多 ${fv.repoShare}/${fv.total} 个指向 ${fv.repo}`}>
                        <Github size={12} /> 混合来源
                      </button>
                    ))}
                    <span className="folder-bar-count">{fv.skills.length} skills</span>
                  </div>
                  <section className={viewMode === "grid" ? "skill-grid" : "skill-list"}>
                    {fv.skills.length === 0 ? (
                      <div className="empty-state">
                        <Sparkles size={28} />
                        <h2>这个文件夹下没有 Skill</h2>
                        <p>{fv.kind === "category" ? "把 Skill 卡片拖到侧边栏的这个分类即可归类。" : "当前搜索条件过滤掉了全部内容。"}<button className="link-button" onClick={() => setOpenFolder(null)}>返回总览</button></p>
                      </div>
                    ) : (
                      fv.skills.map((skill) => renderSkillCard(skill))
                    )}
                  </section>
                </>
              );
            })()
          ) : filter.tagId || filter.starred ? (
            // Tag / starred views are flat lists — no folders here.
            <section className={viewMode === "grid" ? "skill-grid" : "skill-list"}>
              {overviewSkills.length === 0 ? (
                <div className="empty-state">
                  <Sparkles size={28} />
                  <h2>{filter.starred ? "还没有收藏的 Skill" : "这个标签下还没有 Skill"}</h2>
                  <p>{filter.starred ? "点开任意 Skill 的星标即可收藏。" : "把 Skill 卡片拖到侧边栏的这个标签即可打标。"}</p>
                </div>
              ) : (
                overviewSkills.map((skill) => renderSkillCard(skill))
              )}
            </section>
          ) : standaloneSkills.length === 0 && folderCards.length === 0 ? (
            <section className={viewMode === "grid" ? "skill-grid" : "skill-list"}>
              <div className="empty-state">
                <Sparkles size={28} />
                <h2>没有发现 Skill</h2>
                <p>点击左下角"扫描"，或在设置中添加自定义 Agent Skill 目录。</p>
              </div>
            </section>
          ) : (
            <section className={viewMode === "grid" ? "skill-grid" : "skill-list"}>
              {folderCards.map((folder) => (
                <FolderCard
                  key={`${folder.agentId}:${folder.categoryId ?? folder.name}`}
                  folder={folder}
                  onOpen={() => setOpenFolder(folder.ref)}
                  dropTarget={dropTarget}
                  onDropTargetEnter={onDropTargetEnter}
                  onDropTargetLeave={onDropTargetLeave}
                />
              ))}
              {standaloneSkills.map((skill) => renderSkillCard(skill))}
            </section>
          )
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

      {showProvenanceInfo && <ProvenanceInfoModal onClose={() => setShowProvenanceInfo(false)} />}

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

const PROVENANCE_META: Record<ProvenanceStatus, { label: string; short: string; icon: typeof BadgeCheck }> = {
  verified: { label: "已验证 GitHub 来源", short: "已验证", icon: BadgeCheck },
  likely: { label: "疑似 GitHub 来源", short: "疑似", icon: Github },
  ambiguous: { label: "多个同名来源，需确认", short: "歧义", icon: AlertTriangle },
  local: { label: "仅本地 / 未公开", short: "本地", icon: Laptop },
  unknown: { label: "尚未溯源", short: "未溯源", icon: HelpCircle },
};

function provStatus(p?: SkillProvenance): ProvenanceStatus {
  return p?.status ?? "unknown";
}

/// Merge trace results into a name-keyed provenance map. Provenance is a property
/// of the skill (by name), so one trace covers every install that shares the name.
/// Newest result wins, but a resolved entry is never downgraded back to "unknown".
function mergeProvByName(
  base: Map<string, SkillProvenance>,
  results: SkillProvenance[],
  idToName: Map<string, string>,
): Map<string, SkillProvenance> {
  const next = new Map(base);
  for (const result of results) {
    const name = idToName.get(result.skillId);
    if (!name) continue;
    const current = next.get(name);
    if (!current || result.status !== "unknown" || current.status === "unknown") {
      next.set(name, result);
    }
  }
  return next;
}

function ProvenanceBadge({ provenance, withText = false }: { provenance?: SkillProvenance; withText?: boolean }) {
  const status = provStatus(provenance);
  const meta = PROVENANCE_META[status];
  const Icon = meta.icon;
  const title = provenance?.repo ? `${meta.label} · ${provenance.repo}` : meta.label;
  return (
    <span className={`prov-badge prov-${status}`} title={title}>
      <Icon size={12} />
      {withText && <span>{meta.short}</span>}
    </span>
  );
}

function ProvenanceCard({
  provenance,
  onOpenRepo,
  onRetrace,
}: {
  provenance?: SkillProvenance;
  onOpenRepo: (repo: string) => void;
  onRetrace: () => void;
}) {
  const status = provStatus(provenance);
  const meta = PROVENANCE_META[status];
  const Icon = meta.icon;
  const contentLabel =
    provenance?.contentMatch === "identical"
      ? "与上游一致"
      : provenance?.contentMatch === "differs"
      ? "与上游有差异"
      : null;
  return (
    <div className={`prov-card prov-${status}`}>
      <div className="prov-card-head">
        <span className="prov-card-status"><Icon size={14} /> {meta.label}</span>
        <button className="prov-retrace" onClick={onRetrace} title="重新溯源"><RefreshCcw size={12} /></button>
      </div>
      {provenance?.repo && (
        <button className="prov-repo" onClick={() => onOpenRepo(provenance.repo!)} title="在 GitHub 打开">
          <Github size={12} /> {provenance.repo}
        </button>
      )}
      <div className="prov-card-meta">
        {typeof provenance?.installs === "number" && provenance.installs > 0 && (
          <span>{provenance.installs.toLocaleString()} 安装</span>
        )}
        {contentLabel && <span className={provenance?.contentMatch === "identical" ? "prov-ok" : "prov-warn"}>{contentLabel}</span>}
      </div>
      {status === "ambiguous" && provenance && provenance.candidates.length > 1 && (
        <div className="prov-candidates">
          <span className="prov-candidates-label">候选来源：</span>
          {provenance.candidates.map((cand) => (
            <button key={cand.repo} className="prov-candidate" onClick={() => onOpenRepo(cand.repo)} title={`${cand.installs.toLocaleString()} 安装`}>
              {cand.repo}
            </button>
          ))}
        </div>
      )}
      {provenance?.error && <p className="prov-error">{provenance.error}</p>}
      {status === "local" && <p className="prov-hint">未在 skills.sh 找到同名来源，可能是本地自制或尚未公开。</p>}
    </div>
  );
}

function ProvenanceInfoModal({ onClose }: { onClose: () => void }) {
  const tiers: { status: ProvenanceStatus; desc: string }[] = [
    { status: "verified", desc: "在 skills.sh 找到同名来源，且本地 SKILL.md 内容与该 GitHub 仓库的上游高度一致（行级相似度 ≥ 0.6）。最可信。" },
    { status: "likely", desc: "找到了主导来源（安装量远超其他同名仓库，或是唯一候选），但本地内容与上游差异较大，无法逐字确认——通常是同一个 Skill 的旧版本或改过的版本。" },
    { status: "ambiguous", desc: "有多个安装量接近的同名仓库，且都没能在内容上对上号。会列出候选仓库，由你判断。" },
    { status: "local", desc: "skills.sh 上查不到同名 Skill，判定为本地自制或尚未公开发布。" },
    { status: "unknown", desc: "尚未溯源，或上次溯源时网络/限流失败，会在下次启动自动重试。" },
  ];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="prov-info-modal" role="dialog" aria-modal="true" aria-labelledby="prov-info-title" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2 id="prov-info-title">Skill 溯源是怎么判断的</h2>
            <p>给每个本地 Skill 找出它的来源：来自某个 GitHub 仓库，还是本地自制。</p>
          </div>
          <button className="icon-button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="prov-info-body">
          <h3>判断流程</h3>
          <ol>
            <li>用 Skill 名称去权威平台 <strong>skills.sh</strong> 搜索同名候选（自带所属 GitHub 仓库 <code>owner/repo</code> 与安装量）。</li>
            <li>从 <code>raw.githubusercontent.com</code> 拉取热度最高的几个候选的上游 <code>SKILL.md</code>，与本地内容做<strong>行级相似度</strong>比对，取最佳匹配。</li>
            <li>综合"是否有同名候选 + 内容是否对得上 + 某个仓库是否占绝对主导"，归入下面五档之一。</li>
          </ol>
          <h3>五种来源状态</h3>
          <ul className="prov-info-tiers">
            {tiers.map(({ status, desc }) => {
              const meta = PROVENANCE_META[status];
              const Icon = meta.icon;
              return (
                <li key={status}>
                  <span className={`prov-badge prov-${status}`}><Icon size={12} /> {meta.short}</span>
                  <span className="prov-info-tier-desc">{desc}</span>
                </li>
              );
            })}
          </ul>
          <h3>关于速度与隐私</h3>
          <ul className="prov-info-notes">
            <li>溯源在扫描后<strong>后台自动进行</strong>，结果缓存在本地，之后启动直接读缓存，不会重复联网。</li>
            <li>skills.sh 按 IP 限流（约每 10–13 个请求要等 60 秒），所以 Skill 很多时首次会比较慢、进度条会间歇停顿。可在上方<strong>限定只对某个 Agent 溯源</strong>来加快。</li>
            <li>只会把 Skill <strong>名称</strong>发给 skills.sh、并从 GitHub 拉取公开内容比对，<strong>不会上传你的本地 Skill 内容</strong>。</li>
          </ul>
        </div>
        <footer>
          <button className="primary" onClick={onClose}>知道了</button>
        </footer>
      </section>
    </div>
  );
}

function AgentNavGroup({
  agent, categories, autoFolders, skillCount, expanded, onToggleExpand,
  isAgentActive, openFolder, editingCategoryId, confirmDeleteCategoryId,
  dragSkill, dropTarget, navClass,
  onSelectAgent, onOpenFolder, onAddCategory, onRenameCategory, onDeleteCategory,
  onStartEdit, onAskDelete, onCancelEdit, onCancelDelete, setDropTarget, onDropTargetEnter, onDropTargetLeave,
}: {
  agent: Agent;
  categories: SkillCategory[];
  autoFolders: { key: string; name: string; count: number }[];
  skillCount: number;
  expanded: boolean;
  onToggleExpand: () => void;
  isAgentActive: boolean;
  openFolder: FolderRef | null;
  editingCategoryId: string | null;
  confirmDeleteCategoryId: string | null;
  dragSkill: Skill | null;
  dropTarget: string | null;
  navClass: (active: boolean) => string;
  onSelectAgent: () => void;
  onOpenFolder: (ref: FolderRef) => void;
  onAddCategory: () => void;
  onRenameCategory: (catId: string, name: string) => void;
  onDeleteCategory: (catId: string) => void;
  onStartEdit: (catId: string) => void;
  onAskDelete: (catId: string) => void;
  onCancelEdit: () => void;
  onCancelDelete: () => void;
  setDropTarget: (key: string | null) => void;
  onDropTargetEnter: (type: string, id: string, agentId?: string) => void;
  onDropTargetLeave: () => void;
}) {
  const hasSub = autoFolders.length > 0 || categories.length > 0;
  return (
    <div className="agent-nav-group">
      <div className={`agent-nav-row${hasSub ? " has-sub" : ""}`}>
        <button
          className="agent-icon-btn"
          onClick={(e) => { e.stopPropagation(); if (hasSub) onToggleExpand(); else onSelectAgent(); }}
          title={hasSub ? (expanded ? "折叠" : "展开") : agent.name}
        >
          <span className="agent-icon-default"><AgentIcon icon={agent.icon || ""} size={16} /></span>
          {hasSub && (
            <span className="agent-icon-hover">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          )}
        </button>
        <button className={`agent-name-btn ${navClass(isAgentActive)}`} onClick={onSelectAgent}>
          <span className="agent-name">{agent.name}</span>
          <span className="nav-count">{skillCount}</span>
        </button>
        <button className="add-category-icon" onClick={(e) => { e.stopPropagation(); onAddCategory(); }} title="新建文件夹"><Plus size={14} /></button>
      </div>
      {expanded && hasSub && (
        <div className="agent-categories">
          {autoFolders.map((af) => (
            <div key={af.key} className="sidebar-folder-item">
              <button
                className={navClass(!!openFolder && openFolder.kind === "auto" && openFolder.key === af.key)}
                onClick={() => onOpenFolder({ kind: "auto", key: af.key })}
                title={`自动识别合集 · ${af.count} 个 Skill`}
              >
                <Folder size={13} className="sidebar-folder-icon" /><span className="agent-name">{af.name}</span>
                <span className="nav-count">{af.count}</span>
              </button>
            </div>
          ))}
          {categories.map((cat) => {
            const active = !!openFolder && openFolder.kind === "category" && openFolder.categoryId === cat.id && openFolder.agentId === agent.id;
            const dropKey = `cat:${cat.id}`;
            return (
              <div
                key={cat.id}
                className={`sidebar-category-item${dropTarget === dropKey ? " drop-active" : ""}`}
                onMouseEnter={() => onDropTargetEnter("cat", cat.id, agent.id)}
                onMouseLeave={onDropTargetLeave}
              >
                {editingCategoryId === cat.id ? (
                  <InlineInput
                    placeholder="分类名称"
                    initialValue={cat.name}
                    onSubmit={(name) => onRenameCategory(cat.id, name)}
                    onCancel={onCancelEdit}
                  />
                ) : (
                  <>
                    <button className={navClass(active)} onClick={() => onOpenFolder({ kind: "category", agentId: agent.id, categoryId: cat.id })}>
                      <span className="category-dot" /><span className="agent-name">{cat.name}</span>
                      <span className="nav-count">{cat.skillNames.length}</span>
                    </button>
                    {confirmDeleteCategoryId === cat.id ? (
                      <div className="sidebar-confirm">
                        <span className="sidebar-confirm-label">删除?</span>
                        <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); onDeleteCategory(cat.id); }} title="确认删除"><Check size={12} /></button>
                        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onCancelDelete(); }} title="取消"><X size={12} /></button>
                      </div>
                    ) : (
                      <div className="sidebar-item-actions">
                        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onStartEdit(cat.id); }} title="重命名"><SettingsIcon size={12} /></button>
                        <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); onAskDelete(cat.id); }} title="删除"><Trash2 size={12} /></button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FolderCard({ folder, onOpen, dropTarget, onDropTargetEnter, onDropTargetLeave }: {
  folder: FolderCardModel;
  onOpen: () => void;
  dropTarget: string | null;
  onDropTargetEnter: (type: string, id: string, agentId?: string) => void;
  onDropTargetLeave: () => void;
}) {
  const isCategory = folder.kind === "category";
  const dropKey = isCategory && folder.categoryId ? `cat:${folder.categoryId}` : null;
  const isActive = dropKey && dropTarget === dropKey;
  const confident = !!folder.repo && folder.repoShare / folder.total >= 0.5;
  return (
    <article
      className={`folder-card${isCategory ? " folder-card-cat" : ""}${isActive ? " drop-active" : ""}`}
      onClick={onOpen}
      title={`打开${isCategory ? "分类" : "合集"}「${folder.name}」`}
      onMouseEnter={isCategory && folder.categoryId ? () => onDropTargetEnter("cat", folder.categoryId!, folder.agentId) : undefined}
      onMouseLeave={isCategory ? onDropTargetLeave : undefined}
    >
      <div className="folder-card-top">
        <Folder size={20} className="folder-card-icon" />
        <span className="folder-card-count">{folder.count}</span>
      </div>
      <h2 className="folder-card-name">{folder.name}</h2>
      <div className="folder-card-foot">
        {isCategory ? (
          <span className="folder-card-repo muted">{isActive ? "拖到这里归类" : "我的分类"}</span>
        ) : folder.repo ? (
          confident ? (
            <span className="folder-card-repo"><Github size={11} /> {folder.repo}</span>
          ) : (
            <span className="folder-card-repo mixed"><Github size={11} /> 混合来源</span>
          )
        ) : (
          <span className="folder-card-repo muted">本地合集</span>
        )}
      </div>
    </article>
  );
}

function SkillCard({
  skill,
  agents,
  agentIds,
  provenance,
  onOpen,
  onSync,
  onToggleStar,
  onContextMenu,
  onMouseDown,
  onRemoveFromFolder,
  translateOn,
  descriptionZh,
  onRequestZh,
  compact = false
}: {
  skill: Skill;
  agents: Agent[];
  agentIds: string[];
  provenance?: SkillProvenance;
  onOpen: (skill: Skill) => void;
  onSync: (skill: Skill) => void;
  onToggleStar: (skill: Skill) => void;
  onContextMenu: (event: React.MouseEvent, skill: Skill) => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  onRemoveFromFolder?: () => void;
  translateOn?: boolean;
  descriptionZh?: string;
  onRequestZh?: (skill: Skill) => void;
  compact?: boolean;
}) {
  const canSync = agents.length > 1;
  useEffect(() => {
    if (translateOn && !descriptionZh && onRequestZh) onRequestZh(skill);
  }, [translateOn, descriptionZh, skill, onRequestZh]);
  if (compact) {
    const subtitle = skill.displayName && skill.displayName !== skill.name
      ? skill.displayName
      : skill.description || "";
    const agentName = agents.find(a => a.id === agentIds[0])?.name ?? "";
    const sub = [subtitle, agentName].filter(Boolean).join(" · ");
    return (
      <article
        className="skill-card compact"
        onClick={() => onOpen(skill)}
        onContextMenu={(e) => onContextMenu(e, skill)}
        onMouseDown={onMouseDown}
      >
        <div className="compact-title">
          <h2>{skill.name}</h2>
          <ProvenanceBadge provenance={provenance} />
        </div>
        <span className="compact-sub" title={sub}>{sub}</span>
      </article>
    );
  }
  return (
    <article
      className="skill-card"
      onClick={() => onOpen(skill)}
      onContextMenu={(e) => onContextMenu(e, skill)}
      onMouseDown={onMouseDown}
    >
      <div className="card-head">
        <button className={skill.starred ? "icon-button starred" : "icon-button"} onClick={(e) => { e.stopPropagation(); onToggleStar(skill); }} title="收藏">
          <Star size={17} />
        </button>
        {onRemoveFromFolder && (
          <button className="icon-button folder-remove" onClick={(e) => { e.stopPropagation(); onRemoveFromFolder(); }} title="从文件夹移除">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="card-title">
        <div className="card-title-row">
          <h2>{skill.name}</h2>
          <ProvenanceBadge provenance={provenance} />
        </div>
        {skill.displayName && skill.displayName !== skill.name && (
          <span className="skill-subtitle">{skill.displayName}</span>
        )}
      </div>
      <p>{translateOn && descriptionZh ? descriptionZh : (skill.description || "未提供描述")}</p>
      <AgentPresence agentIds={agentIds} agents={agents} />
      <div className="tag-row">
        {skill.tags.map((tag) => <span key={tag.id} style={{ borderColor: tag.color }}>{tag.name}</span>)}
      </div>
      <footer>
        <span>v{skill.version || "0.0.0"}</span>
        <div className="card-actions">
          {canSync && <button onClick={(e) => { e.stopPropagation(); onSync(skill); }}>同步</button>}
          <button onClick={(e) => { e.stopPropagation(); onOpen(skill); }}>编辑</button>
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

function SettingsPanel({ settings, onChange, agents, traceProgress, onTraceScoped, onShowProvenanceInfo, updateInfo, updateDismissed, onDismissUpdate }: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  agents: Agent[];
  traceProgress: { done: number; total: number } | null;
  onTraceScoped: () => void;
  onShowProvenanceInfo: () => void;
  updateInfo: UpdateInfo | null;
  updateDismissed: boolean;
  onDismissUpdate: () => void;
}) {
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; message: string } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [checkUpdateResult, setCheckUpdateResult] = useState<UpdateInfo | null>(null);

  async function runUpdateCheck() {
    setCheckingUpdate(true);
    setCheckUpdateResult(null);
    try {
      const result = await api.checkForUpdates();
      setCheckUpdateResult(result);
    } catch {
      setCheckUpdateResult(null);
    } finally {
      setCheckingUpdate(false);
    }
  }

  function setTranslation(patch: Partial<TranslationConfig>) {
    onChange({ ...settings, translation: { ...settings.translation, ...patch } });
    setTestResult(null);
  }

  async function runTranslationTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testTranslationConfig(settings.translation));
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  }

  async function detectModels() {
    setDetecting(true);
    setDetectError(null);
    try {
      const list = await api.listTranslationModels(settings.translation);
      setModels(list);
      if (list.length === 0) setDetectError("接口没返回模型列表");
    } catch (err) {
      setModels([]);
      setDetectError(errorMessage(err));
    } finally {
      setDetecting(false);
    }
  }

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
      <div className="setting-row">
        <div className="setting-copy">
          <BadgeCheck size={18} />
          <strong>Skill 溯源范围</strong>
          <span>
            对照 skills.sh 自动判断每个 Skill 的来源；可限定只对某个 Agent 的 Skill 溯源以加快首次速度。
            <button type="button" className="link-button" onClick={onShowProvenanceInfo}>了解溯源逻辑</button>
          </span>
        </div>
        <CustomSelect
          value={settings.provenanceAgentId ?? "all"}
          options={[
            { value: "all", label: "全部 Agent" },
            ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
          onChange={(value) => onChange({ ...settings, provenanceAgentId: value === "all" ? null : value })}
        />
      </div>
      <div className="setting-row">
        <div className="setting-copy">
          <RefreshCcw size={18} />
          <strong>立即溯源</strong>
          <span>重新检查{settings.provenanceAgentId ? ` ${agentName(agents, settings.provenanceAgentId)} 的` : "所有"} Skill 的来源（结果缓存，平时无需手动触发）。</span>
        </div>
        <button className="ghost-button" onClick={onTraceScoped} disabled={traceProgress !== null}>
          <BadgeCheck size={15} /> {traceProgress ? `溯源中 ${traceProgress.done}/${traceProgress.total}` : "开始溯源"}
        </button>
      </div>
      <div className="translate-panel">
        <header>
          <Languages size={16} />
          <div>
            <strong>Skill 翻译</strong>
            <span>自带接口（OpenAI 兼容或 Anthropic 原生），在预览页/总览页把英文 Skill 一键译成中文。译文只读，绝不改原文件。Key 仅本地保存。</span>
          </div>
        </header>
        <div className="setting-row">
          <CustomSelect
            value={settings.translation.protocol}
            options={[
              { value: "openai", label: "OpenAI 兼容" },
              { value: "anthropic", label: "Anthropic 原生" }
            ]}
            onChange={(protocol) => setTranslation({ protocol })}
          />
        </div>
        <label className="field-row">
          <span>接口 Base URL</span>
          <input
            type="text"
            value={settings.translation.baseUrl}
            placeholder={settings.translation.protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.deepseek.com"}
            onChange={(e) => setTranslation({ baseUrl: e.target.value })}
          />
        </label>
        <label className="field-row">
          <span>API Key</span>
          <input type="password" value={settings.translation.apiKey} placeholder="sk-..." onChange={(e) => setTranslation({ apiKey: e.target.value })} />
        </label>
        <label className="field-row">
          <span>模型</span>
          <input
            type="text"
            list="translation-models"
            value={settings.translation.model}
            placeholder={settings.translation.protocol === "anthropic" ? "claude-haiku-4-5" : "deepseek-chat"}
            onChange={(e) => setTranslation({ model: e.target.value })}
          />
          <datalist id="translation-models">
            {models.map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
        <div className="translate-test">
          <button className="ghost-button" onClick={() => void detectModels()} disabled={detecting}>
            {detecting ? "检测中…" : "检测模型"}
          </button>
          <button className="ghost-button" onClick={() => void runTranslationTest()} disabled={testing}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          {detectError && <span className="test-chip err" title={detectError}>✗ {detectError}</span>}
          {!detectError && models.length > 0 && <span className="test-chip ok">✓ 检测到 {models.length} 个模型</span>}
          {testResult && (
            <span className={testResult.ok ? "test-chip ok" : "test-chip err"} title={testResult.message}>
              {testResult.ok ? `✓ ${testResult.latencyMs}ms · ${testResult.message}` : `✗ ${testResult.message}`}
            </span>
          )}
        </div>
        {models.length > 0 && (
          <div className="model-pills">
            {models.map((m) => (
              <button
                key={m}
                type="button"
                className={settings.translation.model === m ? "model-pill active" : "model-pill"}
                onClick={() => setTranslation({ model: m })}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="setting-row">
        <div className="setting-copy">
          <Sparkles size={18} />
          <strong>版本更新</strong>
          <span>当前版本 {updateInfo?.currentVersion ?? "—"}。启动时自动检查，也可手动触发。</span>
        </div>
        <div className="setting-action">
          <button className="ghost-button" onClick={() => void runUpdateCheck()} disabled={checkingUpdate}>
            <RefreshCcw size={14} /> {checkingUpdate ? "检查中…" : "检查更新"}
          </button>
          {checkUpdateResult ? (
            checkUpdateResult.hasUpdate ? (
              <>
                <span className="test-chip ok">✓ 发现新版本 {checkUpdateResult.latestVersion}</span>
                <button className="ghost-button" onClick={() => { api.openUrl(checkUpdateResult.assetUrl || checkUpdateResult.releaseUrl); }}>
                  下载
                </button>
              </>
            ) : (
              <span className="test-chip ok">✓ 已是最新版本</span>
            )
          ) : updateInfo && !updateDismissed && updateInfo.hasUpdate ? (
            <>
              <span className="test-chip ok">✓ 发现新版本 {updateInfo.latestVersion}</span>
              <button className="ghost-button" onClick={() => { api.openUrl(updateInfo.assetUrl || updateInfo.releaseUrl); }}>
                下载
              </button>
              <button className="ghost-button" onClick={onDismissUpdate}>
                忽略
              </button>
            </>
          ) : null}
          {!checkUpdateResult && checkingUpdate && (
            <span className="test-chip">检查中…</span>
          )}
        </div>
      </div>
      <div className="custom-agent-panel">
        <header>
          <div className="setting-copy">
            <Tags size={18} />
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
          <div className="setting-copy">
            <Folder size={18} />
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

function StreamingText({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <pre className="translation-stream" ref={ref}>
      {text || "翻译中…"}
    </pre>
  );
}

function MarkdownEditor({ value, onChange, theme, readOnly = false }: { value: string; onChange: (value: string) => void; theme: string; readOnly?: boolean }) {
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
          toolbar: !readOnly,
          readonly: readOnly
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
  }, [appearance, readOnly]);

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

interface BundleGroup {
  key: string;
  name: string;
  agentId: string;
  repo: string | null;
  repoShare: number;
  total: number;
  skills: Skill[];
}

/// A navigable "folder": either an auto-detected install-dir cluster (read-only)
/// or a user-defined manual category (editable + drop target).
type FolderRef =
  | { kind: "auto"; key: string }
  | { kind: "category"; agentId: string; categoryId: string };

/// Display model for a folder card in the overview grid.
interface FolderCardModel {
  ref: FolderRef;
  kind: "auto" | "category";
  name: string;
  count: number;
  agentId: string;
  categoryId?: string;
  repo: string | null;
  repoShare: number;
  total: number;
}

/// Derive a skill's "bundle root": the first path segment under its agent's
/// skills directory (e.g. `.../.claude/skills/gstack/.cursor/...` -> `gstack`).
/// Bundles installed together share this root; a standalone skill's root is just
/// its own folder name.
function bundleRootOf(skill: Skill, agents: Agent[]): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const dir = norm(skill.dirPath);
  const agent = agents.find((a) => a.id === skill.agentId);
  for (const root of agent?.skillDirPaths ?? []) {
    const prefix = norm(root) + "/";
    if (dir.startsWith(prefix)) {
      const first = dir.slice(prefix.length).split("/")[0];
      if (first) return first;
    }
  }
  const parts = dir.split("/");
  return parts[parts.length - 1] || skill.name;
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
