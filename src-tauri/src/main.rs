#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use encoding_rs::{GBK, UTF_8};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
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
            if let Err(err) = setup_tray(app.handle()) {
                eprintln!("[skillanvil] tray setup failed, continuing without it: {err}");
            }
            if let Err(err) = setup_shortcut(app.handle()) {
                eprintln!("[skillanvil] global shortcut registration failed, continuing without it: {err}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let minimize = load_settings(&state.db_path)
                    .map(|settings| settings.minimize_to_tray)
                    .unwrap_or(true);
                if minimize {
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
            translate_markdown,
            translate_stream,
            test_translation_config,
            list_translation_models,
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
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = perform_scan(&state);
                }
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
fn scan_agents(state: State<AppState>) -> AppResult<ScanResult> {
    perform_scan(&state)
}

#[tauri::command]
fn get_agents(state: State<AppState>) -> AppResult<Vec<Agent>> {
    let conn = Connection::open(&state.db_path)?;
    load_agents(&conn)
}

#[tauri::command]
fn get_skills(state: State<AppState>, filter: SkillFilter) -> AppResult<Vec<Skill>> {
    let conn = Connection::open(&state.db_path)?;
    load_skills(&conn, &filter)
}

#[tauri::command]
fn read_skill_file(
    state: State<AppState>,
    skill_id: String,
    relative_path: String,
) -> AppResult<ReadFileResult> {
    let conn = Connection::open(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    let path = secure_join(&skill.dir_path, &relative_path)?;
    read_text_file(&path)
}

#[tauri::command]
fn save_skill_file(
    state: State<AppState>,
    skill_id: String,
    relative_path: String,
    content: String,
    expected_encoding: String,
) -> AppResult<ReadFileResult> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("Lock poisoned".into()))?;
    if contains_mojibake(&content) {
        return Err(AppError::Message("检测到疑似乱码内容，已拒绝写入。".into()));
    }
    let conn = Connection::open(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    let path = secure_join(&skill.dir_path, &relative_path)?;
    let current = read_text_file(&path)?;
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

#[tauri::command]
fn clone_skill(state: State<AppState>, skill_id: String, new_name: String) -> AppResult<Skill> {
    let conn = Connection::open(&state.db_path)?;
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

#[tauri::command]
fn get_sync_targets(state: State<AppState>, skill_id: String) -> AppResult<Vec<SyncTargetStatus>> {
    let conn = Connection::open(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    let source_hash = hash_dir(Path::new(&skill.dir_path))?;
    let mut result = Vec::new();
    for agent in load_agents(&conn)? {
        if agent.id == skill.agent_id {
            continue;
        }
        let target_root = agent.skill_dir_paths.first().cloned().unwrap_or_default();
        let target = Path::new(&target_root).join(&skill.name);
        let status = if !target.exists() {
            "missing"
        } else if hash_dir(&target)? == source_hash {
            "same"
        } else {
            "different"
        };
        result.push(SyncTargetStatus {
            agent_id: agent.id,
            agent_name: agent.name,
            target_path: target.to_string_lossy().to_string(),
            status: status.into(),
        });
    }
    Ok(result)
}

#[tauri::command]
fn sync_skill(
    state: State<AppState>,
    skill_id: String,
    target_agent_ids: Vec<String>,
) -> AppResult<Vec<Skill>> {
    let conn = Connection::open(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    for agent_id in target_agent_ids {
        let agent = find_agent(&conn, &agent_id)?;
        let root = agent
            .skill_dir_paths
            .first()
            .ok_or_else(|| AppError::Message("目标 Agent 没有可写路径。".into()))?;
        fs::create_dir_all(root)?;
        let target = Path::new(root).join(&skill.name);
        if target.exists() {
            trash::delete(&target).map_err(|err| AppError::Message(err.to_string()))?;
        }
        copy_dir_all(Path::new(&skill.dir_path), &target)?;
        conn.execute(
            "insert into sync_logs(id, skill_id, target_agent_id, created_at) values(?1, ?2, ?3, ?4)",
            params![Uuid::new_v4().to_string(), skill_id, agent.id, now()],
        )?;
    }
    perform_scan(&state).map(|result| result.skills)
}

#[tauri::command]
fn trash_skill(state: State<AppState>, skill_id: String, agent_ids: Vec<String>) -> AppResult<()> {
    let conn = Connection::open(&state.db_path)?;
    let skill = find_skill(&conn, &skill_id)?;
    if !agent_ids.contains(&skill.agent_id) {
        return Ok(());
    }
    trash::delete(&skill.dir_path).map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute("delete from skills where id = ?1", params![skill_id])?;
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

#[tauri::command]
fn open_url(url: String) -> AppResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::Message("仅支持打开 http(s) 链接。".into()));
    }
    open_external_url(&url)
}

#[tauri::command]
fn star_skill(state: State<AppState>, skill_id: String, starred: bool) -> AppResult<Skill> {
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "insert into skill_state(skill_id, starred) values(?1, ?2)
         on conflict(skill_id) do update set starred = excluded.starred",
        params![skill_id, starred],
    )?;
    find_skill(&conn, &skill_id)
}

#[tauri::command]
fn set_skill_tags(state: State<AppState>, skill_id: String, tags: Vec<Tag>) -> AppResult<Skill> {
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "delete from skill_tags where skill_id = ?1",
        params![skill_id],
    )?;
    for tag in tags {
        conn.execute(
            "insert into tags(id, name, color) values(?1, ?2, ?3)
             on conflict(id) do update set name = excluded.name, color = excluded.color",
            params![tag.id, tag.name, tag.color],
        )?;
        conn.execute(
            "insert into skill_tags(skill_id, tag_id) values(?1, ?2)",
            params![skill_id, tag.id],
        )?;
    }
    find_skill(&conn, &skill_id)
}

#[tauri::command]
fn get_provenance(state: State<AppState>) -> AppResult<Vec<SkillProvenance>> {
    let conn = Connection::open(&state.db_path)?;
    load_provenance(&conn)
}

#[tauri::command]
async fn trace_skill_provenance(
    state: State<'_, AppState>,
    skill_ids: Vec<String>,
) -> AppResult<Vec<SkillProvenance>> {
    // Resolve (id, name, local SKILL.md) up front, then release the DB connection.
    let targets: Vec<(String, String, String)> = {
        let conn = Connection::open(&state.db_path)?;
        let all = load_skills(&conn, &SkillFilter::default())?;
        skill_ids
            .iter()
            .filter_map(|id| all.iter().find(|s| &s.id == id))
            .map(|s| {
                let local_md = read_text_file(&Path::new(&s.dir_path).join("SKILL.md"))
                    .map(|f| f.content)
                    .unwrap_or_default();
                (s.id.clone(), s.name.clone(), local_md)
            })
            .collect()
    };

    let client = reqwest::Client::new();
    let mut results = Vec::with_capacity(targets.len());
    let last = targets.len().saturating_sub(1);
    for (index, (id, name, local_md)) in targets.into_iter().enumerate() {
        let prov = trace_one_provenance(&client, &id, &name, &local_md).await;
        // Best-effort persist: a transient DB lock must not abort the whole batch.
        if let Ok(conn) = Connection::open(&state.db_path) {
            let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
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
    let value: serde_json::Value = res.json().await?;
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
                if let Ok(text) = res.text().await {
                    return Some(text);
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

#[tauri::command]
fn get_snapshots(state: State<AppState>, skill_id: String) -> AppResult<Vec<Snapshot>> {
    let conn = Connection::open(&state.db_path)?;
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

#[tauri::command]
fn restore_snapshot(state: State<AppState>, snapshot_id: String) -> AppResult<ReadFileResult> {
    let conn = Connection::open(&state.db_path)?;
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

#[tauri::command]
fn get_settings(state: State<AppState>) -> AppResult<Settings> {
    load_settings(&state.db_path)
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: Settings,
) -> AppResult<Settings> {
    register_shortcut(&app, &settings.shortcut)?;
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "insert into settings(key, value) values('settings', ?1)
         on conflict(key) do update set value = excluded.value",
        params![serde_json::to_string(&settings)?],
    )?;
    Ok(settings)
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

/// Call the configured endpoint and return translated text. Branches on
/// `protocol` — adding a provider means adding a match arm here.
async fn translate_text(cfg: &TranslationConfig, content: &str) -> AppResult<String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
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
    let client = reqwest::Client::builder()
        .user_agent("SkillAnvil/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

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
                let detail = res.text().await.unwrap_or_default();
                return Err(AppError::Message(extract_api_error(code, &ctype, &detail)));
            }
            let value: serde_json::Value = res.json().await?;
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
                let detail = res.text().await.unwrap_or_default();
                return Err(AppError::Message(extract_api_error(code, &ctype, &detail)));
            }
            let value: serde_json::Value = res.json().await?;
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
    let target = if cfg.target_lang.trim().is_empty() {
        "zh-CN"
    } else {
        cfg.target_lang.trim()
    };
    let system = translation_system_prompt(target);
    let is_anthropic = cfg.protocol.trim() == "anthropic";
    let client = reqwest::Client::builder()
        .user_agent("SkillAnvil/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

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
        let detail = res.text().await.unwrap_or_default();
        return Err(AppError::Message(extract_api_error(code, &ctype, &detail)));
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    while let Some(bytes) = res.chunk().await? {
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

    if let Ok(conn) = Connection::open(&state.db_path) {
        if let Ok(text) = conn.query_row(
            "select content from translations where cache_key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            return Ok(TranslationResult { text, cached: true });
        }
    }

    let text = translate_text(&cfg, &content).await?;

    if let Ok(conn) = Connection::open(&state.db_path) {
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
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
    if let Ok(conn) = Connection::open(&state.db_path) {
        if let Ok(text) = conn.query_row(
            "select content from translations where cache_key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            return Ok(TranslationResult { text, cached: true });
        }
    }

    let text = translate_text_stream(&cfg, &content, &on_chunk).await?;

    if let Ok(conn) = Connection::open(&state.db_path) {
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
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
async fn test_translation_config(config: TranslationConfig) -> AppResult<TestResult> {
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
async fn list_translation_models(config: TranslationConfig) -> AppResult<Vec<String>> {
    if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
        return Err(AppError::Message("先填接口和 Key 再检测模型。".into()));
    }
    let base = config.base_url.trim().trim_end_matches('/');
    let is_anthropic = config.protocol.trim() == "anthropic";
    let client = reqwest::Client::builder()
        .user_agent("SkillAnvil/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
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
        let detail = res.text().await.unwrap_or_default();
        return Err(AppError::Message(extract_api_error(code, &ctype, &detail)));
    }
    let v: serde_json::Value = res.json().await?;
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

fn perform_scan(state: &AppState) -> AppResult<ScanResult> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| AppError::Message("Lock poisoned".into()))?;
    let conn = Connection::open(&state.db_path)?;
    let settings = load_settings(&state.db_path)?;
    let agents = detect_agents(&settings);
    let active_ids = agents
        .iter()
        .map(|agent| agent.id.clone())
        .collect::<Vec<_>>();
    prune_inactive_agents(&conn, &active_ids)?;
    for agent in &agents {
        upsert_agent(&conn, agent)?;
    }
    let mut found = Vec::new();
    let mut scan_errors = Vec::new();
    for agent in &agents {
        for root in &agent.skill_dir_paths {
            let root_path = Path::new(root);
            if !root_path.exists() {
                continue;
            }
            for entry in WalkDir::new(root_path)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
            {
                if let Some(dir) = entry.path().parent() {
                    match scan_one_skill(agent, dir) {
                        Ok(skill) => {
                            upsert_skill(&conn, &skill)?;
                            found.push(skill);
                        }
                        Err(err) => scan_errors.push(ScanIssue {
                            path: entry.path().to_string_lossy().to_string(),
                            message: err.to_string(),
                        }),
                    }
                }
            }
        }
    }
    Ok(ScanResult {
        agents: load_agents(&conn)?,
        skills: load_skills(&conn, &SkillFilter::default())?,
        scan_errors,
    })
}

#[tauri::command]
async fn check_for_updates(state: State<'_, AppState>) -> AppResult<UpdateInfo> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let client = reqwest::Client::builder()
        .user_agent("SkillAnvil")
        .build()?;

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

    let json: serde_json::Value = response.json().await?;
    let tag = json["tag_name"].as_str().unwrap_or("").to_string();
    let latest_version = tag.strip_prefix('v').unwrap_or(&tag).to_string();
    let release_url = json["html_url"].as_str().unwrap_or("").to_string();
    let release_notes = json["body"].as_str().unwrap_or("").to_string();
    let published_at = json["published_at"].as_str().unwrap_or("").to_string();

    // Pick the asset that matches the current platform so the user can
    // download the installer directly instead of browsing the release page.
    let asset_url = pick_asset(&json);

    // Check if user already dismissed this version
    let conn = Connection::open(&state.db_path)?;
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

#[tauri::command]
fn dismiss_update(state: State<'_, AppState>, version: String) -> AppResult<()> {
    let conn = Connection::open(&state.db_path)?;
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

fn init_db(path: &Path) -> AppResult<()> {
    let conn = Connection::open(path)?;
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
            skill_dir_paths: config
                .paths
                .iter()
                .map(|path| expand_home_path(path, &home))
                .collect(),
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

fn expand_home_path(path: &str, home: &Path) -> String {
    if path == "~" {
        return home.to_string_lossy().to_string();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home.join(rest).to_string_lossy().to_string();
    }
    path.to_string()
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
    let github_repo = read_meta_json(dir)?.and_then(|meta| {
        meta.get("repo")
            .and_then(|value| value.as_str())
            .map(str::to_string)
    });
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
        github_branch: read_meta_json(dir)?.and_then(|meta| {
            meta.get("branch")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        }),
        last_sync_commit: read_meta_json(dir)?.and_then(|meta| {
            meta.get("lastSyncCommit")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        }),
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

fn load_skills(conn: &Connection, filter: &SkillFilter) -> AppResult<Vec<Skill>> {
    let mut stmt = conn.prepare(
        "select s.id, s.name, s.display_name, s.description, s.version, s.dir_path, s.agent_id,
                s.source, s.github_repo, s.github_branch, s.last_sync_commit, s.local_modified,
                coalesce(st.starred, 0), s.updated_at
         from skills s
         left join skill_state st on st.skill_id = s.id
         order by s.display_name",
    )?;
    let rows = stmt.query_map([], |row| {
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
    })?;
    let mut skills = rows.collect::<Result<Vec<_>, _>>()?;
    for skill in &mut skills {
        skill.tags = load_tags_for_skill(conn, &skill.id)?;
        skill.files = list_skill_files(Path::new(&skill.dir_path)).unwrap_or_default();
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
    Ok(skills)
}

fn find_skill(conn: &Connection, id: &str) -> AppResult<Skill> {
    load_skills(conn, &SkillFilter::default())?
        .into_iter()
        .find(|skill| skill.id == id)
        .ok_or_else(|| AppError::Message("Skill 不存在，请重新扫描。".into()))
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
    let conn = Connection::open(db_path)?;
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
            target.paths = existing.paths;
            target.enabled = existing.enabled;
            target.icon = existing.icon.or_else(|| target.icon.clone());
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
    vec![
        builtin_agent(
            "claude-code",
            "Claude Code",
            &["~/.claude/skills"],
            true,
            "claude",
        ),
        builtin_agent("codex", "Codex", &["~/.codex/skills"], true, "codex"),
        builtin_agent(
            "antigravity",
            "Antigravity",
            &["~/.gemini/antigravity/skills", "~/.antigravity/skills"],
            true,
            "antigravity",
        ),
        builtin_agent("kilo-code", "Kilo Code", &["~/.kilo/skills"], false, "kilo"),
        builtin_agent(
            "roo-code",
            "Roo Code",
            &["~/.roo/skills", "~/.roo-code/skills"],
            false,
            "roo",
        ),
        builtin_agent(
            "goose",
            "Goose",
            &["~/.config/goose/skills", "~/.goose/skills"],
            false,
            "goose",
        ),
        builtin_agent(
            "openclaw",
            "OpenClaw",
            &["~/.openclaw/skills"],
            false,
            "openclaw",
        ),
        builtin_agent("trae-ide", "TRAE IDE", &["~/.trae/skills"], false, "trae"),
        builtin_agent("cline", "Cline", &["~/.cline/skills"], false, "cline"),
        builtin_agent(
            "kimi-code-cli",
            "Kimi Code CLI",
            &["~/.kimi-code/skills"],
            false,
            "kimi",
        ),
        builtin_agent(
            "codebuddy",
            "CodeBuddy",
            &["~/.codebuddy/skills"],
            false,
            "codebuddy",
        ),
        builtin_agent("junie", "Junie", &["~/.junie/skills"], false, "junie"),
        builtin_agent(
            "openhands",
            "OpenHands",
            &["~/.openhands/skills"],
            false,
            "openhands",
        ),
        builtin_agent("qoder", "Qoder", &["~/.qoder/skills"], false, "qoder"),
        builtin_agent(
            "zencoder",
            "Zencoder",
            &["~/.zencoder/skills"],
            false,
            "zencoder",
        ),
        builtin_agent(
            "hermes-agent",
            "Hermes Agent",
            &["~/.hermes/skills"],
            false,
            "hermes",
        ),
    ]
}

fn builtin_agent(
    id: &str,
    name: &str,
    paths: &[&str],
    enabled: bool,
    icon: &str,
) -> AgentPathConfig {
    AgentPathConfig {
        id: id.into(),
        name: name.into(),
        paths: paths.iter().map(|path| (*path).into()).collect(),
        enabled,
        builtin: true,
        icon: Some(icon.into()),
        categories: vec![],
    }
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
    let mut file = fs::File::create(path)?;
    match encoding {
        "UTF-8 BOM" => {
            file.write_all(&[0xEF, 0xBB, 0xBF])?;
            file.write_all(content.as_bytes())?;
        }
        "UTF-8" => file.write_all(content.as_bytes())?,
        "GBK" => {
            let (bytes, _, had_errors) = GBK.encode(content);
            if had_errors {
                return Err(AppError::Message(
                    "内容无法无损编码为 GBK，已拒绝写入。".into(),
                ));
            }
            file.write_all(&bytes)?;
        }
        other => return Err(AppError::Message(format!("未知编码 {other}，已拒绝写入。"))),
    }
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

fn list_skill_files(dir: &Path) -> AppResult<Vec<SkillFile>> {
    let mut files = Vec::new();
    if !dir.exists() {
        return Ok(files);
    }
    for entry in WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
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
    let path = root.join(relative);
    let parent = path.parent().unwrap_or(&path).canonicalize()?;
    if !parent.starts_with(&root) {
        return Err(AppError::Message("非法文件路径。".into()));
    }
    Ok(path)
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
    // PRD: only snapshot if non-whitespace character change > 5%
    let last_content: Option<String> = conn
        .query_row(
            "select content from snapshots where skill_id = ?1 and file_path = ?2 order by created_at desc limit 1",
            params![skill_id, relative_path],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(prev) = last_content {
        let prev_chars: usize = prev.chars().filter(|c| !c.is_whitespace()).count();
        let curr_chars: usize = content.chars().filter(|c| !c.is_whitespace()).count();
        let max_len = prev_chars.max(curr_chars).max(1);
        let diff = if curr_chars > prev_chars {
            curr_chars - prev_chars
        } else {
            prev_chars - curr_chars
        };
        if (diff as f64 / max_len as f64) < 0.05 {
            return Ok(());
        }
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
    if name.trim().is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(AppError::Message(
            "Skill 名称不能包含路径或系统非法字符。".into(),
        ));
    }
    Ok(())
}

fn rewrite_skill_identity(content: &str, new_name: &str) -> String {
    if !content.starts_with("---") {
        return format!("---\nname: {new_name}\ndisplayName: {new_name}\n---\n\n{content}");
    }
    let Some(end) = content[3..].find("\n---") else {
        return format!("---\nname: {new_name}\ndisplayName: {new_name}\n---\n\n{content}");
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
            lines.push(format!("name: {new_name}"));
        } else if trimmed.starts_with("displayName:") || trimmed.starts_with("display_name:") {
            has_display_name = true;
            lines.push(format!("displayName: {new_name}"));
        } else {
            lines.push(line.to_string());
        }
    }
    if !has_name {
        lines.insert(0, format!("name: {new_name}"));
    }
    if !has_display_name {
        let insert_at = if has_name { 1 } else { lines.len().min(1) };
        lines.insert(insert_at, format!("displayName: {new_name}"));
    }
    format!("---\n{}\n---{}", lines.join("\n"), rest)
}

fn copy_dir_all(source: &Path, target: &Path) -> AppResult<()> {
    fs::create_dir_all(target)?;
    for entry in WalkDir::new(source).into_iter().filter_map(Result::ok) {
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
        let status = Command::new("explorer.exe")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .status()?;
        if !status.success() {
            return Err(AppError::Message(
                "无法启动 Windows 文件资源管理器。".into(),
            ));
        }
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
        assert!(validate_name("   ").is_err());
    }

    #[test]
    fn expand_home_path_resolves_tilde() {
        let home = Path::new("/home/alice");
        assert_eq!(expand_home_path("~", home), "/home/alice");
        assert_eq!(
            expand_home_path("~/.config/x", home),
            "/home/alice/.config/x"
        );
        assert_eq!(expand_home_path("/abs/path", home), "/abs/path");
    }

    #[test]
    fn rewrite_skill_identity_updates_name_fields() {
        let original = "---\nname: old\ndisplayName: Old\ndescription: keep\n---\n\nbody";
        let out = rewrite_skill_identity(original, "fresh");
        assert!(out.contains("name: fresh"));
        assert!(out.contains("displayName: fresh"));
        assert!(out.contains("description: keep"));
        assert!(out.trim_end().ends_with("body"));
    }

    #[test]
    fn truncate_str_appends_ellipsis_when_clipping() {
        assert_eq!(truncate_str("hi", 10), "hi");
        assert_eq!(truncate_str("hello world", 5).chars().count(), 6);
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
}
