import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  Agent,
  ReadFileResult,
  ScanIssue,
  Settings,
  Skill,
  SkillFilter,
  SkillProvenance,
  Snapshot,
  SyncTargetStatus,
  Tag,
  Theme,
  TranslationConfig,
  UpdateInfo
} from "./types";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime) {
    throw new Error("SkillAnvil must run inside the Tauri desktop shell.");
  }
  return invoke<T>(command, args);
}

export const api = {
  scanAgents: () => call<{ agents: Agent[]; skills: Skill[]; scanErrors: ScanIssue[] }>("scan_agents"),
  getAgents: () => call<Agent[]>("get_agents"),
  getSkills: (filter: SkillFilter = {}) => call<Skill[]>("get_skills", { filter }),
  readSkillFile: (skillId: string, relativePath: string) =>
    call<ReadFileResult>("read_skill_file", { skillId, relativePath }),
  // expectedUpdatedAt：读取该文件时返回的 ReadFileResult.updatedAt；后端写入前校验，
  // 若磁盘上的文件已被外部修改则拒绝写入（错误文案以「文件已被外部修改」开头）。
  saveSkillFile: (skillId: string, relativePath: string, content: string, expectedEncoding: string, expectedUpdatedAt: string) =>
    call<ReadFileResult>("save_skill_file", { skillId, relativePath, content, expectedEncoding, expectedUpdatedAt }),
  cloneSkill: (skillId: string, newName: string) => call<Skill>("clone_skill", { skillId, newName }),
  getSyncTargets: (skillId: string) => call<SyncTargetStatus[]>("get_sync_targets", { skillId }),
  syncSkill: (skillId: string, targetAgentIds: string[]) =>
    call<Skill[]>("sync_skill", { skillId, targetAgentIds }),
  trashSkill: (skillId: string, agentIds: string[]) => call<void>("trash_skill", { skillId, agentIds }),
  openInFileManager: (path: string) => call<void>("open_in_file_manager", { path }),
  openUrl: (url: string) => call<void>("open_url", { url }),
  starSkill: (skillId: string, starred: boolean) => call<Skill>("star_skill", { skillId, starred }),
  setSkillTags: (skillId: string, tags: Tag[]) => call<Skill>("set_skill_tags", { skillId, tags }),
  getProvenance: () => call<SkillProvenance[]>("get_provenance"),
  traceProvenance: (skillIds: string[]) => call<SkillProvenance[]>("trace_skill_provenance", { skillIds }),
  getSnapshots: (skillId: string) => call<Snapshot[]>("get_snapshots", { skillId }),
  restoreSnapshot: (snapshotId: string) => call<ReadFileResult>("restore_snapshot", { snapshotId }),
  getSettings: () => call<Settings>("get_settings"),
  updateSettings: (settings: Settings) => call<Settings>("update_settings", { settings }),
  // Sync the native window appearance to the in-app theme. On macOS the sidebar
  // vibrancy material (windowEffects "sidebar") renders light/dark according to
  // the window's NSAppearance, which otherwise follows the system, not our theme —
  // leaving a dark, washed-out sidebar when the app is light on a dark Mac.
  setWindowTheme: async (theme: Theme) => {
    if (!isTauriRuntime) return;
    await getCurrentWindow().setTheme(theme === "system" ? null : theme);
  },
  translateMarkdown: (content: string) =>
    call<{ text: string; cached: boolean }>("translate_markdown", { content }),
  translateStream: (content: string, onChunk: (delta: string) => void) => {
    const channel = new Channel<string>();
    channel.onmessage = onChunk;
    return call<{ text: string; cached: boolean }>("translate_stream", { content, onChunk: channel });
  },
  testTranslationConfig: (config: TranslationConfig) =>
    call<{ ok: boolean; latencyMs: number; message: string }>("test_translation_config", { config }),
  listTranslationModels: (config: TranslationConfig) =>
    call<string[]>("list_translation_models", { config }),
  /** 清空 translations 表的全部缓存，返回删除行数。 */
  clearTranslationCache: () => call<number>("clear_translation_cache"),
  // ignoreDismissed 为 true 时跳过「忽略此版本」记录（用于手动检查更新）。
  checkForUpdates: (ignoreDismissed = false) => call<UpdateInfo>("check_for_updates", { ignoreDismissed }),
  dismissUpdate: (version: string) => call<void>("dismiss_update", { version })
};
