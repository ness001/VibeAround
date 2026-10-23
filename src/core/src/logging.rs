//! Global tracing subscriber setup.
//!
//! [`init`] installs the subscriber with `try_init`; repeated calls return an
//! error without panicking.
//!
//! # Runtime controls
//!
//! The filter is driven by `RUST_LOG`. Without it, the default is
//! `info,common=debug` — the kernel gets verbose logs, everything else
//! (tokio internals, hyper, ACP crate) stays at info. Override via the
//! environment, e.g.
//!
//! ```sh
//! RUST_LOG=warn,common::channels=trace cargo run
//! ```

use std::sync::OnceLock;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

/// Install the global tracing subscriber. Safe to call multiple times —
/// only the first call takes effect.
pub fn init() {
    init_with_console(true);
}

/// Desktop logs stay on disk; the tray menu opens them on demand.
pub fn init_desktop() {
    init_with_console(false);
}

fn runtime_log_dir() -> std::path::PathBuf {
    crate::config::data_dir().join("logs").join("runtime")
}

/// Resolve today's UTC log on every click so this follows daily rotation.
/// Create an empty file if no event has been written today; never truncate it.
pub fn current_log_file() -> std::io::Result<std::path::PathBuf> {
    prepare_log_file(&runtime_log_dir(), chrono::Utc::now().date_naive())
}

fn prepare_log_file(
    log_dir: &std::path::Path,
    date: chrono::NaiveDate,
) -> std::io::Result<std::path::PathBuf> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join(format!("vibearound.log.{}", date.format("%Y-%m-%d")));
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    Ok(path)
}

fn init_with_console(console: bool) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,common=debug"));

    let file_layer = {
        let log_dir = runtime_log_dir();
        std::fs::create_dir_all(&log_dir).ok().map(|_| {
            let file_appender = tracing_appender::rolling::daily(log_dir, "vibearound.log");
            let (writer, guard) = tracing_appender::non_blocking(file_appender);
            let _ = LOG_GUARD.set(guard);

            tracing_subscriber::fmt::layer()
                .with_target(true)
                .with_line_number(false)
                .with_ansi(false)
                .with_writer(writer)
        })
    };

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(console.then(|| {
            tracing_subscriber::fmt::layer()
                .with_target(true)
                .with_line_number(false)
        }))
        .with(file_layer)
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn tray_log_matches_daily_appender_and_preserves_content() {
        let dir = std::env::temp_dir().join(format!("vibearound-log-{}", uuid::Uuid::new_v4()));
        let now = chrono::Utc::now().date_naive();
        let path = prepare_log_file(&dir, now).unwrap();
        let mut appender = tracing_appender::rolling::daily(&dir, "vibearound.log");
        writeln!(appender, "tray log test").unwrap();
        appender.flush().unwrap();
        drop(appender);
        assert_eq!(prepare_log_file(&dir, now).unwrap(), path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "tray log test\n");

        let next = prepare_log_file(&dir, now.succ_opt().unwrap()).unwrap();
        assert_ne!(next, path);
        assert_eq!(std::fs::metadata(&next).unwrap().len(), 0);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(next).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn tray_log_reports_unusable_directory() {
        let path = std::env::temp_dir().join(format!("vibearound-log-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "not a directory").unwrap();
        assert!(prepare_log_file(&path, chrono::Utc::now().date_naive()).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
