//! Desktop-approved browser credentials, separate from the legacy IM/QR flows.
//! Only remembered credential hashes are persisted; pending exchanges and session
//! credentials disappear with the daemon. Every registry belongs to one daemon.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rand::{rngs::OsRng, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use super::AuthToken;

pub const PAIR_TTL_SECS: u64 = 120;
pub const SESSION_TTL_SECS: u64 = 24 * 60 * 60;
pub const REMEMBER_TTL_SECS: u64 = 30 * 24 * 60 * 60;
const MAX_PENDING: usize = 64;
const MAX_DEVICES: usize = 128;
const STARTS_PER_MINUTE: usize = 30;

pub fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Serialize)]
pub struct StartResponse {
    pub sid: String,
    pub code: String,
    pub expires_in: u64,
}

#[derive(Debug, Serialize)]
pub struct PendingRequest {
    pub id: String,
    pub code: String,
    pub label: String,
    pub remember: bool,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub label: String,
    pub remember: bool,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredDevice {
    #[serde(flatten)]
    info: DeviceInfo,
    token_hash: String,
}

struct Device {
    stored: StoredDevice,
    revoked: watch::Sender<bool>,
}

/// A socket's revocation subscription also expires without incoming traffic.
#[derive(Clone)]
pub struct DeviceAccess {
    pub info: DeviceInfo,
    revoked: watch::Receiver<bool>,
}

impl DeviceAccess {
    pub async fn cancelled(&mut self) {
        loop {
            let remaining = self.info.expires_at.saturating_sub(unix_seconds());
            if *self.revoked.borrow() || remaining == 0 {
                return;
            }
            tokio::select! {
                result = self.revoked.changed() => {
                    if result.is_err() { return; }
                }
                _ = tokio::time::sleep(Duration::from_secs(remaining)) => return,
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairStatus {
    Pending,
    Expired,
    Rejected,
    Verified {
        token: String,
        remember: bool,
        expires_at: u64,
    },
}

enum Decision {
    Pending,
    Rejected,
    Verified(String),
}

struct Pending {
    id: String,
    code: String,
    label: String,
    remember: bool,
    expires_at: u64,
    decision: Decision,
}

#[derive(Default)]
struct Inner {
    pending: BTreeMap<String, Pending>,
    devices: BTreeMap<String, Device>,
    starts: VecDeque<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum PairError {
    #[error("Too many browser pairing requests or devices")]
    Capacity,
    #[error("Pairing request expired or does not exist")]
    Expired,
    #[error("Pairing code does not match")]
    CodeMismatch,
    #[error("Pairing request was rejected")]
    Rejected,
    #[error("Unable to save browser devices")]
    Storage(#[from] anyhow::Error),
}

pub struct BrowserRegistry {
    inner: Mutex<Inner>,
    path: Option<PathBuf>,
    // Prevent two daemons from writing stale snapshots of the same registry.
    _file_lock: Option<crate::file_lock::ExclusiveFileLock>,
}

impl Default for BrowserRegistry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            path: None,
            _file_lock: None,
        }
    }
}

impl BrowserRegistry {
    pub fn load(path: PathBuf) -> anyhow::Result<Self> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Missing device directory"))?;
        std::fs::create_dir_all(parent)?;
        let lock = crate::file_lock::ExclusiveFileLock::acquire(&path.with_extension("lock"))?;
        let stored: Vec<StoredDevice> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            stored.len() <= MAX_DEVICES,
            "Too many stored browser devices"
        );
        let now = unix_seconds();
        let mut inner = Inner::default();
        for stored in stored {
            anyhow::ensure!(
                is_token(&stored.token_hash),
                "Invalid device credential hash"
            );
            if !stored.info.remember
                || stored.info.expires_at <= now
                || stored.info.expires_at > stored.info.created_at.saturating_add(REMEMBER_TTL_SECS)
            {
                continue;
            }
            let (revoked, _) = watch::channel(false);
            inner
                .devices
                .insert(stored.info.id.clone(), Device { stored, revoked });
        }
        Ok(Self {
            inner: Mutex::new(inner),
            path: Some(path),
            _file_lock: Some(lock),
        })
    }

    pub fn start(&self, remember: bool, label: String) -> Result<StartResponse, PairError> {
        self.start_at(remember, label, unix_seconds())
    }

    fn start_at(
        &self,
        remember: bool,
        label: String,
        now: u64,
    ) -> Result<StartResponse, PairError> {
        let mut inner = self.inner.lock();
        prune(&mut inner, now);
        while inner
            .starts
            .front()
            .is_some_and(|at| at.saturating_add(60) <= now)
        {
            inner.starts.pop_front();
        }
        if inner.pending.len() >= MAX_PENDING || inner.starts.len() >= STARTS_PER_MINUTE {
            return Err(PairError::Capacity);
        }
        let sid = AuthToken::generate().as_str().to_string();
        let code = loop {
            let candidate = format!("{:06}", OsRng.gen_range(0..1_000_000u32));
            if !inner.pending.values().any(|pending| pending.code == candidate) {
                break candidate;
            }
        };
        inner.pending.insert(
            sid.clone(),
            Pending {
                id: uuid::Uuid::new_v4().to_string(),
                code: code.clone(),
                label: label.chars().filter(|c| !c.is_control()).take(80).collect(),
                remember,
                expires_at: now.saturating_add(PAIR_TTL_SECS),
                decision: Decision::Pending,
            },
        );
        inner.starts.push_back(now);
        Ok(StartResponse {
            sid,
            code,
            expires_in: PAIR_TTL_SECS,
        })
    }

    pub fn requests(&self) -> Vec<PendingRequest> {
        let now = unix_seconds();
        let mut inner = self.inner.lock();
        prune(&mut inner, now);
        inner
            .pending
            .values()
            .filter(|pending| matches!(pending.decision, Decision::Pending))
            .map(|pending| PendingRequest {
                id: pending.id.clone(),
                code: pending.code.clone(),
                label: pending.label.clone(),
                remember: pending.remember,
                expires_in: pending.expires_at.saturating_sub(now),
            })
            .collect()
    }

    pub fn approve(&self, id: &str, code: &str) -> Result<(), PairError> {
        let now = unix_seconds();
        let mut inner = self.inner.lock();
        prune(&mut inner, now);
        let (sid, pending) = inner
            .pending
            .iter()
            .find(|(_, pending)| pending.id == id)
            .ok_or(PairError::Expired)?;
        if pending.code != code {
            return Err(PairError::CodeMismatch);
        }
        match pending.decision {
            Decision::Rejected => return Err(PairError::Rejected),
            Decision::Verified(_) => return Ok(()),
            Decision::Pending => {}
        }
        if inner.devices.len() >= MAX_DEVICES {
            return Err(PairError::Capacity);
        }
        let sid = sid.clone();
        let token = AuthToken::generate().as_str().to_string();
        let stored = StoredDevice {
            info: DeviceInfo {
                id: id.to_owned(),
                label: pending.label.clone(),
                remember: pending.remember,
                created_at: now,
                expires_at: now.saturating_add(if pending.remember {
                    REMEMBER_TTL_SECS
                } else {
                    SESSION_TTL_SECS
                }),
            },
            token_hash: hash_token(&token),
        };
        if stored.info.remember {
            self.persist(
                inner
                    .devices
                    .values()
                    .map(|d| &d.stored)
                    .chain(std::iter::once(&stored)),
            )?;
        }
        let (revoked, _) = watch::channel(false);
        inner
            .devices
            .insert(id.to_owned(), Device { stored, revoked });
        inner
            .pending
            .get_mut(&sid)
            .expect("pending remains locked")
            .decision = Decision::Verified(token);
        Ok(())
    }

    pub fn reject(&self, id: &str) -> Result<(), PairError> {
        let mut inner = self.inner.lock();
        prune(&mut inner, unix_seconds());
        let pending = inner
            .pending
            .values_mut()
            .find(|p| p.id == id)
            .ok_or(PairError::Expired)?;
        if matches!(pending.decision, Decision::Verified(_)) {
            return Err(PairError::Expired);
        }
        pending.decision = Decision::Rejected;
        Ok(())
    }

    pub fn status(&self, sid: &str) -> PairStatus {
        let mut inner = self.inner.lock();
        prune(&mut inner, unix_seconds());
        let Some(pending) = inner.pending.get(sid) else {
            return PairStatus::Expired;
        };
        match &pending.decision {
            Decision::Pending => PairStatus::Pending,
            Decision::Rejected => PairStatus::Rejected,
            Decision::Verified(token) => match inner.devices.get(&pending.id) {
                Some(device) => PairStatus::Verified {
                    token: token.clone(),
                    remember: device.stored.info.remember,
                    expires_at: device.stored.info.expires_at,
                },
                None => PairStatus::Expired,
            },
        }
    }

    pub fn authenticate(&self, token: &str) -> Option<DeviceAccess> {
        if !is_token(token) {
            return None;
        }
        let hash = hash_token(token);
        let mut inner = self.inner.lock();
        prune(&mut inner, unix_seconds());
        inner
            .devices
            .values()
            .find(|device| hash_matches(&device.stored.token_hash, &hash))
            .map(|device| DeviceAccess {
                info: device.stored.info.clone(),
                revoked: device.revoked.subscribe(),
            })
    }

    pub fn devices(&self) -> Vec<DeviceInfo> {
        let mut inner = self.inner.lock();
        prune(&mut inner, unix_seconds());
        inner
            .devices
            .values()
            .map(|device| device.stored.info.clone())
            .collect()
    }

    pub fn revoke(&self, id: &str) -> Result<(), PairError> {
        let mut inner = self.inner.lock();
        // Persist before invalidating memory or reporting success, including
        // expired records that may still exist in the on-disk snapshot.
        self.persist(
            inner
                .devices
                .values()
                .filter(|d| d.stored.info.id != id)
                .map(|d| &d.stored),
        )?;
        if let Some(device) = inner.devices.remove(id) {
            device.revoked.send_replace(true);
        }
        Ok(())
    }

    fn persist<'a>(
        &self,
        devices: impl Iterator<Item = &'a StoredDevice>,
    ) -> Result<(), PairError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let now = unix_seconds();
        let devices = devices
            .filter(|d| d.info.remember && d.info.expires_at > now)
            .collect::<Vec<_>>();
        crate::file_replace::write_private(
            path,
            serde_json::to_vec(&devices).map_err(anyhow::Error::from)?,
        )?;
        Ok(())
    }
}

fn prune(inner: &mut Inner, now: u64) {
    inner.pending.retain(|_, p| p.expires_at > now);
    inner.devices.retain(|_, device| {
        if device.stored.info.expires_at > now {
            return true;
        }
        device.revoked.send_replace(true);
        false
    });
}

fn is_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn hash_matches(expected: &str, actual: &str) -> bool {
    expected.len() == actual.len()
        && expected
            .bytes()
            .zip(actual.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(registry: &BrowserRegistry, remember: bool) -> (String, String, String) {
        let start = registry
            .start(remember, "Chrome on Android".into())
            .unwrap();
        let id = registry
            .requests()
            .into_iter()
            .find(|p| p.code == start.code)
            .unwrap()
            .id;
        registry.approve(&id, &start.code).unwrap();
        let PairStatus::Verified { token, .. } = registry.status(&start.sid) else {
            panic!("not verified")
        };
        (id, start.sid, token)
    }

    #[test]
    fn exact_approval_is_atomic_and_status_is_idempotent() {
        let registry = BrowserRegistry::default();
        let start = registry.start(false, "Phone".into()).unwrap();
        assert_eq!(start.sid.len(), 64);
        assert_eq!(start.code.len(), 6);
        let id = registry.requests()[0].id.clone();
        assert_ne!(id, start.sid);
        assert!(matches!(
            registry.approve(&id, "wrong"),
            Err(PairError::CodeMismatch)
        ));
        assert!(matches!(
            registry.approve("wrong", &start.code),
            Err(PairError::Expired)
        ));
        assert_eq!(registry.status(&start.sid), PairStatus::Pending);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| registry.approve(&id, &start.code).unwrap());
            }
        });
        let status = registry.status(&start.sid);
        assert_eq!(status, registry.status(&start.sid));
        assert_eq!(registry.devices().len(), 1);
        let PairStatus::Verified { token, .. } = status else {
            panic!("not verified")
        };
        assert_ne!(token, start.sid);
        assert!(registry.authenticate(&token).is_some());
        assert!(registry.authenticate(&start.sid).is_none());
        registry.revoke(&id).unwrap();
        assert_eq!(registry.status(&start.sid), PairStatus::Expired);
        assert!(registry.authenticate(&token).is_none());
    }

    #[test]
    fn rejection_expiry_and_rate_limit_are_enforced() {
        let registry = BrowserRegistry::default();
        let start = registry.start(false, "Phone".into()).unwrap();
        registry.reject(&registry.requests()[0].id).unwrap();
        assert_eq!(registry.status(&start.sid), PairStatus::Rejected);
        let expired = registry
            .start_at(false, "Old".into(), unix_seconds() - PAIR_TTL_SECS)
            .unwrap();
        assert_eq!(registry.status(&expired.sid), PairStatus::Expired);
        let limited = BrowserRegistry::default();
        for _ in 0..STARTS_PER_MINUTE {
            limited.start(false, "Phone".into()).unwrap();
        }
        let requests = limited.requests();
        let codes = requests.iter().map(|request| &request.code).collect::<std::collections::BTreeSet<_>>();
        assert_eq!(codes.len(), requests.len());
        assert!(matches!(
            limited.start(false, "Phone".into()),
            Err(PairError::Capacity)
        ));
        assert_eq!(limited.status("unknown"), PairStatus::Expired);
    }

    #[test]
    fn only_remembered_hashes_survive_restart_and_revoke() {
        let dir = std::env::temp_dir().join(format!("va-browser-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("browser-devices.json");
        let registry = BrowserRegistry::load(path.clone()).unwrap();
        let (id, _, remembered) = issue(&registry, true);
        let (_, _, session) = issue(&registry, false);
        let bytes = std::fs::read_to_string(&path).unwrap();
        assert!(!bytes.contains(&remembered));
        assert!(!bytes.contains(&session));
        assert!(bytes.contains(&hash_token(&remembered)));
        assert_eq!(registry.devices().len(), 2);
        drop(registry);
        let registry = BrowserRegistry::load(path.clone()).unwrap();
        assert!(registry.authenticate(&remembered).is_some());
        assert!(registry.authenticate(&session).is_none());
        registry.revoke(&id).unwrap();
        drop(registry);
        let registry = BrowserRegistry::load(path).unwrap();
        assert!(registry.authenticate(&remembered).is_none());
        drop(registry);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn revocation_and_expiry_wake_existing_socket_subscriptions() {
        let registry = BrowserRegistry::default();
        let (id, _, token) = issue(&registry, false);
        let mut access = registry.authenticate(&token).unwrap();
        registry.revoke(&id).unwrap();
        tokio::time::timeout(Duration::from_millis(100), access.cancelled())
            .await
            .unwrap();
        let (_, _, token) = issue(&registry, false);
        let mut access = registry.authenticate(&token).unwrap();
        access.info.expires_at = unix_seconds();
        tokio::time::timeout(Duration::from_millis(100), access.cancelled())
            .await
            .unwrap();
    }

    #[test]
    fn registries_are_isolated_and_expired_devices_cannot_authenticate() {
        let registry = BrowserRegistry::default();
        let (id, _, token) = issue(&registry, false);
        let info = registry.devices()[0].clone();
        assert_eq!(info.expires_at - info.created_at, SESSION_TTL_SECS);
        assert!(BrowserRegistry::default().authenticate(&token).is_none());
        registry.inner.lock().devices.get_mut(&id).unwrap().stored.info.expires_at = unix_seconds();
        assert!(registry.authenticate(&token).is_none());
        assert!(registry.devices().is_empty());
        let (_, _, token) = issue(&registry, true);
        let info = registry.authenticate(&token).unwrap().info;
        assert_eq!(info.expires_at - info.created_at, REMEMBER_TTL_SECS);
    }

    #[test]
    fn failed_persistence_does_not_issue_or_revoke_credentials() {
        let dir = std::env::temp_dir().join(format!("va-browser-failure-{}", uuid::Uuid::new_v4()));
        let path = dir.join("browser-devices.json");
        let registry = BrowserRegistry::load(path.clone()).unwrap();
        let (id, _, token) = issue(&registry, true);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(registry.revoke(&id).is_err());
        assert!(registry.authenticate(&token).is_some());
        let start = registry.start(true, "Phone".into()).unwrap();
        let pending_id = registry.requests()[0].id.clone();
        assert!(registry.approve(&pending_id, &start.code).is_err());
        assert_eq!(registry.status(&start.sid), PairStatus::Pending);
        assert_eq!(registry.devices().len(), 1);
        drop(registry);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
