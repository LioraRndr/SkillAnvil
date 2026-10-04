#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_installation;

use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use encoding_rs::{GBK, UTF_8};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Write,
    net::IpAddr,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Mutex,
    sync::OnceLock,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;

const MAX_JSON_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_UPSTREAM_SKILL_BYTES: usize = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES: usize = 64 * 1024;
const MASKED_API_KEY: &str = "••••••••";
/// 翻译输出被模型 max_tokens 截断时的统一错误文案。调用方只在 Ok 时写缓存，
/// 因此返回该错误天然保证截断结果不会进入 translations 缓存。
const TRANSLATION_TRUNCATED_MSG: &str =
    "翻译输出因模型长度上限被截断，已放弃（不会写入缓存）。请换支持更长输出的模型或缩短文档。";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    id: String,
    name: String,
    skill_dir_paths: Vec<String>,
    icon: String,
    detected_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Skill {
    id: String,
    name: String,
    display_name: String,
    description: String,
    version: String,
    dir_path: String,
    agent_id: String,
    source: String,
    github_repo: Option<String>,
    github_branch: Option<String>,
    last_sync_commit: Option<String>,
    local_modified: bool,
    starred: bool,
    tags: Vec<Tag>,
    files: Vec<SkillFile>,
    updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillFile {
    relative_path: String,
    is_dir: bool,
    size: u64,
    updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Tag {
    id: String,
    name: String,
    color: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    id: String,
    skill_id: String,
    file_path: String,
    content: String,
    created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default = "default_theme")]
    theme: String,
    #[serde(default = "default_shortcut")]
    shortcut: String,
    #[serde(default = "default_true", alias = "minimize_to_tray")]
    minimize_to_tray: bool,
    #[serde(default = "default_agent_configs", alias = "custom_agents")]
    custom_agents: Vec<AgentPathConfig>,
    #[serde(default = "default_true", alias = "snapshots_enabled")]
    snapshots_enabled: bool,
    #[serde(default = "default_custom_tags", alias = "custom_tags")]
    custom_tags: Vec<Tag>,
    /// Agent id to scope automatic provenance tracing to; None/empty = all agents.
    #[serde(default, alias = "provenance_agent_id")]
    provenance_agent_id: Option<String>,
    /// BYO translation endpoint (OpenAI-compatible or Anthropic-native).
    #[serde(default)]
    translation: TranslationConfig,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationConfig {
    #[serde(default)]
    protocol: String,
    #[serde(default, alias = "base_url")]
    base_url: String,
    #[serde(default, alias = "api_key")]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default, alias = "target_lang")]
    target_lang: String,
}

impl Default for TranslationConfig {
    fn default() -> Self {
        Self {
            protocol: "openai".into(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            target_lang: "zh-CN".into(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillCategory {
    id: String,
    name: String,
    skill_names: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPathConfig {
    id: String,
    name: String,
    paths: Vec<String>,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    builtin: bool,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    categories: Vec<SkillCategory>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessCatalogEntry {
    id: String,
    name: String,
    paths: Vec<String>,
    #[serde(default)]
    paths_windows: Option<Vec<String>>,
    icon: String,
    status: String,
    docs: String,
    enabled: bool,
    flat_sync: bool,
    #[serde(default)]
    legacy_paths: Option<Vec<String>>,
}

fn harness_catalog() -> &'static [HarnessCatalogEntry] {
    static CATALOG: OnceLock<Vec<HarnessCatalogEntry>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/agent-catalog.json"))
            .expect("bundled harness catalog must be valid")
    })
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SkillFilter {
    agent_id: Option<String>,
    query: Option<String>,
    starred: Option<bool>,
    tag_id: Option<String>,
    category_id: Option<String>,
    category_agent_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadFileResult {
    content: String,
    encoding: String,
    updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncTargetStatus {
    agent_id: String,
    agent_name: String,
    target_path: String,
    status: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceCandidate {
    repo: String,
    skill_id: String,
    installs: i64,
    similarity: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillProvenance {
    skill_id: String,
    /// verified | likely | ambiguous | local | unknown
    status: String,
    repo: Option<String>,
    installs: Option<i64>,
    /// identical | differs | unknown
    content_match: Option<String>,
    candidates: Vec<ProvenanceCandidate>,
    manual: bool,
    traced_at: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanIssue {
    path: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    agents: Vec<Agent>,
    skills: Vec<Skill>,
    scan_errors: Vec<ScanIssue>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    has_update: bool,
    /// Direct download URL for the platform-appropriate asset (if found)
    asset_url: String,
    release_url: String,
    release_notes: String,
    published_at: String,
}

struct AppState {
    db_path: PathBuf,
    data_dir: PathBuf,
    lock: Mutex<()>,
    /// Whether the system tray was successfully created. When false the
    /// close-to-tray behavior must be disabled, otherwise hiding the window
    /// leaves an unreachable ghost process.
    tray_available: std::sync::atomic::AtomicBool,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // State + DB are core: if these fail the app genuinely cannot run.
            // Because the release profile uses `panic = "abort"`, a bare `?`
            // here would kill the process before any window paints — the app
            // would just "open then instantly close" with no trace. Persist a
            // crash log to the temp dir first so the failure is diagnosable.
            let state = match init_state().and_then(|state| {
                init_db(&state.db_path)?;
                Ok(state)
            }) {
                Ok(state) => state,
                Err(err) => {
                    log_startup_failure(&err);
                    return Err(Box::new(err));
                }
            };
            app.manage(state);
            // Tray and global shortcut are auxiliary. On Windows in particular,
            // RegisterHotKey fails hard when the combo is already claimed by
            // another app — that must never abort startup and leave the user
            // with an app that "opens then instantly closes". Degrade instead.
            match setup_tray(app.handle()) {
                Ok(()) => {
                    app.state::<AppState>()
                        .tray_available
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                }
                Err(err) => {
                    eprintln!("[skillanvil] tray setup failed, continuing without it: {err}");
                }
            }
            if let Err(err) = setup_shortcut(app.handle()) {
                eprintln!("[skillanvil] global shortcut registration failed, continuing without it: {err}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let tray_available = state
                    .tray_available
                    .load(std::sync::atomic::Ordering::Relaxed);
                let minimize = load_settings(&state.db_path)
                    .map(|settings| settings.minimize_to_tray)
                    .unwrap_or(true);
                // 托盘创建失败时必须放行关闭：否则窗口隐藏后没有任何入口能再
                // 唤出主窗口，进程会变成无法退出的幽灵进程。
                if minimize && tray_available {
                    let _ = window.hide();
                    #[cfg(target_os = "macos")]
                    let _ = window.app_handle().set_dock_visibility(false);
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_agents,
            get_agents,
            get_skills,
            get_skill,
            read_skill_file,
            save_skill_file,
            clone_skill,
            get_sync_targets,
            sync_skill,
            trash_skill,
            open_in_file_manager,
            open_url,
            star_skill,
            set_skill_tags,
            get_provenance,
            trace_skill_provenance,
            get_snapshots,
            restore_snapshot,
            get_settings,
            update_settings,
            detect_installed_agents,
            enable_installed_agents,
            translate_markdown,
            translate_stream,
            test_translation_config,
            list_translation_models,
            clear_translation_cache,
            check_for_updates,
            dismiss_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SkillAnvil");
}

/// Best-effort crash log for fatal startup errors. The release build aborts on
/// panic, so without this a failed `setup` leaves no trace on the user's
/// machine. Written to the temp dir, which is resolvable even when the app's
/// own data dir could not be created.
fn log_startup_failure(err: &AppError) {
    let path = std::env::temp_dir().join("skillanvil-startup-error.log");
    if let Ok(mut file) = fs::File::create(&path) {
        let _ = writeln!(
            file,
            "SkillAnvil {} failed to start: {err}",
            env!("CARGO_PKG_VERSION")
        );
    }
    eprintln!("[skillanvil] fatal startup error: {err}");
}

fn init_state() -> AppResult<AppState> {
    let dirs = ProjectDirs::from("dev", "SkillAnvil", "SkillAnvil")
        .ok_or_else(|| AppError::Message("Cannot resolve application data directory".into()))?;
    let data_dir = dirs.data_local_dir().to_path_buf();
    fs::create_dir_all(&data_dir)?;
    Ok(AppState {
        db_path: data_dir.join("skillanvil.sqlite3"),
        data_dir,
        lock: Mutex::new(()),
        tray_available: std::sync::atomic::AtomicBool::new(false),
    })
}

fn setup_tray(app: &AppHandle) -> AppResult<()> {
    let open = MenuItem::with_id(app, "open", "打开主窗口", true, None::<&str>)
        .map_err(|err| AppError::Message(err.to_string()))?;
    let scan = MenuItem::with_id(app, "scan", "手动扫描", true, None::<&str>)
        .map_err(|err| AppError::Message(err.to_string()))?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|err| AppError::Message(err.to_string()))?;
    let menu = Menu::with_items(app, &[&open, &scan, &quit])
        .map_err(|err| AppError::Message(err.to_string()))?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("SkillAnvil")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "scan" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Some(state) = app.try_state::<AppState>() {
                        if perform_scan(&state).is_ok() {
                            // 通知前端从 DB 重载（前端只重载、不再触发二次扫描）。
                            let _ = app.emit("scan-completed", ());
                        }
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)
        .map_err(|err| AppError::Message(err.to_string()))?;
    Ok(())
}

fn setup_shortcut(app: &AppHandle) -> AppResult<()> {
    let settings = if let Some(state) = app.try_state::<AppState>() {
        load_settings(&state.db_path).unwrap_or_else(|_| default_settings())
    } else {
        default_settings()
    };
    register_shortcut(app, &settings.shortcut)
}

fn register_shortcut(app: &AppHandle, shortcut: &str) -> AppResult<()> {
    // 空字符串表示「禁用全局快捷键」：只清理已有注册，不再注册新组合。
    if shortcut.trim().is_empty() {
        let _ = app.global_shortcut().unregister_all();
        return Ok(());
    }
    let _ = app.global_shortcut().unregister_all();
    let app_handle = app.clone();
    let register_result =
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    show_main_window(&app_handle);
                }
            });
    if let Err(err) = register_result {
        return Err(AppError::Message(format!(
            "全局快捷键 {shortcut} 注册失败：{err}"
        )));
    }
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn scan_agents(app: AppHandle) -> AppResult<ScanResult> {
    tauri::async_runtime::spawn_blocking(move || perform_scan(&app.state::<AppState>()))
        .await
        .map_err(|err| AppError::Message(format!("无法完成扫描：{err}")))?
}

// Commands that touch the disk or SQLite are marked `async` so Tauri runs them
// on its thread pool. Plain sync commands execute on the main thread, where any
// directory walk or busy-database wait freezes the whole window.
#[tauri::command(async)]
fn get_agents(state: State<AppState>) -> AppResult<Vec<Agent>> {
    let conn = open_db(&state.db_path)?;
    load_agents(&conn)
}

#[tauri::command(async)]
fn get_skills(state: State<AppState>, filter: SkillFilter) -> AppResult<Vec<Skill>> {
    let conn = open_db(&state.db_path)?;
    load_skills(&conn, &filter)
}

/// Reload one skill after an edit without re-listing every installed skill.
#[tauri::command(async)]
fn get_skill(state: State<AppState>, skill_id: String) -> AppResult<Skill> {
    let conn = open_db(&state.db_path)?;
    find_skill(&conn, &skill_id)
}

#[tauri::command(async)]
fn read_skill_file(
    state: State<AppState>,
    skill_id: String,
    relative_path: String,
) -> AppResult<ReadFileResult> {
    let conn = open_db(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    let path = secure_join(&skill.dir_path, &relative_path)?;
    read_text_file(&path)
}

#[tauri::command(async)]
fn save_skill_file(
    state: State<AppState>,
    skill_id: String,
    relative_path: String,
    content: String,
    expected_encoding: String,
    expected_updated_at: String,
) -> AppResult<ReadFileResult> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("Lock poisoned".into()))?;
    if contains_mojibake(&content) {
        return Err(AppError::Message("检测到疑似乱码内容，已拒绝写入。".into()));
    }
    let conn = open_db(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    let path = secure_join(&skill.dir_path, &relative_path)?;
    let current = read_text_file(&path)?;
    // 乐观并发检查：编辑器打开后文件若被外部程序（或其他 Agent）改写，
    // 直接覆盖会丢失外部改动。错误文案必须以「文件已被外部修改」开头，
    // 前端依赖该前缀识别此类错误。
    if current.updated_at != expected_updated_at {
        return Err(AppError::Message(
            "文件已被外部修改（可能被其他程序或 Agent 更新）。请复制你的改动后重新打开文件。"
                .into(),
        ));
    }
    if current.encoding != expected_encoding {
        return Err(AppError::Message(format!(
            "文件编码已变化：当前为 {}，编辑器期望为 {}。请重新加载后再保存。",
            current.encoding, expected_encoding
        )));
    }
    create_snapshot_if_needed(
        &conn,
        &state.data_dir,
        &skill_id,
        &relative_path,
        &current.content,
    )?;
    write_text_file(&path, &content, &current.encoding)?;
    let result = read_text_file(&path)?;
    refresh_skill_row(&conn, &skill_id)?;
    Ok(result)
}

#[tauri::command(async)]
fn clone_skill(state: State<AppState>, skill_id: String, new_name: String) -> AppResult<Skill> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("Lock poisoned".into()))?;
    let conn = open_db(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    validate_name(&new_name)?;
    let source = PathBuf::from(&skill.dir_path);
    let target = source
        .parent()
        .ok_or_else(|| AppError::Message("Cannot resolve parent directory".into()))?
        .join(&new_name);
    if target.exists() {
        return Err(AppError::Message("目标 Skill 已存在。".into()));
    }
    copy_dir_all(&source, &target)?;
    let skill_md = target.join("SKILL.md");
    if skill_md.exists() {
        let file = read_text_file(&skill_md)?;
        let updated = rewrite_skill_identity(&file.content, &new_name);
        write_text_file(&skill_md, &updated, &file.encoding)?;
    }
    let agent = find_agent(&conn, &skill.agent_id)?;
    let created = scan_one_skill(&agent, &target)?;
    upsert_skill(&conn, &created)?;
    Ok(created)
}

/// Compute the path of a skill directory relative to its agent's skill roots.
/// Both sides are normalized to forward slashes (trailing slash stripped) so
/// Windows backslash paths compare correctly. Returns `None` when no root is a
/// prefix of `skill_dir` — callers fall back to the flat `skill.name` layout.
fn skill_rel_path(agent: &Agent, skill_dir: &str) -> Option<String> {
    let normalize = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let dir = normalize(skill_dir);
    for root in &agent.skill_dir_paths {
        let root = normalize(root);
        if root.is_empty() || dir.len() <= root.len() {
            continue;
        }
        // 前缀必须落在路径分隔符边界上，避免 `skills` 误匹配 `skillsX`。
        if dir.starts_with(&root) && dir.as_bytes()[root.len()] == b'/' {
            let rest = dir[root.len() + 1..].trim_matches('/');
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    None
}

fn sync_destination(skill: &Skill, source: &Agent, target: &Agent) -> AppResult<PathBuf> {
    let root = target
        .skill_dir_paths
        .first()
        .filter(|root| !root.trim().is_empty())
        .ok_or_else(|| AppError::Message("目标 Agent 没有可写路径。".into()))?;
    let flat = harness_catalog()
        .iter()
        .find(|entry| entry.id == target.id)
        .is_some_and(|entry| entry.flat_sync);
    let relative = if flat {
        skill.name.clone()
    } else {
        skill_rel_path(source, &skill.dir_path).unwrap_or_else(|| skill.name.clone())
    };
    let mut path = PathBuf::from(root);
    for segment in relative.split('/') {
        validate_name(segment)?;
        path.push(segment);
    }
    Ok(path)
}

fn same_skill_directory(source: &Path, target: &Path) -> bool {
    match (source.canonicalize(), target.canonicalize()) {
        (Ok(source), Ok(target)) => source == target,
        _ => false,
    }
}

fn validate_harness_skill(skill: &Skill, target: &Agent) -> AppResult<()> {
    if !harness_catalog()
        .iter()
        .any(|entry| entry.id == target.id && entry.flat_sync)
    {
        return Ok(());
    }
    let content = read_text_file(&Path::new(&skill.dir_path).join("SKILL.md"))?;
    let (meta, _) = parse_frontmatter(&content.content);
    let name = meta
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let description = meta
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let portable = !name.is_empty()
        && name.len() <= 64
        && name == skill.name
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        });
    if !portable || description.trim().is_empty() || description.chars().count() > 1024 {
        return Err(AppError::Message(format!(
            "{} 需要有效的 SKILL.md：name 为 1–64 位小写字母、数字或单连字符，description 为 1–1024 字。请先修正源文件。",
            target.name
        )));
    }
    Ok(())
}

#[tauri::command(async)]
fn get_sync_targets(state: State<AppState>, skill_id: String) -> AppResult<Vec<SyncTargetStatus>> {
    let conn = open_db(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    validate_name(&skill.name)?;
    let source_hash = hash_dir(Path::new(&skill.dir_path))?;
    let agents = load_agents(&conn)?;
    let source_agent = agents
        .iter()
        .find(|agent| agent.id == skill.agent_id)
        .ok_or_else(|| AppError::Message("源 Agent 不存在，请重新扫描。".into()))?;
    let mut result = Vec::new();
    for agent in &agents {
        if agent.id == skill.agent_id {
            continue;
        }
        let target = sync_destination(&skill, source_agent, agent)?;
        let status = if !target.exists() {
            "missing"
        } else if same_skill_directory(Path::new(&skill.dir_path), &target)
            || hash_dir(&target)? == source_hash
        {
            "same"
        } else {
            "different"
        };
        result.push(SyncTargetStatus {
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            target_path: target.to_string_lossy().to_string(),
            status: status.into(),
        });
    }
    Ok(result)
}

#[tauri::command(async)]
fn sync_skill(
    state: State<AppState>,
    skill_id: String,
    target_agent_ids: Vec<String>,
) -> AppResult<Vec<Skill>> {
    let guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("Lock poisoned".into()))?;
    let conn = open_db(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    validate_name(&skill.name)?;
    let source_agent = find_agent(&conn, &skill.agent_id)?;
    let source = Path::new(&skill.dir_path);
    let mut plans = Vec::new();
    let mut destinations = HashSet::new();
    // Validate every IPC target before writing to any of them.
    for agent_id in target_agent_ids {
        let agent = find_agent(&conn, &agent_id)?;
        let target = sync_destination(&skill, &source_agent, &agent)?;
        if same_skill_directory(source, &target) {
            continue;
        }
        validate_harness_skill(&skill, &agent)?;
        ensure_disjoint_paths(source, &target)?;
        if destinations.insert(resolved_path_for_comparison(&target)?) {
            plans.push((agent, target));
        }
    }
    for (agent, target) in plans {
        replace_skill_directory(source, &target)?;
        conn.execute(
            "insert into sync_logs(id, skill_id, target_agent_id, created_at) values(?1, ?2, ?3, ?4)",
            params![Uuid::new_v4().to_string(), skill_id, agent.id, now()],
        )?;
    }
    drop(guard);
    perform_scan(&state).map(|result| result.skills)
}

#[tauri::command(async)]
fn trash_skill(state: State<AppState>, skill_id: String, agent_ids: Vec<String>) -> AppResult<()> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("Lock poisoned".into()))?;
    let conn = open_db(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    if !agent_ids.contains(&skill.agent_id) {
        return Ok(());
    }
    trash::delete(&skill.dir_path).map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute("delete from skills where id = ?1", params![skill_id])?;
    // skill 行删除后，附属数据（收藏、标签、快照、溯源）一并清理，防止孤儿行
    // 在同路径重建 skill（id 相同）时“复活”旧状态。
    for table in ["skill_state", "skill_tags", "snapshots", "skill_provenance"] {
        let sql = format!("delete from {table} where skill_id = ?1");
        conn.execute(&sql, params![skill_id])?;
    }
    Ok(())
}

#[tauri::command]
fn open_in_file_manager(path: String) -> AppResult<()> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(AppError::Message(
            "路径不存在，无法在文件管理器中显示。".into(),
        ));
    }
    show_path_in_file_manager(&target)
}

fn trusted_external_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && (url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("github.com") || host.eq_ignore_ascii_case("www.github.com")
        }) || harness_catalog()
            .iter()
            .any(|entry| reqwest::Url::parse(&entry.docs).is_ok_and(|docs| docs == *url)))
}

#[tauri::command]
fn open_url(url: String) -> AppResult<()> {
    let parsed = validate_outbound_url(&url, false)?;
    if !trusted_external_url(&parsed) {
        return Err(AppError::Message(
            "仅允许打开 GitHub 或目录中列出的官方说明链接。".into(),
        ));
    }
    open_external_url(parsed.as_str())
}

#[tauri::command(async)]
fn star_skill(state: State<AppState>, skill_id: String, starred: bool) -> AppResult<Skill> {
    let conn = open_db(&state.db_path)?;
    // Validate the id before writing so a stale card cannot leave an orphan row.
    find_skill_row(&conn, &skill_id)?;
    conn.execute(
        "insert into skill_state(skill_id, starred) values(?1, ?2)
         on conflict(skill_id) do update set starred = excluded.starred",
        params![skill_id, starred],
    )?;
    find_skill(&conn, &skill_id)
}

#[tauri::command(async)]
fn set_skill_tags(state: State<AppState>, skill_id: String, tags: Vec<Tag>) -> AppResult<Skill> {
    let mut conn = open_db(&state.db_path)?;
    find_skill_row(&conn, &skill_id)?;
    replace_skill_tags(&mut conn, &skill_id, &tags)?;
    find_skill(&conn, &skill_id)
}

/// Replace a skill's tag links atomically. Commands now run concurrently on the
/// thread pool, so two quick tag edits must not interleave their delete/insert
/// steps (that used to surface as a primary-key error and a half-applied set).
/// Duplicate ids in one request are collapsed instead of failing the batch.
fn replace_skill_tags(conn: &mut Connection, skill_id: &str, tags: &[Tag]) -> AppResult<()> {
    let transaction = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    transaction.execute(
        "delete from skill_tags where skill_id = ?1",
        params![skill_id],
    )?;
    for tag in tags {
        transaction.execute(
            "insert into tags(id, name, color) values(?1, ?2, ?3)
             on conflict(id) do update set name = excluded.name, color = excluded.color",
            params![tag.id, tag.name, tag.color],
        )?;
        transaction.execute(
            "insert or ignore into skill_tags(skill_id, tag_id) values(?1, ?2)",
            params![skill_id, tag.id],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

#[tauri::command(async)]
fn get_provenance(state: State<AppState>) -> AppResult<Vec<SkillProvenance>> {
    let conn = open_db(&state.db_path)?;
    load_provenance(&conn)
}

#[tauri::command]
async fn trace_skill_provenance(
    state: State<'_, AppState>,
    skill_ids: Vec<String>,
) -> AppResult<Vec<SkillProvenance>> {
    // Resolve (id, name, local SKILL.md) up front, then release the DB connection.
    // Look the batch up by id: this runs for every batch of a background trace,
    // and loading the whole library here used to walk every skill directory.
    let targets: Vec<(String, String, String)> = {
        let conn = open_db(&state.db_path)?;
        skill_ids
            .iter()
            .filter_map(|id| find_skill_row(&conn, id).ok())
            .map(|s| {
                let local_md = read_text_file(&Path::new(&s.dir_path).join("SKILL.md"))
                    .map(|f| f.content)
                    .unwrap_or_default();
                (s.id.clone(), s.name.clone(), local_md)
            })
            .collect()
    };

    let client = build_http_client("SkillAnvil", true)?;
    let mut results = Vec::with_capacity(targets.len());
    let last = targets.len().saturating_sub(1);
    for (index, (id, name, local_md)) in targets.into_iter().enumerate() {
        let prov = trace_one_provenance(&client, &id, &name, &local_md).await;
        // Best-effort persist: a transient DB lock must not abort the whole batch.
        if let Ok(conn) = open_db(&state.db_path) {
            let _ = upsert_provenance(&conn, &prov);
        }
        results.push(prov);
        // Be polite to skills.sh between lookups to avoid 429s.
        if index < last {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
    }
    Ok(results)
}

/// Trace a single skill against the skills.sh registry and (best-effort) the
/// upstream GitHub content. Network failures degrade gracefully rather than
/// aborting the whole batch.
async fn trace_one_provenance(
    client: &reqwest::Client,
    id: &str,
    name: &str,
    local_md: &str,
) -> SkillProvenance {
    let traced_at = Some(now());
    let candidates = match search_registry(client, name).await {
        Ok(list) => list,
        Err(err) => {
            return SkillProvenance {
                skill_id: id.to_string(),
                status: "unknown".into(),
                repo: None,
                installs: None,
                content_match: None,
                candidates: vec![],
                manual: false,
                traced_at,
                error: Some(err.to_string()),
            };
        }
    };

    // Keep only exact-name matches, most-installed first.
    let mut exact: Vec<ProvenanceCandidate> = candidates
        .into_iter()
        .filter(|c| c.skill_id == name)
        .collect();
    exact.sort_by(|a, b| b.installs.cmp(&a.installs));
    exact.truncate(3);

    if exact.is_empty() {
        return SkillProvenance {
            skill_id: id.to_string(),
            status: "local".into(),
            repo: None,
            installs: None,
            content_match: None,
            candidates: vec![],
            manual: false,
            traced_at,
            error: None,
        };
    }

    // Content-compare the top few candidates (most-installed first) and keep the
    // best match — a skill may originate from a repo that isn't the most popular.
    let mut best_idx: Option<usize> = None;
    let mut best_sim = 0.0_f64;
    if !local_md.is_empty() {
        let compare_n = exact.len().min(3);
        for i in 0..compare_n {
            if let Some(remote) = fetch_upstream_skill_md(client, &exact[i].repo, name).await {
                let sim = line_similarity(local_md, &remote);
                exact[i].similarity = Some(sim);
                if sim > best_sim {
                    best_sim = sim;
                    best_idx = Some(i);
                }
                if sim >= 0.999 {
                    break; // identical — no need to inspect the rest
                }
            }
        }
    }

    let verified = best_idx.is_some() && best_sim >= 0.6;
    let top_repo = exact[0].repo.clone();
    let top_installs = exact[0].installs;
    // A single candidate, or one that dwarfs the runner-up, is a confident
    // (if content-unconfirmed) source; close competitors stay ambiguous.
    let dominant = exact
        .get(1)
        .map(|second| top_installs >= second.installs.saturating_mul(4))
        .unwrap_or(true);

    let (status, repo, installs, content_match) = if verified {
        let best = &exact[best_idx.unwrap()];
        let label = if best_sim >= 0.999 {
            "identical"
        } else {
            "differs"
        };
        (
            "verified".to_string(),
            best.repo.clone(),
            best.installs,
            Some(label.to_string()),
        )
    } else if dominant {
        ("likely".to_string(), top_repo, top_installs, None)
    } else {
        ("ambiguous".to_string(), top_repo, top_installs, None)
    };

    SkillProvenance {
        skill_id: id.to_string(),
        status,
        repo: Some(repo),
        installs: Some(installs),
        content_match,
        candidates: exact,
        manual: false,
        traced_at,
        error: None,
    }
}

async fn search_registry(
    client: &reqwest::Client,
    name: &str,
) -> AppResult<Vec<ProvenanceCandidate>> {
    // skills.sh throttles bursts (HTTP 429 with a `Retry-After` seconds header).
    // Honor it: wait the advertised cooldown and retry a few times.
    let mut attempt = 0;
    let res = loop {
        let res = client
            .get("https://www.skills.sh/api/search")
            .query(&[("q", name)])
            .header("User-Agent", "SkillAnvil")
            .send()
            .await?;
        if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < 4 {
            attempt += 1;
            let wait = res
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(5)
                .clamp(1, 65);
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            continue;
        }
        break res;
    };
    if !res.status().is_success() {
        return Err(AppError::Message(format!(
            "skills.sh 返回 {}",
            res.status()
        )));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&read_response_limited(res, MAX_JSON_RESPONSE_BYTES).await?)?;
    let mut out = Vec::new();
    if let Some(arr) = value["skills"].as_array() {
        for item in arr {
            let repo = item["source"].as_str().unwrap_or("").to_string();
            let skill_id = item["skillId"].as_str().unwrap_or("").to_string();
            let installs = item["installs"].as_i64().unwrap_or(0);
            if repo.is_empty() || skill_id.is_empty() {
                continue;
            }
            out.push(ProvenanceCandidate {
                repo,
                skill_id,
                installs,
                similarity: None,
            });
        }
    }
    Ok(out)
}

/// Best-effort fetch of an upstream SKILL.md from raw.githubusercontent.com.
/// `repo` is `owner/repo`; registry hosts without a slash (e.g. `smithery.ai`)
/// are not on GitHub and are skipped.
async fn fetch_upstream_skill_md(
    client: &reqwest::Client,
    repo: &str,
    name: &str,
) -> Option<String> {
    if repo.split('/').count() != 2 {
        return None;
    }
    let rel_paths = [
        format!("skills/{name}/SKILL.md"),
        format!("{name}/SKILL.md"),
        "SKILL.md".to_string(),
        format!(".claude/skills/{name}/SKILL.md"),
    ];
    for rel in &rel_paths {
        let url = format!("https://raw.githubusercontent.com/{repo}/HEAD/{rel}");
        if let Ok(res) = client
            .get(&url)
            .header("User-Agent", "SkillAnvil")
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(bytes) = read_response_limited(res, MAX_UPSTREAM_SKILL_BYTES).await {
                    if let Ok(text) = String::from_utf8(bytes) {
                        return Some(text);
                    }
                }
            }
        }
    }
    None
}

/// Line-level similarity in [0, 1]: shared non-empty lines over the longer side.
fn line_similarity(a: &str, b: &str) -> f64 {
    let norm = |s: &str| -> Vec<String> {
        s.replace("\r\n", "\n")
            .lines()
            .map(|l| l.trim_end().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    };
    let la = norm(a);
    let lb = norm(b);
    if la.is_empty() || lb.is_empty() {
        return 0.0;
    }
    let mut counts: BTreeMap<&str, i32> = BTreeMap::new();
    for l in &lb {
        *counts.entry(l.as_str()).or_insert(0) += 1;
    }
    let mut common = 0usize;
    for l in &la {
        if let Some(c) = counts.get_mut(l.as_str()) {
            if *c > 0 {
                *c -= 1;
                common += 1;
            }
        }
    }
    common as f64 / la.len().max(lb.len()) as f64
}

fn load_provenance(conn: &Connection) -> AppResult<Vec<SkillProvenance>> {
    let mut stmt = conn.prepare(
        "select skill_id, status, repo, installs, content_match, candidates, manual, traced_at, error
         from skill_provenance",
    )?;
    let rows = stmt.query_map([], |row| {
        let candidates_json: String = row.get(5)?;
        Ok(SkillProvenance {
            skill_id: row.get(0)?,
            status: row.get(1)?,
            repo: row.get(2)?,
            installs: row.get(3)?,
            content_match: row.get(4)?,
            candidates: serde_json::from_str(&candidates_json).unwrap_or_default(),
            manual: row.get::<_, i64>(6)? == 1,
            traced_at: row.get(7)?,
            error: row.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn upsert_provenance(conn: &Connection, p: &SkillProvenance) -> AppResult<()> {
    conn.execute(
        "insert into skill_provenance(skill_id, status, repo, installs, content_match, candidates, manual, traced_at, error)
         values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         on conflict(skill_id) do update set
            status = excluded.status,
            repo = excluded.repo,
            installs = excluded.installs,
            content_match = excluded.content_match,
            candidates = excluded.candidates,
            manual = excluded.manual,
            traced_at = excluded.traced_at,
            error = excluded.error",
        params![
            p.skill_id,
            p.status,
            p.repo,
            p.installs,
            p.content_match,
            serde_json::to_string(&p.candidates)?,
            p.manual as i64,
            p.traced_at,
            p.error
        ],
    )?;
    Ok(())
}

#[tauri::command(async)]
fn get_snapshots(state: State<AppState>, skill_id: String) -> AppResult<Vec<Snapshot>> {
    let conn = open_db(&state.db_path)?;
    let mut stmt = conn.prepare(
        "select id, skill_id, file_path, content, created_at from snapshots
         where skill_id = ?1 order by created_at desc",
    )?;
    let rows = stmt.query_map(params![skill_id], |row| {
        Ok(Snapshot {
            id: row.get(0)?,
            skill_id: row.get(1)?,
            file_path: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
fn restore_snapshot(state: State<AppState>, snapshot_id: String) -> AppResult<ReadFileResult> {
    // Same lock as save_skill_file: a restore must never interleave with an
    // autosave writing the same file from the thread pool.
    let _guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("Lock poisoned".into()))?;
    let conn = open_db(&state.db_path)?;
    let snapshot: Snapshot = conn
        .query_row(
            "select id, skill_id, file_path, content, created_at from snapshots where id = ?1",
            params![snapshot_id],
            |row| {
                Ok(Snapshot {
                    id: row.get(0)?,
                    skill_id: row.get(1)?,
                    file_path: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Message("快照不存在。".into()))?;
    let skill = find_skill(&conn, &snapshot.skill_id)?;
    let path = secure_join(&skill.dir_path, &snapshot.file_path)?;
    let current = read_text_file(&path)?;
    write_text_file(&path, &snapshot.content, &current.encoding)?;
    read_text_file(&path)
}

#[tauri::command(async)]
fn get_settings(state: State<AppState>) -> AppResult<Settings> {
    load_settings(&state.db_path).map(redact_settings)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnableInstalledAgentsResult {
    settings: Settings,
    enabled_agent_ids: Vec<String>,
}

#[tauri::command]
async fn detect_installed_agents(
    state: State<'_, AppState>,
) -> AppResult<Vec<agent_installation::AgentInstallation>> {
    let settings = load_settings(&state.db_path)?;
    tauri::async_runtime::spawn_blocking(move || agent_installation::detect(&settings))
        .await
        .map_err(|err| AppError::Message(format!("无法完成安装检测：{err}")))
}

#[tauri::command]
async fn enable_installed_agents(
    state: State<'_, AppState>,
    agent_ids: Vec<String>,
) -> AppResult<EnableInstalledAgentsResult> {
    if agent_ids.is_empty() || agent_ids.len() > harness_catalog().len() {
        return Err(AppError::Message("请选择已确认安装的 Agent。".into()));
    }
    // Discover again on the backend; never trust a client-provided installation report.
    let report = detect_installed_agents(state.clone()).await?;
    let _guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("设置正在使用，请重试。".into()))?;
    persist_enabled_agents(&state.db_path, &report, &agent_ids)
}

fn persist_enabled_agents(
    db_path: &Path,
    report: &[agent_installation::AgentInstallation],
    ids: &[String],
) -> AppResult<EnableInstalledAgentsResult> {
    let mut conn = open_db(db_path)?;
    let transaction = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut settings = load_settings_from(&transaction)?;
    let enabled_agent_ids = agent_installation::enable_selected(&mut settings, report, ids)?;
    if !enabled_agent_ids.is_empty() {
        transaction.execute(
            "insert into settings(key, value) values('settings', ?1) on conflict(key) do update set value = excluded.value",
            params![serde_json::to_string(&settings)?],
        )?;
    }
    transaction.commit()?;
    // This operation changes no shortcut or credentials and returns the usual redacted settings.
    Ok(EnableInstalledAgentsResult {
        settings: redact_settings(settings),
        enabled_agent_ids,
    })
}

#[tauri::command]
async fn update_settings(app: AppHandle, settings: Settings) -> AppResult<Settings> {
    // Waiting for an in-flight scan must not block the desktop event loop.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state
            .lock
            .lock()
            .map_err(|_| AppError::Message("设置正在使用，请重试。".into()))?;
        persist_settings(&state.db_path, settings, |shortcut| {
            register_shortcut(&app, shortcut)
        })
    })
    .await
    .map_err(|err| AppError::Message(format!("无法保存设置：{err}")))?
}

fn persist_settings(
    db_path: &Path,
    mut settings: Settings,
    register: impl FnOnce(&str) -> AppResult<()>,
) -> AppResult<Settings> {
    let current = load_settings(db_path)?;
    reconcile_masked_api_key(&current.translation, &mut settings.translation);
    // Saving agent flags must work even when another instance owns the unchanged hotkey.
    if current.shortcut != settings.shortcut {
        register(&settings.shortcut)?;
    }
    let mut conn = open_db(db_path)?;
    let transaction = conn.transaction()?;
    transaction.execute(
        "insert into settings(key, value) values('settings', ?1)
         on conflict(key) do update set value = excluded.value",
        params![serde_json::to_string(&settings)?],
    )?;
    reconcile_tags(&transaction, &settings.custom_tags)?;
    transaction.commit()?;
    Ok(redact_settings(settings))
}

/// 让 tags/skill_tags 双存储与 settings.custom_tags 保持一致：
/// 逐个 upsert（改名、改色即时生效），再删除不在集合中的关联与 tag 行。
/// 集合为空时清空两表。
fn reconcile_tags(conn: &Connection, tags: &[Tag]) -> AppResult<()> {
    for tag in tags {
        conn.execute(
            "insert into tags(id, name, color) values(?1, ?2, ?3)
             on conflict(id) do update set name = excluded.name, color = excluded.color",
            params![tag.id, tag.name, tag.color],
        )?;
    }
    if tags.is_empty() {
        conn.execute("delete from skill_tags", [])?;
        conn.execute("delete from tags", [])?;
        return Ok(());
    }
    let ids: Vec<&str> = tags.iter().map(|tag| tag.id.as_str()).collect();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("delete from skill_tags where tag_id not in ({placeholders})");
    conn.execute(&sql, rusqlite::params_from_iter(ids.iter()))?;
    let sql = format!("delete from tags where id not in ({placeholders})");
    conn.execute(&sql, rusqlite::params_from_iter(ids.iter()))?;
    Ok(())
}

fn redact_settings(mut settings: Settings) -> Settings {
    if !settings.translation.api_key.is_empty() {
        settings.translation.api_key = MASKED_API_KEY.into();
    }
    settings
}

fn same_translation_endpoint(a: &TranslationConfig, b: &TranslationConfig) -> bool {
    a.protocol.trim().eq_ignore_ascii_case(b.protocol.trim())
        && a.base_url.trim().trim_end_matches('/') == b.base_url.trim().trim_end_matches('/')
}

fn reconcile_masked_api_key(current: &TranslationConfig, incoming: &mut TranslationConfig) {
    if incoming.api_key == MASKED_API_KEY {
        incoming.api_key = if same_translation_endpoint(current, incoming) {
            current.api_key.clone()
        } else {
            String::new()
        };
    }
}

fn resolve_translation_config(
    db_path: &Path,
    mut config: TranslationConfig,
) -> AppResult<TranslationConfig> {
    if config.api_key == MASKED_API_KEY {
        let current = load_settings(db_path)?.translation;
        if !same_translation_endpoint(&current, &config) {
            return Err(AppError::Message("接口已变化，请重新输入 API Key。".into()));
        }
        config.api_key = current.api_key;
    }
    Ok(config)
}

// ─── Translation (BYO endpoint) ─────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationResult {
    text: String,
    cached: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestResult {
    ok: bool,
    latency_ms: u64,
    message: String,
}

fn translation_system_prompt(target_lang: &str) -> String {
    format!(
        "You are a professional technical translator. Translate the user's Markdown document into {target_lang}. \
Preserve all Markdown structure exactly: headings, lists, tables, blockquotes, and especially fenced code blocks and inline `code` — translate prose only, never translate code, commands, file paths, URLs, or YAML frontmatter keys. Keep identifier-like frontmatter values untouched. Do not add explanations and do not wrap the output in a code fence. Output only the translated document."
    )
}

fn truncate_str(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let cut: String = t.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// Turn a non-2xx response body into a short, readable message instead of
/// dumping a raw HTML error page or JSON blob into the UI.
fn extract_api_error(status: reqwest::StatusCode, content_type: &str, body: &str) -> String {
    let trimmed = body.trim();
    // HTML/XML error page — gateways, WAFs, and rate-limit blockers return these.
    if content_type.contains("text/html") || trimmed.starts_with('<') {
        let title = trimmed
            .split_once("<title>")
            .and_then(|(_, rest)| rest.split_once("</title>"))
            .map(|(t, _)| t.trim())
            .filter(|t| !t.is_empty());
        return match title {
            Some(t) => format!("接口返回 {status}（HTML 错误页：{}）", truncate_str(t, 80)),
            None => format!("接口返回 {status}（HTML 错误页，可能是网关限流或拦截）"),
        };
    }
    // JSON error envelope (OpenAI / Anthropic style).
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(msg) = v["error"]["message"]
            .as_str()
            .or_else(|| v["message"].as_str())
            .or_else(|| v["error"]["type"].as_str())
            .or_else(|| v["error"].as_str())
        {
            return format!("接口返回 {status}：{}", truncate_str(msg, 200));
        }
    }
    format!("接口返回 {status}：{}", truncate_str(trimmed, 200))
}

fn translation_cache_key(content: &str, model: &str, target_lang: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("{digest}:{model}:{target_lang}")
}

fn validate_outbound_url(raw: &str, allow_http_loopback: bool) -> AppResult<reqwest::Url> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| AppError::Message("接口地址不是有效 URL。".into()))?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::Message(
            "接口地址不能包含账号、密码、查询参数或片段。".into(),
        ));
    }

    let is_loopback = url.host_str().is_some_and(|host| {
        let host = host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(host);
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    match url.scheme() {
        "https" => Ok(url),
        "http" if allow_http_loopback && is_loopback => Ok(url),
        "http" => Err(AppError::Message(
            "为防止密钥被窃听，远程接口必须使用 HTTPS；本机 localhost 可使用 HTTP。".into(),
        )),
        _ => Err(AppError::Message("仅支持 http(s) 地址。".into())),
    }
}

fn build_http_client(user_agent: &str, allow_redirects: bool) -> AppResult<reqwest::Client> {
    let redirect = if allow_redirects {
        reqwest::redirect::Policy::limited(5)
    } else {
        reqwest::redirect::Policy::none()
    };
    Ok(reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(45))
        .timeout(Duration::from_secs(180))
        .redirect(redirect)
        .build()?)
}

async fn read_response_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> AppResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(AppError::Message(format!(
            "接口响应超过安全上限（{} MiB）。",
            max_bytes / (1024 * 1024)
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(AppError::Message(format!(
                "接口响应超过安全上限（{} MiB）。",
                max_bytes / (1024 * 1024)
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn read_response_text_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> AppResult<String> {
    let body = read_response_limited(response, max_bytes).await?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Call the configured endpoint and return translated text. Branches on
/// `protocol` — adding a provider means adding a match arm here.
async fn translate_text(cfg: &TranslationConfig, content: &str) -> AppResult<String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    validate_outbound_url(base, true)?;
    let target = if cfg.target_lang.trim().is_empty() {
        "zh-CN"
    } else {
        cfg.target_lang.trim()
    };
    let system = translation_system_prompt(target);
    let protocol = if cfg.protocol.trim().is_empty() {
        "openai"
    } else {
        cfg.protocol.trim()
    };
    // A User-Agent is required by many API front-ends (Cloudflare/WAF return a
    // 429/403 HTML block page for requests without one — reqwest sends none by
    // default). Mirrors the provenance client.
    // Authentication-bearing requests never follow redirects: a misconfigured
    // or malicious endpoint must not be able to bounce credentials elsewhere.
    let client = build_http_client("SkillAnvil/0.1", false)?;

    match protocol {
        "anthropic" => {
            let url = format!("{base}/v1/messages");
            let body = serde_json::json!({
                "model": cfg.model.trim(),
                "max_tokens": 8192,
                "system": system,
                "messages": [{ "role": "user", "content": content }],
            });
            let res = client
                .post(&url)
                .header("x-api-key", cfg.api_key.trim())
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .json(&body)
                .send()
                .await?;
            if !res.status().is_success() {
                let code = res.status();
                let ctype = res
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let detail = read_response_text_limited(res, MAX_ERROR_RESPONSE_BYTES)
                    .await
                    .unwrap_or_default();
                return Err(AppError::Message(extract_api_error(code, &ctype, &detail)));
            }
            let value: serde_json::Value = serde_json::from_slice(
                &read_response_limited(res, MAX_JSON_RESPONSE_BYTES).await?,
            )?;
            if value["stop_reason"] == "max_tokens" {
                return Err(AppError::Message(TRANSLATION_TRUNCATED_MSG.into()));
            }
            value["content"][0]["text"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| AppError::Message("响应解析失败：缺少 content[0].text".into()))
        }
        _ => {
            let url = format!("{base}/chat/completions");
            let body = serde_json::json!({
                "model": cfg.model.trim(),
                "temperature": 0,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": content },
                ],
            });
            let res = client
                .post(&url)
                .header("authorization", format!("Bearer {}", cfg.api_key.trim()))
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .json(&body)
                .send()
                .await?;
            if !res.status().is_success() {
                let code = res.status();
                let ctype = res
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let detail = read_response_text_limited(res, MAX_ERROR_RESPONSE_BYTES)
                    .await
                    .unwrap_or_default();
                return Err(AppError::Message(extract_api_error(code, &ctype, &detail)));
            }
            let value: serde_json::Value = serde_json::from_slice(
                &read_response_limited(res, MAX_JSON_RESPONSE_BYTES).await?,
            )?;
            if value["choices"][0]["finish_reason"] == "length" {
                return Err(AppError::Message(TRANSLATION_TRUNCATED_MSG.into()));
            }
            value["choices"][0]["message"]["content"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| {
                    AppError::Message("响应解析失败：缺少 choices[0].message.content".into())
                })
        }
    }
}

/// Streaming variant: sends incremental deltas through a Tauri channel and
/// returns the accumulated full text. SSE is parsed from a byte buffer split on
/// newlines so multi-byte UTF-8 (e.g. Chinese) is never decoded mid-character.
async fn translate_text_stream(
    cfg: &TranslationConfig,
    content: &str,
    on_chunk: &tauri::ipc::Channel<String>,
) -> AppResult<String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    validate_outbound_url(base, true)?;
    let target = if cfg.target_lang.trim().is_empty() {
        "zh-CN"
    } else {
        cfg.target_lang.trim()
    };
    let system = translation_system_prompt(target);
    let is_anthropic = cfg.protocol.trim() == "anthropic";
    let client = build_http_client("SkillAnvil/0.1", false)?;

    let (url, body) = if is_anthropic {
        (
            format!("{base}/v1/messages"),
            serde_json::json!({
                "model": cfg.model.trim(),
                "max_tokens": 8192,
                "stream": true,
                "system": system,
                "messages": [{ "role": "user", "content": content }],
            }),
        )
    } else {
        (
            format!("{base}/chat/completions"),
            serde_json::json!({
                "model": cfg.model.trim(),
                "temperature": 0,
                "stream": true,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": content },
                ],
            }),
        )
    };

    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream");
    req = if is_anthropic {
        req.header("x-api-key", cfg.api_key.trim())
            .header("anthropic-version", "2023-06-01")
    } else {
        req.header("authorization", format!("Bearer {}", cfg.api_key.trim()))
    };
    let mut res = req.json(&body).send().await?;

    if !res.status().is_success() {
        let code = res.status();
        let ctype = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let detail = read_response_text_limited(res, MAX_ERROR_RESPONSE_BYTES)
            .await
            .unwrap_or_default();
        return Err(AppError::Message(extract_api_error(code, &ctype, &detail)));
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    let mut truncated = false;
    let mut received_bytes = 0usize;
    while let Some(bytes) = res.chunk().await? {
        received_bytes = received_bytes.saturating_add(bytes.len());
        if received_bytes > MAX_JSON_RESPONSE_BYTES {
            return Err(AppError::Message(
                "流式翻译响应超过安全上限（8 MiB）。".into(),
            ));
        }
        buf.extend_from_slice(&bytes);
        // Only decode complete lines — a complete SSE line never splits a char.
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    // 截断检测：流式事件里 max_tokens/length 表示输出被模型
                    // 长度上限截断，流结束后整体作废。
                    if is_anthropic {
                        if v["type"] == "message_delta" && v["delta"]["stop_reason"] == "max_tokens"
                        {
                            truncated = true;
                        }
                    } else if v["choices"][0]["finish_reason"] == "length" {
                        truncated = true;
                    }
                    let delta = if is_anthropic {
                        v["delta"]["text"].as_str()
                    } else {
                        v["choices"][0]["delta"]["content"].as_str()
                    };
                    if let Some(d) = delta {
                        if !d.is_empty() {
                            full.push_str(d);
                            let _ = on_chunk.send(d.to_string());
                        }
                    }
                }
            }
        }
    }
    if truncated {
        return Err(AppError::Message(TRANSLATION_TRUNCATED_MSG.into()));
    }
    Ok(full)
}

#[tauri::command]
async fn translate_markdown(
    state: State<'_, AppState>,
    content: String,
) -> AppResult<TranslationResult> {
    let cfg = load_settings(&state.db_path)?.translation;
    if cfg.base_url.trim().is_empty()
        || cfg.api_key.trim().is_empty()
        || cfg.model.trim().is_empty()
    {
        return Err(AppError::Message(
            "翻译未配置：请在设置里填写接口、Key 和模型。".into(),
        ));
    }
    let target = if cfg.target_lang.trim().is_empty() {
        "zh-CN"
    } else {
        cfg.target_lang.trim()
    };
    let key = translation_cache_key(&content, cfg.model.trim(), target);

    if let Ok(conn) = open_db(&state.db_path) {
        if let Ok(text) = conn.query_row(
            "select content from translations where cache_key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            return Ok(TranslationResult { text, cached: true });
        }
    }

    let text = translate_text(&cfg, &content).await?;

    if let Ok(conn) = open_db(&state.db_path) {
        let _ = conn.execute(
            "insert into translations(cache_key, content, created_at) values(?1, ?2, ?3)
             on conflict(cache_key) do update set content = excluded.content, created_at = excluded.created_at",
            params![key, text, now()],
        );
    }

    Ok(TranslationResult {
        text,
        cached: false,
    })
}

#[tauri::command]
async fn translate_stream(
    state: State<'_, AppState>,
    content: String,
    on_chunk: tauri::ipc::Channel<String>,
) -> AppResult<TranslationResult> {
    let cfg = load_settings(&state.db_path)?.translation;
    if cfg.base_url.trim().is_empty()
        || cfg.api_key.trim().is_empty()
        || cfg.model.trim().is_empty()
    {
        return Err(AppError::Message(
            "翻译未配置：请在设置里填写接口、Key 和模型。".into(),
        ));
    }
    let target = if cfg.target_lang.trim().is_empty() {
        "zh-CN"
    } else {
        cfg.target_lang.trim()
    };
    let key = translation_cache_key(&content, cfg.model.trim(), target);

    // Cache hit → return the whole text; no need to stream.
    if let Ok(conn) = open_db(&state.db_path) {
        if let Ok(text) = conn.query_row(
            "select content from translations where cache_key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            return Ok(TranslationResult { text, cached: true });
        }
    }

    let text = translate_text_stream(&cfg, &content, &on_chunk).await?;

    if let Ok(conn) = open_db(&state.db_path) {
        let _ = conn.execute(
            "insert into translations(cache_key, content, created_at) values(?1, ?2, ?3)
             on conflict(cache_key) do update set content = excluded.content, created_at = excluded.created_at",
            params![key, text, now()],
        );
    }

    Ok(TranslationResult {
        text,
        cached: false,
    })
}

#[tauri::command]
async fn test_translation_config(
    state: State<'_, AppState>,
    config: TranslationConfig,
) -> AppResult<TestResult> {
    // The frontend only receives a masked secret. Resolve it exclusively for
    // the already-configured endpoint so a compromised WebView cannot redirect
    // the stored key to an attacker-controlled server.
    let config = resolve_translation_config(&state.db_path, config)?;
    if config.base_url.trim().is_empty()
        || config.api_key.trim().is_empty()
        || config.model.trim().is_empty()
    {
        return Ok(TestResult {
            ok: false,
            latency_ms: 0,
            message: "接口、Key、模型都要填。".into(),
        });
    }
    let start = std::time::Instant::now();
    match translate_text(&config, "Hello, world.").await {
        Ok(text) => Ok(TestResult {
            ok: true,
            latency_ms: start.elapsed().as_millis() as u64,
            message: truncate_str(&text, 80),
        }),
        Err(err) => Ok(TestResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            message: err.to_string(),
        }),
    }
}

#[tauri::command]
async fn list_translation_models(
    state: State<'_, AppState>,
    config: TranslationConfig,
) -> AppResult<Vec<String>> {
    let config = resolve_translation_config(&state.db_path, config)?;
    if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
        return Err(AppError::Message("先填接口和 Key 再检测模型。".into()));
    }
    let base = config.base_url.trim().trim_end_matches('/');
    validate_outbound_url(base, true)?;
    let is_anthropic = config.protocol.trim() == "anthropic";
    let client = build_http_client("SkillAnvil/0.1", false)?;
    let url = if is_anthropic {
        format!("{base}/v1/models")
    } else {
        format!("{base}/models")
    };
    let mut req = client.get(&url).header("accept", "application/json");
    req = if is_anthropic {
        req.header("x-api-key", config.api_key.trim())
            .header("anthropic-version", "2023-06-01")
    } else {
        req.header("authorization", format!("Bearer {}", config.api_key.trim()))
    };
    let res = req.send().await?;
    if !res.status().is_success() {
        let code = res.status();
        let ctype = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let detail = read_response_text_limited(res, MAX_ERROR_RESPONSE_BYTES)
            .await
            .unwrap_or_default();
        return Err(AppError::Message(extract_api_error(code, &ctype, &detail)));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&read_response_limited(res, MAX_JSON_RESPONSE_BYTES).await?)?;
    let mut models: Vec<String> = v["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();
    Ok(models)
}

/// 清空翻译缓存（translations 表全部行），返回删除的行数。
#[tauri::command(async)]
fn clear_translation_cache(state: State<AppState>) -> AppResult<u64> {
    let conn = open_db(&state.db_path)?;
    let deleted = conn.execute("delete from translations", [])?;
    Ok(deleted as u64)
}

fn perform_scan(state: &AppState) -> AppResult<ScanResult> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("Lock poisoned".into()))?;
    let mut conn = open_db(&state.db_path)?;
    let settings = load_settings_from(&conn)?;
    let agents = detect_agents(&settings);
    let active_ids = agents
        .iter()
        .map(|agent| agent.id.clone())
        .collect::<Vec<_>>();
    let mut scan_errors = Vec::new();
    let mut missing_roots = Vec::new();
    let mut jobs: Vec<(&Agent, PathBuf)> = Vec::new();
    for agent in &agents {
        let mut seen_directories = HashSet::new();
        for root in &agent.skill_dir_paths {
            let root_path = Path::new(root);
            if !root_path.exists() {
                // 根目录暂时不可用（网络盘/移动盘未挂载、盘符变化等）≠ 其中的
                // skill 已删除。记下来让 prune_stale_skills 跳过这些行。
                missing_roots.push(root.clone());
                continue;
            }
            let (directories, errors) = discover_skill_directories(root_path);
            scan_errors.extend(errors);
            for dir in directories {
                if seen_directories.insert(dir.canonicalize().unwrap_or_else(|_| dir.clone())) {
                    jobs.push((agent, dir));
                }
            }
        }
    }
    // Reading SKILL.md and listing files is pure filesystem work, so it runs in
    // parallel; all database writes then land in one transaction instead of one
    // implicit commit (and fsync) per skill.
    let scanned = parallel_map(&jobs, |(agent, dir)| scan_one_skill(agent, dir));
    let transaction = conn.transaction()?;
    prune_inactive_agents(&transaction, &active_ids)?;
    for agent in &agents {
        upsert_agent(&transaction, agent)?;
    }
    let mut found_files = HashMap::new();
    for ((_, dir), result) in jobs.iter().zip(scanned) {
        match result {
            Ok(skill) => {
                upsert_skill(&transaction, &skill)?;
                found_files.insert(skill.id, skill.files);
            }
            Err(err) => scan_errors.push(ScanIssue {
                path: dir.join("SKILL.md").to_string_lossy().to_string(),
                message: err.to_string(),
            }),
        }
    }
    let found_ids: Vec<String> = found_files.keys().cloned().collect();
    let error_paths: Vec<String> = scan_errors.iter().map(|issue| issue.path.clone()).collect();
    prune_stale_skills(&transaction, &found_ids, &missing_roots, &error_paths)?;
    transaction.commit()?;
    Ok(ScanResult {
        agents: load_agents(&conn)?,
        // Reuse the file lists gathered above rather than walking every skill twice.
        skills: load_skills_with_files(&conn, &SkillFilter::default(), found_files)?,
        scan_errors,
    })
}

/// Map `items` on a few scoped threads, preserving order. Small inputs stay on
/// the calling thread because spawning would cost more than it saves.
fn parallel_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .min(8);
    if items.len() < 16 || threads < 2 {
        return items.iter().map(f).collect();
    }
    let chunk_size = items.len().div_ceil(threads);
    let f = &f;
    std::thread::scope(|scope| {
        let handles = items
            .chunks(chunk_size)
            .map(|chunk| scope.spawn(move || chunk.iter().map(f).collect::<Vec<R>>()))
            .collect::<Vec<_>>();
        let mut results = Vec::with_capacity(items.len());
        for handle in handles {
            match handle.join() {
                Ok(part) => results.extend(part),
                Err(payload) => std::panic::resume_unwind(payload),
            }
        }
        results
    })
}

fn discover_skill_directories(root: &Path) -> (Vec<PathBuf>, Vec<ScanIssue>) {
    let mut directories = Vec::new();
    let mut errors = Vec::new();
    for result in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_ignored_dir(entry))
    {
        match result {
            Ok(entry) if entry.file_type().is_file() && entry.file_name() == "SKILL.md" => {
                if let Some(directory) = entry.path().parent() {
                    directories.push(directory.to_path_buf());
                }
            }
            // npx skills and other installers link individual bundles. Read the
            // linked root without following arbitrary links inside the bundle.
            Ok(entry)
                if entry.file_type().is_symlink()
                    && entry.path().is_dir()
                    && entry.path().join("SKILL.md").is_file() =>
            {
                directories.push(entry.path().to_path_buf());
            }
            Ok(_) => {}
            Err(error) => errors.push(ScanIssue {
                path: error.path().unwrap_or(root).to_string_lossy().to_string(),
                message: error.to_string(),
            }),
        }
    }
    (directories, errors)
}

#[tauri::command]
async fn check_for_updates(
    state: State<'_, AppState>,
    ignore_dismissed: bool,
) -> AppResult<UpdateInfo> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let client = build_http_client("SkillAnvil", true)?;

    let response = client
        .get("https://api.github.com/repos/LioraRndr/SkillAnvil/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;

    let empty = || UpdateInfo {
        current_version: current_version.clone(),
        latest_version: String::new(),
        has_update: false,
        asset_url: String::new(),
        release_url: String::new(),
        release_notes: String::new(),
        published_at: String::new(),
    };

    if !response.status().is_success() {
        return Ok(empty());
    }

    let json: serde_json::Value =
        serde_json::from_slice(&read_response_limited(response, MAX_JSON_RESPONSE_BYTES).await?)?;
    let tag = json["tag_name"].as_str().unwrap_or("").to_string();
    let latest_version = tag.strip_prefix('v').unwrap_or(&tag).to_string();
    let release_url = json["html_url"].as_str().unwrap_or("").to_string();
    let release_notes = json["body"].as_str().unwrap_or("").to_string();
    let published_at = json["published_at"].as_str().unwrap_or("").to_string();

    // Pick the asset that matches the current platform so the user can
    // download the installer directly instead of browsing the release page.
    let asset_url = pick_asset(&json);

    // Check if user already dismissed this version. Manual "check for updates"
    // passes ignore_dismissed = true to bypass the suppression.
    if !ignore_dismissed {
        let conn = open_db(&state.db_path)?;
        let dismissed: bool = conn
            .query_row(
                "select count(*) from dismissed_update where version = ?1",
                params![latest_version],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count > 0)
            .unwrap_or(false);

        if dismissed {
            return Ok(UpdateInfo {
                asset_url,
                release_url,
                release_notes,
                published_at,
                ..empty()
            });
        }
    }

    let has_update =
        compare_versions(&latest_version, &current_version) == std::cmp::Ordering::Greater;

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        asset_url,
        release_url,
        release_notes,
        published_at,
    })
}

#[tauri::command(async)]
fn dismiss_update(state: State<'_, AppState>, version: String) -> AppResult<()> {
    let conn = open_db(&state.db_path)?;
    conn.execute(
        "insert or ignore into dismissed_update(version) values(?1)",
        params![version],
    )?;
    Ok(())
}

/// Pick the release asset best matching the current platform so the user
/// can download the installer with a single click (no release-page browsing).
fn pick_asset(release: &serde_json::Value) -> String {
    let assets = match release["assets"].as_array() {
        Some(a) => a,
        None => return String::new(),
    };

    // Extension priority per platform — first match wins
    #[cfg(target_os = "macos")]
    let exts: &[&str] = &[".dmg", ".app.tar.gz"];
    #[cfg(target_os = "windows")]
    let exts: &[&str] = &[".msi", ".exe"];
    #[cfg(all(unix, not(target_os = "macos")))]
    let exts: &[&str] = &[".AppImage", ".deb", ".rpm"];

    for asset in assets {
        let name = asset["name"].as_str().unwrap_or("").to_lowercase();
        let url = asset["browser_download_url"].as_str().unwrap_or("");
        if exts.iter().any(|ext| name.ends_with(ext)) && !url.is_empty() {
            return url.to_string();
        }
    }

    // Fallback: return the first download URL if no platform match
    assets
        .first()
        .and_then(|a| a["browser_download_url"].as_str())
        .map(str::to_string)
        .unwrap_or_default()
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse =
        |v: &str| -> Vec<u64> { v.split('.').filter_map(|s| s.parse::<u64>().ok()).collect() };
    let va = parse(a);
    let vb = parse(b);
    for i in 0..va.len().max(vb.len()) {
        let na = va.get(i).copied().unwrap_or(0);
        let nb = vb.get(i).copied().unwrap_or(0);
        match na.cmp(&nb) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// Open the application database with a 5s busy timeout so concurrent
/// readers/writers (scan、翻译缓存、溯源写入) wait briefly instead of failing
/// immediately with SQLITE_BUSY. Setting the timeout is best-effort.
fn open_db(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    let _ = conn.busy_timeout(Duration::from_secs(5));
    Ok(conn)
}

fn init_db(path: &Path) -> AppResult<()> {
    let conn = open_db(path)?;
    // WAL lets short-lived reader/writer connections coexist without blocking,
    // which matters while background provenance tracing writes during reads.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(
        r#"
        create table if not exists agents(
            id text primary key,
            name text not null,
            paths text not null,
            icon text not null,
            detected_at text not null
        );
        create table if not exists skills(
            id text primary key,
            name text not null,
            display_name text not null,
            description text not null,
            version text not null,
            dir_path text not null,
            agent_id text not null,
            source text not null,
            github_repo text,
            github_branch text,
            last_sync_commit text,
            local_modified integer not null,
            updated_at text not null
        );
        create table if not exists skill_state(
            skill_id text primary key,
            starred integer not null default 0
        );
        create table if not exists tags(
            id text primary key,
            name text not null,
            color text not null
        );
        create table if not exists skill_tags(
            skill_id text not null,
            tag_id text not null,
            primary key(skill_id, tag_id)
        );
        create table if not exists snapshots(
            id text primary key,
            skill_id text not null,
            file_path text not null,
            content text not null,
            created_at text not null
        );
        create table if not exists sync_logs(
            id text primary key,
            skill_id text not null,
            target_agent_id text not null,
            created_at text not null
        );
        create table if not exists settings(
            key text primary key,
            value text not null
        );
        create table if not exists skill_provenance(
            skill_id text primary key,
            status text not null,
            repo text,
            installs integer,
            content_match text,
            candidates text not null default '[]',
            manual integer not null default 0,
            traced_at text,
            error text
        );
        create table if not exists translations(
            cache_key text primary key,
            content text not null,
            created_at text not null
        );
        create table if not exists dismissed_update(
            version text primary key
        );
        "#,
    )?;
    Ok(())
}

fn detect_agents(settings: &Settings) -> Vec<Agent> {
    let home = directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .unwrap_or_default();
    settings
        .custom_agents
        .iter()
        .filter(|config| config.enabled)
        .map(|config| Agent {
            id: config.id.clone(),
            name: config.name.clone(),
            skill_dir_paths: resolved_skill_roots(&config.paths, &home),
            icon: config.icon.clone().unwrap_or_else(|| "custom".into()),
            detected_at: now(),
        })
        .collect()
}

fn prune_inactive_agents(conn: &Connection, active_ids: &[String]) -> AppResult<()> {
    if active_ids.is_empty() {
        conn.execute("delete from skills", [])?;
        conn.execute("delete from agents", [])?;
        return Ok(());
    }
    let placeholders = active_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let agent_sql = format!("delete from agents where id not in ({placeholders})");
    conn.execute(&agent_sql, rusqlite::params_from_iter(active_ids.iter()))?;
    let skill_sql = format!("delete from skills where agent_id not in ({placeholders})");
    conn.execute(&skill_sql, rusqlite::params_from_iter(active_ids.iter()))?;
    Ok(())
}

/// Remove skills rows whose directory no longer exists on disk. Runs after a
/// full scan。「本轮扫描未找到」不等于「磁盘上已删除」：根目录暂时不可用
/// （网络盘/移动盘未挂载）、SKILL.md 解析失败（文件被占用、乱码、名称非法）、
/// WalkDir 的 IO 错误被吞掉等瞬态条件都会让磁盘上仍然存在的 skill 落不进
/// `found_ids`，而快照是本应用唯一的回滚保护，误删不可恢复。因此对不在
/// `found_ids` 中的行逐行确认后才删：
/// - 位于本轮缺失的根目录（`missing_roots`）之下 → 状态未知，跳过；
/// - 出现在本轮扫描错误（`error_paths`，SKILL.md 路径）中 → 目录还在，跳过；
/// - 目录在磁盘上仍然存在 → 跳过；
/// 只有目录确认消失的行才连同附属数据（收藏、标签、快照、溯源）一并删除，
/// 防止孤儿行在同路径重建 skill（id 相同）时“复活”旧状态。附属表只清理本次
/// 确认删除的 id：禁用 agent（`prune_inactive_agents`）留下的附属行必须保留——
/// id 是确定性 `stable_id`，重新启用后行重建即自动重挂。
fn prune_stale_skills(
    conn: &Connection,
    found_ids: &[String],
    missing_roots: &[String],
    error_paths: &[String],
) -> AppResult<()> {
    let found: HashSet<&str> = found_ids.iter().map(String::as_str).collect();
    let error_dirs: HashSet<String> = error_paths
        .iter()
        .filter_map(|path| Path::new(path).parent())
        .map(|dir| normalize_path_key(&dir.to_string_lossy()))
        .collect();
    let mut stmt = conn.prepare("select id, dir_path from skills")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, dir_path) in rows {
        if found.contains(id.as_str()) {
            continue;
        }
        if missing_roots
            .iter()
            .any(|root| path_is_under(root, &dir_path))
        {
            continue;
        }
        if error_dirs.contains(&normalize_path_key(&dir_path)) {
            continue;
        }
        if Path::new(&dir_path).exists() {
            continue;
        }
        conn.execute("delete from skills where id = ?1", params![id])?;
        for table in ["skill_state", "skill_tags", "snapshots", "skill_provenance"] {
            let sql = format!("delete from {table} where skill_id = ?1");
            conn.execute(&sql, params![id])?;
        }
    }
    Ok(())
}

/// 路径比较键：统一分隔符、去尾部斜杠、小写（Windows 路径大小写不敏感，与
/// `stable_id` 的语义一致）。
fn normalize_path_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// `dir_path` 是否等于 `root` 或位于其之下。前缀必须落在路径分隔符边界上，
/// 避免 `skills` 误匹配 `skillsX`（与 `skill_rel_path` 同规则）。
fn path_is_under(root: &str, dir_path: &str) -> bool {
    let root = normalize_path_key(root);
    let dir = normalize_path_key(dir_path);
    if root.is_empty() {
        return false;
    }
    if dir == root {
        return true;
    }
    dir.len() > root.len() && dir.starts_with(&root) && dir.as_bytes()[root.len()] == b'/'
}

fn expand_home_path(path: &str, home: &Path) -> String {
    if path == "~" {
        return home.to_string_lossy().to_string();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home.join(rest).to_string_lossy().to_string();
    }
    path.to_string()
}

fn expand_skill_root_with(
    path: &str,
    home: &Path,
    get_env: impl Fn(&str) -> Option<String>,
) -> String {
    let defaults = [
        ("CLAUDE_CONFIG_DIR", ".claude"),
        ("CODEX_HOME", ".codex"),
        ("XDG_CONFIG_HOME", ".config"),
        ("DSH_HOME", ".dsh"),
        ("DSH_AGENTS_HOME", ".agents"),
        ("GROK_HOME", ".grok"),
        ("HERMES_HOME", ".hermes"),
        ("KIMI_CODE_HOME", ".kimi-code"),
        ("APPDATA", "AppData/Roaming"),
    ];
    for (variable, fallback) in defaults {
        let prefix = format!("${variable}/");
        if let Some(rest) = path.strip_prefix(&prefix) {
            let base = get_env(variable)
                .filter(|value| !value.trim().is_empty())
                .map(|value| PathBuf::from(expand_home_path(&value, home)))
                .filter(|value| value.is_absolute())
                .unwrap_or_else(|| home.join(fallback));
            return base.join(rest).to_string_lossy().to_string();
        }
    }
    expand_home_path(path, home)
}

fn expand_skill_root(path: &str, home: &Path) -> String {
    expand_skill_root_with(path, home, |variable| std::env::var(variable).ok())
}

fn resolved_skill_roots(paths: &[String], home: &Path) -> Vec<String> {
    let mut seen = HashSet::new();
    paths
        .iter()
        .map(|path| expand_skill_root(path, home))
        .filter(|path| !path.trim().is_empty())
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn scan_one_skill(agent: &Agent, dir: &Path) -> AppResult<Skill> {
    let main = dir.join("SKILL.md");
    let text = read_text_file(&main)?;
    let (meta, body) = parse_frontmatter(&text.content);
    let fallback_name = dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill")
        .to_string();
    let name = meta
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| fallback_name.clone());
    validate_name(&name).map_err(|_| {
        AppError::Message(format!(
            "Skill 名称包含不安全字符，已跳过：{}",
            main.display()
        ))
    })?;
    let display_name = meta
        .get("displayName")
        .or_else(|| meta.get("display_name"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| first_heading(body))
        .unwrap_or_else(|| name.clone());
    let description = meta
        .get("description")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| first_paragraph(body));
    let version = meta
        .get("version")
        .and_then(|value| value.as_str().or_else(|| value.as_f64().map(|_| "")))
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "0.1.0".into());
    let meta_json = read_meta_json(dir)?;
    let meta_string = |key: &str| {
        meta_json
            .as_ref()
            .and_then(|meta| meta.get(key))
            .and_then(|value| value.as_str())
            .map(str::to_string)
    };
    let github_repo = meta_string("repo");
    let source = if github_repo.is_some() {
        "github"
    } else {
        "local"
    }
    .to_string();
    Ok(Skill {
        id: stable_id(&agent.id, dir),
        name,
        display_name,
        description,
        version,
        dir_path: dir.to_string_lossy().to_string(),
        agent_id: agent.id.clone(),
        source,
        github_repo,
        github_branch: meta_string("branch"),
        last_sync_commit: meta_string("lastSyncCommit"),
        local_modified: false,
        starred: false,
        tags: vec![],
        files: list_skill_files(dir)?,
        updated_at: file_updated_at(&main),
    })
}

fn load_agents(conn: &Connection) -> AppResult<Vec<Agent>> {
    let mut stmt =
        conn.prepare("select id, name, paths, icon, detected_at from agents order by name")?;
    let rows = stmt.query_map([], |row| {
        Ok(Agent {
            id: row.get(0)?,
            name: row.get(1)?,
            skill_dir_paths: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
            icon: row.get(3)?,
            detected_at: row.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

const SKILL_SELECT: &str =
    "select s.id, s.name, s.display_name, s.description, s.version, s.dir_path, s.agent_id,
            s.source, s.github_repo, s.github_branch, s.last_sync_commit, s.local_modified,
            coalesce(st.starred, 0), s.updated_at
     from skills s
     left join skill_state st on st.skill_id = s.id";

fn skill_from_row(row: &rusqlite::Row) -> rusqlite::Result<Skill> {
    Ok(Skill {
        id: row.get(0)?,
        name: row.get(1)?,
        display_name: row.get(2)?,
        description: row.get(3)?,
        version: row.get(4)?,
        dir_path: row.get(5)?,
        agent_id: row.get(6)?,
        source: row.get(7)?,
        github_repo: row.get(8)?,
        github_branch: row.get(9)?,
        last_sync_commit: row.get(10)?,
        local_modified: row.get::<_, i64>(11)? == 1,
        starred: row.get::<_, i64>(12)? == 1,
        tags: vec![],
        files: vec![],
        updated_at: row.get(13)?,
    })
}

fn load_skills(conn: &Connection, filter: &SkillFilter) -> AppResult<Vec<Skill>> {
    load_skills_with_files(conn, filter, HashMap::new())
}

/// Load skill rows plus tags and file lists. `known_files` lets a fresh scan
/// hand over the lists it already gathered; other skills are listed in parallel.
fn load_skills_with_files(
    conn: &Connection,
    filter: &SkillFilter,
    mut known_files: HashMap<String, Vec<SkillFile>>,
) -> AppResult<Vec<Skill>> {
    let mut stmt = conn.prepare(&format!("{SKILL_SELECT} order by s.display_name"))?;
    let mut skills = stmt
        .query_map([], skill_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut tags = load_all_skill_tags(conn)?;
    for skill in &mut skills {
        skill.tags = tags.remove(&skill.id).unwrap_or_default();
    }
    skills.retain(|skill| {
        if filter
            .agent_id
            .as_ref()
            .is_some_and(|id| id != &skill.agent_id)
        {
            return false;
        }
        if filter.starred == Some(true) && !skill.starred {
            return false;
        }
        if let Some(tag_id) = &filter.tag_id {
            if !skill.tags.iter().any(|tag| &tag.id == tag_id) {
                return false;
            }
        }
        if let Some(query) = &filter.query {
            let q = query.to_lowercase();
            return [
                skill.name.as_str(),
                skill.display_name.as_str(),
                skill.description.as_str(),
                skill.dir_path.as_str(),
            ]
            .join(" ")
            .to_lowercase()
            .contains(&q);
        }
        true
    });
    // Filter first so only the skills actually returned get their directory walked.
    let mut pending = Vec::new();
    for (index, skill) in skills.iter_mut().enumerate() {
        match known_files.remove(&skill.id) {
            Some(files) => skill.files = files,
            None => pending.push((index, skill.dir_path.clone())),
        }
    }
    let listed = parallel_map(&pending, |(_, dir)| {
        list_skill_files(Path::new(dir)).unwrap_or_default()
    });
    for ((index, _), files) in pending.into_iter().zip(listed) {
        skills[index].files = files;
    }
    Ok(skills)
}

/// Tag links for every skill in one query (ordered by tag name, matching
/// `load_tags_for_skill`) instead of one query per skill.
fn load_all_skill_tags(conn: &Connection) -> AppResult<HashMap<String, Vec<Tag>>> {
    let mut stmt = conn.prepare(
        "select st.skill_id, t.id, t.name, t.color from tags t
         join skill_tags st on st.tag_id = t.id
         order by t.name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            Tag {
                id: row.get(1)?,
                name: row.get(2)?,
                color: row.get(3)?,
            },
        ))
    })?;
    let mut tags: HashMap<String, Vec<Tag>> = HashMap::new();
    for row in rows {
        let (skill_id, tag) = row?;
        tags.entry(skill_id).or_default().push(tag);
    }
    Ok(tags)
}

/// The skill row (with starred state) by id, without tags or files. Cheap
/// enough for every IPC call that only needs to resolve a path.
fn find_skill_row(conn: &Connection, id: &str) -> AppResult<Skill> {
    conn.query_row(
        &format!("{SKILL_SELECT} where s.id = ?1"),
        params![id],
        skill_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::Message("Skill 不存在，请重新扫描。".into()))
}

/// One skill by id with its tags and file list. Earlier versions loaded the
/// whole library (walking every skill directory) just to pick one entry, which
/// made opening, saving, starring and tagging scale with library size.
fn find_skill(conn: &Connection, id: &str) -> AppResult<Skill> {
    let mut skill = find_skill_row(conn, id)?;
    skill.tags = load_tags_for_skill(conn, &skill.id)?;
    skill.files = list_skill_files(Path::new(&skill.dir_path)).unwrap_or_default();
    Ok(skill)
}

fn find_agent(conn: &Connection, id: &str) -> AppResult<Agent> {
    load_agents(conn)?
        .into_iter()
        .find(|agent| agent.id == id)
        .ok_or_else(|| AppError::Message("Agent 不存在，请重新扫描。".into()))
}

fn upsert_agent(conn: &Connection, agent: &Agent) -> AppResult<()> {
    conn.execute(
        "insert into agents(id, name, paths, icon, detected_at) values(?1, ?2, ?3, ?4, ?5)
         on conflict(id) do update set name = excluded.name, paths = excluded.paths, icon = excluded.icon, detected_at = excluded.detected_at",
        params![agent.id, agent.name, serde_json::to_string(&agent.skill_dir_paths)?, agent.icon, agent.detected_at],
    )?;
    Ok(())
}

fn upsert_skill(conn: &Connection, skill: &Skill) -> AppResult<()> {
    conn.execute(
        "insert into skills(id, name, display_name, description, version, dir_path, agent_id, source,
                           github_repo, github_branch, last_sync_commit, local_modified, updated_at)
         values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         on conflict(id) do update set
             name = excluded.name,
             display_name = excluded.display_name,
             description = excluded.description,
             version = excluded.version,
             dir_path = excluded.dir_path,
             agent_id = excluded.agent_id,
             source = excluded.source,
             github_repo = excluded.github_repo,
             github_branch = excluded.github_branch,
             last_sync_commit = excluded.last_sync_commit,
             updated_at = excluded.updated_at",
        params![
            skill.id,
            skill.name,
            skill.display_name,
            skill.description,
            skill.version,
            skill.dir_path,
            skill.agent_id,
            skill.source,
            skill.github_repo,
            skill.github_branch,
            skill.last_sync_commit,
            skill.local_modified as i64,
            skill.updated_at
        ],
    )?;
    Ok(())
}

fn refresh_skill_row(conn: &Connection, skill_id: &str) -> AppResult<()> {
    let skill = find_skill(conn, skill_id)?;
    let agent = find_agent(conn, &skill.agent_id)?;
    let updated = scan_one_skill(&agent, Path::new(&skill.dir_path))?;
    upsert_skill(conn, &updated)
}

fn load_tags_for_skill(conn: &Connection, skill_id: &str) -> AppResult<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "select t.id, t.name, t.color from tags t
         join skill_tags st on st.tag_id = t.id
         where st.skill_id = ?1 order by t.name",
    )?;
    let rows = stmt.query_map(params![skill_id], |row| {
        Ok(Tag {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_settings(db_path: &Path) -> AppResult<Settings> {
    let conn = open_db(db_path)?;
    load_settings_from(&conn)
}

fn load_settings_from(conn: &Connection) -> AppResult<Settings> {
    let value: Option<String> = conn
        .query_row(
            "select value from settings where key = 'settings'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(value) = value {
        Ok(normalize_settings(serde_json::from_str(&value)?))
    } else {
        Ok(default_settings())
    }
}

fn normalize_settings(mut settings: Settings) -> Settings {
    #[cfg(target_os = "macos")]
    {
        if settings.shortcut == "Ctrl+Shift+K" {
            settings.shortcut = default_shortcut();
        }
    }
    if settings.custom_agents.is_empty() {
        settings.custom_agents = default_agent_configs();
        return settings;
    }
    let defaults = default_agent_configs();
    let default_ids: std::collections::HashSet<String> =
        defaults.iter().map(|a| a.id.clone()).collect();
    let mut merged = defaults;
    for existing in settings.custom_agents {
        if let Some(target) = merged.iter_mut().find(|agent| agent.id == existing.id) {
            target.name = existing.name;
            let legacy = harness_catalog()
                .iter()
                .find(|entry| entry.id == existing.id)
                .and_then(|entry| entry.legacy_paths.as_ref());
            // Only migrate the exact shipped defaults, preserving custom roots and order.
            if !(existing.builtin && legacy == Some(&existing.paths)) {
                target.paths = existing.paths;
            }
            target.enabled = existing.enabled;
            target.icon = existing.icon.or_else(|| target.icon.clone());
            // 手动分类是用户数据，合并内置 agent 时必须保留，否则每次启动被清空。
            target.categories = existing.categories;
        } else if !default_ids.contains(&existing.id) && !existing.builtin {
            // Keep custom (non-builtin) agents that are not in defaults
            merged.push(existing);
        }
        // Skip removed builtin agents
    }
    settings.custom_agents = merged;
    settings
}

fn default_settings() -> Settings {
    Settings {
        theme: default_theme(),
        shortcut: default_shortcut(),
        minimize_to_tray: true,
        custom_agents: default_agent_configs(),
        snapshots_enabled: true,
        custom_tags: default_custom_tags(),
        provenance_agent_id: None,
        translation: TranslationConfig::default(),
    }
}

fn default_custom_tags() -> Vec<Tag> {
    vec![
        Tag {
            id: "writing".into(),
            name: "写作".into(),
            color: "#7dd3fc".into(),
        },
        Tag {
            id: "coding".into(),
            name: "开发".into(),
            color: "#86efac".into(),
        },
        Tag {
            id: "review".into(),
            name: "审查".into(),
            color: "#fcd34d".into(),
        },
    ]
}

fn default_theme() -> String {
    "dark".into()
}

fn default_shortcut() -> String {
    #[cfg(target_os = "macos")]
    {
        "Cmd+Shift+K".into()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Ctrl+Shift+K".into()
    }
}

fn default_true() -> bool {
    true
}

fn default_agent_configs() -> Vec<AgentPathConfig> {
    default_agent_configs_for_platform(cfg!(target_os = "windows"))
}

fn default_agent_configs_for_platform(windows: bool) -> Vec<AgentPathConfig> {
    harness_catalog()
        .iter()
        .filter(|entry| entry.status == "native")
        .map(|entry| AgentPathConfig {
            id: entry.id.clone(),
            name: entry.name.clone(),
            paths: if windows {
                entry.paths_windows.as_ref().unwrap_or(&entry.paths).clone()
            } else {
                entry.paths.clone()
            },
            enabled: entry.enabled,
            builtin: true,
            icon: Some(entry.icon.clone()),
            categories: vec![],
        })
        .collect()
}

fn read_text_file(path: &Path) -> AppResult<ReadFileResult> {
    let bytes = fs::read(path)?;
    let (content, encoding) = decode_known_text(&bytes)?;
    if contains_mojibake(&content) {
        return Err(AppError::Message(format!(
            "检测到疑似乱码，拒绝读取：{}",
            path.display()
        )));
    }
    Ok(ReadFileResult {
        content,
        encoding,
        updated_at: file_updated_at(path),
    })
}

fn decode_known_text(bytes: &[u8]) -> AppResult<(String, String)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _, had_errors) = UTF_8.decode(&bytes[3..]);
        if had_errors {
            return Err(AppError::Message("UTF-8 BOM 文件解码失败。".into()));
        }
        return Ok((cow.into_owned(), "UTF-8 BOM".into()));
    }
    if std::str::from_utf8(bytes).is_ok() {
        return Ok((String::from_utf8_lossy(bytes).to_string(), "UTF-8".into()));
    }
    let (cow, _, had_errors) = GBK.decode(bytes);
    if !had_errors {
        return Ok((cow.into_owned(), "GBK".into()));
    }
    Err(AppError::Message("无法确认文件编码，已拒绝操作。".into()))
}

fn write_text_file(path: &Path, content: &str, encoding: &str) -> AppResult<()> {
    // Finish all fallible encoding work before opening the destination. Opening
    // with File::create truncates immediately, so encoding GBK afterwards used
    // to erase the original file when the new content was not representable.
    let bytes = match encoding {
        "UTF-8 BOM" => {
            let mut bytes = Vec::with_capacity(content.len() + 3);
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            bytes.extend_from_slice(content.as_bytes());
            bytes
        }
        "UTF-8" => content.as_bytes().to_vec(),
        "GBK" => {
            let (bytes, _, had_errors) = GBK.encode(content);
            if had_errors {
                return Err(AppError::Message(
                    "内容无法无损编码为 GBK，已拒绝写入。".into(),
                ));
            }
            bytes.into_owned()
        }
        other => return Err(AppError::Message(format!("未知编码 {other}，已拒绝写入。"))),
    };
    let mut file = fs::File::create(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

fn contains_mojibake(content: &str) -> bool {
    let markers = [
        String::from_iter(['\u{9460}', '\u{7248}', '\u{582a}']),
        String::from_iter(['\u{6fee}', '\u{714e}']),
        String::from_iter(['\u{951f}', '\u{65a4}', '\u{62f7}']),
        String::from_iter(['\u{fffd}']),
    ];
    markers.iter().any(|marker| content.contains(marker))
}

fn parse_frontmatter(content: &str) -> (BTreeMap<String, serde_yaml::Value>, &str) {
    if !content.starts_with("---") {
        return (BTreeMap::new(), content);
    }
    let Some(rest) = content.strip_prefix("---") else {
        return (BTreeMap::new(), content);
    };
    let Some((yaml, body)) = rest.split_once("\n---") else {
        return (BTreeMap::new(), content);
    };
    let meta =
        serde_yaml::from_str::<BTreeMap<String, serde_yaml::Value>>(yaml).unwrap_or_default();
    (meta, body.trim_start_matches(['\r', '\n']))
}

fn first_heading(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("# ")
            .map(|value| value.trim().to_string())
    })
}

fn first_paragraph(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))
        .unwrap_or("")
        .chars()
        .take(180)
        .collect()
}

fn read_meta_json(dir: &Path) -> AppResult<Option<serde_json::Value>> {
    let path = dir.join(".skillanvil").join("meta.json");
    if !path.exists() {
        return Ok(None);
    }
    let file = read_text_file(&path)?;
    Ok(Some(serde_json::from_str(&file.content)?))
}

/// 扫描、哈希、文件列表阶段跳过的目录：node_modules 与 .git 体量巨大，且其中
/// 出现的 SKILL.md（依赖内嵌示例）不是用户技能。复制（copy_dir_all）不过滤，
/// 保持副本完整。
fn is_ignored_dir(entry: &walkdir::DirEntry) -> bool {
    entry.file_type().is_dir()
        && entry.file_name().to_str().is_some_and(|name| {
            name == "node_modules"
                || name == ".git"
                || name.starts_with(".skillanvil-sync-")
                || name.starts_with(".skillanvil-backup-")
        })
}

fn list_skill_files(dir: &Path) -> AppResult<Vec<SkillFile>> {
    let mut files = Vec::new();
    if !dir.exists() {
        return Ok(files);
    }
    for entry in WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|entry| !is_ignored_dir(entry))
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path == dir {
            continue;
        }
        let relative = path
            .strip_prefix(dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if relative.starts_with(".skillanvil") {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|err| AppError::Message(err.to_string()))?;
        files.push(SkillFile {
            relative_path: relative,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            updated_at: metadata
                .modified()
                .ok()
                .map(format_time)
                .unwrap_or_else(now),
        });
    }
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

fn secure_join(root: &str, relative: &str) -> AppResult<PathBuf> {
    let root = PathBuf::from(root).canonicalize()?;
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::Message("非法文件路径。".into()));
    }

    let mut path = root.clone();
    for part in relative.components() {
        let Component::Normal(segment) = part else {
            return Err(AppError::Message("非法文件路径。".into()));
        };
        path.push(segment);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AppError::Message("拒绝访问符号链接文件。".into()));
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }

    let parent = path.parent().unwrap_or(&path).canonicalize()?;
    if !parent.starts_with(&root) {
        return Err(AppError::Message("非法文件路径。".into()));
    }
    if path.exists() && !path.canonicalize()?.starts_with(&root) {
        return Err(AppError::Message("非法文件路径。".into()));
    }
    Ok(path)
}

/// Decide whether a new snapshot is warranted. `prev` is the latest snapshot
/// for the same file as `(content, created_at_rfc3339)`.
/// 规则：无 prev → 建；内容与 prev 完全相同 → 不建；非空白字符数变化率
/// >= 5% → 建；否则（等长/小改写）仅当最近快照距 `now` 超过 10 分钟才建，
/// 保证等量改写不会永远失去快照保护。
fn should_snapshot(prev: Option<(&str, &str)>, content: &str, now: DateTime<Utc>) -> bool {
    let Some((prev_content, prev_created_at)) = prev else {
        return true;
    };
    if content == prev_content {
        return false;
    }
    let prev_chars = prev_content.chars().filter(|c| !c.is_whitespace()).count();
    let curr_chars = content.chars().filter(|c| !c.is_whitespace()).count();
    let max_len = prev_chars.max(curr_chars).max(1);
    let diff = prev_chars.abs_diff(curr_chars);
    if (diff as f64 / max_len as f64) >= 0.05 {
        return true;
    }
    match DateTime::parse_from_rfc3339(prev_created_at) {
        Ok(created) => {
            now.signed_duration_since(created.with_timezone(&Utc)) > chrono::Duration::minutes(10)
        }
        // 时间戳损坏时宁可多建一次快照，也不要静默丢失保护。
        Err(_) => true,
    }
}

fn create_snapshot_if_needed(
    conn: &Connection,
    data_dir: &Path,
    skill_id: &str,
    relative_path: &str,
    content: &str,
) -> AppResult<()> {
    let settings = load_settings(&data_dir.join("skillanvil.sqlite3"))?;
    if !settings.snapshots_enabled || content.trim().is_empty() {
        return Ok(());
    }
    let last: Option<(String, String)> = conn
        .query_row(
            "select content, created_at from snapshots where skill_id = ?1 and file_path = ?2 order by created_at desc limit 1",
            params![skill_id, relative_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if !should_snapshot(
        last.as_ref()
            .map(|(prev, created_at)| (prev.as_str(), created_at.as_str())),
        content,
        Utc::now(),
    ) {
        return Ok(());
    }
    conn.execute(
        "insert into snapshots(id, skill_id, file_path, content, created_at) values(?1, ?2, ?3, ?4, ?5)",
        params![Uuid::new_v4().to_string(), skill_id, relative_path, content, now()],
    )?;
    let mut stmt = conn.prepare(
        "select id from snapshots where skill_id = ?1 and file_path = ?2 order by created_at desc limit -1 offset 20",
    )?;
    let old_ids = stmt
        .query_map(params![skill_id, relative_path], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for id in old_ids {
        conn.execute("delete from snapshots where id = ?1", params![id])?;
    }
    Ok(())
}

fn validate_name(name: &str) -> AppResult<()> {
    let trimmed = name.trim();
    let upper_stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let windows_reserved = matches!(upper_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper_stem.len() == 4
            && (upper_stem.starts_with("COM") || upper_stem.starts_with("LPT"))
            && upper_stem
                .as_bytes()
                .last()
                .is_some_and(|digit| matches!(digit, b'1'..=b'9')));
    if trimmed.is_empty()
        || trimmed != name
        || matches!(trimmed, "." | "..")
        || name.len() > 200
        || name.chars().any(char::is_control)
        || name.ends_with([' ', '.'])
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || windows_reserved
    {
        return Err(AppError::Message(
            "Skill 名称为空、过长，或包含路径/系统非法字符。".into(),
        ));
    }
    Ok(())
}

fn rewrite_skill_identity(content: &str, new_name: &str) -> String {
    // JSON string literals are valid YAML scalars and safely preserve spaces,
    // `#`, quotes, and other characters without creating new frontmatter keys.
    let yaml_name = serde_json::to_string(new_name).unwrap_or_else(|_| "\"skill\"".into());
    if !content.starts_with("---") {
        return format!("---\nname: {yaml_name}\ndisplayName: {yaml_name}\n---\n\n{content}");
    }
    let Some(end) = content[3..].find("\n---") else {
        return format!("---\nname: {yaml_name}\ndisplayName: {yaml_name}\n---\n\n{content}");
    };
    let frontmatter_end = end + 3;
    let frontmatter = &content[3..frontmatter_end];
    let rest = &content[(frontmatter_end + 4)..];
    let mut has_name = false;
    let mut has_display_name = false;
    let mut lines = Vec::new();
    for line in frontmatter.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("name:") {
            has_name = true;
            lines.push(format!("name: {yaml_name}"));
        } else if trimmed.starts_with("displayName:") || trimmed.starts_with("display_name:") {
            has_display_name = true;
            lines.push(format!("displayName: {yaml_name}"));
        } else {
            lines.push(line.to_string());
        }
    }
    if !has_name {
        lines.insert(0, format!("name: {yaml_name}"));
    }
    if !has_display_name {
        let insert_at = if has_name { 1 } else { lines.len().min(1) };
        lines.insert(insert_at, format!("displayName: {yaml_name}"));
    }
    format!("---\n{}\n---{}", lines.join("\n"), rest)
}

fn resolved_path_for_comparison(path: &Path) -> AppResult<PathBuf> {
    if path.exists() {
        return Ok(path.canonicalize()?);
    }
    let mut ancestor = path;
    let mut missing = Vec::new();
    while !ancestor.exists() {
        missing.push(
            ancestor
                .file_name()
                .ok_or_else(|| AppError::Message("无法解析目标目录。".into()))?
                .to_owned(),
        );
        ancestor = ancestor
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| AppError::Message("目标 Skill 根目录必须是绝对路径。".into()))?;
    }
    let mut resolved = ancestor.canonicalize()?;
    for segment in missing.into_iter().rev() {
        resolved.push(segment);
    }
    Ok(resolved)
}

fn replace_skill_directory(source: &Path, target: &Path) -> AppResult<()> {
    ensure_disjoint_paths(source, target)?;
    if fs::symlink_metadata(target)
        .is_ok_and(|meta| meta.file_type().is_symlink() || !meta.is_dir())
    {
        return Err(AppError::Message(
            "目标不是普通 Skill 目录，已拒绝覆盖。".into(),
        ));
    }
    let expected = if target.exists() {
        Some(hash_dir(target)?)
    } else {
        None
    };
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Message("无法解析目标目录。".into()))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".skillanvil-sync-{}", Uuid::new_v4()));
    let backup = parent.join(format!(".skillanvil-backup-{}", Uuid::new_v4()));
    // Complete the copy before moving the old directory, so malformed sources
    // or IO failures never discard the previous target.
    if let Err(error) = copy_dir_all(source, &staging) {
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        return Err(error);
    }
    let result = (|| -> AppResult<()> {
        let current = if target.exists() {
            Some(hash_dir(target)?)
        } else {
            None
        };
        if current != expected
            || fs::symlink_metadata(target).is_ok_and(|meta| meta.file_type().is_symlink())
        {
            return Err(AppError::Message(
                "目标 Skill 已被外部修改，已取消同步。".into(),
            ));
        }
        if expected.is_some() {
            fs::rename(target, &backup)?;
        }
        if let Err(error) = fs::rename(&staging, target) {
            if backup.exists() {
                if let Err(restore_error) = fs::rename(&backup, target) {
                    return Err(AppError::Message(format!(
                        "同步失败：{error}；原目录保存在 {}，恢复失败：{restore_error}",
                        backup.display()
                    )));
                }
            }
            return Err(error.into());
        }
        if backup.exists() {
            trash::delete(&backup).map_err(|error| {
                AppError::Message(format!(
                    "同步已写入；旧副本保留在 {}，移入回收站失败：{error}",
                    backup.display()
                ))
            })?;
        }
        Ok(())
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn ensure_disjoint_paths(source: &Path, target: &Path) -> AppResult<()> {
    let source = source.canonicalize()?;
    let target = resolved_path_for_comparison(target)?;
    if source == target || source.starts_with(&target) || target.starts_with(&source) {
        return Err(AppError::Message(
            "源 Skill 与目标目录重叠，已拒绝同步以防止数据丢失。".into(),
        ));
    }
    Ok(())
}

fn copy_dir_all(source: &Path, target: &Path) -> AppResult<()> {
    // A skill root may be an installer-created symlink. Resolve only that root;
    // links inside the bundle remain prohibited by the checks below.
    let resolved_source = source.canonicalize()?;
    let source = resolved_source.as_path();
    ensure_disjoint_paths(source, target)?;
    if fs::symlink_metadata(target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::Message("拒绝复制到符号链接目录。".into()));
    }
    let entries = WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| AppError::Message(format!("无法读取 Skill 目录：{err}")))?;
    for entry in &entries {
        let file_type = entry.file_type();
        if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
            return Err(AppError::Message(format!(
                "Skill 包含不安全的链接或特殊文件，已拒绝复制：{}",
                entry.path().display()
            )));
        }
    }

    fs::create_dir_all(target)?;
    for entry in entries {
        let src = entry.path();
        let dst = target.join(src.strip_prefix(source).unwrap());
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dst)?;
        } else {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(src, dst)?;
        }
    }
    Ok(())
}

fn show_path_in_file_manager(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        // explorer.exe 即使成功打开窗口也会返回退出码 1（本机实测），
        // 因此不能用退出码判断成败：spawn 成功即视为成功。
        Command::new("explorer.exe")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .spawn()?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open").arg("-R").arg(path).status()?;
        if !status.success() {
            return Err(AppError::Message("无法启动 Finder。".into()));
        }
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let open_path = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        let status = Command::new("xdg-open").arg(open_path).status()?;
        if !status.success() {
            return Err(AppError::Message("无法启动文件管理器。".into()));
        }
        return Ok(());
    }
}

fn open_external_url(url: &str) -> AppResult<()> {
    // Delegate to the `open` crate, which invokes the platform launcher safely
    // (ShellExecuteW on Windows) instead of routing an untrusted URL through
    // `cmd /C start`, where shell metacharacters (`&`, `|`, …) could inject
    // commands. The caller (`open_url`) already restricts the scheme to http(s).
    open::that(url).map_err(|err| AppError::Message(format!("无法打开链接：{err}")))
}

fn hash_dir(path: &Path) -> AppResult<String> {
    let mut hasher = Sha256::new();
    let mut files = WalkDir::new(path)
        .into_iter()
        .filter_entry(|entry| !is_ignored_dir(entry))
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().to_path_buf())
        .collect::<Vec<_>>();
    files.sort();
    for file in files {
        hasher.update(
            file.strip_prefix(path)
                .unwrap_or(&file)
                .to_string_lossy()
                .as_bytes(),
        );
        hasher.update(fs::read(file)?);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn stable_id(agent_id: &str, dir: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(agent_id.as_bytes());
    hasher.update(dir.to_string_lossy().to_lowercase().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn file_updated_at(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .map(format_time)
        .unwrap_or_else(now)
}

fn format_time(time: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn harness_fixture() -> (PathBuf, Agent, Skill) {
        let base = std::env::temp_dir().join(format!("skillanvil-harness-{}", Uuid::new_v4()));
        let root = base.join("source");
        let directory = root.join("bundle").join("test-skill");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("SKILL.md"),
            "---\nname: test-skill\ndescription: Test harness discovery.\n---\n\n# Test\n",
        )
        .unwrap();
        let agent = Agent {
            id: "codex".into(),
            name: "Codex".into(),
            skill_dir_paths: vec![root.to_string_lossy().into()],
            icon: "codex".into(),
            detected_at: now(),
        };
        let skill = scan_one_skill(&agent, &directory).unwrap();
        (base, agent, skill)
    }

    #[test]
    fn catalog_only_registers_harnesses_with_native_roots() {
        let configs = default_agent_configs();
        assert_eq!(configs.len(), 33);
        assert!(!configs
            .iter()
            .any(|entry| entry.id == "aider" || entry.id == "workbuddy"));
        assert!(configs.iter().all(|entry| !entry.paths.is_empty()));
        let ids: HashSet<_> = configs.iter().map(|entry| &entry.id).collect();
        assert_eq!(ids.len(), configs.len());
        assert_eq!(
            configs
                .iter()
                .find(|entry| entry.id == "kimi-code-cli")
                .unwrap()
                .paths[0],
            "$KIMI_CODE_HOME/skills"
        );
        assert_eq!(
            configs
                .iter()
                .find(|entry| entry.id == "opencode")
                .unwrap()
                .paths[0],
            "$XDG_CONFIG_HOME/opencode/skills"
        );
    }

    #[test]
    fn official_documentation_links_remain_restricted() {
        for entry in harness_catalog() {
            let url = validate_outbound_url(&entry.docs, false).unwrap();
            assert!(trusted_external_url(&url), "{}", entry.id);
        }
        for url in [
            "https://example.com/",
            "https://kiro.dev/other-page",
            "https://kiro.dev/docs/skills/?redirect=example.com",
            "https://github.com.example.com/",
            "http://github.com/",
            "https://user:pass@github.com/",
        ] {
            assert!(!trusted_external_url(&reqwest::Url::parse(url).unwrap()));
        }
        assert!(trusted_external_url(
            &reqwest::Url::parse("https://github.com/SkillAnvil/SkillAnvil/releases").unwrap()
        ));
    }

    #[test]
    fn current_and_legacy_kimi_roots_are_distinct() {
        let home = std::env::temp_dir().join("kimi-home");
        let custom = home.join("isolated");
        assert_eq!(
            PathBuf::from(expand_skill_root_with(
                "$KIMI_CODE_HOME/skills",
                &home,
                |_| None
            )),
            home.join(".kimi-code/skills")
        );
        assert_eq!(
            PathBuf::from(expand_skill_root_with(
                "$KIMI_CODE_HOME/skills",
                &home,
                |_| { Some(custom.to_string_lossy().into()) }
            )),
            custom.join("skills")
        );
        let catalog = harness_catalog();
        assert_eq!(
            catalog
                .iter()
                .find(|item| item.id == "kimi-cli-legacy")
                .unwrap()
                .paths[0],
            "~/.kimi/skills"
        );
    }

    #[test]
    fn devin_cli_uses_appdata_only_on_windows() {
        for (windows, expected) in [
            (true, "$APPDATA/devin/skills"),
            (false, "$XDG_CONFIG_HOME/devin/skills"),
        ] {
            let configs = default_agent_configs_for_platform(windows);
            assert_eq!(
                configs
                    .iter()
                    .find(|entry| entry.id == "devin-cli")
                    .unwrap()
                    .paths[0],
                expected
            );
        }
    }

    #[test]
    fn exact_legacy_defaults_migrate_but_user_paths_survive() {
        let mut settings = default_settings();
        let kimi = settings
            .custom_agents
            .iter_mut()
            .find(|entry| entry.id == "kimi-code-cli")
            .unwrap();
        kimi.paths = vec!["~/.kimi-code/skills".into()];
        kimi.enabled = true;
        let result = normalize_settings(settings);
        let kimi = result
            .custom_agents
            .iter()
            .find(|entry| entry.id == "kimi-code-cli")
            .unwrap();
        assert_eq!(kimi.paths[0], "$KIMI_CODE_HOME/skills");
        assert!(kimi.enabled);
        let mut customized = result.clone();
        let kimi = customized
            .custom_agents
            .iter_mut()
            .find(|entry| entry.id == "kimi-code-cli")
            .unwrap();
        kimi.paths = vec!["~/team/skills".into(), "~/.kimi-code/skills".into()];
        let result = normalize_settings(customized);
        assert_eq!(
            result
                .custom_agents
                .iter()
                .find(|entry| entry.id == "kimi-code-cli")
                .unwrap()
                .paths,
            vec!["~/team/skills", "~/.kimi-code/skills"]
        );
    }

    #[test]
    fn path_variables_resolve_overrides_and_safe_defaults() {
        let home = std::env::temp_dir().join("harness-home");
        let custom = std::env::temp_dir().join("custom-config");
        assert_eq!(
            PathBuf::from(expand_skill_root_with(
                "$XDG_CONFIG_HOME/opencode/skills",
                &home,
                |_| None
            )),
            home.join(".config/opencode/skills")
        );
        assert_eq!(
            PathBuf::from(expand_skill_root_with("$CODEX_HOME/skills", &home, |_| {
                Some(custom.to_string_lossy().into())
            })),
            custom.join("skills")
        );
        assert_eq!(
            PathBuf::from(expand_skill_root_with("$CODEX_HOME/skills", &home, |_| {
                Some("relative".into())
            })),
            home.join(".codex/skills")
        );
        assert_eq!(
            expand_skill_root_with("$API_KEY/skills", &home, |_| panic!(
                "must not read arbitrary env"
            )),
            "$API_KEY/skills"
        );
    }

    #[test]
    fn scan_root_deduplication_preserves_sync_priority() {
        let home = std::env::temp_dir().join("harness-home");
        let roots = resolved_skill_roots(
            &[
                "~/.kimi/skills".into(),
                "".into(),
                "~/.agents/skills".into(),
                "~/.kimi/skills".into(),
            ],
            &home,
        );
        assert_eq!(
            roots,
            vec![
                home.join(".kimi/skills").to_string_lossy(),
                home.join(".agents/skills").to_string_lossy()
            ]
        );
    }

    #[test]
    fn flat_harness_sync_is_discoverable_by_direct_child_glob() {
        let (base, source, skill) = harness_fixture();
        let mut target = source.clone();
        target.id = "opencode".into();
        target.skill_dir_paths = vec![base.join("target").to_string_lossy().into()];
        let path = sync_destination(&skill, &source, &target).unwrap();
        assert_eq!(path, base.join("target/test-skill"));
        validate_harness_skill(&skill, &target).unwrap();
        replace_skill_directory(Path::new(&skill.dir_path), &path).unwrap();
        assert!(base.join("target/test-skill/SKILL.md").is_file());
        assert!(!base.join("target/bundle/test-skill").exists());
        target.id = "hermes-agent".into();
        assert_eq!(
            sync_destination(&skill, &source, &target).unwrap(),
            base.join("target/bundle/test-skill")
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn shared_skill_root_is_a_noop_and_empty_targets_are_rejected() {
        let (base, source, skill) = harness_fixture();
        let mut target = source.clone();
        target.id = "hermes-agent".into();
        let path = sync_destination(&skill, &source, &target).unwrap();
        assert!(same_skill_directory(Path::new(&skill.dir_path), &path));
        target.skill_dir_paths = vec!["".into()];
        assert!(sync_destination(&skill, &source, &target).is_err());
        assert!(Path::new(&skill.dir_path).join("SKILL.md").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn portable_harness_rejects_missing_metadata_before_copying() {
        let (base, source, skill) = harness_fixture();
        let mut target = source.clone();
        target.id = "opencode".into();
        fs::write(
            Path::new(&skill.dir_path).join("SKILL.md"),
            "# Plain Markdown",
        )
        .unwrap();
        assert!(validate_harness_skill(&skill, &target).is_err());
        assert!(!base.join("target").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn overlap_is_rejected_without_creating_missing_ancestors() {
        let (base, _, skill) = harness_fixture();
        let source = Path::new(&skill.dir_path);
        let target = source.join("missing/nested/target");
        assert!(ensure_disjoint_paths(source, &target).is_err());
        assert!(!source.join("missing").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(windows)]
    fn link_test_directory(link: &Path, target: &Path) {
        use std::os::windows::process::CommandExt;
        let output = Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success(), "junction creation failed");
    }
    #[cfg(unix)]
    fn link_test_directory(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn linked_bundle_is_discovered_and_can_be_copied() {
        let (base, _, skill) = harness_fixture();
        let root = base.join("linked-root");
        fs::create_dir_all(&root).unwrap();
        let link = root.join("test-skill");
        link_test_directory(&link, Path::new(&skill.dir_path));
        let (dirs, errors) = discover_skill_directories(&root);
        assert!(errors.is_empty());
        assert_eq!(dirs, vec![link.clone()]);
        copy_dir_all(&link, &base.join("copy")).unwrap();
        assert!(base.join("copy/SKILL.md").is_file());
        assert!(same_skill_directory(&link, Path::new(&skill.dir_path)));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn failed_copy_preserves_existing_target_and_recovery_dirs_are_not_scanned() {
        let (base, _, skill) = harness_fixture();
        let target = base.join("target/test-skill");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "original target").unwrap();
        link_test_directory(&Path::new(&skill.dir_path).join("unsafe-link"), &target);
        assert!(replace_skill_directory(Path::new(&skill.dir_path), &target).is_err());
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "original target"
        );
        let backup = base.join("target/.skillanvil-backup-test");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("SKILL.md"), "old backup").unwrap();
        assert_eq!(
            discover_skill_directories(&base.join("target")).0,
            vec![target]
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn compare_versions_orders_semver() {
        use std::cmp::Ordering;
        assert_eq!(compare_versions("1.2.0", "1.1.9"), Ordering::Greater);
        assert_eq!(compare_versions("0.1.0", "0.1.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.1"), Ordering::Less);
        // Missing trailing components are treated as zero.
        assert_eq!(compare_versions("2", "2.0.0"), Ordering::Equal);
    }

    #[test]
    fn line_similarity_detects_identical_and_disjoint() {
        let a = "alpha\nbeta\ngamma";
        assert!((line_similarity(a, a) - 1.0).abs() < 1e-9);
        assert_eq!(line_similarity("alpha\nbeta", "x\ny\nz"), 0.0);
        assert_eq!(line_similarity("", "anything"), 0.0);
    }

    #[test]
    fn parse_frontmatter_extracts_metadata_and_body() {
        let doc = "---\nname: my-skill\nversion: 0.2.0\n---\n\n# Title\nbody";
        let (meta, body) = parse_frontmatter(doc);
        assert_eq!(meta.get("name").and_then(|v| v.as_str()), Some("my-skill"));
        assert!(body.starts_with("# Title"));
    }

    #[test]
    fn parse_frontmatter_passes_through_plain_markdown() {
        let doc = "# No frontmatter\ntext";
        let (meta, body) = parse_frontmatter(doc);
        assert!(meta.is_empty());
        assert_eq!(body, doc);
    }

    #[test]
    fn validate_name_rejects_path_separators() {
        assert!(validate_name("good-name").is_ok());
        assert!(validate_name("../escape").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name(".").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("line\nbreak").is_err());
        assert!(validate_name(" trailing-space ").is_err());
        assert!(validate_name("   ").is_err());
    }

    #[test]
    fn scan_rejects_unsafe_frontmatter_name() {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        let skill_dir = base.join("malicious-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: ../../outside\n---\n\n# Unsafe\n",
        )
        .unwrap();
        let agent = Agent {
            id: "test-agent".into(),
            name: "Test Agent".into(),
            skill_dir_paths: vec![base.to_string_lossy().to_string()],
            icon: "test".into(),
            detected_at: now(),
        };

        assert!(scan_one_skill(&agent, &skill_dir).is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn expand_home_path_resolves_tilde() {
        let home = Path::new("/home/alice");
        assert_eq!(PathBuf::from(expand_home_path("~", home)), home);
        assert_eq!(
            PathBuf::from(expand_home_path("~/.config/x", home)),
            home.join(".config/x")
        );
        assert_eq!(
            PathBuf::from(expand_home_path("/abs/path", home)),
            PathBuf::from("/abs/path")
        );
    }

    #[test]
    fn rewrite_skill_identity_updates_name_fields() {
        let original = "---\nname: old\ndisplayName: Old\ndescription: keep\n---\n\nbody";
        let out = rewrite_skill_identity(original, "fresh");
        assert!(out.contains("name: \"fresh\""));
        assert!(out.contains("displayName: \"fresh\""));
        assert!(out.contains("description: keep"));
        assert!(out.trim_end().ends_with("body"));
    }

    #[test]
    fn truncate_str_appends_ellipsis_when_clipping() {
        assert_eq!(truncate_str("hi", 10), "hi");
        assert_eq!(truncate_str("hello world", 5).chars().count(), 6);
    }

    #[test]
    fn outbound_url_policy_requires_encryption_or_loopback() {
        assert!(validate_outbound_url("https://api.example.com/v1", true).is_ok());
        assert!(validate_outbound_url("http://localhost:11434/v1", true).is_ok());
        assert!(validate_outbound_url("http://127.0.0.1:8080", true).is_ok());
        assert!(validate_outbound_url("http://[::1]:8080", true).is_ok());
        assert!(validate_outbound_url("http://api.example.com/v1", true).is_err());
        assert!(validate_outbound_url("https://user:pass@example.com", true).is_err());
        assert!(validate_outbound_url("file:///tmp/secret", true).is_err());
        // External links are stricter than explicitly configured local APIs.
        assert!(validate_outbound_url("http://localhost:8080", false).is_err());
    }

    #[test]
    fn masked_api_key_is_reused_only_for_the_same_endpoint() {
        let current = TranslationConfig {
            protocol: "openai".into(),
            base_url: "https://api.example.com/v1/".into(),
            api_key: "secret".into(),
            model: "old-model".into(),
            target_lang: "zh-CN".into(),
        };
        let mut same_endpoint = TranslationConfig {
            protocol: "OPENAI".into(),
            base_url: "https://api.example.com/v1".into(),
            api_key: MASKED_API_KEY.into(),
            model: "new-model".into(),
            target_lang: "ja".into(),
        };
        reconcile_masked_api_key(&current, &mut same_endpoint);
        assert_eq!(same_endpoint.api_key, "secret");

        let mut changed_endpoint = same_endpoint.clone();
        changed_endpoint.api_key = MASKED_API_KEY.into();
        changed_endpoint.base_url = "https://attacker.example/v1".into();
        reconcile_masked_api_key(&current, &mut changed_endpoint);
        assert!(changed_endpoint.api_key.is_empty());
    }

    #[test]
    fn saving_agent_flags_does_not_reregister_an_unchanged_shortcut() {
        let base = std::env::temp_dir().join(format!("skillanvil-settings-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let db = base.join("test.sqlite3");
        init_db(&db).unwrap();
        let mut current = load_settings(&db).unwrap();
        current.translation.api_key = "fixture-api-key".into();
        open_db(&db).unwrap().execute(
            "insert into settings(key, value) values('settings', ?1) on conflict(key) do update set value = excluded.value",
            params![serde_json::to_string(&current).unwrap()],
        ).unwrap();

        for enabled in [true, false] {
            let mut incoming = redact_settings(load_settings(&db).unwrap());
            incoming
                .custom_agents
                .iter_mut()
                .find(|agent| agent.id == "qwen-code")
                .unwrap()
                .enabled = enabled;
            let response = persist_settings(&db, incoming, |_| {
                Err(AppError::Message("fixture hotkey is occupied".into()))
            })
            .expect("agent changes must save without registering the unchanged shortcut");
            assert_eq!(
                response
                    .custom_agents
                    .iter()
                    .find(|agent| agent.id == "qwen-code")
                    .unwrap()
                    .enabled,
                enabled
            );
            assert_eq!(response.translation.api_key, MASKED_API_KEY);
            let stored = load_settings(&db).unwrap();
            assert_eq!(
                stored
                    .custom_agents
                    .iter()
                    .find(|agent| agent.id == "qwen-code")
                    .unwrap()
                    .enabled,
                enabled
            );
            assert_eq!(stored.translation.api_key, "fixture-api-key");
            assert_eq!(stored.shortcut, current.shortcut);
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_changed_shortcut_is_registered_and_failure_preserves_settings() {
        let base = std::env::temp_dir().join(format!("skillanvil-settings-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let db = base.join("test.sqlite3");
        init_db(&db).unwrap();
        let current = load_settings(&db).unwrap();
        let mut incoming = current.clone();
        incoming.shortcut = "Ctrl+Shift+L".into();
        incoming
            .custom_agents
            .iter_mut()
            .find(|agent| agent.id == "qwen-code")
            .unwrap()
            .enabled = true;
        let mut called = false;
        let result = persist_settings(&db, incoming.clone(), |shortcut| {
            called = true;
            assert_eq!(shortcut, "Ctrl+Shift+L");
            Err(AppError::Message("fixture hotkey is occupied".into()))
        });
        assert!(called);
        assert!(result.is_err());
        assert_eq!(
            serde_json::to_value(load_settings(&db).unwrap()).unwrap(),
            serde_json::to_value(&current).unwrap()
        );
        let response = persist_settings(&db, incoming, |shortcut| {
            assert_eq!(shortcut, "Ctrl+Shift+L");
            Ok(())
        })
        .unwrap();
        assert_eq!(response.shortcut, "Ctrl+Shift+L");
        assert!(
            load_settings(&db)
                .unwrap()
                .custom_agents
                .iter()
                .find(|agent| agent.id == "qwen-code")
                .unwrap()
                .enabled
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pick_asset_falls_back_to_first_download_url() {
        let release = serde_json::json!({
            "assets": [
                { "name": "notes.txt", "browser_download_url": "https://example.com/notes.txt" }
            ]
        });
        assert_eq!(pick_asset(&release), "https://example.com/notes.txt");
        let empty = serde_json::json!({ "assets": [] });
        assert_eq!(pick_asset(&empty), "");
    }

    #[test]
    fn extract_api_error_reads_json_message() {
        let status = reqwest::StatusCode::TOO_MANY_REQUESTS;
        let msg = extract_api_error(
            status,
            "application/json",
            r#"{"error":{"message":"rate limited"}}"#,
        );
        assert!(msg.contains("rate limited"));
    }

    #[test]
    fn secure_join_rejects_parent_traversal() {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let root = base.to_string_lossy().to_string();
        // A normal child resolves fine.
        assert!(secure_join(&root, "child.md").is_ok());
        // Escaping the root is rejected.
        assert!(secure_join(&root, "../escape.md").is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn secure_join_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        let root = base.join("root");
        let outside = base.join("outside.md");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, "secret").unwrap();
        symlink(&outside, root.join("linked.md")).unwrap();

        assert!(secure_join(&root.to_string_lossy(), "linked.md").is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn failed_gbk_encoding_preserves_original_file() {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("legacy.md");
        std::fs::write(&path, b"original").unwrap();

        assert!(write_text_file(&path, "emoji: 🙂", "GBK").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_rejects_overlapping_source_and_target() {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        let source = base.join("skill");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "# Test").unwrap();

        assert!(copy_dir_all(&source, &source).is_err());
        assert!(copy_dir_all(&source, &source.join("nested")).is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    // B1 回归：合并内置 agent 设置时必须保留手动分类。
    #[test]
    fn normalize_settings_preserves_builtin_categories() {
        let mut settings = default_settings();
        settings.custom_agents = vec![AgentPathConfig {
            id: "claude-code".into(),
            name: "Claude Code".into(),
            paths: vec!["~/.claude/skills".into()],
            enabled: true,
            builtin: true,
            icon: Some("claude".into()),
            categories: vec![SkillCategory {
                id: "cat-1".into(),
                name: "写作".into(),
                skill_names: vec!["blog-post-writer".into()],
            }],
        }];
        let normalized = normalize_settings(settings);
        let agent = normalized
            .custom_agents
            .iter()
            .find(|agent| agent.id == "claude-code")
            .expect("builtin agent should survive normalization");
        assert_eq!(agent.categories.len(), 1);
        assert_eq!(agent.categories[0].id, "cat-1");
        assert_eq!(agent.categories[0].skill_names, vec!["blog-post-writer"]);
    }

    fn insert_test_skill(conn: &Connection, id: &str) {
        insert_test_skill_at(conn, id, id);
    }

    fn insert_test_skill_at(conn: &Connection, id: &str, dir_path: &str) {
        conn.execute(
            "insert into skills(id, name, display_name, description, version, dir_path, agent_id,
                                source, github_repo, github_branch, last_sync_commit, local_modified, updated_at)
             values(?1, ?1, ?1, '', '0.1.0', ?2, 'agent', 'local', null, null, null, 0, ?3)",
            params![id, dir_path, now()],
        )
        .unwrap();
    }

    // B3 回归：扫描后不在 found 集合中的幽灵 skill 行与孤儿附属数据被清理。
    #[test]
    fn prune_stale_skills_removes_ghosts_and_orphans() {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let db = base.join("test.sqlite3");
        init_db(&db).unwrap();
        let conn = Connection::open(&db).unwrap();

        insert_test_skill(&conn, "keep");
        insert_test_skill(&conn, "ghost");
        conn.execute(
            "insert into skill_state(skill_id, starred) values('ghost', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into skill_tags(skill_id, tag_id) values('ghost', 'writing')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into snapshots(id, skill_id, file_path, content, created_at)
             values('snap', 'ghost', 'SKILL.md', 'x', ?1)",
            params![now()],
        )
        .unwrap();
        conn.execute(
            "insert into skill_provenance(skill_id, status) values('ghost', 'local')",
            [],
        )
        .unwrap();

        prune_stale_skills(&conn, &["keep".to_string()], &[], &[]).unwrap();

        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() };
        assert_eq!(count("select count(*) from skills"), 1);
        assert_eq!(count("select count(*) from skills where id = 'keep'"), 1);
        assert_eq!(count("select count(*) from skill_state"), 0);
        assert_eq!(count("select count(*) from skill_tags"), 0);
        assert_eq!(count("select count(*) from snapshots"), 0);
        assert_eq!(count("select count(*) from skill_provenance"), 0);

        // found 为空且目录确认不在磁盘上时，剩余幽灵行同样被删除。
        prune_stale_skills(&conn, &[], &[], &[]).unwrap();
        assert_eq!(count("select count(*) from skills"), 0);
        std::fs::remove_dir_all(&base).ok();
    }

    // 回归：瞬态条件不得触发删除——目录仍在磁盘上（WalkDir IO 错误被吞掉）、
    // 根目录暂时不可用（网络盘/移动盘未挂载）、SKILL.md 解析失败（scan_errors）
    // 的 skill 行与快照必须保留；只有目录确认消失的行才连同附属数据被清理。
    #[test]
    fn prune_stale_skills_keeps_transient_rows_and_deletes_confirmed_only() {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let db = base.join("test.sqlite3");
        init_db(&db).unwrap();
        let conn = Connection::open(&db).unwrap();

        // 目录仍存在于磁盘（本轮却未扫到）→ 保留。
        let on_disk = base.join("on-disk");
        std::fs::create_dir_all(&on_disk).unwrap();
        insert_test_skill_at(&conn, "on-disk", &on_disk.to_string_lossy());

        // 根目录本轮缺失 → 状态未知，即使目录当前不可达也保留。
        let missing_root = base.join("missing-root");
        let under_missing = missing_root.join("skill-a");
        insert_test_skill_at(&conn, "under-missing", &under_missing.to_string_lossy());

        // 本轮 scan_errors 涉及的路径（文件被占用/乱码/名称非法）→ 保留。
        let err_dir = base.join("err-skill");
        insert_test_skill_at(&conn, "scan-error", &err_dir.to_string_lossy());

        // 目录确认消失 → 删除。
        let gone = base.join("gone");
        insert_test_skill_at(&conn, "gone", &gone.to_string_lossy());

        for id in ["on-disk", "under-missing", "scan-error", "gone"] {
            conn.execute(
                "insert into snapshots(id, skill_id, file_path, content, created_at)
                 values(?1, ?1, 'SKILL.md', 'x', ?2)",
                params![id, now()],
            )
            .unwrap();
        }

        let missing_roots = vec![missing_root.to_string_lossy().to_string()];
        let error_paths = vec![err_dir.join("SKILL.md").to_string_lossy().to_string()];
        prune_stale_skills(&conn, &[], &missing_roots, &error_paths).unwrap();

        let ids = |sql: &str| -> Vec<String> {
            let mut stmt = conn.prepare(sql).unwrap();
            let mut rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows.sort();
            rows
        };
        assert_eq!(
            ids("select id from skills"),
            ["on-disk", "scan-error", "under-missing"]
        );
        assert_eq!(
            ids("select skill_id from snapshots"),
            ["on-disk", "scan-error", "under-missing"]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // 回归：禁用 agent（prune_inactive_agents 删除其 skills 行）后，附属数据
    // 必须保留——id 是确定性 stable_id，重新启用后行重建即自动重挂旧快照。
    #[test]
    fn prune_stale_skills_keeps_orphan_rows_of_disabled_agents() {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let db = base.join("test.sqlite3");
        init_db(&db).unwrap();
        let conn = Connection::open(&db).unwrap();

        // 无对应 skills 行，模拟 prune_inactive_agents 刚删掉禁用 agent 的行。
        conn.execute(
            "insert into skill_state(skill_id, starred) values('disabled-skill', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into snapshots(id, skill_id, file_path, content, created_at)
             values('snap', 'disabled-skill', 'SKILL.md', 'x', ?1)",
            params![now()],
        )
        .unwrap();

        prune_stale_skills(&conn, &[], &[], &[]).unwrap();

        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() };
        assert_eq!(
            count("select count(*) from skill_state where skill_id = 'disabled-skill'"),
            1
        );
        assert_eq!(
            count("select count(*) from snapshots where skill_id = 'disabled-skill'"),
            1
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // path_is_under：分隔符/大小写归一化与分隔符边界。
    #[test]
    fn path_is_under_normalizes_separators_case_and_boundary() {
        assert!(path_is_under(
            "C:/Users/x/skills",
            "c:\\users\\x\\skills\\foo"
        ));
        assert!(path_is_under("D:/alt/skills/", "D:/alt/skills/foo"));
        assert!(path_is_under("D:/alt/skills", "D:/alt/skills"));
        assert!(!path_is_under(
            "C:/Users/x/skills",
            "C:/Users/x/skillsX/foo"
        ));
        assert!(!path_is_under("C:/Users/x/skills/foo", "C:/Users/x/skills"));
        assert!(!path_is_under("", "C:/anything"));
    }

    // B4 回归：嵌套 skill 的相对路径解析。
    #[test]
    fn skill_rel_path_resolves_nested_roots_and_separators() {
        let agent = Agent {
            id: "a".into(),
            name: "A".into(),
            skill_dir_paths: vec!["C:/Users/x/.claude/skills".into(), "D:/alt/skills/".into()],
            icon: "i".into(),
            detected_at: now(),
        };
        // 嵌套命中：返回多段相对路径。
        assert_eq!(
            skill_rel_path(&agent, "C:/Users/x/.claude/skills/gstack/qa").as_deref(),
            Some("gstack/qa")
        );
        // 多 root：第二个 root 命中。
        assert_eq!(
            skill_rel_path(&agent, "D:/alt/skills/foo").as_deref(),
            Some("foo")
        );
        // 反斜杠输入照样命中。
        assert_eq!(
            skill_rel_path(&agent, "C:\\Users\\x\\.claude\\skills\\bar").as_deref(),
            Some("bar")
        );
        // 无前缀 → None（回退平铺）。
        assert_eq!(skill_rel_path(&agent, "E:/elsewhere/foo"), None);
        // 前缀必须落在分隔符边界：skillsX 不应匹配 skills。
        assert_eq!(
            skill_rel_path(&agent, "C:/Users/x/.claude/skillsX/foo"),
            None
        );
    }

    // B5 回归：快照触发策略四个分支。
    #[test]
    fn should_snapshot_covers_all_branches() {
        let now_ts = Utc::now();
        // 无 prev → true。
        assert!(should_snapshot(None, "anything", now_ts));
        // 内容与 prev 完全相同 → false。
        let recent = now_ts.to_rfc3339();
        assert!(!should_snapshot(
            Some(("same", recent.as_str())),
            "same",
            now_ts
        ));
        // 非空白字符数变化率 >= 5% → true。
        assert!(should_snapshot(
            Some(("aaaaaaaaaa", recent.as_str())),
            "aaaa",
            now_ts
        ));
        // 等长改写 + 最近快照 < 10 分钟 → false。
        let five_min_ago = (now_ts - chrono::Duration::minutes(5)).to_rfc3339();
        assert!(!should_snapshot(
            Some(("abcdefghij", five_min_ago.as_str())),
            "abcdefghik",
            now_ts
        ));
        // 等长改写 + 最近快照 > 10 分钟 → true。
        let eleven_min_ago = (now_ts - chrono::Duration::minutes(11)).to_rfc3339();
        assert!(should_snapshot(
            Some(("abcdefghij", eleven_min_ago.as_str())),
            "abcdefghik",
            now_ts
        ));
    }

    // B11 回归：settings.custom_tags 与 tags/skill_tags 双存储的对账。
    #[test]
    fn reconcile_tags_removes_stale_and_applies_renames() {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let db = base.join("test.sqlite3");
        init_db(&db).unwrap();
        let conn = Connection::open(&db).unwrap();

        conn.execute(
            "insert into tags(id, name, color) values('keep', '旧名', '#fff')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into tags(id, name, color) values('stale', '脏', '#000')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into skill_tags(skill_id, tag_id) values('s1', 'keep')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into skill_tags(skill_id, tag_id) values('s1', 'stale')",
            [],
        )
        .unwrap();

        let tags = vec![Tag {
            id: "keep".into(),
            name: "新名".into(),
            color: "#fff".into(),
        }];
        reconcile_tags(&conn, &tags).unwrap();

        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() };
        // 重命名即时生效。
        let name: String = conn
            .query_row("select name from tags where id = 'keep'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "新名");
        // 脏 tag 与其关联被清理，有效关联保留。
        assert_eq!(count("select count(*) from tags where id = 'stale'"), 0);
        assert_eq!(
            count("select count(*) from skill_tags where tag_id = 'stale'"),
            0
        );
        assert_eq!(
            count("select count(*) from skill_tags where tag_id = 'keep'"),
            1
        );

        // 集合为空时清空两表。
        reconcile_tags(&conn, &[]).unwrap();
        assert_eq!(count("select count(*) from tags"), 0);
        assert_eq!(count("select count(*) from skill_tags"), 0);
        std::fs::remove_dir_all(&base).ok();
    }

    fn tag(id: &str, name: &str) -> Tag {
        Tag {
            id: id.into(),
            name: name.into(),
            color: "#fff".into(),
        }
    }

    fn library_fixture() -> (PathBuf, Connection, PathBuf) {
        let base = std::env::temp_dir().join(format!("skillanvil-test-{}", Uuid::new_v4()));
        let shared = base.join("shared-skill");
        fs::create_dir_all(shared.join("references")).unwrap();
        fs::write(shared.join("SKILL.md"), "# shared\n").unwrap();
        fs::write(shared.join("references").join("notes.md"), "notes\n").unwrap();
        let db = base.join("test.sqlite3");
        init_db(&db).unwrap();
        let conn = Connection::open(&db).unwrap();
        (base, conn, shared)
    }

    // 性能回归：find_skill 按 id 直接取一行（含标签与文件），未知 id 报错，
    // 不再借道全量 load_skills（那会遍历所有 Skill 目录）。
    #[test]
    fn find_skill_loads_only_the_requested_row() {
        let (base, mut conn, shared) = library_fixture();
        insert_test_skill_at(&conn, "wanted", &shared.to_string_lossy());
        insert_test_skill_at(&conn, "other", &base.join("missing").to_string_lossy());
        replace_skill_tags(&mut conn, "wanted", &[tag("z", "Zeta"), tag("a", "Alpha")]).unwrap();
        conn.execute(
            "insert into skill_state(skill_id, starred) values('wanted', 1)",
            [],
        )
        .unwrap();

        let skill = find_skill(&conn, "wanted").unwrap();
        assert_eq!(skill.id, "wanted");
        assert!(skill.starred);
        let names: Vec<_> = skill.tags.iter().map(|tag| tag.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Zeta"]);
        let files: Vec<_> = skill
            .files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        assert_eq!(files, ["SKILL.md", "references", "references/notes.md"]);

        let row = find_skill_row(&conn, "wanted").unwrap();
        assert!(row.files.is_empty() && row.tags.is_empty());
        assert!(find_skill(&conn, "nope").is_err());
        assert!(find_skill_row(&conn, "nope").is_err());
        fs::remove_dir_all(&base).ok();
    }

    // 批量加载：标签一次查询按名称排序挂回各 Skill；共享同一目录的多个
    // Skill（不同 Agent 指向同一根目录）都能拿到文件列表。
    #[test]
    fn load_skills_batches_tags_and_lists_shared_directories() {
        let (base, mut conn, shared) = library_fixture();
        insert_test_skill_at(&conn, "first", &shared.to_string_lossy());
        insert_test_skill_at(&conn, "second", &shared.to_string_lossy());
        replace_skill_tags(&mut conn, "first", &[tag("z", "Zeta"), tag("a", "Alpha")]).unwrap();
        replace_skill_tags(&mut conn, "second", &[tag("z", "Zeta")]).unwrap();

        let skills = load_skills(&conn, &SkillFilter::default()).unwrap();
        assert_eq!(skills.len(), 2);
        for skill in &skills {
            assert_eq!(
                skill.files.len(),
                3,
                "{} lists the shared directory",
                skill.id
            );
        }
        let first = skills.iter().find(|skill| skill.id == "first").unwrap();
        let names: Vec<_> = first.tags.iter().map(|tag| tag.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Zeta"]);

        let tagged = load_skills(
            &conn,
            &SkillFilter {
                tag_id: Some("a".into()),
                ..SkillFilter::default()
            },
        )
        .unwrap();
        let ids: Vec<_> = tagged.iter().map(|skill| skill.id.as_str()).collect();
        assert_eq!(ids, ["first"]);

        // A fresh scan hands over its file lists; they are used as-is.
        let mut known = HashMap::new();
        known.insert("first".to_string(), Vec::new());
        let reused = load_skills_with_files(&conn, &SkillFilter::default(), known).unwrap();
        let first = reused.iter().find(|skill| skill.id == "first").unwrap();
        let second = reused.iter().find(|skill| skill.id == "second").unwrap();
        assert!(first.files.is_empty());
        assert_eq!(second.files.len(), 3);
        fs::remove_dir_all(&base).ok();
    }

    // 并发回归：标签替换在一个事务里完成，重复 id 被合并而不是让整批失败。
    #[test]
    fn replace_skill_tags_is_atomic_and_collapses_duplicates() {
        let (base, mut conn, shared) = library_fixture();
        insert_test_skill_at(&conn, "s", &shared.to_string_lossy());
        replace_skill_tags(
            &mut conn,
            "s",
            &[tag("a", "A"), tag("a", "A"), tag("b", "B")],
        )
        .unwrap();
        let count = |conn: &Connection| -> i64 {
            conn.query_row(
                "select count(*) from skill_tags where skill_id = 's'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(count(&conn), 2);
        replace_skill_tags(&mut conn, "s", &[]).unwrap();
        assert_eq!(count(&conn), 0);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn parallel_map_preserves_input_order() {
        let items: Vec<usize> = (0..257).collect();
        let doubled = parallel_map(&items, |value| value * 2);
        assert_eq!(
            doubled,
            items.iter().map(|value| value * 2).collect::<Vec<_>>()
        );
        assert!(parallel_map(&Vec::<usize>::new(), |value| *value).is_empty());
    }
}
