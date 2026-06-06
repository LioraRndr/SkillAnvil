export type Theme = "dark" | "light" | "system";
export type SkillSource = "local" | "github";
export type TranslationProtocol = "openai" | "anthropic";

export interface TranslationConfig {
  protocol: TranslationProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  targetLang: string;
}

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
  theme: Theme;
  shortcut: string;
  minimizeToTray: boolean;
  customTags: Tag[];
  customAgents: AgentPathConfig[];
  snapshotsEnabled: boolean;
  provenanceAgentId?: string | null;
  translation: TranslationConfig;
}

export interface SkillCategory {
  id: string;
  name: string;
  skillNames: string[];
}

export interface AgentPathConfig {
  id: string;
  name: string;
  paths: string[];
  enabled: boolean;
  builtin: boolean;
  icon?: string | null;
  categories: SkillCategory[];
}

export interface SkillFilter {
  agentId?: string | null;
  query?: string | null;
  starred?: boolean | null;
  tagId?: string | null;
  categoryId?: string | null;
  categoryAgentId?: string | null;
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

export interface ScanIssue {
  path: string;
  message: string;
}

export type ProvenanceStatus = "verified" | "likely" | "ambiguous" | "local" | "unknown";
export type ProvenanceContentMatch = "identical" | "differs" | "unknown";

export interface ProvenanceCandidate {
  repo: string;
  skillId: string;
  installs: number;
  similarity?: number | null;
}

export interface SkillProvenance {
  skillId: string;
  status: ProvenanceStatus;
  repo?: string | null;
  installs?: number | null;
  contentMatch?: ProvenanceContentMatch | null;
  candidates: ProvenanceCandidate[];
  manual: boolean;
  tracedAt?: string | null;
  error?: string | null;
}
