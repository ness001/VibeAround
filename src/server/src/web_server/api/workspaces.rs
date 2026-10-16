use axum::{extract::Query, http::StatusCode, Json};
use std::path::{Path, PathBuf};

use common::config;

fn workspace_item(
    ws: &std::path::Path,
    default_workspace: &std::path::Path,
    builtin: &std::path::Path,
) -> crate::api_types::WorkspaceItem {
    crate::api_types::WorkspaceItem {
        path: ws.to_string_lossy().to_string(),
        is_default: config::workspace_paths_equal(ws, default_workspace),
        is_builtin: config::workspace_paths_equal(ws, builtin),
    }
}

fn workspaces_response() -> Result<crate::api_types::WorkspacesResponse, String> {
    let root = config::read_settings_json()?;
    let settings = config::workspace_settings_from_json(&root);
    let builtin = config::builtin_workspaces_dir();
    let default_workspace = settings.default_workspace;
    let mut all = vec![default_workspace.clone()];
    if !all
        .iter()
        .any(|path| config::workspace_paths_equal(path, &builtin))
    {
        all.push(builtin.clone());
    }
    for workspace in settings.workspaces {
        if !all
            .iter()
            .any(|path| config::workspace_paths_equal(path, &workspace))
        {
            all.push(workspace);
        }
    }

    let workspaces = all
        .iter()
        .map(|ws| workspace_item(ws, &default_workspace, &builtin))
        .collect();

    Ok(crate::api_types::WorkspacesResponse {
        workspaces,
        default_workspace: default_workspace.to_string_lossy().to_string(),
    })
}

/// GET /api/workspaces -- list all workspaces.
pub async fn list_workspaces_handler(
) -> Result<Json<crate::api_types::WorkspacesResponse>, (StatusCode, String)> {
    super::run_blocking_io(|| {
        workspaces_response()
            .map(Json)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))
    })
    .await
}

#[derive(serde::Deserialize)]
pub(crate) struct BrowseFoldersQuery {
    path: Option<String>,
}

fn browse_root(
    configured: Option<&str>,
    launch_root: Option<&std::ffi::OsStr>,
    default_workspace: &Path,
) -> PathBuf {
    configured
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            launch_root
                .filter(|root| !root.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| default_workspace.to_path_buf())
}

fn root_response(
    settings: &serde_json::Value,
    launch_root: Option<&std::ffi::OsStr>,
) -> Result<crate::api_types::WorkspaceBrowserRootResponse, (StatusCode, String)> {
    let configured = match settings.get("workspace_browser_root") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(path)) if !path.trim().is_empty() => Some(path.as_str()),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "Configured folder browser root must be a nonempty path".into(),
            ))
        }
    };
    let default_workspace = config::workspace_settings_from_json(settings).default_workspace;
    let root = canonical_folder(&browse_root(configured, launch_root, &default_workspace))?;
    let root = path_string(&root);
    Ok(crate::api_types::WorkspaceBrowserRootResponse {
        configured_root: configured.map(|_| root.clone()),
        root,
    })
}

#[derive(serde::Deserialize)]
pub(crate) struct BrowserRootBody {
    path: Option<String>,
}

pub async fn get_workspace_browser_root_handler(
) -> Result<Json<crate::api_types::WorkspaceBrowserRootResponse>, (StatusCode, String)> {
    super::run_blocking_io(|| {
        let settings = config::read_settings_json()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        root_response(
            &settings,
            std::env::var_os("VIBEAROUND_WORKSPACE").as_deref(),
        )
        .map(Json)
    })
    .await
}

pub async fn set_workspace_browser_root_handler(
    Json(body): Json<BrowserRootBody>,
) -> Result<Json<crate::api_types::WorkspaceBrowserRootResponse>, (StatusCode, String)> {
    super::run_blocking_io(move || {
        let path = body
            .path
            .as_deref()
            .map(Path::new)
            .map(canonical_folder)
            .transpose()?;
        let normalized = path
            .as_deref()
            .map(common::workspace::normalize_workspace_cwd);
        config::set_workspace_browser_root(normalized.as_deref())
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        let settings = config::read_settings_json()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        root_response(
            &settings,
            std::env::var_os("VIBEAROUND_WORKSPACE").as_deref(),
        )
        .map(Json)
    })
    .await
}

fn folder_io_error(error: std::io::Error) -> (StatusCode, String) {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => {
            (StatusCode::FORBIDDEN, "This folder cannot be read".into())
        }
        std::io::ErrorKind::NotFound => (StatusCode::NOT_FOUND, "Folder no longer exists".into()),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Unable to read this folder".into(),
        ),
    }
}

fn canonical_folder(path: &Path) -> Result<PathBuf, (StatusCode, String)> {
    if !path.is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Folder location must be an absolute path".into(),
        ));
    }
    let canonical = std::fs::canonicalize(path).map_err(folder_io_error)?;
    if !std::fs::metadata(&canonical)
        .map_err(folder_io_error)?
        .is_dir()
    {
        return Err((StatusCode::BAD_REQUEST, "Location is not a folder".into()));
    }
    Ok(canonical)
}

fn path_string(path: &Path) -> String {
    common::workspace::normalize_workspace_cwd(path)
        .to_string_lossy()
        .to_string()
}

fn browse_folders(
    root: &Path,
    requested: Option<&Path>,
) -> Result<crate::api_types::BrowseFoldersResponse, (StatusCode, String)> {
    let root = canonical_folder(root)?;
    let path = canonical_folder(requested.unwrap_or(&root))?;
    if !path.starts_with(&root) {
        return Err((
            StatusCode::FORBIDDEN,
            "Choose a folder inside the project root".into(),
        ));
    }
    let mut folders = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(folder_io_error)? {
        let entry = entry.map_err(folder_io_error)?;
        let child_path = entry.path();
        let file_type = entry.file_type().map_err(folder_io_error)?;
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        // Resolve links/junctions before returning navigation targets. Outside
        // links are not offered, and unreadable/disappeared links fail honestly.
        let canonical = match canonical_folder(&child_path) {
            Ok(canonical) => canonical,
            Err((StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND, _)) => continue,
            Err(error) => return Err(error),
        };
        if canonical.starts_with(&root) {
            folders.push(crate::api_types::BrowseFolderItem {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path_string(&canonical),
            });
        }
    }
    folders.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(crate::api_types::BrowseFoldersResponse {
        root: path_string(&root),
        path: path_string(&path),
        parent_path: if path == root {
            None
        } else {
            path.parent().map(path_string)
        },
        folders,
    })
}

/// GET /api/workspaces/browse -- lazily browse the host's configured project root.
pub async fn browse_workspaces_handler(
    Query(query): Query<BrowseFoldersQuery>,
) -> Result<Json<crate::api_types::BrowseFoldersResponse>, (StatusCode, String)> {
    super::run_blocking_io(move || {
        let settings = config::read_settings_json()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        let root = root_response(
            &settings,
            std::env::var_os("VIBEAROUND_WORKSPACE").as_deref(),
        )?;
        browse_folders(Path::new(&root.root), query.path.as_deref().map(Path::new)).map(Json)
    })
    .await
}

#[derive(serde::Deserialize)]
pub(crate) struct WorkspacePathBody {
    path: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct WorkspaceOrderBody {
    paths: Vec<String>,
}

#[derive(serde::Deserialize)]
pub(crate) struct CreateWorkspaceBody {
    name: String,
    #[serde(default)]
    parent_path: Option<String>,
}

fn validate_workspace_name(name: &str) -> Result<String, (StatusCode, String)> {
    let name = name.trim_start();
    if name.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Project folder name is required".into(),
        ));
    }
    if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err((
            StatusCode::BAD_REQUEST,
            "Project name must be a single folder name".into(),
        ));
    }
    // Keep project names portable, including when the dashboard runs remotely.
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"|?*".contains(ch))
        || reserved
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Project folder name is not valid".into(),
        ));
    }
    Ok(name.to_string())
}

fn existing_folder(path: &std::path::Path) -> Result<std::path::PathBuf, (StatusCode, String)> {
    if !path.is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Folder location must be an absolute path".into(),
        ));
    }
    let path = common::workspace::normalize_workspace_cwd(path);
    if !path.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Folder location does not exist or is not a directory: {}",
                path.display()
            ),
        ));
    }
    Ok(path)
}

fn create_project_folder(
    name: &str,
    parent_path: Option<&str>,
    default_workspace: &std::path::Path,
) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let name = validate_workspace_name(name)?;
    let parent = existing_folder(
        parent_path
            .map(std::path::Path::new)
            .unwrap_or(default_workspace),
    )?;
    let path = parent.join(name);
    // A single atomic create refuses existing files, folders and symlinks.
    std::fs::create_dir(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            (StatusCode::CONFLICT, "A folder or file with this name already exists. Choose another name or use the existing folder.".into())
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        }
    })?;
    Ok(path)
}

/// POST /api/workspaces -- add a workspace path.
pub async fn add_workspace_handler(
    Json(body): Json<WorkspacePathBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    super::run_blocking_io(move || {
        let path = existing_folder(std::path::Path::new(&body.path))?;
        config::register_workspace_path(&path)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        let path_string = path.to_string_lossy().to_string();

        Ok(Json(serde_json::json!({ "added": path_string })))
    })
    .await
}

/// POST /api/workspaces/create -- create a project in an existing parent folder and register it.
pub async fn create_workspace_handler(
    Json(body): Json<CreateWorkspaceBody>,
) -> Result<Json<crate::api_types::CreateWorkspaceResponse>, (StatusCode, String)> {
    super::run_blocking_io(move || {
        let root = config::read_settings_json()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        let default_workspace = config::workspace_settings_from_json(&root).default_workspace;
        let builtin = config::builtin_workspaces_dir();
        let path =
            create_project_folder(&body.name, body.parent_path.as_deref(), &default_workspace)?;

        config::register_workspace_path(&path)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;

        let response =
            workspaces_response().map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        Ok(Json(crate::api_types::CreateWorkspaceResponse {
            workspace: workspace_item(&path, &default_workspace, &builtin),
            workspaces: response.workspaces,
            default_workspace: response.default_workspace,
        }))
    })
    .await
}

/// POST /api/workspaces/remove -- remove a workspace path (cannot remove built-in).
pub async fn remove_workspace_handler(
    Json(body): Json<WorkspacePathBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    super::run_blocking_io(move || {
        let path = std::path::PathBuf::from(&body.path);
        config::remove_registered_workspace(&path)
            .map_err(|error| remove_workspace_error(error, &path))?;

        Ok(Json(serde_json::json!({ "removed": body.path })))
    })
    .await
}

/// PUT /api/workspaces/order -- reorder registered user workspaces.
pub async fn reorder_workspaces_handler(
    Json(body): Json<WorkspaceOrderBody>,
) -> Result<Json<crate::api_types::WorkspacesResponse>, (StatusCode, String)> {
    super::run_blocking_io(move || {
        let requested = body
            .paths
            .into_iter()
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>();
        config::reorder_workspace_paths(&requested)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        workspaces_response()
            .map(Json)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))
    })
    .await
}

/// PUT /api/workspaces/default -- set the default workspace root.
pub async fn set_default_workspace_handler(
    Json(body): Json<WorkspacePathBody>,
) -> Result<Json<crate::api_types::WorkspacesResponse>, (StatusCode, String)> {
    super::run_blocking_io(move || {
        let path = common::workspace::normalize_workspace_cwd(std::path::PathBuf::from(&body.path));
        std::fs::create_dir_all(&path)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        config::set_default_workspace_path(&path)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        workspaces_response()
            .map(Json)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))
    })
    .await
}

fn remove_workspace_error(
    error: config::RemoveWorkspaceError,
    path: &std::path::Path,
) -> (StatusCode, String) {
    match error {
        config::RemoveWorkspaceError::Default => (
            StatusCode::BAD_REQUEST,
            "Cannot remove the default workspace".to_string(),
        ),
        config::RemoveWorkspaceError::Builtin => (
            StatusCode::BAD_REQUEST,
            "Cannot remove the built-in workspace".to_string(),
        ),
        config::RemoveWorkspaceError::Unregistered => (
            StatusCode::NOT_FOUND,
            format!("Workspace is not registered: {}", path.display()),
        ),
        config::RemoveWorkspaceError::Storage(message) => {
            (StatusCode::INTERNAL_SERVER_ERROR, message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestFolder(std::path::PathBuf);

    impl TestFolder {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("va-project-folder-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(common::workspace::normalize_workspace_cwd(path))
        }
    }

    impl Drop for TestFolder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn browse_root_prefers_application_root_over_selected_default() {
        let default = Path::new("/projects/current");
        assert_eq!(
            browse_root(None, Some(std::ffi::OsStr::new("/projects")), default),
            PathBuf::from("/projects")
        );
        assert_eq!(browse_root(None, None, default), default);
        assert_eq!(
            browse_root(None, Some(std::ffi::OsStr::new("")), default),
            default
        );
    }

    #[test]
    fn configured_browser_root_overrides_launch_and_updates_without_cache() {
        let configured = TestFolder::new();
        let launched = TestFolder::new();
        let fallback = TestFolder::new();
        let mut settings = serde_json::json!({
            "workspace_browser_root": configured.0,
            "default_workspace": fallback.0,
        });
        let launch = Some(launched.0.as_os_str());
        let response = root_response(&settings, launch).unwrap();
        assert_eq!(response.root, configured.0.to_string_lossy());
        assert_eq!(
            response.configured_root.as_deref(),
            Some(response.root.as_str())
        );
        settings
            .as_object_mut()
            .unwrap()
            .remove("workspace_browser_root");
        let response = root_response(&settings, launch).unwrap();
        assert_eq!(response.root, launched.0.to_string_lossy());
        assert_eq!(response.configured_root, None);
        assert_eq!(
            root_response(&settings, None).unwrap().root,
            fallback.0.to_string_lossy()
        );
        settings["workspace_browser_root"] = serde_json::json!("relative");
        assert_eq!(
            root_response(&settings, launch).unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        settings["workspace_browser_root"] = serde_json::json!(42);
        assert_eq!(
            root_response(&settings, launch).unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn browses_one_level_of_sorted_directories_and_navigates_to_root() {
        let root = TestFolder::new();
        for name in ["zulu", "Alpha", ".hidden"] {
            std::fs::create_dir(root.0.join(name)).unwrap();
        }
        std::fs::create_dir(root.0.join("Alpha").join("nested")).unwrap();
        std::fs::write(root.0.join("file.txt"), "not a folder").unwrap();
        let listing = browse_folders(&root.0, None).unwrap();
        assert_eq!(listing.root, root.0.to_string_lossy());
        assert_eq!(listing.path, listing.root);
        assert_eq!(listing.parent_path, None);
        assert_eq!(
            listing
                .folders
                .iter()
                .map(|folder| folder.name.as_str())
                .collect::<Vec<_>>(),
            vec![".hidden", "Alpha", "zulu"]
        );
        let child = browse_folders(&root.0, Some(&root.0.join("Alpha"))).unwrap();
        assert_eq!(child.parent_path.as_deref(), Some(listing.root.as_str()));
        assert_eq!(child.folders.len(), 1);
        assert_eq!(child.folders[0].name, "nested");
        let back = browse_folders(
            &root.0,
            Some(Path::new(child.parent_path.as_ref().unwrap())),
        )
        .unwrap();
        assert_eq!(back.parent_path, None);
    }

    #[test]
    fn browser_rejects_escape_missing_relative_and_nonfolder_paths() {
        let parent = TestFolder::new();
        let root = parent.0.join("root");
        let sibling = parent.0.join("root-other");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        std::fs::write(root.join("file"), "keep").unwrap();
        for outside in [sibling, root.join(".."), parent.0.clone()] {
            assert_eq!(
                browse_folders(&root, Some(&outside)).unwrap_err().0,
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            browse_folders(&root, Some(Path::new("relative")))
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            browse_folders(&root, Some(&root.join("missing")))
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            browse_folders(&root, Some(&root.join("file")))
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            folder_io_error(std::io::ErrorKind::PermissionDenied.into()).0,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn browser_never_follows_directory_links_outside_root() {
        let root = TestFolder::new();
        let outside = TestFolder::new();
        let link = root.0.join("escape");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside.0, &link).unwrap();
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside.0)
                .output()
                .unwrap();
            assert!(result.status.success(), "junction fixture failed");
        }
        let result = browse_folders(&root.0, Some(&link));
        let listing = browse_folders(&root.0, None);
        // Remove the link itself before fixture cleanup; never traverse its target.
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        assert_eq!(result.unwrap_err().0, StatusCode::FORBIDDEN);
        assert!(listing.unwrap().folders.is_empty());
        assert!(outside.0.is_dir());
    }

    #[test]
    fn validates_workspace_folder_names() {
        for valid in ["project-a", "my project", "项目", "CONSOLE", ".hidden"] {
            assert_eq!(validate_workspace_name(valid).unwrap(), valid);
        }
        assert_eq!(validate_workspace_name(" project-a").unwrap(), "project-a");
        for invalid in [
            "",
            " ",
            ".",
            "..",
            "../project",
            "nested/project",
            "nested\\project",
            "project.",
            "project ",
            "project:",
            "bad*name",
            "bad?name",
            "bad|name",
            "bad<name",
            "bad>name",
            "bad\"name",
            "bad\0name",
            "bad\nname",
            "CON",
            "con.txt",
            "PRN",
            "aux",
            "NUL",
            "COM1",
            "COM9.txt",
            "LPT1",
            "LPT³",
        ] {
            assert_eq!(
                validate_workspace_name(invalid).unwrap_err().0,
                StatusCode::BAD_REQUEST,
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn create_body_keeps_parent_optional() {
        let old: CreateWorkspaceBody =
            serde_json::from_value(serde_json::json!({"name": "project"})).unwrap();
        assert_eq!(old.parent_path, None);
        let new: CreateWorkspaceBody = serde_json::from_value(
            serde_json::json!({"name": "project", "parent_path": "/projects"}),
        )
        .unwrap();
        assert_eq!(new.parent_path.as_deref(), Some("/projects"));
    }

    #[test]
    fn creates_project_in_default_or_explicit_parent() {
        let default = TestFolder::new();
        let chosen = TestFolder::new();
        let first = create_project_folder("first", None, &default.0).unwrap();
        let second =
            create_project_folder("second", Some(chosen.0.to_str().unwrap()), &default.0).unwrap();
        assert_eq!(first, default.0.join("first"));
        assert_eq!(second, chosen.0.join("second"));
        assert!(first.is_dir());
        assert!(second.is_dir());
        assert!(!default.0.join("second").exists());
    }

    #[test]
    fn rejects_existing_targets_without_modifying_contents() {
        let root = TestFolder::new();
        let existing = root.0.join("existing");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("keep.txt"), "keep").unwrap();
        std::fs::write(root.0.join("file"), "keep").unwrap();
        for name in ["existing", "file"] {
            assert_eq!(
                create_project_folder(name, None, &root.0).unwrap_err().0,
                StatusCode::CONFLICT
            );
        }
        assert_eq!(
            std::fs::read_to_string(existing.join("keep.txt")).unwrap(),
            "keep"
        );
        assert_eq!(
            std::fs::read_to_string(root.0.join("file")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn rejects_relative_missing_or_file_parents_without_creating_ancestors() {
        let root = TestFolder::new();
        let missing = root.0.join("missing").join("parent");
        let file = root.0.join("file");
        std::fs::write(&file, "keep").unwrap();
        for parent in [
            "",
            "relative",
            ".",
            missing.to_str().unwrap(),
            file.to_str().unwrap(),
        ] {
            assert_eq!(
                create_project_folder("project", Some(parent), &root.0)
                    .unwrap_err()
                    .0,
                StatusCode::BAD_REQUEST
            );
            assert_eq!(
                existing_folder(std::path::Path::new(parent)).unwrap_err().0,
                StatusCode::BAD_REQUEST
            );
        }
        assert!(!root.0.join("missing").exists());
        assert!(!root.0.join("project").exists());
        assert_eq!(existing_folder(&root.0).unwrap(), root.0);
    }

    #[test]
    fn normalizes_existing_parent_without_escaping_it() {
        let root = TestFolder::new();
        let parent = root.0.join(".");
        let created =
            create_project_folder("project", Some(parent.to_str().unwrap()), &root.0).unwrap();
        assert_eq!(created, root.0.join("project"));
        assert_eq!(
            create_project_folder("../escape", None, &root.0)
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
    }
}
