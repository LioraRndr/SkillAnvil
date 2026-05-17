export type Language = "zh-CN" | "en-US";
export type Theme = "dark" | "light" | "system";
export type SkillSource = "local" | "github";

export interface Agent {
  id: string;
  name: string;
  skillDirPaths: string[];
  icon: string;
  detectedAt: string;
}

export interface Skill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  dirPath: string;
  agentId: string;
  source: SkillSource;
  githubRepo?: string | null;
  githubBranch?: string | null;
  lastSyncCommit?: string | null;
  localModified: boolean;
  starred: boolean;
  tags: Tag[];
  files: SkillFile[];
  updatedAt: string;
}

export interface SkillFile {
  relativePath: string;
  isDir: boolean;
  size: number;
  updatedAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Snapshot {
  id: string;
  skillId: string;
  filePath: string;
  content: string;
  createdAt: string;
}

export interface Settings {
  language: Language;
  theme: Theme;
  shortcut: string;
  minimizeToTray: boolean;
  customAgents: AgentPathConfig[];
  snapshotsEnabled: boolean;
}

export interface AgentPathConfig {
  id: string;
  name: string;
  paths: string[];
  enabled: boolean;
  builtin: boolean;
  icon?: string | null;
}

export interface SkillFilter {
  agentId?: string | null;
  query?: string | null;
  starred?: boolean | null;
  tagId?: string | null;
}

export interface ReadFileResult {
  content: string;
  encoding: string;
  updatedAt: string;
}

export interface SyncTargetStatus {
  agentId: string;
  agentName: string;
  targetPath: string;
  status: "same" | "different" | "missing";
}

export interface GithubUpdate {
  skillId: string;
  hasUpdate: boolean;
  latestCommit?: string | null;
  summary: string[];
  error?: string | null;
}

export interface ScanIssue {
  path: string;
  message: string;
}
