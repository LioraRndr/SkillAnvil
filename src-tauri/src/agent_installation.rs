//! Bounded, read-only installation discovery. Never execute a discovered program.
use super::{harness_catalog, AppError, AppResult, Settings};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct InstallationSpec {
    commands: Vec<CommandProbe>,
    windows: Vec<String>,
    macos: Vec<String>,
    linux: Vec<String>,
    extensions: Vec<String>,
    config_directories: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandProbe {
    name: String,
    #[serde(default)]
    markers: Vec<String>,
    #[serde(default)]
    exclude_markers: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InstallationEvidence {
    kind: &'static str,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentInstallation {
    pub agent_id: String,
    name: String,
    pub status: &'static str,
    enabled: bool,
    pub can_enable: bool,
    evidence: Vec<InstallationEvidence>,
}

fn specs() -> &'static BTreeMap<String, InstallationSpec> {
    static SPECS: OnceLock<BTreeMap<String, InstallationSpec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/agent-installations.json"))
            .expect("bundled installation probes must be valid")
    })
}

struct ProbeContext {
    home: PathBuf,
    platform: &'static str,
    command_dirs: Vec<PathBuf>,
    app_vars: BTreeMap<String, PathBuf>,
    extension_roots: Vec<PathBuf>,
    include_system_apps: bool,
}

fn local_absolute(path: &Path) -> bool {
    path.is_absolute() && !path.to_string_lossy().starts_with("\\\\")
}

impl ProbeContext {
    fn current() -> Self {
        let home = directories::BaseDirs::new()
            .map(|dirs| dirs.home_dir().to_path_buf())
            .unwrap_or_default();
        let mut command_dirs: Vec<_> = std::env::var_os("PATH")
            .map(|paths| std::env::split_paths(&paths).take(128).collect())
            .unwrap_or_default();
        for relative in [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".npm/bin",
            ".kimi-code/bin",
            ".opencode/bin",
            ".antigravity/antigravity/bin",
            ".hermes/hermes-agent/.venv/bin",
        ] {
            command_dirs.push(home.join(relative));
        }
        let mut app_vars = BTreeMap::new();
        // Only installation location variables; never expand arbitrary environment secrets.
        for key in [
            "LOCALAPPDATA",
            "APPDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
        ] {
            if let Some(value) = std::env::var_os(key) {
                let path = PathBuf::from(value);
                if local_absolute(&path) {
                    app_vars.insert(key.into(), path);
                }
            }
        }
        if let Some(appdata) = app_vars.get("APPDATA") {
            command_dirs.push(appdata.join("npm"));
        }
        command_dirs.extend(
            [
                "/usr/local/bin",
                "/usr/bin",
                "/opt/homebrew/bin",
                "/snap/bin",
            ]
            .map(PathBuf::from),
        );
        let mut seen = HashSet::new();
        command_dirs.retain(|path| local_absolute(path) && seen.insert(path.clone()));
        let extension_roots = [
            ".vscode",
            ".vscode-insiders",
            ".cursor",
            ".kiro",
            ".trae",
            ".trae-cn",
            ".windsurf",
            ".antigravity",
        ]
        .map(|dir| home.join(dir).join("extensions"))
        .to_vec();
        Self {
            home,
            platform: std::env::consts::OS,
            command_dirs,
            app_vars,
            extension_roots,
            include_system_apps: true,
        }
    }

    fn application_path(&self, template: &str) -> Option<PathBuf> {
        let path = if let Some(relative) = template.strip_prefix("~/") {
            self.home.join(relative)
        } else if let Some(variable) = template.strip_prefix('$') {
            let (key, relative) = variable.split_once('/')?;
            self.app_vars.get(key)?.join(relative)
        } else {
            if !self.include_system_apps {
                return None;
            }
            PathBuf::from(template)
        };
        local_absolute(&path).then_some(path)
    }
}

fn read_small(path: &Path, limit: u64) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > limit {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn is_program(path: &Path, platform: &str) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        return false;
    }
    if platform == "windows" {
        return matches!(
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("exe" | "cmd" | "bat" | "ps1")
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn find_command(context: &ProbeContext, probe: &CommandProbe) -> Option<PathBuf> {
    let suffixes: &[&str] = if context.platform == "windows" {
        &[".exe", ".cmd", ".bat", ".ps1"]
    } else {
        &[""]
    };
    for dir in &context.command_dirs {
        if !local_absolute(dir) {
            continue;
        }
        for suffix in suffixes {
            let path = dir.join(format!("{}{suffix}", probe.name));
            if !is_program(&path, context.platform) {
                continue;
            }
            let body = read_small(&path, 16 * 1024).unwrap_or_default();
            let resolved = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            let identity = format!(
                "{}\n{}\n{body}",
                path.to_string_lossy(),
                resolved.to_string_lossy()
            )
            .to_ascii_lowercase();
            if (!probe.markers.is_empty()
                && !probe.markers.iter().any(|marker| identity.contains(marker)))
                || probe
                    .exclude_markers
                    .iter()
                    .any(|marker| identity.contains(marker))
            {
                continue;
            }
            // npm's stock shims may survive uninstall. Require their referenced package.
            if let Some(after) = body.replace('\\', "/").split("node_modules/").nth(1) {
                let parts: Vec<_> = after
                    .split('/')
                    .take(if after.starts_with('@') { 2 } else { 1 })
                    .collect();
                let package = parts.join("/");
                if !package.is_empty()
                    && !dir
                        .join("node_modules")
                        .join(package)
                        .join("package.json")
                        .is_file()
                {
                    continue;
                }
            }
            return Some(path);
        }
    }
    None
}

fn extension_index(context: &ProbeContext) -> BTreeMap<String, PathBuf> {
    let mut found = BTreeMap::new();
    for root in &context.extension_roots {
        let obsolete: BTreeMap<String, bool> = read_small(&root.join(".obsolete"), 256 * 1024)
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.take(512).flatten() {
            if obsolete.get(&entry.file_name().to_string_lossy().to_string()) == Some(&true) {
                continue;
            }
            let path = entry.path().join("package.json");
            let Some(manifest) = read_small(&path, 256 * 1024)
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            else {
                continue;
            };
            let Some(publisher) = manifest["publisher"].as_str() else {
                continue;
            };
            let Some(name) = manifest["name"].as_str() else {
                continue;
            };
            let Some(main) = manifest["main"]
                .as_str()
                .or_else(|| manifest["browser"].as_str())
            else {
                continue;
            };
            let main = Path::new(main);
            if main.is_absolute()
                || main
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
                || !entry.path().join(main).is_file()
            {
                continue;
            }
            found
                .entry(format!("{publisher}.{name}").to_ascii_lowercase())
                .or_insert(path);
        }
    }
    found
}

fn detect_with(context: &ProbeContext, settings: &Settings) -> Vec<AgentInstallation> {
    let extensions = extension_index(context);
    harness_catalog()
        .iter()
        .map(|entry| {
            let spec = &specs()[&entry.id];
            let mut evidence = Vec::new();
            for probe in &spec.commands {
                if let Some(path) = find_command(context, probe) {
                    evidence.push(InstallationEvidence {
                        kind: "command",
                        path: path.to_string_lossy().into(),
                    });
                }
            }
            let apps = match context.platform {
                "windows" => &spec.windows,
                "macos" => &spec.macos,
                _ => &spec.linux,
            };
            for template in apps {
                if let Some(path) = context.application_path(template) {
                    let installed = if context.platform == "macos"
                        && path.extension().is_some_and(|ext| ext == "app")
                    {
                        path.join("Contents/Info.plist").is_file()
                            && fs::read_dir(path.join("Contents/MacOS")).is_ok_and(|files| {
                                files
                                    .flatten()
                                    .any(|file| is_program(&file.path(), context.platform))
                            })
                    } else {
                        is_program(&path, context.platform)
                    };
                    if installed {
                        evidence.push(InstallationEvidence {
                            kind: "application",
                            path: path.to_string_lossy().into(),
                        });
                    }
                }
            }
            for id in &spec.extensions {
                if let Some(path) = extensions.get(id) {
                    evidence.push(InstallationEvidence {
                        kind: "extension",
                        path: path.to_string_lossy().into(),
                    });
                }
            }
            let installed = !evidence.is_empty();
            if !installed {
                for template in &spec.config_directories {
                    let template = if template.starts_with('$') && !template.contains('/') {
                        format!("{template}/")
                    } else {
                        template.clone()
                    };
                    let path = PathBuf::from(super::expand_skill_root(&template, &context.home));
                    if local_absolute(&path) && path.is_dir() {
                        evidence.push(InstallationEvidence {
                            kind: "config",
                            path: path.to_string_lossy().into(),
                        });
                    }
                }
            }
            let config = settings
                .custom_agents
                .iter()
                .find(|agent| agent.id == entry.id);
            AgentInstallation {
                agent_id: entry.id.clone(),
                name: config
                    .map(|agent| agent.name.clone())
                    .unwrap_or_else(|| entry.name.clone()),
                status: if installed {
                    "installed"
                } else if evidence.is_empty() {
                    "notFound"
                } else {
                    "configured"
                },
                enabled: config.is_some_and(|agent| agent.enabled),
                can_enable: installed
                    && entry.status == "native"
                    && config.is_some_and(|agent| valid_roots(&agent.paths, &context.home)),
                evidence,
            }
        })
        .collect()
}

pub(super) fn detect(settings: &Settings) -> Vec<AgentInstallation> {
    detect_with(&ProbeContext::current(), settings)
}

fn valid_roots(paths: &[String], home: &Path) -> bool {
    !paths.is_empty()
        && paths.iter().all(|path| {
            !path.trim().is_empty()
                && Path::new(&super::expand_skill_root(path, home)).is_absolute()
        })
}

/// Validate the whole request before modifying anything. No stale frontend settings accepted.
pub(super) fn enable_selected(
    settings: &mut Settings,
    report: &[AgentInstallation],
    ids: &[String],
) -> AppResult<Vec<String>> {
    if ids.is_empty() || ids.len() > harness_catalog().len() {
        return Err(AppError::Message("请选择已确认安装的 Agent。".into()));
    }
    let selected: HashSet<_> = ids.iter().collect();
    let home = directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .unwrap_or_default();
    for id in &selected {
        let found = report.iter().find(|entry| &entry.agent_id == *id);
        if !harness_catalog()
            .iter()
            .any(|entry| &entry.id == *id && entry.status == "native")
            || !found.is_some_and(|entry| entry.status == "installed" && entry.can_enable)
            || !settings
                .custom_agents
                .iter()
                .any(|agent| &agent.id == *id && valid_roots(&agent.paths, &home))
        {
            return Err(AppError::Message(
                "安装状态已变化或该 Agent 无法自动启用，请重新检测。".into(),
            ));
        }
    }
    let mut enabled = Vec::new();
    for agent in &mut settings.custom_agents {
        if selected.contains(&agent.id) && !agent.enabled {
            agent.enabled = true;
            enabled.push(agent.id.clone());
        }
    }
    Ok(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("skillanvil-installation-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn context(&self) -> ProbeContext {
            ProbeContext {
                home: self.0.clone(),
                platform: "windows",
                command_dirs: vec![self.0.join("bin")],
                app_vars: BTreeMap::from([("LOCALAPPDATA".into(), self.0.join("AppData"))]),
                extension_roots: vec![self.0.join(".vscode/extensions")],
                include_system_apps: false,
            }
        }
        fn file(&self, relative: &str, body: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, body).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn probe(name: &str) -> CommandProbe {
        CommandProbe {
            name: name.into(),
            markers: vec![],
            exclude_markers: vec![],
        }
    }
    fn entry<'a>(report: &'a [AgentInstallation], id: &str) -> &'a AgentInstallation {
        report.iter().find(|agent| agent.agent_id == id).unwrap()
    }

    #[test]
    fn probes_cover_catalog_and_never_use_shared_roots_as_installation_evidence() {
        assert_eq!(specs().len(), harness_catalog().len());
        for harness in harness_catalog() {
            let spec = &specs()[&harness.id];
            for path in &spec.config_directories {
                assert!(!path.contains(".agents"));
            }
            for command in &spec.commands {
                assert!(!command.name.contains(['/', '\\', '.', ' ']));
            }
        }
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join(".agents/skills")).unwrap();
        fs::create_dir_all(fixture.0.join(".qwen/skills")).unwrap();
        let report = detect_with(&fixture.context(), &super::super::default_settings());
        assert!(report
            .iter()
            .all(|agent| agent.status != "installed" && !agent.can_enable));
        assert_eq!(entry(&report, "qwen-code").status, "configured");
        assert_eq!(entry(&report, "github-copilot").status, "notFound");
    }

    #[test]
    fn command_probe_skips_relative_paths_empty_files_and_stale_npm_shims() {
        let fixture = Fixture::new();
        let mut context = fixture.context();
        context.command_dirs = vec![
            PathBuf::new(),
            PathBuf::from("."),
            PathBuf::from("relative/bin"),
        ];
        assert!(find_command(&context, &probe("codex")).is_none());
        context = fixture.context();
        fixture.file("bin/codex.exe", "");
        assert!(find_command(&context, &probe("codex")).is_none());
        fixture.file(
            "bin/codex.cmd",
            "node \"%dp0%/node_modules/@openai/codex/bin/codex.js\"",
        );
        assert!(find_command(&context, &probe("codex")).is_none());
        fixture.file("bin/node_modules/@openai/codex/package.json", "{}");
        assert_eq!(
            find_command(&context, &probe("codex")).unwrap(),
            fixture.0.join("bin/codex.cmd")
        );
    }

    #[test]
    fn kimi_versions_and_antigravity_launchers_are_not_confused() {
        let fixture = Fixture::new();
        let mut context = fixture.context();
        fixture.file("bin/kimi.exe", "unidentified binary");
        let report = detect_with(&context, &super::super::default_settings());
        assert_ne!(entry(&report, "kimi-code-cli").status, "installed");
        assert_ne!(entry(&report, "kimi-cli-legacy").status, "installed");
        context.command_dirs = vec![fixture.0.join(".kimi-code/bin")];
        fixture.file(".kimi-code/bin/kimi.exe", "current binary");
        let report = detect_with(&context, &super::super::default_settings());
        assert_eq!(entry(&report, "kimi-code-cli").status, "installed");
        assert_ne!(entry(&report, "kimi-cli-legacy").status, "installed");
        context = fixture.context();
        fixture.file("bin/kimi.exe", "from kimi_cli.cli import main");
        fixture.file("bin/agy.cmd", "../Antigravity.exe");
        fixture.file("bin/pi.exe", "unrelated math program");
        let report = detect_with(&context, &super::super::default_settings());
        assert_eq!(entry(&report, "kimi-cli-legacy").status, "installed");
        assert_ne!(entry(&report, "kimi-code-cli").status, "installed");
        assert_eq!(entry(&report, "antigravity").status, "installed");
        assert_ne!(entry(&report, "antigravity-cli").status, "installed");
        assert_ne!(entry(&report, "pi").status, "installed");
    }

    #[test]
    fn extensions_require_exact_manifest_identity_runtime_and_nonobsolete_installation() {
        let fixture = Fixture::new();
        let context = fixture.context();
        let manifest = r#"{"publisher":"GitHub","name":"copilot","main":"./dist/extension.js"}"#;
        fixture.file(".vscode/extensions/arbitrary-folder/package.json", manifest);
        assert!(extension_index(&context).is_empty());
        fixture.file(
            ".vscode/extensions/arbitrary-folder/dist/extension.js",
            "export {}",
        );
        assert!(extension_index(&context).contains_key("github.copilot"));
        fixture.file(
            ".vscode/extensions/github.copilot-fake/package.json",
            r#"{"publisher":"wrong","name":"copilot","main":"./dist/extension.js"}"#,
        );
        fixture.file(
            ".vscode/extensions/github.copilot-fake/dist/extension.js",
            "export {}",
        );
        fixture.file(
            ".vscode/extensions/.obsolete",
            r#"{"arbitrary-folder":true}"#,
        );
        assert!(!extension_index(&context).contains_key("github.copilot"));
        fixture.file(
            ".vscode/extensions/traversal/package.json",
            r#"{"publisher":"GitHub","name":"copilot","main":"../../outside.js"}"#,
        );
        fixture.file(".vscode/outside.js", "export {}");
        assert!(!extension_index(&context).contains_key("github.copilot"));
        let large = fixture.file(
            ".vscode/extensions/large/package.json",
            &" ".repeat(256 * 1024 + 1),
        );
        assert!(read_small(&large, 256 * 1024).is_none());
    }

    #[test]
    fn desktop_detection_requires_an_executable_not_an_empty_app_folder() {
        let fixture = Fixture::new();
        let mut context = fixture.context();
        fs::create_dir_all(fixture.0.join("AppData/Programs/cursor")).unwrap();
        let report = detect_with(&context, &super::super::default_settings());
        assert_ne!(entry(&report, "cursor").status, "installed");
        fixture.file("AppData/Programs/cursor/Cursor.exe", "binary");
        let report = detect_with(&context, &super::super::default_settings());
        assert_eq!(entry(&report, "cursor").status, "installed");
        assert!(context.application_path("$API_KEY/app.exe").is_none());
        context.platform = "macos";
        fs::create_dir_all(fixture.0.join("Applications/Cursor.app")).unwrap();
        assert_ne!(
            entry(
                &detect_with(&context, &super::super::default_settings()),
                "cursor"
            )
            .status,
            "installed"
        );
        fixture.file("Applications/Cursor.app/Contents/Info.plist", "plist");
        fixture.file("Applications/Cursor.app/Contents/MacOS/Cursor", "binary");
        assert_eq!(
            entry(
                &detect_with(&context, &super::super::default_settings()),
                "cursor"
            )
            .status,
            "installed"
        );
    }

    #[test]
    fn enable_is_atomic_and_preserves_custom_paths_categories_other_agents_and_credentials() {
        let fixture = Fixture::new();
        let mut settings = super::super::default_settings();
        settings.translation.api_key = "test-canary-only".into();
        let qwen = settings
            .custom_agents
            .iter_mut()
            .find(|agent| agent.id == "qwen-code")
            .unwrap();
        qwen.paths = vec![fixture.0.join("custom/skills").to_string_lossy().into()];
        qwen.categories.push(super::super::SkillCategory {
            id: "custom".into(),
            name: "用户分类".into(),
            skill_names: vec!["skill-a".into()],
        });
        fixture.file("bin/qwen.exe", "binary");
        fixture.file("bin/aider.exe", "binary");
        let report = detect_with(&fixture.context(), &settings);
        assert!(!entry(&report, "aider").can_enable);
        let original = serde_json::to_value(&settings).unwrap();
        for bad in ["aider", "workbuddy", "missing-id", "cline"] {
            assert!(
                enable_selected(&mut settings, &report, &["qwen-code".into(), bad.into()]).is_err()
            );
            assert_eq!(serde_json::to_value(&settings).unwrap(), original);
        }
        let db_path = fixture.0.join("test.sqlite");
        super::super::init_db(&db_path).unwrap();
        let conn = super::super::open_db(&db_path).unwrap();
        conn.execute(
            "insert into settings(key,value) values('settings',?1)",
            [serde_json::to_string(&settings).unwrap()],
        )
        .unwrap();
        // Reload the latest persisted settings, rather than accepting a stale whole settings blob.
        let result = super::super::persist_enabled_agents(
            &db_path,
            &report,
            &["qwen-code".into(), "qwen-code".into()],
        )
        .unwrap();
        assert_eq!(result.enabled_agent_ids, ["qwen-code"]);
        assert_eq!(
            result.settings.translation.api_key,
            super::super::MASKED_API_KEY
        );
        let loaded = super::super::load_settings(&db_path).unwrap();
        let mut expected = original;
        let index = settings
            .custom_agents
            .iter()
            .position(|agent| agent.id == "qwen-code")
            .unwrap();
        expected["customAgents"][index]["enabled"] = true.into();
        assert_eq!(serde_json::to_value(&loaded).unwrap(), expected);
        assert!(
            super::super::persist_enabled_agents(&db_path, &report, &["qwen-code".into()])
                .unwrap()
                .enabled_agent_ids
                .is_empty()
        );
        let saved: String = conn
            .query_row(
                "select value from settings where key='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(super::super::persist_enabled_agents(
            &db_path,
            &report,
            &["qwen-code".into(), "cline".into()]
        )
        .is_err());
        assert_eq!(
            conn.query_row::<String, _, _>(
                "select value from settings where key='settings'",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            saved
        );
    }

    #[test]
    fn invalid_or_changed_roots_are_not_enabled() {
        let fixture = Fixture::new();
        fixture.file("bin/qwen.exe", "binary");
        let mut settings = super::super::default_settings();
        let report = detect_with(&fixture.context(), &settings);
        assert!(entry(&report, "qwen-code").can_enable);
        for invalid in [
            vec![],
            vec![" ".into()],
            vec!["relative/path".into()],
            vec!["$UNKNOWN_SECRET/skills".into()],
        ] {
            settings
                .custom_agents
                .iter_mut()
                .find(|agent| agent.id == "qwen-code")
                .unwrap()
                .paths = invalid;
            assert!(!entry(&detect_with(&fixture.context(), &settings), "qwen-code").can_enable);
            let before = serde_json::to_value(&settings).unwrap();
            assert!(enable_selected(&mut settings, &report, &["qwen-code".into()]).is_err());
            assert_eq!(serde_json::to_value(&settings).unwrap(), before);
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_commands_require_execute_permission_and_ignore_broken_links() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let fixture = Fixture::new();
        let mut context = fixture.context();
        context.platform = "linux";
        let path = fixture.file("bin/codex", "#!/bin/sh\n");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(find_command(&context, &probe("codex")).is_none());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(find_command(&context, &probe("codex")).is_some());
        symlink("missing-target", fixture.0.join("bin/qwen")).unwrap();
        assert!(find_command(&context, &probe("qwen")).is_none());
    }
}
