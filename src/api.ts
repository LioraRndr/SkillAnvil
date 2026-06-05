import { invoke } from "@tauri-apps/api/core";
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
  Theme
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
  saveSkillFile: (skillId: string, relativePath: string, content: string, expectedEncoding: string) =>
    call<ReadFileResult>("save_skill_file", { skillId, relativePath, content, expectedEncoding }),
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
  }
};
