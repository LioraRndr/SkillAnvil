import { invoke } from "@tauri-apps/api/core";
import type {
  Agent,
  GithubUpdate,
  ReadFileResult,
  ScanIssue,
  Settings,
  Skill,
  SkillFilter,
  Snapshot,
  SyncTargetStatus,
  Tag
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
  starSkill: (skillId: string, starred: boolean) => call<Skill>("star_skill", { skillId, starred }),
  setSkillTags: (skillId: string, tags: Tag[]) => call<Skill>("set_skill_tags", { skillId, tags }),
  checkGithubUpdates: (skillIds: string[]) => call<GithubUpdate[]>("check_github_updates", { skillIds }),
  getSnapshots: (skillId: string) => call<Snapshot[]>("get_snapshots", { skillId }),
  restoreSnapshot: (snapshotId: string) => call<ReadFileResult>("restore_snapshot", { snapshotId }),
  getSettings: () => call<Settings>("get_settings"),
  updateSettings: (settings: Settings) => call<Settings>("update_settings", { settings })
};
