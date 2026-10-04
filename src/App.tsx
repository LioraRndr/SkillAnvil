import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  GitCompare,
  Github,
  Grid2X2,
  HelpCircle,
  Home,
  Info,
  Languages,
  Laptop,
  Library,
  List,
  Loader2,
  Plus,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  Star,
  Tag as TagIcon,
  Trash2,
  X
} from "lucide-react";
import skillanvilLogo from "./assets/skillanvil-logo.png";
import { agentIconMap, harnessById, harnessCatalog, harnessGroups } from "./agentCatalog";
import { AgentInstallationPanel } from "./AgentInstallationPanel";
import { MarkdownEditor } from "./MarkdownEditor";
import { api } from "./api";
import type { Agent, EnableInstalledAgentsResult, ProvenanceStatus, ReadFileResult, ScanIssue, Settings, Skill, SkillCategory, SkillFilter, SkillProvenance, Snapshot, SyncTargetStatus, Tag, TranslationConfig, UpdateInfo } from "./types";

const MONO_AGENT_ICONS = new Set(["cline", "goose", "hermes", "kilo", "roo", "kimi", "cursor", "githubcopilot", "opencode", "pi", "grok", "aider", "warp"]);

function AgentIcon({ icon, size = 16 }: { icon: string; size?: number }) {
  const src = agentIconMap[icon];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className={`agent-icon ${MONO_AGENT_ICONS.has(icon) ? "agent-icon-mono" : ""}`}
        style={{ width: size, height: size }}
        width={size}
        height={size}
      />
    );
  }
  return <FolderOpen size={size} />;
}

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
/// One open file inside a skill tab. Each document keeps its own editor, save
/// state and translation, so switching files or tabs never loses edits.
type DocState = {
  file: string;
  fileState: ReadFileResult | null;
  editorValue: string;
  saveState: SaveState;
  loadError: string | null;
  translation?: TabTranslation;
};
/// One tab per skill (keyed by skill id). Opening the same skill again, or
/// another file of it from the file tree, focuses this tab instead of adding one.
type Tab = {
  skill: Skill;
  file: string;
  docs: Record<string, DocState>;
  syncTargets: SyncTargetStatus[] | null;
  syncError: string | null;
  snapshots: Snapshot[] | null;
};

const defaultTags: Tag[] = [
  { id: "writing", name: "写作", color: "#7dd3fc" },
  { id: "coding", name: "开发", color: "#86efac" },
  { id: "review", name: "审查", color: "#fcd34d" }
];

const TAG_COLORS = ["#7dd3fc", "#86efac", "#fcd34d", "#fca5a5", "#c4b5fd", "#fdba74", "#a5b4fc"];

const isMacPlatform = navigator.platform.toLowerCase().includes("mac");

const defaultSettings: Settings = {
  theme: "dark",
  shortcut: isMacPlatform ? "Cmd+Shift+K" : "Ctrl+Shift+K",
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

const VIEW_MODE_KEY = "skillanvil.viewMode";

function docKey(skillId: string, file: string) {
  return `${skillId}::${file}`;
}

function emptyDoc(file: string): DocState {
  return { file, fileState: null, editorValue: "", saveState: "idle", loadError: null };
}

/// Split a `skillId::file` key. Skill ids are hex digests, so the first `::`
/// always separates the id from the relative path.
function splitDocKey(key: string): [string, string] {
  const index = key.indexOf("::");
  return [key.slice(0, index), key.slice(index + 2)];
}

function findDoc(list: Tab[], key: string): { tab: Tab; doc: DocState } | null {
  const [skillId, file] = splitDocKey(key);
  const tab = list.find((item) => item.skill.id === skillId);
  const doc = tab?.docs[file];
  return tab && doc ? { tab, doc } : null;
}

function mapDoc(list: Tab[], key: string, update: (doc: DocState) => DocState): Tab[] {
  const [skillId, file] = splitDocKey(key);
  let changed = false;
  const next = list.map((tab) => {
    if (tab.skill.id !== skillId || !tab.docs[file]) return tab;
    const doc = update(tab.docs[file]);
    if (doc === tab.docs[file]) return tab;
    changed = true;
    return { ...tab, docs: { ...tab.docs, [file]: doc } };
  });
  return changed ? next : list;
}

function tabIsDirty(tab: Tab) {
  return Object.values(tab.docs).some((doc) => doc.saveState === "dirty" || doc.saveState === "saving" || doc.saveState === "error");
}

/// A callback with a stable identity that always runs the latest closure. Lets
/// memoized children (skill cards) skip re-rendering while the editor types.
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

export default function App() {
  const [scannedAgents, setAgents] = useState<Agent[]>([]);
  const [scannedSkills, setSkills] = useState<Skill[]>([]);
  const [booting, setBooting] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<SkillFilter>({});
  const [query, setQuery] = useState("");
  const [viewMode, setViewModeState] = useState<ViewMode>(() => (readStorage(VIEW_MODE_KEY) === "list" ? "list" : "grid"));
  const [translateCards, setTranslateCards] = useState(false);
  const [cardZh, setCardZh] = useState<Record<string, string>>({});
  const cardQueue = useRef<{ queue: Skill[]; active: number; seen: Set<string> }>({ queue: [], active: 0, seen: new Set() });
  const [openFolder, setOpenFolder] = useState<FolderRef | null>(null);
  const dragRef = useRef<{ skill: Skill; startX: number; startY: number; chip: HTMLElement | null } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hoveredDropTarget = useRef<{ type: string; agentId?: string; id: string } | null>(null);
  const [folderToggle, setFolderToggle] = useState<Map<string, boolean>>(new Map());
  const [pane, setPane] = useState<Pane>("skills");
  const pageScrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [tabs, setTabsState] = useState<Tab[]>([]);
  // tabsRef is the source of truth: every update goes through updateTabs, which
  // writes the ref synchronously before React re-renders. Async save/open logic
  // therefore always sees the latest tabs and can never add a duplicate tab.
  const tabsRef = useRef<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [confirmedSettings, setConfirmedSettings] = useState<Settings>(defaultSettings);
  const confirmedSettingsRef = useRef(defaultSettings);
  const settingsWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsEditRevision = useRef(0);
  const scanRevision = useRef(0);
  // Navigation follows saved settings; disk scans only supply roots and Skill contents.
  const agents = useMemo<Agent[]>(() => confirmedSettings.customAgents.filter((agent) => agent.enabled).map((config) => {
    const scanned = scannedAgents.find((agent) => agent.id === config.id);
    return { id: config.id, name: config.name, icon: config.icon || "", skillDirPaths: scanned?.skillDirPaths ?? [], detectedAt: scanned?.detectedAt ?? "" };
  }), [confirmedSettings.customAgents, scannedAgents]);
  const skills = useMemo(() => {
    const enabledIds = new Set(agents.map((agent) => agent.id));
    return scannedSkills.filter((skill) => enabledIds.has(skill.agentId));
  }, [agents, scannedSkills]);
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
  // 挂起的自动保存。key 为 `${skill.id}::${file}`，保证内容只写回它所属的文件。
  const pendingSave = useRef<{ key: string; value: string; timer: number } | null>(null);
  // 同一 key 的在途保存 Promise：后续冲刷串行排队，避免并发保存携带过期的
  // updatedAt 而被后端误判为「文件已被外部修改」。resolve 值表示该次保存是否成功。
  const inflightSaves = useRef<Map<string, Promise<boolean>>>(new Map());
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [confirmDeleteCategoryId, setConfirmDeleteCategoryId] = useState<string | null>(null);
  const [confirmDeleteTagId, setConfirmDeleteTagId] = useState<string | null>(null);
  const [cloningSkill, setCloningSkill] = useState<Skill | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const updateTabs = useCallback((update: (list: Tab[]) => Tab[]) => {
    const next = update(tabsRef.current);
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    setTabsState(next);
  }, []);

  /// Apply a freshly loaded skill list, also refreshing the skill objects held
  /// by open tabs (file lists, tags, metadata) so the inspector never goes stale.
  function applySkills(list: Skill[]) {
    setSkills(list);
    const byId = new Map(list.map((skill) => [skill.id, skill]));
    updateTabs((tabsList) => {
      let changed = false;
      const next = tabsList.map((tab) => {
        const fresh = byId.get(tab.skill.id);
        if (!fresh || fresh === tab.skill) return tab;
        changed = true;
        return { ...tab, skill: fresh };
      });
      return changed ? next : tabsList;
    });
  }

  function setViewMode(mode: ViewMode) {
    setViewModeState(mode);
    writeStorage(VIEW_MODE_KEY, mode);
  }

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

  // 托盘「手动扫描」完成后后端 emit "scan-completed"：只从 DB 重载列表，
  // 绝不能再调 scanAgents（否则会触发二次扫描死循环）。
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    listen("scan-completed", () => {
      const revision = ++scanRevision.current;
      void (async () => {
        try {
          const [agentList, skillList] = await Promise.all([api.getAgents(), api.getSkills({})]);
          if (!alive || revision !== scanRevision.current) return;
          setAgents(agentList);
          applySkills(skillList);
        } catch (err) {
          if (alive && revision === scanRevision.current) setError(errorMessage(err));
        }
      })();
    })
      .then((fn) => {
        // StrictMode 双挂载：若 effect 已清理，注册结果到达时立即退订。
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {
        // 非 Tauri 环境（纯浏览器 dev）无法监听，忽略。
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  function dismissUpdatePanel() {
    if (updateInfo) {
      api.dismissUpdate(updateInfo.latestVersion).catch(() => {});
      setUpdateDismissed(true);
    }
  }

  const showToast = useStableCallback((message: string, type: ToastType = "success") => {
    const id = ++toastIdSeq;
    setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), type === "error" ? 5000 : 3000);
  });

  const activeTab = activeKey ? tabs.find((tab) => tab.skill.id === activeKey) ?? null : null;
  const activeDoc = activeTab ? activeTab.docs[activeTab.file] ?? null : null;
  const isHome = !activeTab;
  const onSkillsPane = isHome && pane === "skills";

  // A closed or trashed tab must not leave the workspace pointing at nothing.
  useEffect(() => {
    if (activeKey && !tabs.some((tab) => tab.skill.id === activeKey)) setActiveKey(null);
  }, [activeKey, tabs]);

  const uniqueSkillCount = useMemo(() => new Set(skills.map((skill) => skill.name)).size, [skills]);
  const starredCount = useMemo(() => new Set(skills.filter((skill) => skill.starred).map((skill) => skill.name)).size, [skills]);
  const skillCountByAgent = useMemo(() => {
    const names = new Map<string, Set<string>>();
    for (const skill of skills) {
      if (!names.has(skill.agentId)) names.set(skill.agentId, new Set());
      names.get(skill.agentId)!.add(skill.name);
    }
    return new Map(Array.from(names, ([id, set]) => [id, set.size]));
  }, [skills]);

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
    const searching = query.trim() !== "" || provFilter !== "all";
    const visibleNames = new Set(visibleSkills.map((skill) => skill.name));
    for (const agent of settings.customAgents) {
      if (filter.agentId && agent.id !== filter.agentId) continue;
      if (!agent.enabled) continue;
      for (const cat of agent.categories ?? []) {
        // Empty categories stay visible as drop targets, but a search or source
        // filter should only surface folders that hold a matching skill.
        if (searching && !cat.skillNames.some((name) => visibleNames.has(name))) continue;
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
  }, [bundleGroups, settings.customAgents, filter.agentId, query, provFilter, visibleSkills]);

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

  async function boot() {
    const revision = ++scanRevision.current;
    setError(null);
    try {
      const [settingsResult, scanResult, provList] = await Promise.all([
        api.getSettings(),
        api.scanAgents(),
        api.getProvenance().catch(() => [] as SkillProvenance[]),
      ]);
      if (revision !== scanRevision.current) return;
      confirmedSettingsRef.current = settingsResult;
      setConfirmedSettings(settingsResult);
      setSettings(settingsResult);
      setAgents(scanResult.agents);
      setSkills(scanResult.skills);
      setScanIssues(scanResult.scanErrors ?? []);
      const idToName = new Map(scanResult.skills.map((skill) => [skill.id, skill.name]));
      const provMap = mergeProvByName(new Map(), provList, idToName);
      setProvenance(provMap);
      void autoTraceProvenance(scanResult.skills, provMap, false, settingsResult.provenanceAgentId);
    } catch (err) {
      if (revision === scanRevision.current) setError(errorMessage(err));
    } finally {
      setBooting(false);
    }
  }

  async function refresh(announce = false) {
    const revision = ++scanRevision.current;
    setError(null);
    if (announce) setScanning(true);
    try {
      const result = await api.scanAgents();
      if (revision !== scanRevision.current) return;
      setAgents(result.agents);
      applySkills(result.skills);
      setScanIssues(result.scanErrors ?? []);
      if (announce) showToast(`扫描完成：${new Set(result.skills.map((skill) => skill.name)).size} 个 Skill`);
      void autoTraceProvenance(result.skills, provenance, false, confirmedSettingsRef.current.provenanceAgentId);
    } catch (err) {
      if (revision === scanRevision.current) setError(errorMessage(err));
    } finally {
      if (announce) setScanning(false);
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

  // ── Navigation ──────────────────────────────────────────────────────────

  function navigate(next: { pane?: Pane; filter?: SkillFilter; folder?: FolderRef | null }) {
    setActiveKey(null);
    setPane(next.pane ?? "skills");
    if (next.filter) setFilter(next.filter);
    if (next.folder !== undefined) setOpenFolder(next.folder);
    setContextMenu(null);
    window.requestAnimationFrame(() => pageScrollRef.current?.scrollTo({ top: 0 }));
  }

  function enterFolder(ref: FolderRef | null) {
    setOpenFolder(ref);
    window.requestAnimationFrame(() => pageScrollRef.current?.scrollTo({ top: 0 }));
  }

  function onSearchChange(value: string) {
    setQuery(value);
    // Results live on the overview; leave the editor or settings so they show.
    if (value.trim() && (!isHome || pane !== "skills")) {
      setActiveKey(null);
      setPane("skills");
    }
  }

  // ── Tabs & documents ───────────────────────────────────────────────────

  async function loadDoc(skillId: string, file: string) {
    const key = docKey(skillId, file);
    try {
      const result = await api.readSkillFile(skillId, file);
      updateTabs((list) => mapDoc(list, key, (doc) => (doc.fileState ? doc : { ...doc, fileState: result, editorValue: result.content, saveState: "saved", loadError: null })));
    } catch (err) {
      updateTabs((list) => mapDoc(list, key, (doc) => (doc.fileState ? doc : { ...doc, loadError: errorMessage(err) })));
    }
  }

  /// Sync status hashes every target directory and can take a moment; it loads
  /// beside the editor instead of delaying the tab from opening.
  async function loadTabMeta(skillId: string) {
    const [targets, snapshots] = await Promise.allSettled([api.getSyncTargets(skillId), api.getSnapshots(skillId)]);
    updateTabs((list) => list.map((tab) => tab.skill.id !== skillId ? tab : {
      ...tab,
      syncTargets: targets.status === "fulfilled" ? targets.value : [],
      syncError: targets.status === "rejected" ? errorMessage(targets.reason) : null,
      snapshots: snapshots.status === "fulfilled" ? snapshots.value : [],
    }));
  }

  function selectFile(skillId: string, file: string) {
    const tab = tabsRef.current.find((item) => item.skill.id === skillId);
    if (!tab) return;
    const existing = tab.docs[file];
    const retry = existing?.loadError != null;
    updateTabs((list) => list.map((item) => item.skill.id !== skillId ? item : {
      ...item,
      file,
      docs: existing && !retry ? item.docs : { ...item.docs, [file]: emptyDoc(file) },
    }));
    if (!existing || retry) void loadDoc(skillId, file);
  }

  function openSkill(skill: Skill, relativePath = "SKILL.md") {
    if (suppressClickRef.current) return;
    let target = skill;
    if (filter.agentId && skill.agentId !== filter.agentId) {
      const match = skills.find((s) => s.name === skill.name && s.agentId === filter.agentId);
      if (match) target = match;
    }
    setDiffView(null);
    setContextMenu(null);
    const existing = tabsRef.current.find((tab) => tab.skill.id === target.id);
    setActiveKey(target.id);
    if (existing) {
      if (existing.file !== relativePath || existing.docs[relativePath]?.loadError) selectFile(target.id, relativePath);
      return;
    }
    // The tab is registered synchronously, so a second click (or a double
    // click) that lands before the file is read finds it and only focuses it.
    updateTabs((list) => list.some((tab) => tab.skill.id === target.id) ? list : [...list, {
      skill: target,
      file: relativePath,
      docs: { [relativePath]: emptyDoc(relativePath) },
      syncTargets: null,
      syncError: null,
      snapshots: null,
    }]);
    window.requestAnimationFrame(() => {
      tabBarRef.current?.querySelector<HTMLElement>(`[data-tab-id="${cssEscape(target.id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    void loadDoc(target.id, relativePath);
    void loadTabMeta(target.id);
  }
  const openSkillStable = useStableCallback((skill: Skill) => openSkill(skill));

  function removeTab(skillId: string) {
    const list = tabsRef.current;
    const index = list.findIndex((tab) => tab.skill.id === skillId);
    if (index < 0) return;
    const next = list.filter((tab) => tab.skill.id !== skillId);
    updateTabs(() => next);
    if (activeKeyRef.current === skillId) {
      setActiveKey(next.length > 0 ? next[Math.min(index, next.length - 1)].skill.id : null);
    }
  }

  async function closeTab(skillId: string) {
    // 冲刷可能要多轮：await 期间标签页仍在界面上，用户还能继续输入并重新
    // 排定挂起保存。每轮重新读取最新状态，直到确认没有内容会随关闭丢失。
    for (;;) {
      const tab = tabsRef.current.find((item) => item.skill.id === skillId);
      if (!tab) return;
      let flushed = false;
      for (const doc of Object.values(tab.docs)) {
        const key = docKey(skillId, doc.file);
        const pending = pendingSave.current;
        let ok = true;
        if (pending && pending.key === key) {
          // 关闭前先冲刷挂起的自动保存，防止最后 1 秒内的编辑丢失。
          // 必须等待冲刷结果：写入被拒（如「文件已被外部修改」）时保留标签页，
          // 否则编辑器内容随标签页销毁，提示「请复制你的改动」将无从执行。
          window.clearTimeout(pending.timer);
          pendingSave.current = null;
          ok = await flushSaveByKey(key, pending.value);
          flushed = true;
        } else if (doc.saveState === "dirty") {
          // 无挂起定时器但仍是脏状态（例如挂起保存曾被切换顶掉）：同样先冲刷并等待结果。
          ok = await flushSaveByKey(key, doc.editorValue);
          flushed = true;
        } else if (doc.saveState === "saving") {
          // 保存在途：等它落定再关闭；失败则保留标签页让用户处置。
          const run = inflightSaves.current.get(key);
          if (run) {
            ok = await run;
            flushed = true;
          }
        }
        if (!ok) {
          setActiveKey(skillId);
          selectFile(skillId, doc.file);
          return;
        }
        if (flushed) break;
      }
      if (flushed) continue;
      const unsaved = Object.values(tab.docs).filter((doc) => doc.saveState === "error" && doc.fileState && doc.editorValue !== doc.fileState.content);
      if (unsaved.length > 0) {
        const names = unsaved.map((doc) => doc.file).join("、");
        if (!window.confirm(`${names} 有未保存的更改且上次保存失败，确定关闭并丢弃吗？`)) return;
      }
      break;
    }
    removeTab(skillId);
  }
  const closeTabStable = useStableCallback((skillId: string) => void closeTab(skillId));

  function cycleTab(direction: 1 | -1) {
    const list = tabsRef.current;
    if (list.length === 0) return;
    const index = list.findIndex((tab) => tab.skill.id === activeKeyRef.current);
    const next = index < 0 ? (direction > 0 ? 0 : list.length - 1) : index + direction;
    if (next < 0 || next >= list.length) setActiveKey(null);
    else setActiveKey(list[next].skill.id);
  }

  /// 按 key（skill.id::file）把内容写回它所属的文件。同一 key 的保存
  /// 串行排队：前一次保存落定（fileState.updatedAt 刷新）后才发起下一次，
  /// 避免并发保存携带过期的 updatedAt 被误判为「文件已被外部修改」。
  /// 返回该次保存是否成功。
  function flushSaveByKey(key: string, value: string): Promise<boolean> {
    const prior = inflightSaves.current.get(key) ?? Promise.resolve(true);
    // performSave 内部消化所有异常（永不 reject），链条不会中断。
    const run = prior.then(() => performSave(key, value));
    inflightSaves.current.set(key, run);
    void run.finally(() => {
      if (inflightSaves.current.get(key) === run) inflightSaves.current.delete(key);
    });
    return run;
  }

  /// 真正执行一次保存。目标文档从 tabsRef 里现查（不是执行时的活动标签页），
  /// 因此延迟触发时即使用户已切换文件或关闭标签页，内容也只会写进原来的文件，
  /// 绝不会串台。不得直接调用——一律经 flushSaveByKey 串行化入队。
  async function performSave(key: string, value: string): Promise<boolean> {
    const found = findDoc(tabsRef.current, key);
    if (!found || !found.doc.fileState) return false;
    const { tab, doc } = found;
    const fileState = found.doc.fileState;
    updateTabs((list) => mapDoc(list, key, (d) => ({ ...d, saveState: "saving" })));
    try {
      const result = await api.saveSkillFile(tab.skill.id, doc.file, value, fileState.encoding, fileState.updatedAt);
      // 在途保存期间用户可能继续输入：仅当编辑器内容仍等于本次写入值才置
      // saved，否则保持 dirty（新内容由其自己的挂起定时器随后冲刷）。
      // updateTabs 同步写入 tabsRef：串行队列中的下一次保存立刻读到新的 updatedAt。
      updateTabs((list) => mapDoc(list, key, (d) => ({ ...d, fileState: result, saveState: d.editorValue === value ? "saved" : "dirty" })));
      void refreshSkillAfterSave(tab.skill.id);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      // 失败同样同步写入 tabsRef：保证在途保存落定后 ref 里绝不会残留
      // 「saving」状态（closeTab 依赖这一点判断是否还需等待）。
      updateTabs((list) => mapDoc(list, key, (d) => ({ ...d, saveState: "error" })));
      return false;
    }
  }

  /// Refresh the saved skill's metadata and history. Only this skill is
  /// re-read; the save itself already succeeded, so failures here are silent.
  async function refreshSkillAfterSave(skillId: string) {
    try {
      const [updated, snapshots] = await Promise.all([api.getSkill(skillId), api.getSnapshots(skillId)]);
      setSkills((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      updateTabs((list) => list.map((tab) => (tab.skill.id === skillId ? { ...tab, skill: updated, snapshots } : tab)));
    } catch {
      // Best effort.
    }
  }

  function changeEditor(key: string, value: string) {
    // 按 key 而不是活动标签页更新：每个编辑器绑定自己的文档。
    // Editing invalidates any cached translation for this document.
    updateTabs((list) => mapDoc(list, key, (doc) => ({ ...doc, editorValue: value, saveState: "dirty", translation: undefined })));
    const pending = pendingSave.current;
    if (pending) {
      window.clearTimeout(pending.timer);
      if (pending.key !== key) {
        // 切换文档后立刻冲刷上一个文档的待保存内容，防止丢失。
        pendingSave.current = null;
        void flushSaveByKey(pending.key, pending.value);
      }
    }
    // 记录用对象身份标识：定时器触发时只消费「自己这条」挂起记录。若在途
    // 保存期间用户又输入并重排了新记录，新记录（及其定时器）必须原样保留，
    // 不能被旧一轮的完成逻辑误清成孤儿。
    const record = { key, value, timer: 0 };
    record.timer = window.setTimeout(() => {
      if (pendingSave.current === record) pendingSave.current = null;
      void flushSaveByKey(key, value);
    }, 1000);
    pendingSave.current = record;
  }

  async function saveNow() {
    const tab = tabsRef.current.find((item) => item.skill.id === activeKeyRef.current);
    const doc = tab?.docs[tab.file];
    if (!tab || !doc || !doc.fileState) return;
    const key = docKey(tab.skill.id, doc.file);
    const pending = pendingSave.current;
    if (pending && pending.key === key) {
      window.clearTimeout(pending.timer);
      pendingSave.current = null;
    } else if (doc.saveState === "saved" && doc.editorValue === doc.fileState.content) {
      return;
    }
    await flushSaveByKey(key, doc.editorValue);
  }
  const saveNowStable = useStableCallback(() => void saveNow());

  /// Re-read clean documents of a skill after something else rewrote it (sync).
  /// Documents with unsaved edits are left alone; their next save reports the
  /// conflict instead of silently overwriting.
  async function reloadCleanDocs(skillId: string) {
    const tab = tabsRef.current.find((item) => item.skill.id === skillId);
    if (!tab) return;
    await Promise.all(Object.values(tab.docs).map(async (doc) => {
      if (doc.saveState !== "saved" || !doc.fileState) return;
      const key = docKey(skillId, doc.file);
      try {
        const result = await api.readSkillFile(skillId, doc.file);
        updateTabs((list) => mapDoc(list, key, (d) => (d.saveState === "saved" ? { ...d, fileState: result, editorValue: result.content, translation: undefined } : d)));
      } catch {
        // The next save surfaces any real problem.
      }
    }));
  }

  async function toggleTranslation() {
    const tab = activeTab;
    const doc = activeDoc;
    if (!tab || !doc) return;
    const key = docKey(tab.skill.id, doc.file);
    const tr = doc.translation;
    // Already translated → just flip between 原文 / 译文 (instant, no API call).
    if (tr && tr.status === "done") {
      updateTabs((list) => mapDoc(list, key, (d) => ({ ...d, translation: d.translation ? { ...d.translation, showing: !d.translation.showing } : d.translation })));
      return;
    }
    if (tr && tr.status === "loading") return;
    updateTabs((list) => mapDoc(list, key, (d) => ({ ...d, translation: { status: "loading", text: "", error: "", showing: true } })));

    // Throttle live updates: buffer deltas, flush to state at most ~every 90ms.
    let pending = "";
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      const add = pending;
      pending = "";
      updateTabs((list) => mapDoc(list, key, (d) => ({ ...d, translation: { status: "loading", text: (d.translation?.text ?? "") + add, error: "", showing: true } })));
    };

    try {
      const res = await api.translateStream(doc.editorValue, (delta) => {
        pending += delta;
        if (timer === null) timer = window.setTimeout(flush, 90);
      });
      if (timer !== null) window.clearTimeout(timer);
      updateTabs((list) => mapDoc(list, key, (d) => ({ ...d, translation: { status: "done", text: res.text, error: "", showing: true } })));
    } catch (err) {
      if (timer !== null) window.clearTimeout(timer);
      const message = errorMessage(err);
      updateTabs((list) => mapDoc(list, key, (d) => ({ ...d, translation: { status: "error", text: "", error: message, showing: false } })));
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
      updateTabs((list) => list.map((t) => (t.skill.id === updated.id ? { ...t, skill: updated } : t)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const toggleStarStable = useStableCallback((skill: Skill) => void toggleStar(skill));

  async function doCloneSkill(skill: Skill, newName: string) {
    try {
      const created = await api.cloneSkill(skill.id, newName);
      setSkills((items) => [...items.filter((item) => item.id !== created.id), created]);
      setCloningSkill(null);
      if (activeTab && skill.id === activeTab.skill.id) {
        openSkill(created);
      } else {
        showToast(`已克隆为 ${created.displayName || newName}`);
      }
    } catch (err) {
      setError(errorMessage(err));
      setCloningSkill(null);
    }
  }

  async function trashSkill(skill: Skill) {
    const agent = agents.find((item) => item.id === skill.agentId);
    const otherAgentCount = (agentPresenceBySkillName.get(skill.name) ?? []).filter((id) => id !== skill.agentId).length;
    const presenceHint = otherAgentCount > 0 ? `\n该 Skill 还存在于另外 ${otherAgentCount} 个 Agent，本次仅删除当前 Agent 的副本。` : "";
    const ok = window.confirm(`确认卸载 ${skill.displayName}？\n\n路径：${skill.dirPath}\n将移动到系统回收站。${presenceHint}`);
    if (!ok) return;
    try {
      await api.trashSkill(skill.id, [skill.agentId]);
      // 目录已移走：丢弃指向它的挂起保存，并直接移除标签页（无需冲刷）。
      const pending = pendingSave.current;
      if (pending && pending.key.startsWith(`${skill.id}::`)) {
        window.clearTimeout(pending.timer);
        pendingSave.current = null;
      }
      removeTab(skill.id);
      setSkills((items) => items.filter((item) => item.id !== skill.id));
      showToast(agent ? `已从 ${agent.name} 移至回收站` : "已移至回收站");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revealInFileManager(path: string) {
    try {
      await api.openInFileManager(path);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /// After a sync rewrites target directories, refresh skills, the source tab's
  /// sync status, and any open tabs of the overwritten copies.
  async function afterSync(sourceId: string, nextSkills: Skill[], targetAgentIds: string[]) {
    applySkills(nextSkills);
    const source = nextSkills.find((s) => s.id === sourceId);
    if (tabsRef.current.some((tab) => tab.skill.id === sourceId)) void loadTabMeta(sourceId);
    if (!source) return;
    for (const tab of tabsRef.current) {
      if (tab.skill.name === source.name && targetAgentIds.includes(tab.skill.agentId)) {
        void reloadCleanDocs(tab.skill.id);
        void loadTabMeta(tab.skill.id);
      }
    }
  }

  async function syncSelected(target: SyncTargetStatus) {
    if (!activeTab) return;
    if (target.status === "same") return;
    const skill = activeTab.skill;
    const actionLabel = target.status === "missing" ? "新增" : "覆盖";
    try {
      const nextSkills = await api.syncSkill(skill.id, [target.agentId]);
      await afterSync(skill.id, nextSkills, [target.agentId]);
      showToast(`${skill.displayName} 已${actionLabel}到 ${target.agentName}`);
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
  const openSyncPanelStable = useStableCallback((skill: Skill) => void openSyncPanel(skill));

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
    setSyncBusy(true);
    try {
      const nextSkills = await api.syncSkill(syncDraft.skill.id, syncDraft.selectedAgentIds);
      await afterSync(syncDraft.skill.id, nextSkills, syncDraft.selectedAgentIds);
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
      updateTabs((list) => list.map((t) => (t.skill.id === updated.id ? { ...t, skill: updated } : t)));
      setSkills((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function restoreSnapshot(snapshot: Snapshot) {
    // 后端只会改写 snapshot.skillId 对应 skill 目录下的那一个文件；跨 Agent 的
    // 同名 skill 是不同 id、不同目录的独立实体，绝不能按 name 匹配（否则另一
    // Agent 同名文档会被灌入别人的内容并标成 saved，与自己的磁盘文件脱节）。
    const skillId = snapshot.skillId;
    const ok = window.confirm("确认回滚到该快照？当前文件内容将被覆盖。");
    if (!ok) return;
    try {
      const key = docKey(skillId, snapshot.filePath);
      // 清掉指向同一文件的挂起自动保存，防止陈旧内容覆盖回滚结果。
      const pending = pendingSave.current;
      if (pending && pending.key === key) {
        window.clearTimeout(pending.timer);
        pendingSave.current = null;
      }
      const result = await api.restoreSnapshot(snapshot.id);
      const snaps = await api.getSnapshots(skillId);
      // 只把回滚内容灌进「同 skill.id + 同文件」的文档；该 skill 的其他文档只刷新快照列表。
      updateTabs((list) => mapDoc(list, key, (doc) => ({ ...doc, fileState: result, editorValue: result.content, saveState: "saved", translation: undefined })));
      updateTabs((list) => list.map((tab) => (tab.skill.id === skillId ? { ...tab, snapshots: snaps } : tab)));
      void refreshSkillAfterSave(skillId);
      showToast(`已回滚 ${snapshot.filePath}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function viewSnapshotDiff(snapshot: Snapshot) {
    try {
      const current = await api.readSkillFile(snapshot.skillId, snapshot.filePath);
      setDiffView({
        snapshot,
        currentContent: current.content,
        snapshotContent: snapshot.content,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // 统一 diff（快照 → 当前）。超大文件时为 null，回退为双栏纯文本。
  const diffLines = useMemo(
    () => (diffView ? computeLineDiff(diffView.snapshotContent, diffView.currentContent) : null),
    [diffView],
  );

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
    window.addEventListener("blur", handler);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("click", handler);
      window.removeEventListener("contextmenu", handler);
      window.removeEventListener("blur", handler);
      window.removeEventListener("resize", handler);
    };
  }, [contextMenu, closeContextMenu]);

  // Global shortcuts. Handlers are stable wrappers, so this registers once.
  const onGlobalKeyDown = useStableCallback((event: KeyboardEvent) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "s") {
      event.preventDefault();
      saveNowStable();
    } else if (mod && key === "w") {
      event.preventDefault();
      if (activeKeyRef.current) closeTabStable(activeKeyRef.current);
    } else if (mod && key === "k") {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    } else if (event.ctrlKey && key === "tab") {
      event.preventDefault();
      cycleTab(event.shiftKey ? -1 : 1);
    } else if (key === "escape" && !event.defaultPrevented) {
      if (contextMenu) setContextMenu(null);
      else if (cloningSkill) setCloningSkill(null);
      else if (diffView) setDiffView(null);
      else if (showProvenanceInfo) setShowProvenanceInfo(false);
      else if (syncDraft && !syncBusy) setSyncDraft(null);
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onGlobalKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onGlobalKeyDown]);

  function acceptSettings(next: Settings, revision: number) {
    // Only a change to agent paths / enabled-set / agent-set needs a disk
    // rescan. Category, tag, and name edits are pure metadata — skip the rescan
    // (avoids flicker and clobbering folder state mid-drag).
    const sig = (list: Settings["customAgents"]) =>
      JSON.stringify(list.map((a) => [a.id, a.paths, a.enabled]).sort());
    const needsRescan = sig(confirmedSettingsRef.current.customAgents) !== sig(next.customAgents);
    confirmedSettingsRef.current = next;
    setConfirmedSettings(next);
    if (revision === settingsEditRevision.current) setSettings(next);
    if (needsRescan) void refresh();
  }

  async function updateSettings(next: Settings) {
    const revision = ++settingsEditRevision.current;
    const enabledEdits = new Map<string, boolean>(next.customAgents.filter((agent) =>
      settings.customAgents.find((previous) => previous.id === agent.id)?.enabled !== agent.enabled
    ).map((agent) => [agent.id, agent.enabled]));
    setSettings(next);
    // Serialize writes so an older response cannot overwrite a newer enable/disable.
    const save = settingsWriteQueue.current.then(async () => {
      // A queued metadata edit may predate a batch enable. Carry forward saved
      // flags unless this particular edit explicitly changed that flag.
      const latestFlags = new Map(confirmedSettingsRef.current.customAgents.map((agent) => [agent.id, agent.enabled]));
      const incoming = { ...next, customAgents: next.customAgents.map((agent) => ({
        ...agent, enabled: enabledEdits.get(agent.id) ?? latestFlags.get(agent.id) ?? agent.enabled
      })) };
      acceptSettings(await api.updateSettings(incoming), revision);
    });
    settingsWriteQueue.current = save.catch(() => {});
    try {
      await save;
    } catch (err) {
      if (revision === settingsEditRevision.current) setSettings(confirmedSettingsRef.current);
      setError(errorMessage(err));
    }
  }

  function enableInstalledAgents(ids: string[]): Promise<EnableInstalledAgentsResult> {
    const revision = ++settingsEditRevision.current;
    const save = settingsWriteQueue.current.then(async () => {
      const result = await api.enableInstalledAgents(ids);
      acceptSettings(result.settings, revision);
      return result;
    });
    settingsWriteQueue.current = save.then(() => {}, () => {});
    return save;
  }

  const themeClass = settings.theme === "light" ? "theme-light" : settings.theme === "system" ? "theme-system" : "theme-dark";
  const isMacChrome = document.documentElement.classList.contains("is-macos");
  const activeSyncTargets = syncDraft?.targets.filter((target) => target.status !== "same") ?? [];

  // Resolve a folder ref to its display data + member skills (self-contained,
  // independent of the current sidebar filter). Auto folders recompute from disk
  // structure; category folders from the saved skillNames.
  function resolveFolderView(ref: FolderRef): {
    name: string;
    kind: "auto" | "category";
    agentId: string;
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
      return { name: root, kind: "auto", agentId, repo, repoShare, total: seen.size, skills: members };
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
    return { name: cat.name, kind: "category", agentId: ref.agentId, repo: null, repoShare: 0, total: seen.size, skills: members };
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
    void updateSettings({ ...settings, customAgents });
    const category = settings.customAgents.find((a) => a.id === agentId)?.categories?.find((c) => c.id === categoryId);
    if (category) showToast(`已将 ${skill.name} 归入「${category.name}」`);
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
    void updateSettings({ ...settings, customAgents });
  }
  const removeFromOpenFolder = useStableCallback((skill: Skill) => {
    if (openFolder?.kind === "category") removeSkillFromCategory(skill, openFolder.agentId, openFolder.categoryId);
  });

  // Drag-to-classify: attach a tag to a skill (persisted in DB via setSkillTags).
  async function addTagToSkill(skill: Skill, tag: Tag) {
    if (skill.tags.some((t) => t.id === tag.id)) return;
    try {
      const updated = await api.setSkillTags(skill.id, [...skill.tags, tag]);
      setSkills((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      updateTabs((list) => list.map((t) => (t.skill.id === updated.id ? { ...t, skill: updated } : t)));
      showToast(`已为 ${skill.name} 添加标签「${tag.name}」`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // ── Mouse-based drag (replaces HTML5 DnD which is broken in Tauri WKWebView) ──
  // Drop targets self-report via onMouseEnter/onMouseLeave during drag. The drag
  // only starts after the pointer travels a few pixels, so a plain click opens
  // the skill without flashing a drag chip.

  function onDropTargetEnter(type: string, id: string, agentId?: string) {
    if (!dragRef.current?.chip) return;
    hoveredDropTarget.current = { type, id, agentId };
    setDropTarget(`${type}:${id}`);
  }

  function onDropTargetLeave() {
    if (!dragRef.current?.chip) return;
    hoveredDropTarget.current = null;
    setDropTarget(null);
  }

  const onDocMouseMove = useStableCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.chip) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      const chip = document.createElement("div");
      chip.className = "drag-chip";
      chip.textContent = d.skill.displayName || d.skill.name;
      document.body.appendChild(chip);
      d.chip = chip;
      setDragging(true);
      window.getSelection()?.removeAllRanges();
    }
    d.chip.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px) rotate(-2deg)`;
  });

  const onDocMouseUp = useStableCallback(() => {
    document.removeEventListener("mousemove", onDocMouseMove);
    document.removeEventListener("mouseup", onDocMouseUp);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !d.chip) return;
    d.chip.remove();
    setDragging(false);
    // The mouseup of a real drag is followed by a click on the card under the
    // pointer; swallow it so dropping does not also open the skill.
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
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
    setDropTarget(null);
  });

  const onSkillMouseDown = useStableCallback((skill: Skill, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { skill, startX: e.clientX, startY: e.clientY, chip: null };
    document.addEventListener("mousemove", onDocMouseMove);
    document.addEventListener("mouseup", onDocMouseUp);
  });

  const folderRemovable = openFolder?.kind === "category";
  function renderSkillCard(skill: Skill) {
    return (
      <SkillCard
        key={skill.id}
        skill={skill}
        agents={agents}
        agentIds={agentPresenceBySkillName.get(skill.name) ?? [skill.agentId]}
        provenance={provenance.get(skill.name)}
        onOpen={openSkillStable}
        onSync={openSyncPanelStable}
        onToggleStar={toggleStarStable}
        onContextMenu={handleContextMenu}
        compact={viewMode === "list"}
        onMouseDown={onSkillMouseDown}
        onRemoveFromFolder={folderRemovable ? removeFromOpenFolder : undefined}
        translateOn={translateCards}
        descriptionZh={cardZh[skill.id]}
        onRequestZh={requestCardZh}
      />
    );
  }

  const listClass = viewMode === "grid" ? "skill-grid" : "skill-list";
  const overviewTools = (
    <div className="page-tools">
      {traceProgress && (
        <span className="trace-progress" title="正在对照 skills.sh 判断来源">
          <Loader2 size={13} className="spin" /> 溯源 {traceProgress.done}/{traceProgress.total}
        </span>
      )}
      <div className="prov-filter">
        <CustomSelect value={provFilter} options={provFilterOptions} onChange={setProvFilter} ariaLabel="按来源筛选" />
      </div>
      <button
        className={translateCards ? "btn btn-toggle active" : "btn btn-toggle"}
        onClick={() => setTranslateCards((v) => !v)}
        title="翻译卡片描述（只读）"
        aria-pressed={translateCards}
      >
        <Languages size={14} /> {translateCards ? "原文" : "译"}
      </button>
      <div className="segmented" role="group" aria-label="视图">
        <button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")} title="网格" aria-pressed={viewMode === "grid"}><Grid2X2 size={15} /></button>
        <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} title="紧凑" aria-pressed={viewMode === "list"}><List size={15} /></button>
      </div>
    </div>
  );

  function scopeLabel() {
    if (filter.starred) return "收藏夹";
    if (filter.tagId) return settings.customTags.find((tag) => tag.id === filter.tagId)?.name ?? "标签";
    if (filter.agentId) return agentName(agents, filter.agentId);
    return "全部 Skill";
  }

  function scopeHead(): { eyebrow: ReactNode; title: ReactNode; meta: ReactNode } {
    const shown = new Set(visibleSkills.map((skill) => skill.name)).size;
    const countText = query.trim() || provFilter !== "all" ? `${shown} 个匹配` : `${shown} 个 Skill`;
    if (filter.starred) {
      return { eyebrow: <><Star size={12} /> 资料库</>, title: "收藏夹", meta: countText };
    }
    if (filter.tagId) {
      const tag = settings.customTags.find((item) => item.id === filter.tagId);
      return {
        eyebrow: <><span className="tag-dot" style={{ background: tag?.color }} /> 标签</>,
        title: tag?.name ?? "标签",
        meta: countText,
      };
    }
    if (filter.agentId) {
      const agent = agents.find((item) => item.id === filter.agentId);
      const roots = agent?.skillDirPaths ?? [];
      return {
        eyebrow: <><AgentIcon icon={agent?.icon ?? ""} size={13} /> Agent</>,
        title: agent?.name ?? "Agent",
        meta: <>{countText}{roots[0] && <><span className="page-meta-sep" /><span className="page-meta-path" title={roots.join("\n")}>{roots[0]}{roots.length > 1 ? ` 等 ${roots.length} 个目录` : ""}</span></>}</>,
      };
    }
    return {
      eyebrow: <><Library size={12} /> 资料库</>,
      title: "全部 Skill",
      meta: <>{countText}<span className="page-meta-sep" />{agents.length} 个 Agent</>,
    };
  }

  function renderOverview() {
    if (openFolder) {
      const fv = resolveFolderView(openFolder);
      const scope = scopeLabel();
      const back = <button className="page-back" onClick={() => enterFolder(null)}><ChevronLeft size={14} /> {scope}</button>;
      if (!fv) {
        return (
          <div className="page" key="folder-missing">
            <PageHead eyebrow={back} title="文件夹不存在" />
            <EmptyState icon={<Folder size={22} />} title="这个文件夹已不存在" body="可能已被删除或重命名。">
              <button className="btn" onClick={() => enterFolder(null)}>返回{scope}</button>
            </EmptyState>
          </div>
        );
      }
      const confident = !!fv.repo && fv.repoShare / fv.total >= 0.5;
      return (
        <div className="page" key={`folder:${openFolder.kind === "auto" ? openFolder.key : openFolder.categoryId}`}>
          <PageHead
            eyebrow={back}
            title={<><Folder size={26} className={fv.kind === "category" ? "page-title-icon folder-icon-cat" : "page-title-icon"} />{fv.name}</>}
            meta={
              <>
                <span>{fv.skills.length === fv.total ? `${fv.total} 个 Skill` : `${fv.skills.length} / ${fv.total} 个 Skill`}</span>
                <span className="page-meta-sep" />
                <span className="page-meta-agent"><AgentIcon icon={agents.find((a) => a.id === fv.agentId)?.icon ?? ""} size={13} /> {agentName(agents, fv.agentId)}</span>
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
              </>
            }
            tools={overviewTools}
          />
          {fv.skills.length === 0 ? (
            <EmptyState
              icon={<Folder size={22} />}
              title="这个文件夹下没有 Skill"
              body={fv.kind === "category" ? "把 Skill 卡片拖到侧边栏的这个分类即可归类。" : "当前搜索条件过滤掉了全部内容。"}
            >
              <button className="btn" onClick={() => enterFolder(null)}>返回{scope}</button>
            </EmptyState>
          ) : (
            <section className={listClass}>{fv.skills.map((skill) => renderSkillCard(skill))}</section>
          )}
        </div>
      );
    }

    const head = scopeHead();
    const flat = Boolean(filter.tagId || filter.starred);
    const cards = flat ? overviewSkills : standaloneSkills;
    const empty = flat ? overviewSkills.length === 0 : standaloneSkills.length === 0 && folderCards.length === 0;
    return (
      <div className="page" key={`scope:${filter.agentId ?? ""}:${filter.tagId ?? ""}:${filter.starred ? 1 : 0}`}>
        <PageHead eyebrow={head.eyebrow} title={head.title} meta={head.meta} tools={overviewTools} />
        {booting ? (
          <SkeletonGrid listClass={listClass} />
        ) : empty ? (
          query.trim() ? (
            <EmptyState icon={<Search size={22} />} title="没有匹配的 Skill" body={`没有找到与「${query.trim()}」相关的内容。`}>
              <button className="btn" onClick={() => setQuery("")}>清除搜索</button>
            </EmptyState>
          ) : filter.starred ? (
            <EmptyState icon={<Star size={22} />} title="还没有收藏的 Skill" body="点亮任意 Skill 卡片左上角的星标即可收藏。" />
          ) : filter.tagId ? (
            <EmptyState icon={<TagIcon size={22} />} title="这个标签下还没有 Skill" body="把 Skill 卡片拖到侧边栏的这个标签即可打标。" />
          ) : provFilter !== "all" ? (
            <EmptyState icon={<BadgeCheck size={22} />} title="没有符合该来源的 Skill" body="换一个来源筛选试试。">
              <button className="btn" onClick={() => setProvFilter("all")}>显示全部来源</button>
            </EmptyState>
          ) : (
            <EmptyState icon={<Sparkles size={22} />} title="没有发现 Skill" body="点击左下角「扫描」，或在设置中启用、添加 Agent 的 Skill 目录。">
              <button className="btn" onClick={() => navigate({ pane: "settings" })}>打开 Agent 目录</button>
            </EmptyState>
          )
        ) : (
          <section className={listClass}>
            {!flat && folderCards.map((folder) => (
              <FolderCard
                key={`${folder.agentId}:${folder.categoryId ?? folder.name}`}
                folder={folder}
                onOpen={() => enterFolder(folder.ref)}
                dropTarget={dropTarget}
                onDropTargetEnter={onDropTargetEnter}
                onDropTargetLeave={onDropTargetLeave}
              />
            ))}
            {cards.map((skill) => renderSkillCard(skill))}
          </section>
        )}
      </div>
    );
  }

  const activeAgent = activeTab ? agents.find((agent) => agent.id === activeTab.skill.agentId) : undefined;
  const dirtyFiles = useMemo(() => new Set(activeTab ? Object.values(activeTab.docs).filter((doc) => doc.saveState === "dirty" || doc.saveState === "saving" || doc.saveState === "error").map((doc) => doc.file) : []), [activeTab]);
  const translationShowing = Boolean(activeDoc?.translation?.showing && (activeDoc.translation.status === "loading" || activeDoc.translation.status === "done"));

  return (
    <div className={`app-shell ${themeClass}${dragging ? " is-dragging" : ""}`}>
      <aside className="sidebar">
        {isMacChrome && <div className="titlebar-drag" data-tauri-drag-region />}
        <div className="brand">
          <img className="brand-logo" src={skillanvilLogo} alt="SkillAnvil logo" />
          <strong>SkillAnvil</strong>
        </div>

        <label className="search-box">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
            placeholder="搜索 Skill"
            aria-label="搜索 Skill"
          />
          {query ? (
            <button type="button" className="search-clear" onClick={() => setQuery("")} title="清除搜索" aria-label="清除搜索"><X size={13} /></button>
          ) : (
            <kbd className="search-kbd">{isMacPlatform ? "⌘K" : "Ctrl K"}</kbd>
          )}
        </label>

        <div className="section-title">资料库</div>
        <nav className="nav-section">
          <button className={navClass(onSkillsPane && !openFolder && !filter.agentId && !filter.starred && !filter.tagId)} onClick={() => navigate({ filter: {}, folder: null })}>
            <Library size={16} /> <span className="agent-name">全部 Skill</span> <span className="nav-count">{uniqueSkillCount}</span>
          </button>
          <button className={navClass(onSkillsPane && !openFolder && Boolean(filter.starred))} onClick={() => navigate({ filter: { starred: true }, folder: null })}>
            <Star size={16} /> <span className="agent-name">收藏夹</span> <span className="nav-count">{starredCount}</span>
          </button>
        </nav>

        <div className="section-title">Agents</div>
        <nav className="nav-section grow">
          {agents.map((agent) => {
            const agentConfig = settings.customAgents.find((a) => a.id === agent.id);
            const categories = agentConfig?.categories ?? [];
            const autoFolders = autoFoldersByAgent.get(agent.id) ?? [];
            return (
              <AgentNavGroup
                key={agent.id}
                agent={agent}
                categories={categories}
                autoFolders={autoFolders}
                skillCount={skillCountByAgent.get(agent.id) ?? 0}
                expanded={folderToggle.get(agent.id) ?? (autoFolders.length <= 8)}
                onToggleExpand={() => setFolderToggle((m) => {
                  const cur = m.get(agent.id) ?? (autoFolders.length <= 8);
                  const n = new Map(m); n.set(agent.id, !cur); return n;
                })}
                isAgentActive={onSkillsPane && filter.agentId === agent.id && !openFolder}
                openFolder={onSkillsPane ? openFolder : null}
                editingCategoryId={editingCategoryId}
                confirmDeleteCategoryId={confirmDeleteCategoryId}
                dropTarget={dropTarget}
                dragging={dragging}
                navClass={navClass}
                onSelectAgent={() => navigate({ filter: { agentId: agent.id }, folder: null })}
                onOpenFolder={(ref) => navigate({ folder: ref })}
                onAddCategory={() => {
                  const newCat = { id: `cat-${crypto.randomUUID().slice(0, 8)}`, name: nextDefaultName(agentConfig?.categories ?? [], "新分类"), skillNames: [] as string[] };
                  const newCats = [...(agentConfig?.categories ?? []), newCat];
                  void updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                  setFolderToggle((m) => new Map(m).set(agent.id, true));
                  setEditingCategoryId(newCat.id);
                  setConfirmDeleteCategoryId(null);
                }}
                onRenameCategory={(catId, name) => {
                  const newCats = (agentConfig?.categories ?? []).map((c) => c.id === catId ? { ...c, name } : c);
                  void updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                  setEditingCategoryId(null);
                }}
                onDeleteCategory={(catId) => {
                  const newCats = (agentConfig?.categories ?? []).filter((c) => c.id !== catId);
                  void updateSettings({ ...settings, customAgents: settings.customAgents.map((a) => a.id === agent.id ? { ...a, categories: newCats } : a) });
                  setConfirmDeleteCategoryId(null);
                  if (openFolder?.kind === "category" && openFolder.categoryId === catId) setOpenFolder(null);
                }}
                onStartEdit={(catId) => { setConfirmDeleteCategoryId(null); setEditingCategoryId(catId); }}
                onAskDelete={(catId) => setConfirmDeleteCategoryId(catId)}
                onCancelEdit={() => setEditingCategoryId(null)}
                onCancelDelete={() => setConfirmDeleteCategoryId(null)}
                onDropTargetEnter={onDropTargetEnter}
                onDropTargetLeave={onDropTargetLeave}
              />
            );
          })}
          {agents.length === 0 && !booting && (
            <button className="nav-empty" onClick={() => navigate({ pane: "settings" })}>
              <Plus size={14} /> 启用 Agent
            </button>
          )}
        </nav>

        <div className="section-title">
          <span>标签</span>
          <button className="add-btn" onClick={() => {
            const color = TAG_COLORS[settings.customTags.length % TAG_COLORS.length];
            const newTag = { id: `tag-${crypto.randomUUID().slice(0, 8)}`, name: nextDefaultName(settings.customTags, "新标签"), color };
            void updateSettings({ ...settings, customTags: [...settings.customTags, newTag] });
            setEditingTagId(newTag.id);
            setConfirmDeleteTagId(null);
          }} title="添加标签" aria-label="添加标签"><Plus size={14} /></button>
        </div>
        <nav className="nav-section tag-nav">
          {settings.customTags.map((tag) => {
            const dropKey = `tag:${tag.id}`;
            return (
            <div
              key={tag.id}
              className={`sidebar-tag-item${dropTarget === dropKey ? " drop-active" : ""}${dragging ? " drop-armed" : ""}`}
              onMouseEnter={() => onDropTargetEnter("tag", tag.id)}
              onMouseLeave={onDropTargetLeave}
            >
              {editingTagId === tag.id ? (
                <InlineInput
                  placeholder="标签名称"
                  initialValue={tag.name}
                  onSubmit={(name) => {
                    void updateSettings({ ...settings, customTags: settings.customTags.map((t) => t.id === tag.id ? { ...t, name } : t) });
                    setEditingTagId(null);
                  }}
                  onCancel={() => setEditingTagId(null)}
                />
              ) : (
                <>
                  <button className={navClass(onSkillsPane && !openFolder && filter.tagId === tag.id)} onClick={() => navigate({ filter: { tagId: tag.id }, folder: null })}>
                    <span className="tag-dot" style={{ background: tag.color }} /> <span className="agent-name">{tag.name}</span>
                  </button>
                  {confirmDeleteTagId === tag.id ? (
                    <div className="sidebar-confirm">
                      <span className="sidebar-confirm-label">删除?</span>
                      <button className="icon-btn danger" onClick={(e) => {
                        e.stopPropagation();
                        void updateSettings({ ...settings, customTags: settings.customTags.filter((t) => t.id !== tag.id) });
                        setConfirmDeleteTagId(null);
                        if (filter.tagId === tag.id) setFilter({});
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
          <button className="ghost-button" onClick={() => void refresh(true)} disabled={scanning} title="重新扫描所有 Agent 目录">
            <RefreshCcw size={16} className={scanning ? "spin" : undefined} /> {scanning ? "扫描中" : "扫描"}
          </button>
          <button className={`ghost-button${isHome && pane === "settings" ? " active" : ""}`} onClick={() => navigate({ pane: "settings" })}>
            <SettingsIcon size={16} /> 设置
          </button>
        </div>
      </aside>

      <main className="main">
        <div
          className="tab-bar"
          ref={tabBarRef}
          role="tablist"
          aria-label="已打开的 Skill"
          onWheel={(event) => {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
          }}
        >
          <button
            className={isHome ? "tab home-tab active" : "tab home-tab"}
            onClick={() => setActiveKey(null)}
            title={pane === "settings" ? "设置" : "Skill 总览"}
            aria-label="返回总览"
            role="tab"
            aria-selected={isHome}
          >
            <Home size={14} />
          </button>
          {tabs.map((tab) => {
            const agent = agents.find((item) => item.id === tab.skill.agentId);
            const active = tab.skill.id === activeKey;
            const dirty = tabIsDirty(tab);
            return (
              <div
                key={tab.skill.id}
                data-tab-id={tab.skill.id}
                className={active ? "tab active" : "tab"}
                role="tab"
                tabIndex={0}
                aria-selected={active}
                onClick={() => setActiveKey(tab.skill.id)}
                onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTabStable(tab.skill.id); } }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveKey(tab.skill.id); } }}
                title={`${tab.skill.displayName} — ${agent?.name ?? "Unknown"} · ${tab.file}`}
              >
                <span className="tab-icon"><AgentIcon icon={agent?.icon ?? ""} size={13} /></span>
                <span className="tab-label">{tab.skill.displayName}</span>
                <button
                  type="button"
                  className={dirty ? "tab-close is-dirty" : "tab-close"}
                  onClick={(e) => { e.stopPropagation(); closeTabStable(tab.skill.id); }}
                  title="关闭标签页"
                  aria-label={`关闭 ${tab.skill.displayName}`}
                >
                  <span className="tab-dot" />
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="main-body">
          <div className="notice-stack">
            {error && (
              <div className="notice" role="alert">
                <ShieldAlert size={15} />
                <span className="notice-text">{error}</span>
                <button className="notice-close" onClick={() => setError(null)} title="关闭" aria-label="关闭提示"><X size={14} /></button>
              </div>
            )}
            {scanIssues.length > 0 && (
              <div className="notice warn" title={scanIssues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}>
                <AlertTriangle size={15} />
                <span className="notice-text">扫描跳过 {scanIssues.length} 个异常 Skill。其他功能可继续使用；悬停查看路径。</span>
                <button className="notice-close" onClick={() => setScanIssues([])} title="关闭" aria-label="关闭提示"><X size={14} /></button>
              </div>
            )}
            {updateInfo && !updateDismissed && updateInfo.hasUpdate && (
              <div className="update-banner">
                <div className="update-banner-body">
                  <Sparkles size={16} />
                  <div className="update-banner-text">
                    <strong>SkillAnvil {updateInfo.latestVersion} 已发布</strong>
                    <span>当前版本 {updateInfo.currentVersion} — 建议更新以获取最新功能和修复。</span>
                  </div>
                </div>
                <div className="update-banner-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => { void api.openUrl(updateInfo.assetUrl || updateInfo.releaseUrl); }}>
                    下载
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={dismissUpdatePanel}>
                    忽略此版本
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="view-area">
            <div className={`view page-scroll${isHome ? "" : " is-hidden"}`} ref={pageScrollRef} aria-hidden={!isHome || undefined}>
              {pane === "settings" ? (
                <div className="page" key="settings">
                  <PageHead
                    eyebrow={<><SettingsIcon size={12} /> 偏好设置</>}
                    title="设置"
                    meta={<>主题、快捷键、溯源、翻译与 Agent 目录{updateInfo?.currentVersion ? <><span className="page-meta-sep" />SkillAnvil {updateInfo.currentVersion}</> : null}</>}
                  />
                  <SettingsPanel
                    settings={settings}
                    onChange={updateSettings}
                    onEnableAgents={enableInstalledAgents}
                    agents={agents}
                    traceProgress={traceProgress}
                    onTraceScoped={() => void autoTraceProvenance(skills, provenance, true, settings.provenanceAgentId)}
                    onShowProvenanceInfo={() => setShowProvenanceInfo(true)}
                    updateInfo={updateInfo}
                    updateDismissed={updateDismissed}
                    onDismissUpdate={dismissUpdatePanel}
                  />
                </div>
              ) : renderOverview()}
            </div>

            {tabs.length > 0 && (
              <section className={`view workspace${activeTab ? "" : " is-hidden"}`} aria-hidden={!activeTab || undefined}>
                {activeTab && (
                  <header className="workspace-head" key={activeTab.skill.id}>
                    <div className="workspace-heading">
                      <div className="workspace-crumbs">
                        <span className="crumb-agent"><AgentIcon icon={activeAgent?.icon ?? ""} size={13} /> {activeAgent?.name ?? "Unknown"}</span>
                        <ChevronRight size={12} className="crumb-sep" />
                        <span className="crumb-path" title={activeTab.skill.dirPath}>{skillRelativeDir(activeTab.skill, agents)}</span>
                        <ChevronRight size={12} className="crumb-sep" />
                        <span className="crumb-file">{activeTab.file}</span>
                      </div>
                      <h1 className="skill-title-serif">{activeTab.skill.displayName}</h1>
                    </div>
                    <div className="workspace-actions">
                      {activeDoc && <SaveIndicator state={activeDoc.saveState} />}
                      <button
                        onClick={() => void toggleTranslation()}
                        className={translationShowing ? "btn active" : "btn"}
                        disabled={!activeDoc?.fileState || activeDoc.translation?.status === "loading"}
                        title="机器翻译（只读，不改原文件）"
                      >
                        {activeDoc?.translation?.status === "loading" ? <Loader2 size={14} className="spin" /> : <Languages size={14} />}
                        {activeDoc?.translation?.status === "loading" ? "翻译中" : translationShowing ? "原文" : "译"}
                      </button>
                      <button className="btn" onClick={() => void saveNow()} disabled={!activeDoc?.fileState} title={`保存（${isMacPlatform ? "⌘S" : "Ctrl+S"}）`}><Save size={14} /> 保存</button>
                      <button className="btn" onClick={() => setCloningSkill(activeTab.skill)}><Copy size={14} /> 克隆</button>
                      <button className="btn btn-danger" onClick={() => void trashSkill(activeTab.skill)}><Trash2 size={14} /> 卸载</button>
                    </div>
                  </header>
                )}
                <div className="workspace-body">
                  <div className="editor-card">
                    {translationShowing && (
                      <div className="translation-banner">
                        <Languages size={13} />
                        {activeDoc?.translation?.status === "loading" ? "翻译中…（流式）" : "机器翻译 · 只读 · 点「原文」切回"}
                      </div>
                    )}
                    <div className="editor-stack">
                      {tabs.flatMap((tab) => Object.values(tab.docs).filter((doc) => doc.fileState).map((doc) => {
                        const key = docKey(tab.skill.id, doc.file);
                        const visible = tab.skill.id === activeKey && doc.file === tab.file && !translationShowing;
                        return (
                          <MarkdownEditor
                            key={key}
                            hidden={!visible}
                            value={doc.editorValue}
                            onChange={(value) => changeEditor(key, value)}
                            theme={settings.theme}
                          />
                        );
                      }))}
                      {activeTab && activeDoc && !activeDoc.fileState && (
                        activeDoc.loadError ? (
                          <div className="editor-placeholder">
                            <ShieldAlert size={20} />
                            <strong>无法打开 {activeDoc.file}</strong>
                            <p>{activeDoc.loadError}</p>
                            <button className="btn" onClick={() => selectFile(activeTab.skill.id, activeDoc.file)}>重试</button>
                          </div>
                        ) : (
                          <div className="editor-placeholder is-loading" aria-busy="true">
                            <Loader2 size={18} className="spin" />
                            <span>正在读取 {activeDoc.file}…</span>
                          </div>
                        )
                      )}
                      {activeTab && activeDoc && translationShowing && activeDoc.translation && (
                        activeDoc.translation.status === "loading" ? (
                          <StreamingText text={activeDoc.translation.text} />
                        ) : (
                          <MarkdownEditor
                            key={`${activeTab.skill.id}-${activeDoc.file}-zh`}
                            value={activeDoc.translation.text}
                            onChange={() => {}}
                            theme={settings.theme}
                            readOnly
                          />
                        )
                      )}
                    </div>
                  </div>
                  {activeTab && (
                    <aside className="inspector" key={activeTab.skill.id}>
                      <InspectorSection title="文件" count={activeTab.skill.files.filter((file) => !file.isDir).length}>
                        <FileTree
                          files={activeTab.skill.files}
                          selectedFile={activeTab.file}
                          dirtyFiles={dirtyFiles}
                          onOpen={(relativePath) => selectFile(activeTab.skill.id, relativePath)}
                        />
                      </InspectorSection>
                      <InspectorSection title="来源">
                        <ProvenanceCard
                          provenance={provenance.get(activeTab.skill.name)}
                          onOpenRepo={(repo) => void api.openUrl(`https://github.com/${repo}`)}
                          onRetrace={() => void retraceSkill(activeTab.skill)}
                        />
                      </InspectorSection>
                      <InspectorSection title="同步到">
                        <div className="sync-list">
                          {activeTab.syncTargets === null ? (
                            <p className="muted-copy inline-loading"><Loader2 size={12} className="spin" /> 正在比较各 Agent 中的副本…</p>
                          ) : activeTab.syncError ? (
                            <p className="muted-copy is-error">无法检查同步状态：{activeTab.syncError}</p>
                          ) : activeTab.syncTargets.length === 0 ? (
                            <p className="muted-copy">没有其他已启用的 Agent。可在设置中启用更多 Agent。</p>
                          ) : (
                            <>
                              {activeTab.syncTargets.map((target) => {
                                const agent = agents.find((a) => a.id === target.agentId);
                                return (
                                  <button key={target.agentId} disabled={target.status === "same"} title={target.status === "same" ? `${target.targetPath}（已一致）` : `${target.status === "missing" ? "新增" : "覆盖"}到 ${target.targetPath}`} onClick={() => void syncSelected(target)}>
                                    <AgentIcon icon={agent?.icon || ""} size={14} />
                                    <span>{target.agentName}</span>
                                    <em className={`sync-badge ${target.status}`}>{statusLabel(target.status)}</em>
                                  </button>
                                );
                              })}
                              {activeTab.syncTargets.every((t) => t.status === "same") && <p className="muted-copy">所有目标均已同步，无需操作。</p>}
                            </>
                          )}
                        </div>
                      </InspectorSection>
                      <InspectorSection title="标签">
                        <TagPicker
                          tags={settings.customTags}
                          value={activeTab.skill.tags}
                          onChange={(tags) => void updateSelectedSkillTags(tags)}
                        />
                      </InspectorSection>
                      <InspectorSection title="子分类">
                        <CategoryPicker
                          agentId={activeTab.skill.agentId}
                          skillName={activeTab.skill.name}
                          settings={settings}
                          onChange={(next) => void updateSettings(next)}
                        />
                      </InspectorSection>
                      <InspectorSection title="信息">
                        <dl className="meta">
                          <dt>版本</dt><dd>{activeTab.skill.version || "-"}</dd>
                          <dt>编码</dt><dd>{activeDoc?.fileState?.encoding ?? "-"}</dd>
                          <dt>路径</dt><dd className="meta-path" title={activeTab.skill.dirPath}>{activeTab.skill.dirPath}</dd>
                          <dt>存在于</dt>
                          <dd>
                            <AgentPresence
                              agentIds={agentPresenceBySkillName.get(activeTab.skill.name) ?? [activeTab.skill.agentId]}
                              agents={agents}
                            />
                          </dd>
                        </dl>
                        <button className="btn btn-sm wide-button" onClick={() => void revealInFileManager(activeTab.skill.dirPath)}><FolderOpen size={13} /> 在文件管理器中显示</button>
                      </InspectorSection>
                      <InspectorSection title="版本历史" count={activeTab.snapshots?.length || undefined}>
                        <div className="snapshot-list">
                          {activeTab.snapshots === null ? (
                            <p className="muted-copy inline-loading"><Loader2 size={12} className="spin" /> 读取中…</p>
                          ) : activeTab.snapshots.length === 0 ? (
                            <p className="muted-copy">{settings.snapshotsEnabled ? "暂无快照。保存时自动创建。" : "快照已在设置中关闭。"}</p>
                          ) : (
                            activeTab.snapshots.slice(0, 10).map((snap) => (
                              <div key={snap.id} className="snapshot-row">
                                <div className="snapshot-info">
                                  <span className="snapshot-time" title={new Date(snap.createdAt).toLocaleString("zh-CN")}>{formatSnapshotTime(snap.createdAt)}</span>
                                  <span className="snapshot-file">{snap.filePath}</span>
                                </div>
                                <div className="snapshot-actions">
                                  <button title="查看 diff" aria-label="查看 diff" onClick={() => void viewSnapshotDiff(snap)}><GitCompare size={13} /></button>
                                  <button title="回滚到此版本" aria-label="回滚到此版本" onClick={() => void restoreSnapshot(snap)}><RotateCcw size={13} /></button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </InspectorSection>
                    </aside>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      </main>

      {syncDraft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !syncBusy) setSyncDraft(null); }}>
          <section className="modal sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-title">
            <header>
              <div>
                <h2 id="sync-title">同步 {syncDraft.skill.displayName}</h2>
                <p>{syncDraft.skill.dirPath}</p>
              </div>
              <button className="icon-button" onClick={() => setSyncDraft(null)} disabled={syncBusy} aria-label="关闭"><X size={16} /></button>
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
                        className="checkbox"
                        disabled={target.status === "same" || syncBusy}
                        checked={syncDraft.selectedAgentIds.includes(target.agentId)}
                        onChange={() => toggleSyncDraftTarget(target.agentId)}
                      />
                      <AgentIcon icon={agent?.icon || ""} size={16} />
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
              <button className="btn" onClick={() => setSyncDraft(null)} disabled={syncBusy}>取消</button>
              <button className="btn btn-primary" onClick={() => void confirmSyncDraft()} disabled={syncBusy || syncDraft.selectedAgentIds.length === 0}>
                {syncBusy ? <><Loader2 size={14} className="spin" /> 同步中</> : `同步 ${syncDraft.selectedAgentIds.length} 个目标`}
              </button>
            </footer>
          </section>
        </div>
      )}

      {diffView && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDiffView(null)}>
          <section className="modal diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2 id="diff-title">版本对比</h2>
                <p>{formatSnapshotTime(diffView.snapshot.createdAt)} — {diffView.snapshot.filePath}</p>
              </div>
              {diffLines && (
                <span className="diff-legend">
                  <span className="diff-legend-del">− 快照</span>
                  <span className="diff-legend-add">+ 当前</span>
                </span>
              )}
              <button className="icon-button" onClick={() => setDiffView(null)} aria-label="关闭"><X size={16} /></button>
            </header>
            {diffLines ? (
              <div className="diff-content diff-content-unified">
                <div className="diff-unified">
                  {diffLines.map((line, index) => (
                    <div key={index} className={line.type === "same" ? "diff-line" : `diff-line ${line.type}`}>
                      <span className="diff-line-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
                      <span className="diff-line-text">{line.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
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
            )}
            <footer>
              <span />
              <button className="btn" onClick={() => setDiffView(null)}>关闭</button>
              <button className="btn btn-primary" onClick={() => { void restoreSnapshot(diffView.snapshot); setDiffView(null); }}>
                <RotateCcw size={14} /> 回滚到快照版本
              </button>
            </footer>
          </section>
        </div>
      )}

      {showProvenanceInfo && <ProvenanceInfoModal onClose={() => setShowProvenanceInfo(false)} />}

      {contextMenu && (
        <ContextMenuView x={contextMenu.x} y={contextMenu.y}>
          <button onClick={() => { openSkill(contextMenu.skill); closeContextMenu(); }}>
            <FileText size={14} /> 编辑
          </button>
          {agents.length > 1 && (
            <button onClick={() => { void openSyncPanel(contextMenu.skill); closeContextMenu(); }}>
              <RefreshCcw size={14} /> 同步到…
            </button>
          )}
          <button onClick={() => { void toggleStar(contextMenu.skill); closeContextMenu(); }}>
            <Star size={14} /> {contextMenu.skill.starred ? "取消收藏" : "收藏"}
          </button>
          <button onClick={() => { setCloningSkill(contextMenu.skill); closeContextMenu(); }}>
            <Copy size={14} /> 克隆
          </button>
          <button onClick={() => { void revealInFileManager(contextMenu.skill.dirPath); closeContextMenu(); }}>
            <FolderOpen size={14} /> 在文件管理器中显示
          </button>
          <div className="context-separator" />
          <button onClick={() => { void trashSkill(contextMenu.skill); closeContextMenu(); }} className="danger">
            <Trash2 size={14} /> 卸载
          </button>
        </ContextMenuView>
      )}

      {cloningSkill && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setCloningSkill(null)}>
          <section className="modal clone-modal" role="dialog" aria-modal="true" aria-labelledby="clone-title" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <h2 id="clone-title">克隆 {cloningSkill.displayName}</h2>
                <p>在同一目录下复制一份，并改写 SKILL.md 中的名称。</p>
              </div>
              <button className="icon-button" onClick={() => setCloningSkill(null)} aria-label="关闭"><X size={16} /></button>
            </header>
            <CloneForm
              placeholder={`${cloningSkill.name}-copy`}
              onSubmit={(name) => void doCloneSkill(cloningSkill, name)}
              onCancel={() => setCloningSkill(null)}
            />
          </section>
        </div>
      )}

      <footer className="statusbar">
        <span>{agents.length} agents</span>
        <span>{uniqueSkillCount} skills</span>
        {traceProgress && <span className="statusbar-progress"><Loader2 size={11} className="spin" /> 溯源 {traceProgress.done}/{traceProgress.total}</span>}
        {activeDoc && <span className={`statusbar-save state-${activeDoc.saveState}`}>{saveStateText(activeDoc.saveState)}</span>}
      </footer>

      <div className="toast-container" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            {toast.type === "error" ? <ShieldAlert size={15} /> : toast.type === "info" ? <Info size={15} /> : <CheckCircle2 size={15} />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PageHead({ eyebrow, title, meta, tools }: { eyebrow?: ReactNode; title: ReactNode; meta?: ReactNode; tools?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-copy">
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {tools}
    </header>
  );
}

function EmptyState({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {children && <div className="empty-state-actions">{children}</div>}
    </div>
  );
}

function SkeletonGrid({ listClass }: { listClass: string }) {
  return (
    <section className={listClass} aria-busy="true" aria-label="正在扫描">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className={listClass === "skill-list" ? "skeleton-card compact" : "skeleton-card"} style={{ animationDelay: `${index * 60}ms` }}>
          <span className="skeleton-line short" />
          <span className="skeleton-line title" />
          <span className="skeleton-line" />
          <span className="skeleton-line" />
        </div>
      ))}
    </section>
  );
}

function InspectorSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="inspector-section">
      <h2 className="inspector-head">{title}{typeof count === "number" && <span className="inspector-count">{count}</span>}</h2>
      {children}
    </section>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const icon = state === "saving" ? <Loader2 size={12} className="spin" /> : state === "error" ? <ShieldAlert size={12} /> : state === "dirty" ? <span className="save-dot" /> : <Check size={12} />;
  return <span className={`save-indicator state-${state}`} role="status">{icon}{saveStateText(state)}</span>;
}

function ContextMenuView({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  // Keep the menu fully on screen near the window edges.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: position.left, top: position.top }} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

function CloneForm({ placeholder, onSubmit, onCancel }: { placeholder: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const name = value.trim() || placeholder;
  return (
    <form
      className="clone-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        onSubmit(name);
      }}
    >
      <label className="field-row">
        <span>新的 Skill 名称</span>
        <input ref={ref} value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} spellCheck={false} />
      </label>
      <footer>
        <span />
        <button type="button" className="btn" onClick={onCancel}>取消</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : <Copy size={14} />} 克隆为 {name}</button>
      </footer>
    </form>
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
        <button className="prov-retrace" onClick={onRetrace} title="重新溯源" aria-label="重新溯源"><RefreshCcw size={12} /></button>
      </div>
      {provenance?.repo && (
        <button className="prov-repo" onClick={() => onOpenRepo(provenance.repo!)} title="在 GitHub 打开">
          <Github size={12} /> {provenance.repo}
        </button>
      )}
      {(contentLabel || (typeof provenance?.installs === "number" && provenance.installs > 0)) && (
        <div className="prov-card-meta">
          {typeof provenance?.installs === "number" && provenance.installs > 0 && (
            <span>{provenance.installs.toLocaleString()} 安装</span>
          )}
          {contentLabel && <span className={provenance?.contentMatch === "identical" ? "prov-ok" : "prov-warn"}>{contentLabel}</span>}
        </div>
      )}
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
      <section className="modal prov-info-modal" role="dialog" aria-modal="true" aria-labelledby="prov-info-title" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2 id="prov-info-title">Skill 溯源是怎么判断的</h2>
            <p>给每个本地 Skill 找出它的来源：来自某个 GitHub 仓库，还是本地自制。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
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
            <li>skills.sh 按 IP 限流（约每 10–13 个请求要等 60 秒），所以 Skill 很多时首次会比较慢、进度条会间歇停顿。可在设置中<strong>限定只对某个 Agent 溯源</strong>来加快。</li>
            <li>只会把 Skill <strong>名称</strong>发给 skills.sh、并从 GitHub 拉取公开内容比对，<strong>不会上传你的本地 Skill 内容</strong>。</li>
          </ul>
        </div>
        <footer>
          <span />
          <button className="btn btn-primary" onClick={onClose}>知道了</button>
        </footer>
      </section>
    </div>
  );
}

function AgentNavGroup({
  agent, categories, autoFolders, skillCount, expanded, onToggleExpand,
  isAgentActive, openFolder, editingCategoryId, confirmDeleteCategoryId,
  dropTarget, dragging, navClass,
  onSelectAgent, onOpenFolder, onAddCategory, onRenameCategory, onDeleteCategory,
  onStartEdit, onAskDelete, onCancelEdit, onCancelDelete, onDropTargetEnter, onDropTargetLeave,
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
  dropTarget: string | null;
  dragging: boolean;
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
          aria-expanded={hasSub ? expanded : undefined}
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
        <button className="add-category-icon" onClick={(e) => { e.stopPropagation(); onAddCategory(); }} title="新建分类" aria-label={`为 ${agent.name} 新建分类`}><Plus size={14} /></button>
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
                className={`sidebar-category-item${dropTarget === dropKey ? " drop-active" : ""}${dragging ? " drop-armed" : ""}`}
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

const SkillCard = memo(function SkillCard({
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
  onMouseDown?: (skill: Skill, e: React.MouseEvent) => void;
  onRemoveFromFolder?: (skill: Skill) => void;
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
      : (translateOn && descriptionZh ? descriptionZh : skill.description) || "";
    const agentName = agents.find(a => a.id === agentIds[0])?.name ?? "";
    const sub = [subtitle, agentName].filter(Boolean).join(" · ");
    return (
      <article
        className="skill-card compact"
        onClick={() => onOpen(skill)}
        onContextMenu={(e) => onContextMenu(e, skill)}
        onMouseDown={onMouseDown ? (e) => onMouseDown(skill, e) : undefined}
      >
        <div className="compact-title">
          <h2>{skill.name}</h2>
          <ProvenanceBadge provenance={provenance} />
          {skill.starred && <Star size={12} className="compact-star" />}
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
      onMouseDown={onMouseDown ? (e) => onMouseDown(skill, e) : undefined}
    >
      <div className="card-head">
        <button className={skill.starred ? "icon-button starred" : "icon-button"} onClick={(e) => { e.stopPropagation(); onToggleStar(skill); }} title={skill.starred ? "取消收藏" : "收藏"} aria-pressed={skill.starred}>
          <Star size={17} />
        </button>
        {onRemoveFromFolder && (
          <button className="icon-button folder-remove" onClick={(e) => { e.stopPropagation(); onRemoveFromFolder(skill); }} title="从文件夹移除">
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
});

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
  if (tags.length === 0) return <p className="muted-copy">还没有标签。可在侧边栏或设置中添加。</p>;
  return (
    <div className="tag-picker">
      {tags.map((tag) => {
        const selected = selectedIds.has(tag.id);
        return (
          <button
            key={tag.id}
            className={selected ? "selected" : ""}
            style={{ "--tag-color": tag.color } as CSSProperties}
            aria-pressed={selected}
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
    return <p className="muted-copy">该 Agent 暂无子分类，可在侧边栏 Agent 行的「+」新建。</p>;
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
            aria-pressed={isInCategory}
            onClick={() => toggleCategory(cat.id, isInCategory)}
          >
            <span className="category-dot" />
            {cat.name}
          </button>
        );
      })}
    </div>
  );
}

const SETTINGS_SECTIONS = [
  { id: "settings-general", label: "外观与行为" },
  { id: "settings-provenance", label: "溯源" },
  { id: "settings-translation", label: "翻译" },
  { id: "settings-tags", label: "标签" },
  { id: "settings-agents", label: "Agent 目录" },
  { id: "settings-about", label: "关于" },
];

function SettingsSection({ id, title, description, action, children, bodyClassName }: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="settings-section" id={id} aria-labelledby={`${id}-title`}>
      <header className="settings-section-head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="settings-section-action">{action}</div>}
      </header>
      <div className={bodyClassName ? `settings-card ${bodyClassName}` : "settings-card"}>{children}</div>
    </section>
  );
}

function SettingsPanel({ settings, onChange, onEnableAgents, agents, traceProgress, onTraceScoped, onShowProvenanceInfo, updateInfo, updateDismissed, onDismissUpdate }: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onEnableAgents: (ids: string[]) => Promise<EnableInstalledAgentsResult>;
  agents: Agent[];
  traceProgress: { done: number; total: number } | null;
  onTraceScoped: () => void;
  onShowProvenanceInfo: () => void;
  updateInfo: UpdateInfo | null;
  updateDismissed: boolean;
  onDismissUpdate: () => void;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentQuery, setAgentQuery] = useState("");
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTag, setEditingTag] = useState<Tag>({ id: "", name: "", color: "#7dd3fc" });
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [addingTag, setAddingTag] = useState(false);
  const [addingCategoryForAgent, setAddingCategoryForAgent] = useState<string | null>(null);
  const [addingAgent, setAddingAgent] = useState(false);
  const [addingAgentStep, setAddingAgentStep] = useState<"name" | "path">("name");
  const [addingAgentName, setAddingAgentName] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; message: string } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [checkUpdateResult, setCheckUpdateResult] = useState<UpdateInfo | null>(null);
  const [checkUpdateError, setCheckUpdateError] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [clearCacheResult, setClearCacheResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function runUpdateCheck() {
    setCheckingUpdate(true);
    setCheckUpdateResult(null);
    setCheckUpdateError(null);
    try {
      // 手动检查更新要无视「忽略此版本」记录，否则被忽略过的新版本永远查不到。
      const result = await api.checkForUpdates(true);
      setCheckUpdateResult(result);
    } catch (err) {
      setCheckUpdateResult(null);
      setCheckUpdateError(errorMessage(err));
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function runClearTranslationCache() {
    setClearingCache(true);
    setClearCacheResult(null);
    try {
      const removed = await api.clearTranslationCache();
      setClearCacheResult({ ok: true, message: `已清除 ${removed} 条缓存` });
    } catch (err) {
      setClearCacheResult({ ok: false, message: errorMessage(err) });
    } finally {
      setClearingCache(false);
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
    const color = TAG_COLORS[settings.customTags.length % TAG_COLORS.length];
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
      customTags: settings.customTags.map((t) => t.id === editingTagId ? { ...editingTag, name: editingTag.name.trim() } : t)
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
          ? { ...a, categories: (a.categories || []).map((c) => c.id === editingCategoryId ? { ...c, name: editingCategoryName.trim() } : c) }
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

  function addCustomAgentWithPath(path: string) {
    const id = `custom-${crypto.randomUUID()}`;
    onChange({
      ...settings,
      customAgents: [
        ...settings.customAgents,
        {
          id,
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
    setSelectedAgentId(id);
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
  const selectedHarness = selectedAgentId ? harnessById.get(selectedAgentId) : undefined;
  const enabledCount = settings.customAgents.filter((agent) => agent.enabled).length;
  const directoryEntries = [
    ...settings.customAgents.map((agent) => ({ ...agent, tier: harnessById.get(agent.id)?.tier ?? 0 })),
    ...harnessCatalog.filter((entry) => entry.status !== "native").map((entry) => ({ ...entry, builtin: true, enabled: false })),
  ].filter((entry) => `${entry.name} ${entry.paths.join(" ")} ${harnessById.get(entry.id)?.loading ?? ""}`.toLowerCase().includes(agentQuery.trim().toLowerCase()));
  const updateResult = checkUpdateResult?.hasUpdate ? checkUpdateResult : !checkUpdateResult && updateInfo && !updateDismissed && updateInfo.hasUpdate ? updateInfo : null;

  return (
    <div className="settings-panel">
      <nav className="settings-nav" aria-label="设置分区">
        {SETTINGS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <SettingsSection id="settings-general" title="外观与行为" description="主题、全局快捷键与窗口行为。">
        <div className="setting-row">
          <span className="setting-copy"><strong>主题</strong><span>编辑器配色随主题调整。</span></span>
          <CustomSelect
            value={settings.theme}
            options={[
              { value: "dark", label: "深色" },
              { value: "light", label: "浅色" },
              { value: "system", label: "跟随系统" }
            ]}
            onChange={(theme) => onChange({ ...settings, theme })}
            ariaLabel="主题"
          />
        </div>
        <div className="setting-row">
          <span className="setting-copy"><strong>全局快捷键</strong><span>随时唤出 SkillAnvil。macOS 默认 Cmd+Shift+K，Windows/Linux 默认 Ctrl+Shift+K。</span></span>
          <ShortcutInput value={settings.shortcut} onChange={(shortcut) => onChange({ ...settings, shortcut })} />
        </div>
        <label className="setting-row toggle-row">
          <span className="setting-copy"><strong>关闭窗口时最小化到系统托盘</strong><span>托盘不可用时会直接退出，避免留下无法唤出的后台进程。</span></span>
          <input type="checkbox" className="switch" checked={settings.minimizeToTray} onChange={(event) => onChange({ ...settings, minimizeToTray: event.target.checked })} />
        </label>
        <label className="setting-row toggle-row">
          <span className="setting-copy"><strong>保存时创建本地快照</strong><span>每个文件保留最近 20 个版本，可在编辑页的「版本历史」中对比与回滚。</span></span>
          <input type="checkbox" className="switch" checked={settings.snapshotsEnabled} onChange={(event) => onChange({ ...settings, snapshotsEnabled: event.target.checked })} />
        </label>
      </SettingsSection>

      <SettingsSection
        id="settings-provenance"
        title="Skill 溯源"
        description={<>对照 skills.sh 自动判断每个 Skill 来自哪个 GitHub 仓库。<button type="button" className="link-button" onClick={onShowProvenanceInfo}>了解溯源逻辑</button></>}
      >
        <div className="setting-row">
          <span className="setting-copy"><strong>溯源范围</strong><span>限定只对某个 Agent 的 Skill 溯源，可加快首次速度。</span></span>
          <CustomSelect
            value={settings.provenanceAgentId ?? "all"}
            options={[
              { value: "all", label: "全部 Agent" },
              ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
            onChange={(value) => onChange({ ...settings, provenanceAgentId: value === "all" ? null : value })}
            ariaLabel="溯源范围"
          />
        </div>
        <div className="setting-row">
          <span className="setting-copy">
            <strong>立即溯源</strong>
            <span>重新检查{settings.provenanceAgentId ? ` ${agentName(agents, settings.provenanceAgentId)} 的` : "所有"} Skill 的来源。结果会缓存，平时无需手动触发。</span>
          </span>
          <button className="btn" onClick={onTraceScoped} disabled={traceProgress !== null}>
            {traceProgress ? <Loader2 size={14} className="spin" /> : <BadgeCheck size={14} />} {traceProgress ? `溯源中 ${traceProgress.done}/${traceProgress.total}` : "开始溯源"}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="settings-translation"
        title="Skill 翻译"
        description="自带接口（OpenAI 兼容或 Anthropic 原生），在编辑页与总览把英文 Skill 一键译成中文。译文只读，绝不改原文件；Key 仅保存在本机。"
      >
        <div className="setting-row">
          <span className="setting-copy"><strong>接口协议</strong><span>DeepSeek、通义、OpenRouter 等选 OpenAI 兼容。</span></span>
          <CustomSelect
            value={settings.translation.protocol}
            options={[
              { value: "openai", label: "OpenAI 兼容" },
              { value: "anthropic", label: "Anthropic 原生" }
            ]}
            onChange={(protocol) => setTranslation({ protocol })}
            ariaLabel="接口协议"
          />
        </div>
        <div className="field-grid">
          <label className="field-row">
            <span>接口 Base URL</span>
            <input
              type="text"
              value={settings.translation.baseUrl}
              placeholder={settings.translation.protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.deepseek.com"}
              onChange={(e) => setTranslation({ baseUrl: e.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="field-row">
            <span>API Key {settings.translation.apiKey && <em className="field-badge"><Check size={11} /> 已保存</em>}</span>
            <input
              type="password"
              value={apiKeyDraft}
              autoComplete="new-password"
              placeholder={settings.translation.apiKey ? "输入新 Key 可替换" : "sk-..."}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apiKeyDraft.trim()) {
                  e.preventDefault();
                  setTranslation({ apiKey: apiKeyDraft.trim() });
                  setApiKeyDraft("");
                }
              }}
            />
          </label>
          <label className="field-row">
            <span>模型</span>
            <input
              type="text"
              list="translation-models"
              value={settings.translation.model}
              placeholder={settings.translation.protocol === "anthropic" ? "claude-haiku-4-5" : "deepseek-chat"}
              onChange={(e) => setTranslation({ model: e.target.value })}
              spellCheck={false}
            />
            <datalist id="translation-models">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <label className="field-row">
            <span>目标语言</span>
            <input
              type="text"
              value={settings.translation.targetLang}
              placeholder="zh-CN（可填 en、ja 等）"
              onChange={(e) => setTranslation({ targetLang: e.target.value })}
              spellCheck={false}
            />
          </label>
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
        <div className="settings-actions translate-test">
          <div className="settings-actions-group">
            <button
              className="btn btn-primary"
              onClick={() => {
                setTranslation({ apiKey: apiKeyDraft.trim() });
                setApiKeyDraft("");
              }}
              disabled={!apiKeyDraft.trim()}
            >
              保存 API Key
            </button>
            <button
              className="btn"
              onClick={() => {
                setApiKeyDraft("");
                setTranslation({ apiKey: "" });
              }}
              disabled={!settings.translation.apiKey}
            >
              清除 API Key
            </button>
          </div>
          <div className="settings-actions-group">
            <button className="btn" onClick={() => void detectModels()} disabled={detecting}>
              {detecting && <Loader2 size={14} className="spin" />} {detecting ? "检测中…" : "检测模型"}
            </button>
            <button className="btn" onClick={() => void runTranslationTest()} disabled={testing}>
              {testing && <Loader2 size={14} className="spin" />} {testing ? "测试中…" : "测试连接"}
            </button>
            <button className="btn btn-ghost" onClick={() => void runClearTranslationCache()} disabled={clearingCache}>
              {clearingCache ? "清除中…" : "清除翻译缓存"}
            </button>
          </div>
        </div>
        {(clearCacheResult || detectError || models.length > 0 || testResult) && (
          <div className="settings-results">
            {clearCacheResult && (
              <span className={clearCacheResult.ok ? "test-chip ok" : "test-chip err"} title={clearCacheResult.message}>
                {clearCacheResult.ok ? `✓ ${clearCacheResult.message}` : `✗ ${clearCacheResult.message}`}
              </span>
            )}
            {detectError && <span className="test-chip err" title={detectError}>✗ {detectError}</span>}
            {!detectError && models.length > 0 && <span className="test-chip ok">✓ 检测到 {models.length} 个模型</span>}
            {testResult && (
              <span className={testResult.ok ? "test-chip ok" : "test-chip err"} title={testResult.message}>
                {testResult.ok ? `✓ ${testResult.latencyMs}ms · ${testResult.message}` : `✗ ${testResult.message}`}
              </span>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="settings-tags"
        title="标签管理"
        description="用于给 Skill 打标。也可以把 Skill 卡片直接拖到侧边栏的标签上。"
        action={addingTag ? (
          <InlineInput placeholder="标签名称" onSubmit={addTagWithName} onCancel={() => setAddingTag(false)} />
        ) : (
          <button className="btn btn-sm" onClick={() => setAddingTag(true)}><Plus size={13} /> 添加标签</button>
        )}
      >
        {settings.customTags.length === 0 ? (
          <p className="settings-empty">还没有标签。</p>
        ) : (
          <div className="tag-manager">
            {settings.customTags.map((tag) => (
              <div key={tag.id} className="tag-manager-item">
                {editingTagId === tag.id ? (
                  <>
                    <input
                      type="color"
                      className="tag-edit-color"
                      value={editingTag.color}
                      onChange={(e) => setEditingTag({ ...editingTag, color: e.target.value })}
                      aria-label="标签颜色"
                    />
                    <input
                      className="tag-edit-input"
                      value={editingTag.name}
                      autoFocus
                      onChange={(e) => setEditingTag({ ...editingTag, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveTagEdit();
                        if (e.key === "Escape") setEditingTagId(null);
                      }}
                      aria-label="标签名称"
                    />
                    <button className="btn btn-sm btn-primary" onClick={saveTagEdit}>保存</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditingTagId(null)}>取消</button>
                  </>
                ) : (
                  <>
                    <span className="tag-dot" style={{ background: tag.color }} />
                    <span className="tag-manager-name">{tag.name}</span>
                    <button className="btn btn-sm btn-ghost" onClick={() => startEditTag(tag)}>编辑</button>
                    <button className="btn btn-sm btn-ghost btn-danger" onClick={() => deleteTag(tag.id)}>删除</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="settings-agents"
        title="Agent 目录"
        description={`查看加载方式与 Skill 目录，启用后显示在左侧（当前已启用 ${enabledCount} 个）。目录中的第一条路径用于同步。`}
        bodyClassName="custom-agent-panel"
        action={addingAgent ? (
          addingAgentStep === "name" ? (
            <InlineInput
              key="agent-name"
              placeholder="Agent 名称"
              onSubmit={(name) => { setAddingAgentName(name); setAddingAgentStep("path"); }}
              onCancel={() => { setAddingAgent(false); setAddingAgentStep("name"); setAddingAgentName(""); }}
            />
          ) : (
            <InlineInput
              key="agent-path"
              placeholder="Skill 目录路径"
              onSubmit={addCustomAgentWithPath}
              onCancel={() => { setAddingAgent(false); setAddingAgentStep("name"); setAddingAgentName(""); }}
            />
          )
        ) : (
          <button className="btn btn-sm" onClick={() => setAddingAgent(true)}><Plus size={13} /> 添加 Agent</button>
        )}
      >
        <AgentInstallationPanel settings={settings} onEnable={onEnableAgents} />
        <label className="agent-directory-search">
          <Search size={15} />
          <input aria-label="搜索 Agent" placeholder="搜索 Agent、路径或加载方式" value={agentQuery} onChange={(event) => setAgentQuery(event.target.value)} />
        </label>
        {harnessGroups.map((group) => {
          const entries = directoryEntries.filter((entry) => entry.tier === group.tier);
          if (entries.length === 0) return null;
          return <div className="agent-directory-group" key={group.tier}>
            <div className="agent-directory-group-label">{group.label}<span>{entries.length}</span></div>
            <div className="agent-chips">
          {entries.map((agent) => (
            <button
              key={agent.id}
              className={`agent-chip ${selectedAgentId === agent.id ? "active" : ""} ${!agent.enabled ? "disabled" : ""}`}
              onClick={() => setSelectedAgentId(selectedAgentId === agent.id ? null : agent.id)}
              title={harnessById.get(agent.id)?.loading ?? agent.name}
              aria-expanded={selectedAgentId === agent.id}
            >
              <AgentIcon icon={agent.icon || ""} size={18} />
              <span>{agent.name}</span>
              {harnessById.get(agent.id)?.status === "manual" && <small>手动读取</small>}
              {harnessById.get(agent.id)?.status === "import" && <small>客户端导入</small>}
            </button>
          ))}
            </div>
          </div>;
        })}
        {directoryEntries.length === 0 && <p className="agent-directory-empty">没有匹配的 Agent。</p>}
        {selectedHarness && <div className="agent-loading-guide">
          <div className="agent-loading-guide-header"><strong>{selectedHarness.name}</strong><button type="button" className="link-button" onClick={() => void api.openUrl(selectedHarness.docs)}>官方说明 ↗</button></div>
          <p>{selectedHarness.loading}</p>
          {selectedHarness.projectPaths.length > 0 && <p>项目目录：{selectedHarness.projectPaths.map((path) => <code key={path}>{path}</code>)}。将对应项目 Skill 目录的绝对路径添加到下方列表。</p>}
          {selectedHarness.status === "native" && <p>同步后在 harness 的技能列表确认加载。云端、容器、SSH 和 WSL 使用各自环境的目录。</p>}
        </div>}
        {selectedAgent && (
          <div className="agent-detail">
            <div className="agent-detail-header">
              <span className="agent-detail-title"><AgentIcon icon={selectedAgent.icon || ""} size={18} /> <strong>{selectedAgent.name}</strong></span>
              <div className="agent-detail-controls">
                <label className="toggle-row">
                  <input type="checkbox" className="switch" checked={selectedAgent.enabled} onChange={(event) => updateAgentConfig(selectedAgent.id, { enabled: event.target.checked })} />
                  <span>启用</span>
                </label>
                {!selectedAgent.builtin && (
                  <button className="btn btn-sm btn-danger remove-btn" onClick={() => removeCustomAgent(selectedAgent.id)}>移除</button>
                )}
              </div>
            </div>
            <div className="agent-detail-paths">
              <label htmlFor={`agent-paths-${selectedAgent.id}`}>Skill 目录路径（每行一个，第一条为同步目标；支持 ~ 与内置路径变量）</label>
              <textarea
                id={`agent-paths-${selectedAgent.id}`}
                value={selectedAgent.paths.join("\n")}
                onChange={(event) => updateAgentConfig(selectedAgent.id, { paths: event.target.value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) })}
                rows={Math.max(2, Math.min(4, selectedAgent.paths.length))}
                spellCheck={false}
              />
            </div>
            <div className="agent-detail-categories">
              <div className="agent-detail-categories-header">
                <label>Skill 子分类</label>
                {addingCategoryForAgent === selectedAgent.id ? (
                  <InlineInput placeholder="分类名称" compact onSubmit={(name) => addCategoryWithName(selectedAgent.id, name)} onCancel={() => setAddingCategoryForAgent(null)} />
                ) : (
                  <button className="btn btn-sm" onClick={() => setAddingCategoryForAgent(selectedAgent.id)}><Plus size={13} /> 添加分类</button>
                )}
              </div>
              <div className="category-list">
                {(selectedAgent.categories || []).length === 0 && <p className="muted-copy">暂无子分类。</p>}
                {(selectedAgent.categories || []).map((cat) => (
                  <div key={cat.id} className="category-item">
                    {editingCategoryId === cat.id ? (
                      <>
                        <input
                          className="tag-edit-input"
                          value={editingCategoryName}
                          autoFocus
                          onChange={(e) => setEditingCategoryName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveCategoryEdit(selectedAgent.id);
                            if (e.key === "Escape") setEditingCategoryId(null);
                          }}
                          placeholder="分类名称"
                        />
                        <button className="btn btn-sm btn-primary" onClick={() => saveCategoryEdit(selectedAgent.id)}>保存</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditingCategoryId(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <span className="category-dot" />
                        <span className="category-name">{cat.name}</span>
                        <span className="category-count">{cat.skillNames.length} 个 Skill</span>
                        <button className="btn btn-sm btn-ghost" onClick={() => startEditCategory(cat)}>编辑</button>
                        <button className="btn btn-sm btn-ghost btn-danger" onClick={() => deleteCategory(selectedAgent.id, cat.id)}>删除</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection id="settings-about" title="关于" description="SkillAnvil 是一个本地优先的 Coding Agent Skill 工作台。">
        <div className="setting-row">
          <span className="setting-copy">
            <strong>版本更新</strong>
            <span>当前版本 {updateInfo?.currentVersion ?? "—"}。启动时自动检查，也可以手动触发。</span>
          </span>
          <div className="setting-action">
            {checkUpdateResult && !checkUpdateResult.hasUpdate && <span className="test-chip ok">✓ 已是最新版本</span>}
            {checkUpdateError && <span className="test-chip err" title={checkUpdateError}>✗ 检查失败</span>}
            {updateResult && (
              <>
                <span className="test-chip ok">新版本 {updateResult.latestVersion}</span>
                <button className="btn btn-primary" onClick={() => { void api.openUrl(updateResult.assetUrl || updateResult.releaseUrl); }}>
                  下载
                </button>
                {!checkUpdateResult && (
                  <button className="btn btn-ghost" onClick={onDismissUpdate}>
                    忽略
                  </button>
                )}
              </>
            )}
            <button className="btn" onClick={() => void runUpdateCheck()} disabled={checkingUpdate}>
              <RefreshCcw size={14} className={checkingUpdate ? "spin" : undefined} /> {checkingUpdate ? "检查中…" : "检查更新"}
            </button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function CustomSelect<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: SelectOption<T>[]; onChange: (value: T) => void; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div
      className={`custom-select ${open ? "open" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="custom-select-trigger" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} title={ariaLabel}>
        <span>{selected.label}</span>
        <ChevronsUpDown size={14} />
      </button>
      <div className="custom-select-menu" role="listbox" aria-label={ariaLabel}>
        {options.map((option) => (
          <button
            type="button"
            role="option"
            aria-selected={option.value === value}
            key={option.value}
            className={option.value === value ? "selected" : ""}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
          >
            <span>{option.label}</span>
            {option.value === value && <Check size={13} />}
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

  // 设置是 boot 后异步到达的：非录制状态下让显示跟随外部 value 变化。
  useEffect(() => {
    if (!recording) setDisplay(value);
  }, [value, recording]);

  function handleKeyDown(event: React.KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();

    const parts: string[] = [];
    if (event.metaKey) parts.push("Cmd");
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");

    const key = event.key;
    if (key === "Escape" && parts.length === 0) {
      ref.current?.blur();
      return;
    }
    if (["Meta", "Control", "Alt", "Shift", "Cmd"].includes(key)) {
      setDisplay(parts.join("+") || value);
      return;
    }

    const shortcut = [...parts, key.length === 1 ? key.toUpperCase() : key].join("+");
    setDisplay(shortcut);
    onChange(shortcut);
    setRecording(false);
    ref.current?.blur();
  }

  function handleFocus() {
    setRecording(true);
    setDisplay("");
  }

  function handleBlur() {
    setRecording(false);
    setDisplay(value);
  }

  // 空字符串表示「禁用全局快捷键」（后端遇空串只 unregister，不注册）。
  const shown = recording ? display : value === "" ? "已禁用" : display;

  return (
    <span className="shortcut-input-group">
      <input
        ref={ref}
        className={recording ? "shortcut-input recording" : "shortcut-input"}
        value={shown}
        readOnly
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder="按下组合键…"
        aria-label="全局快捷键（点击后按下组合键）"
        title="点击后按下新的组合键"
      />
      <button
        type="button"
        className="btn btn-ghost shortcut-disable-btn"
        onClick={() => onChange("")}
        disabled={value === ""}
        title="禁用全局快捷键"
      >
        禁用
      </button>
    </span>
  );
}

type FileTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
};

function FileTree({ files, selectedFile, dirtyFiles, onOpen }: { files: Skill["files"]; selectedFile: string; dirtyFiles: Set<string>; onOpen: (relativePath: string) => void }) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  if (tree.length === 0) return <p className="muted-copy">没有可显示的文件。</p>;
  return (
    <div className="file-list">
      {tree.map((node) => (
        <FileTreeItem key={node.path || node.name} node={node} selectedFile={selectedFile} dirtyFiles={dirtyFiles} onOpen={onOpen} level={0} />
      ))}
    </div>
  );
}

function FileTreeItem({ node, selectedFile, dirtyFiles, onOpen, level }: { node: FileTreeNode; selectedFile: string; dirtyFiles: Set<string>; onOpen: (relativePath: string) => void; level: number }) {
  const [expanded, setExpanded] = useState(true);

  if (node.isDir) {
    return (
      <div className="file-tree-group">
        <button type="button" className="file-tree-dir" style={{ paddingLeft: `${level * 12 + 4}px` }} onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="file-tree-name">{node.name}</span>
          <span className="file-tree-count">{countFiles(node)}</span>
        </button>
        {expanded && (
          <div className="file-tree-children" style={{ marginLeft: `${level * 12 + 10}px` }}>
            {node.children.map((child) => (
              <FileTreeItem key={child.path || child.name} node={child} selectedFile={selectedFile} dirtyFiles={dirtyFiles} onOpen={onOpen} level={level + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const active = node.path === selectedFile;
  return (
    <button className={active ? "file-tree-file-row active" : "file-tree-file-row"} style={{ paddingLeft: `${level * 12 + 4}px` }} onClick={() => onOpen(node.path)} aria-current={active ? "true" : undefined}>
      <FileText size={13} />
      <span className="file-tree-name">{node.name}</span>
      {dirtyFiles.has(node.path) && <span className="file-tree-dirty" title="有未保存的更改" />}
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

  // SKILL.md is the entry point, so it leads the root; folders then files after it.
  const rank = (node: FileTreeNode) => (node.path === "SKILL.md" ? 0 : node.isDir ? 1 : 2);
  const sortTree = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
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
  // Enter and the blur that follows it must not submit twice.
  const settledRef = useRef(false);

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [autoFocus]);

  function handleConfirm() {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  }

  function handleCancel() {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  }

  return (
    <span className={`inline-input-wrap${compact ? " compact" : ""}${wide ? " wide" : ""}`}>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="inline-input-field"
        onKeyDown={(e) => {
          if (e.key === "Enter") handleConfirm();
          if (e.key === "Escape") {
            e.stopPropagation();
            handleCancel();
          }
        }}
        onBlur={handleConfirm}
      />
      <button className="inline-input-btn" onMouseDown={(e) => { e.preventDefault(); handleConfirm(); }} title="确认" aria-label="确认">
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

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable; the preference simply does not persist.
  }
}

function cssEscape(value: string) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
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

function normalizeDir(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/// A skill's directory relative to the agent root it was found under
/// (e.g. `gstack/qa`), falling back to the folder name.
function skillRelativeDir(skill: Skill, agents: Agent[]): string {
  const dir = normalizeDir(skill.dirPath);
  const agent = agents.find((a) => a.id === skill.agentId);
  for (const root of agent?.skillDirPaths ?? []) {
    const prefix = normalizeDir(root) + "/";
    if (dir.startsWith(prefix) && dir.length > prefix.length) return dir.slice(prefix.length);
  }
  const parts = dir.split("/");
  return parts[parts.length - 1] || skill.name;
}

/// Derive a skill's "bundle root": the first path segment under its agent's
/// skills directory (e.g. `.../.claude/skills/gstack/.cursor/...` -> `gstack`).
/// Bundles installed together share this root; a standalone skill's root is just
/// its own folder name.
function bundleRootOf(skill: Skill, agents: Agent[]): string {
  const dir = normalizeDir(skill.dirPath);
  const agent = agents.find((a) => a.id === skill.agentId);
  for (const root of agent?.skillDirPaths ?? []) {
    const prefix = normalizeDir(root) + "/";
    if (dir.startsWith(prefix)) {
      const first = dir.slice(prefix.length).split("/")[0];
      if (first) return first;
    }
  }
  const parts = dir.split("/");
  return parts[parts.length - 1] || skill.name;
}

type DiffLine = { type: "same" | "add" | "del"; text: string };

/// 按行 LCS 计算统一 diff（a=快照/旧，b=当前/新）：del 为快照里被删掉的行，
/// add 为当前版本新增的行。任一侧超过 3000 行时返回 null，由调用方回退为
/// 双栏纯文本展示（LCS 是 O(n*m)，超大文件会卡住 UI）。
function computeLineDiff(a: string, b: string): DiffLine[] | null {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const MAX_LINES = 3000;
  if (aLines.length > MAX_LINES || bLines.length > MAX_LINES) return null;
  const n = aLines.length;
  const m = bLines.length;
  // lcs[i][j] = aLines[i..] 与 bLines[j..] 的 LCS 长度（后缀 DP，便于正序回溯）。
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        aLines[i] === bLines[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ type: "same", text: aLines[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ type: "del", text: aLines[i] });
      i++;
    } else {
      out.push({ type: "add", text: bLines[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: aLines[i] });
    i++;
  }
  while (j < m) {
    out.push({ type: "add", text: bLines[j] });
    j++;
  }
  return out;
}

function statusLabel(status: SyncTargetStatus["status"]) {
  return status === "same" ? "一致" : status === "different" ? "不同" : "新增";
}

function saveStateText(state: SaveState) {
  return state === "dirty" ? "未保存" : state === "saving" ? "保存中…" : state === "saved" ? "已保存" : state === "error" ? "保存失败" : "读取中";
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
