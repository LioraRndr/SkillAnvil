import { useEffect, useMemo, useRef, useState } from "react";
import { ink } from "ink-mde";
import type { Instance } from "ink-mde";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  Diff,
  FileText,
  FolderOpen,
  Grid2X2,
  Languages,
  List,
  RefreshCcw,
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
import { api } from "./api";
import type { Agent, ReadFileResult, ScanIssue, Settings, Skill, SkillFilter, SyncTargetStatus, Tag } from "./types";

type ViewMode = "grid" | "list";
type Pane = "skills" | "settings";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type SelectOption<T extends string> = { value: T; label: string };

const defaultSettings: Settings = {
  language: "zh-CN",
  theme: "dark",
  shortcut: "Ctrl+Shift+K",
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
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [selectedFile, setSelectedFile] = useState("SKILL.md");
  const [fileState, setFileState] = useState<ReadFileResult | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [syncTargets, setSyncTargets] = useState<SyncTargetStatus[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [scanIssues, setScanIssues] = useState<ScanIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (filter.agentId && skill.agentId !== filter.agentId) return false;
      if (filter.starred && !skill.starred) return false;
      if (filter.tagId && !skill.tags.some((tag) => tag.id === filter.tagId)) return false;
      if (!q) return true;
      return [skill.displayName, skill.name, skill.description, skill.version, skill.dirPath]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [filter, query, skills]);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedSkill) {
        setSelectedSkill(null);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedSkill, editorValue, fileState, selectedFile]);

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

  async function openSkill(skill: Skill, relativePath = "SKILL.md") {
    setSelectedSkill(skill);
    setSelectedFile(relativePath);
    setError(null);
    try {
      const result = await api.readSkillFile(skill.id, relativePath);
      setFileState(result);
      setEditorValue(result.content);
      setSaveState("saved");
      setSyncTargets(await api.getSyncTargets(skill.id));
    } catch (err) {
      setError(errorMessage(err));
      setSaveState("error");
    }
  }

  function changeEditor(value: string) {
    setEditorValue(value);
    setSaveState("dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveNow(value), 1000);
  }

  async function saveNow(nextValue = editorValue) {
    if (!selectedSkill || !fileState) return;
    setSaveState("saving");
    try {
      const result = await api.saveSkillFile(selectedSkill.id, selectedFile, nextValue, fileState.encoding);
      setFileState(result);
      setSaveState("saved");
      setSkills(await api.getSkills({}));
    } catch (err) {
      setError(errorMessage(err));
      setSaveState("error");
    }
  }

  async function toggleStar(skill: Skill) {
    try {
      const updated = await api.starSkill(skill.id, !skill.starred);
      setSkills((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      if (selectedSkill?.id === updated.id) setSelectedSkill(updated);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function cloneSelected() {
    if (!selectedSkill) return;
    const newName = window.prompt("输入克隆后的 Skill 名称", `${selectedSkill.name}-copy`);
    if (!newName) return;
    try {
      const created = await api.cloneSkill(selectedSkill.id, newName);
      setSkills(await api.getSkills({}));
      await openSkill(created);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openSelectedInFileManager() {
    if (!selectedSkill) return;
    try {
      await api.openInFileManager(selectedSkill.dirPath);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function trashSelected() {
    if (!selectedSkill) return;
    const agent = agents.find((item) => item.id === selectedSkill.agentId);
    const ok = window.confirm(`确认卸载 ${selectedSkill.displayName}？\n\n路径：${selectedSkill.dirPath}\n将移动到系统回收站。`);
    if (!ok) return;
    try {
      await api.trashSkill(selectedSkill.id, [selectedSkill.agentId]);
      setSelectedSkill(null);
      setSkills(await api.getSkills({}));
      setError(agent ? `已从 ${agent.name} 移至回收站。` : "已移至回收站。");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function syncSelected(target: SyncTargetStatus) {
    if (!selectedSkill) return;
    if (target.status === "same") return;
    const action = target.status === "missing" ? "新增" : "覆盖";
    const details = [
      `目标 Agent：${target.agentName}`,
      `状态：${statusLabel(target.status)}`,
      `源路径：${selectedSkill.dirPath}`,
      `目标路径：${target.targetPath}`,
      target.status === "different" ? "目标目录内容不同，继续后旧目录会先移至系统回收站，再复制当前 Skill。" : "目标 Agent 下不存在该 Skill，继续后会复制当前 Skill。"
    ].join("\n");
    const ok = window.confirm(`确认${action} ${selectedSkill.displayName}？\n\n${details}`);
    if (!ok) return;
    try {
      const nextSkills = await api.syncSkill(selectedSkill.id, [target.agentId]);
      setSkills(nextSkills);
      setSyncTargets(await api.getSyncTargets(selectedSkill.id));
      setError(`已同步到 ${target.agentName}。`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

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

  const themeClass = settings.theme === "light" ? "theme-light" : settings.theme === "system" ? "theme-system" : "theme-dark";

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
            <Star size={16} /> 收藏夹 <span className="nav-count">{skills.filter((skill) => skill.starred).length}</span>
          </button>
        </nav>

        <div className="section-title">Agents</div>
        <nav className="nav-section grow">
          {agents.map((agent) => (
            <button key={agent.id} className={navClass(filter.agentId === agent.id)} onClick={() => { setPane("skills"); setFilter({ agentId: agent.id }); }}>
              <FolderOpen size={16} /> {agent.name}
              <span className="nav-count">{skills.filter((skill) => skill.agentId === agent.id).length}</span>
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
        <header className="topbar">
          <div>
            <h1>{selectedSkill ? selectedSkill.displayName : pane === "settings" ? "设置" : "Skill 总览"}</h1>
            <p>{selectedSkill ? `${agentName(agents, selectedSkill.agentId)} > ${selectedFile}` : "扫描、编辑和同步本地 Coding Agent Skills"}</p>
          </div>
          {!selectedSkill && pane === "skills" && (
            <div className="topbar-stats">
              <span>{agents.length} Agents</span>
              <span>{skills.length} Skills</span>
            </div>
          )}
          {!selectedSkill && pane === "skills" && (
            <div className="segmented">
              <button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")} title="网格"><Grid2X2 size={16} /></button>
              <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} title="列表"><List size={16} /></button>
            </div>
          )}
          {selectedSkill && (
            <div className="editor-actions">
              <button onClick={() => void saveNow()}><Save size={16} /> 保存</button>
              <button onClick={cloneSelected}><Copy size={16} /> 克隆</button>
              <button onClick={trashSelected} className="danger"><Trash2 size={16} /> 卸载</button>
              <button onClick={() => setSelectedSkill(null)}><X size={16} /></button>
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

        {pane === "settings" && !selectedSkill ? (
          <SettingsPanel settings={settings} onChange={updateSettings} />
        ) : selectedSkill ? (
          <section className="editor-layout">
            <div className="editor-card">
              <MarkdownEditor value={editorValue} onChange={changeEditor} />
            </div>
            <aside className="inspector">
              <h2>文件树</h2>
              <FileTree
                files={selectedSkill.files}
                selectedFile={selectedFile}
                onOpen={(relativePath) => openSkill(selectedSkill, relativePath)}
              />
              <h2>元信息</h2>
              <dl className="meta">
                <dt>编码</dt><dd>{fileState?.encoding ?? "-"}</dd>
                <dt>版本</dt><dd>{selectedSkill.version || "-"}</dd>
                <dt>来源</dt><dd>{selectedSkill.source}</dd>
                <dt>路径</dt><dd title={selectedSkill.dirPath}>{selectedSkill.dirPath}</dd>
              </dl>
              <button className="wide-button" onClick={openSelectedInFileManager}><FolderOpen size={16} /> 在文件管理器中显示</button>
              <h2>同步到</h2>
              <div className="sync-list">
                {syncTargets.map((target) => (
                  <button key={target.agentId} disabled={target.status === "same"} title={target.targetPath} onClick={() => syncSelected(target)}>
                    <span>{target.agentName}</span>
                    <em>{statusLabel(target.status)}</em>
                  </button>
                ))}
              </div>
            </aside>
          </section>
        ) : (
          <section className={viewMode === "grid" ? "skill-grid" : "skill-list"}>
            {visibleSkills.length === 0 ? (
              <div className="empty-state">
                <Sparkles size={28} />
                <h2>没有发现 Skill</h2>
                <p>点击左下角“扫描”，或在设置中添加自定义 Agent Skill 目录。</p>
              </div>
            ) : (
              visibleSkills.map((skill) => (
                <article key={skill.id} className="skill-card" onDoubleClick={() => openSkill(skill)}>
                  <div className="card-head">
                    <button className={skill.starred ? "icon-button starred" : "icon-button"} onClick={() => toggleStar(skill)}><Star size={17} /></button>
                    <span>{agentName(agents, skill.agentId)}</span>
                  </div>
                  <h2>{skill.displayName}</h2>
                  <p>{skill.description || "未提供描述"}</p>
                  <div className="tag-row">
                    {skill.tags.map((tag) => <span key={tag.id} style={{ borderColor: tag.color }}>{tag.name}</span>)}
                  </div>
                  <footer>
                    <span>v{skill.version || "0.0.0"}</span>
                    <button onClick={() => openSkill(skill)}>编辑</button>
                  </footer>
                </article>
              ))
            )}
          </section>
        )}
      </main>

      <footer className="statusbar">
        <span>{agents.length} agents</span>
        <span>{skills.length} skills</span>
        <span>{saveStateText(saveState)}</span>
      </footer>
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
        <div className="setting-copy"><ChevronsUpDown size={18} /><strong>全局快捷键</strong><span>Tauri 桌面端注册，默认 Ctrl+Shift+K。</span></div>
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

function MarkdownEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Instance | null>(null);
  const lastValueRef = useRef(value);
  const mountRunRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    const mountRun = ++mountRunRef.current;
    async function mount() {
      if (!hostRef.current) return;
      hostRef.current.replaceChildren();
      const instance = await ink(hostRef.current, {
        doc: value,
        interface: {
          appearance: "dark",
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
  }, []);

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
