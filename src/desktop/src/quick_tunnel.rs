//! Desktop-owned temporary tunnel, using the same restricted gateway as phone testing.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use common::process::registry::{ChildRegistry, ProcessKind};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex;

const GATEWAY: &str = include_str!("../../../local-tools/phone-test/quick-tunnel.cjs");
const CONTROL: &str = r#"
let tunnel;
let stopping = false;
async function stop() {
  stopping = true;
  if (tunnel) await tunnel.stop();
}
process.stdin.resume();
process.stdin.on('data', () => { void stop(); });
process.stdin.on('end', () => { void stop(); });
process.stdin.on('error', () => { void stop(); });
module.exports.startTunnel({ upstreamPort: Number(process.env.VIBEAROUND_TUNNEL_PORT) })
  .then(async (started) => {
    tunnel = started;
    if (stopping) await tunnel.stop();
    process.exitCode = await tunnel.done;
    process.stdin.destroy();
  }).catch(() => {
    process.stdout.write('TUNNEL_STOPPED\n');
    process.exitCode = 1;
    process.stdin.destroy();
  });
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickTunnelStatus {
    status: &'static str,
    public_url: Option<String>,
    error: Option<String>,
    cloudflared_path: Option<String>,
}

impl Default for QuickTunnelStatus {
    fn default() -> Self {
        Self {
            status: "stopped",
            public_url: None,
            error: None,
            cloudflared_path: None,
        }
    }
}

#[derive(Default)]
struct Inner {
    snapshot: QuickTunnelStatus,
    registry_id: Option<u64>,
    stdin: Option<ChildStdin>,
    generation: u64,
}

#[derive(Clone, Default)]
pub struct QuickTunnelState(Arc<Mutex<Inner>>);

impl QuickTunnelState {
    pub async fn stop(&self) -> QuickTunnelStatus {
        let mut inner = self.0.lock().await;
        inner.generation = inner.generation.wrapping_add(1);
        if let Some(mut stdin) = inner.stdin.take() {
            let _ = stdin.write_all(b"STOP\n").await;
        }
        if let Some(id) = inner.registry_id.take() {
            reap_helper(id).await;
        }
        inner.snapshot.status = "stopped";
        inner.snapshot.public_url = None;
        inner.snapshot.error = None;
        inner.snapshot.clone()
    }
}

async fn reap_helper(id: u64) {
    if let Some(mut child) = ChildRegistry::global().remove(id) {
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}

fn resolve_program(name: &str, env: &std::collections::HashMap<String, String>) -> Option<PathBuf> {
    let path = env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))?
        .1;
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    // Never resolve executable names against the current working directory.
    std::env::split_paths(path)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(&filename))
        .find(|path| path.is_file())
}

fn cloudflared_program(
    requested: Option<String>,
    env: &std::collections::HashMap<String, String>,
) -> Result<PathBuf, String> {
    let configured = requested
        .filter(|path| !path.trim().is_empty())
        .or_else(|| {
            env.iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("CLOUDFLARED_PATH"))
                .map(|(_, value)| value.clone())
        });
    if let Some(configured) = configured {
        let path = PathBuf::from(configured.trim());
        if !path.is_absolute() || !path.is_file() {
            return Err(
                "Select an installed cloudflared executable using its absolute path.".into(),
            );
        }
        return Ok(path);
    }
    let managed =
        common::plugins::user_plugin_dependency_bin_path("tunnel-cloudflare", "cloudflared");
    if managed.is_file() {
        return Ok(managed);
    }
    resolve_program("cloudflared", env).ok_or_else(|| {
        "cloudflared is not installed. Install it with VibeAround setup or select its executable.".into()
    })
}

fn public_url(line: &str) -> Option<String> {
    let url = line.strip_prefix("PUBLIC_URL=")?;
    let hostname = url
        .strip_prefix("https://")?
        .strip_suffix(".trycloudflare.com/va/")?;
    if hostname.is_empty()
        || hostname.len() > 63
        || !hostname
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return None;
    }
    Some(url.to_string())
}

#[tauri::command]
pub async fn quick_tunnel_status(
    state: tauri::State<'_, QuickTunnelState>,
) -> Result<QuickTunnelStatus, String> {
    Ok(state.0.lock().await.snapshot.clone())
}

#[tauri::command]
pub async fn quick_tunnel_start(
    state: tauri::State<'_, QuickTunnelState>,
    controller: tauri::State<'_, crate::DaemonController>,
    cloudflared_path: Option<String>,
) -> Result<QuickTunnelStatus, String> {
    let mut inner = state.0.lock().await;
    if inner.registry_id.is_some() {
        return Ok(inner.snapshot.clone());
    }
    if controller.running.lock().await.is_none() {
        return Err("Start VibeAround services before opening a temporary tunnel.".into());
    }
    let env = common::process::env::child_env();
    let resolved = (|| {
        let cloudflared = cloudflared_program(cloudflared_path, &env)?;
        let node = resolve_program("node", &env).ok_or_else(|| {
            "Node.js is required for the restricted Quick Tunnel gateway.".to_string()
        })?;
        Ok::<_, String>((cloudflared, node))
    })();
    let (cloudflared, node) = match resolved {
        Ok(programs) => programs,
        Err(error) => {
            inner.snapshot.status = "failed";
            inner.snapshot.error = Some(error.clone());
            return Err(error);
        }
    };
    // The script is compiled into the app, not loaded from a writable repo or download.
    // A private module object prevents the helper's standalone entrypoint from running.
    let script = format!("((module) => {{\n{GATEWAY}\n{CONTROL}\n}})({{exports: {{}}}});");
    let mut command = common::process::env::silent_command(&node);
    command.env_clear();
    for (key, value) in &env {
        // The gateway needs no application credentials, Node preload hooks, or named tunnel token.
        if [
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "HOME",
            "USERPROFILE",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LOCALAPPDATA",
            "APPDATA",
            "PROGRAMDATA",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ]
        .iter()
        .any(|allowed| key.eq_ignore_ascii_case(allowed))
        {
            command.env(key, value);
        }
    }
    command
        .args(["-e", &script])
        .env("CLOUDFLARED_PATH", &cloudflared)
        .env(
            "VIBEAROUND_TUNNEL_PORT",
            common::config::DEFAULT_PORT.to_string(),
        )
        .current_dir(node.parent().unwrap_or(Path::new("/")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let error = format!("Failed to start the restricted Quick Tunnel gateway: {error}");
            inner.snapshot.status = "failed";
            inner.snapshot.error = Some(error.clone());
            return Err(error);
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or("Quick Tunnel output pipe is missing")?;
    inner.stdin = child.stdin.take();
    let id = ChildRegistry::global().register(ProcessKind::Tunnel, "cloudflare-quick", child);
    inner.registry_id = Some(id);
    inner.generation = inner.generation.wrapping_add(1);
    let generation = inner.generation;
    inner.snapshot = QuickTunnelStatus {
        status: "starting",
        public_url: None,
        error: None,
        cloudflared_path: Some(cloudflared.to_string_lossy().into_owned()),
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut inner = state.0.lock().await;
            if inner.generation != generation {
                return;
            }
            if let Some(url) = public_url(&line) {
                inner.snapshot.status = "running";
                inner.snapshot.public_url = Some(url);
            } else if line == "TUNNEL_STOPPED" || line == "TUNNEL_EXPIRED" {
                break;
            }
        }
        let mut inner = state.0.lock().await;
        if inner.generation != generation {
            return;
        }
        inner.stdin.take();
        if let Some(id) = inner.registry_id.take() {
            reap_helper(id).await;
        }
        inner.snapshot.status = "failed";
        inner.snapshot.public_url = None;
        inner.snapshot.error = Some("Quick Tunnel stopped or could not connect. Check the network and cloudflared installation, then retry.".into());
    });
    Ok(inner.snapshot.clone())
}

#[tauri::command]
pub async fn quick_tunnel_stop(
    state: tauri::State<'_, QuickTunnelState>,
) -> Result<QuickTunnelStatus, String> {
    Ok(state.stop().await)
}
