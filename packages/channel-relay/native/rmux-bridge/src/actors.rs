//! Process-owned RMUX session actors backed by public `rmux-sdk` 0.10.0 APIs.
//!
//! Create path (no rmux patches):
//! 1. `OwnedSession` with `KillOnOwnerExit` + lease TTL
//! 2. `new_window_with().cwd(...)` for the work pane, with the POSIX
//!    application terminal dialect pinned to `TERM=xterm-256color`
//! 3. close default window 0
//! 4. resize the work window + set `history-limit` on the stable pane id

use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rmux_sdk::{
    CleanupPolicy, NewWindowBuilder, OwnedSession, PaneId, PaneRecoveryEvent,
    PaneRecoveryRebaseReason, Rmux, RmuxBuilder, SessionName,
};
use tokio::sync::{mpsc, Mutex};

use crate::protocol::{
    encode_b64, encode_rebase_events, redact_error_message, InventoryEntryDto, RecoveryEventDto,
    ServerMessage, BRIDGE_VERSION, RECOVERY_STREAM_ENDED_CODE, RECOVERY_STREAM_FAILED_CODE,
};

/// Bound Recover startup (`pane_by_id` + `recover_output` + first Rebase) so a
/// pending stream cannot stall the Recover RPC forever. Kept under the Node
/// sidecar request timeout (15s). Recover itself is dispatched off the stdin
/// loop so other panes are not queued behind this wait.
const INITIAL_REBASE_TIMEOUT: Duration = Duration::from_secs(10);

/// Terminal dialect advertised to POSIX applications whose RMUX raw recovery
/// stream is replayed by relay-web's xterm.js renderer.
///
/// This is an end-to-end renderer contract, not RMUX's daemon terminal type.
/// Keeping application output on the xterm dialect prevents screen/tmux-only
/// control strings from reaching a renderer that does not implement them.
const POSIX_WEB_TERMINAL_DIALECT: &str = "xterm-256color";
const POSIX_WEB_TERMINAL_DIALECT_CAPABILITY: &str =
    "terminal.posix-dialect.xterm-256color.v1";
const RMUX_ENDPOINT_LABEL_PREFIX: &str = "xacpx-relay";
const RMUX_ENDPOINT_LABEL_ENV: &str = "XACPX_RMUX_ENDPOINT_LABEL";

pub struct BridgeState {
    rmux: Rmux,
    daemon: Mutex<DaemonLifecycle>,
    sessions: Mutex<HashMap<String, SessionActor>>,
    panes: Mutex<HashMap<String, String>>, // pane_id → session_id
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DaemonLifecycle {
    Dormant,
    Live,
    Empty,
    Shutdown,
}

struct SessionActor {
    owned: OwnedSession,
    session_id: String,
    pane_id: String,
    window_index: u32,
    name: String,
    tags: Vec<String>,
    recover_abort: Option<tokio::task::JoinHandle<()>>,
}

pub async fn connect_bridge() -> Result<Arc<BridgeState>, String> {
    let pid = std::process::id();
    let startup_nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("rmux endpoint clock failed: {e}"))?
        .as_nanos();
    let label = match env::var_os(RMUX_ENDPOINT_LABEL_ENV) {
        Some(value) => validate_endpoint_label(value.into_string().map_err(|_| {
            "rmux endpoint label must be valid Unicode".to_owned()
        })?)?,
        None => process_scoped_endpoint_label(pid, startup_nonce),
    };
    new_bridge_state_for_label(&label)
}

#[cfg(test)]
fn new_bridge_state(pid: u32, startup_nonce: u128) -> Result<Arc<BridgeState>, String> {
    let label = process_scoped_endpoint_label(pid, startup_nonce);
    new_bridge_state_for_label(&label)
}

fn new_bridge_state_for_label(label: &str) -> Result<Arc<BridgeState>, String> {
    let rmux = rmux_builder_for_label(label)?.build();
    Ok(Arc::new(BridgeState {
        rmux,
        daemon: Mutex::new(DaemonLifecycle::Dormant),
        sessions: Mutex::new(HashMap::new()),
        panes: Mutex::new(HashMap::new()),
    }))
}

#[cfg(test)]
fn process_scoped_rmux_builder(pid: u32, startup_nonce: u128) -> Result<RmuxBuilder, String> {
    let label = process_scoped_endpoint_label(pid, startup_nonce);
    rmux_builder_for_label(&label)
}

fn process_scoped_endpoint_label(pid: u32, startup_nonce: u128) -> String {
    format!("{RMUX_ENDPOINT_LABEL_PREFIX}-{pid}-{startup_nonce:x}")
}

fn validate_endpoint_label(label: String) -> Result<String, String> {
    if label.is_empty()
        || label.len() > 96
        || !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            "rmux endpoint label must contain only ASCII letters, digits, '-' or '_' and be at most 96 bytes"
                .to_owned(),
        );
    }
    Ok(label)
}

fn rmux_builder_for_label(label: &str) -> Result<RmuxBuilder, String> {
    let endpoint = rmux_ipc::endpoint_for_label(label)
        .map_err(|e| format!("rmux endpoint resolution failed: {e}"))?;
    let builder = Rmux::builder().default_timeout(Duration::from_secs(15));

    #[cfg(unix)]
    {
        Ok(builder.unix_socket(endpoint.into_path()))
    }
    #[cfg(windows)]
    {
        Ok(builder.windows_pipe(
            endpoint
                .as_path()
                .as_os_str()
                .to_string_lossy()
                .into_owned(),
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (builder, endpoint);
        Err("RMUX endpoint isolation is unsupported on this platform".to_owned())
    }
}

impl BridgeState {
    async fn ensure_daemon(&self) -> Result<(), String> {
        let mut lifecycle = self.daemon.lock().await;
        match *lifecycle {
            DaemonLifecycle::Live => return Ok(()),
            DaemonLifecycle::Shutdown => return Err("rmux bridge is shutting down".to_owned()),
            DaemonLifecycle::Dormant | DaemonLifecycle::Empty => {}
        }

        let connected = Rmux::builder()
            .endpoint(self.rmux.endpoint().clone())
            .default_timeout(Duration::from_secs(15))
            .connect_or_start()
            .await
            .map_err(|e| format!("rmux connect failed: {e}"))?;
        drop(connected);
        *lifecycle = DaemonLifecycle::Live;
        Ok(())
    }

    async fn daemon_is_live(&self) -> bool {
        *self.daemon.lock().await == DaemonLifecycle::Live
    }

    #[cfg(test)]
    async fn daemon_lifecycle(&self) -> DaemonLifecycle {
        *self.daemon.lock().await
    }

    pub async fn create(
        &self,
        name: String,
        cwd: String,
        cols: u16,
        rows: u16,
        history_limit: u32,
        tags: Vec<String>,
        owner_lease_ttl_seconds: u32,
    ) -> Result<(String, String, String, Vec<String>), String> {
        self.ensure_daemon().await?;
        {
            let sessions = self.sessions.lock().await;
            if sessions.values().any(|s| s.name == name) {
                return Err(format!("session name already in use: {name}"));
            }
        }

        let session_name =
            SessionName::new(&name).map_err(|e| format!("invalid session name: {e}"))?;
        let ttl = Duration::from_secs(u64::from(owner_lease_ttl_seconds.max(15)));

        let mut owned = self
            .rmux
            .owned_session(session_name)
            .cleanup_policy(CleanupPolicy::KillOnOwnerExit)
            .lease_ttl(ttl)
            .await
            .map_err(|e| format!("owned_session create failed: {e}"))?;

        let work_builder = owned
            .new_window_with()
            .name("shell")
            .cwd(PathBuf::from(&cwd));
        let work_builder =
            apply_production_work_window_env(work_builder, std::env::consts::FAMILY);
        let work = match work_builder.await {
            Ok(w) => w,
            Err(e) => {
                let _ = owned.cleanup().await;
                return Err(format!("new_window failed: {e}"));
            }
        };
        let work_window_index = work.target().window_index;

        let _ = owned.window(0).close().await;

        // Pane::resize changes a pane inside the current window layout; it
        // cannot grow a single-pane window beyond the window's own geometry.
        // relay-web needs the PTY/window itself to match the browser viewport,
        // so use the SDK's authoritative ResizeWindow request instead.
        if let Err(e) = work.resize(Some(cols), Some(rows)).await {
            let _ = owned.cleanup().await;
            return Err(format!("window resize failed: {e}"));
        }

        let panes = match work.panes().await {
            Ok(p) => p,
            Err(e) => {
                let _ = owned.cleanup().await;
                return Err(format!("list panes failed: {e}"));
            }
        };
        let pane_meta = match panes.into_iter().next() {
            Some(p) => p,
            None => {
                let _ = owned.cleanup().await;
                return Err("work window has no pane".to_owned());
            }
        };
        let pane_id = pane_meta.id;
        let pane = match owned.pane_by_id(pane_id).await {
            Ok(p) => p,
            Err(e) => {
                let _ = owned.cleanup().await;
                return Err(format!("pane_by_id failed: {e}"));
            }
        };
        let _ = pane
            .set_option("history-limit", history_limit.to_string())
            .await;

        // Durable identity key: unique RMUX session name (never reused).
        let session_id = name.clone();
        let pane_id_str = format!("{pane_id}");

        let actor = SessionActor {
            owned,
            session_id: session_id.clone(),
            pane_id: pane_id_str.clone(),
            window_index: work_window_index,
            name: name.clone(),
            tags: tags.clone(),
            recover_abort: None,
        };

        self.panes
            .lock()
            .await
            .insert(pane_id_str.clone(), session_id.clone());
        self.sessions.lock().await.insert(session_id.clone(), actor);

        Ok((session_id, pane_id_str, name, tags))
    }

    pub async fn list(&self) -> Vec<InventoryEntryDto> {
        if !self.daemon_is_live().await {
            return Vec::new();
        }
        let sessions = self.sessions.lock().await;
        let mut entries: Vec<InventoryEntryDto> = sessions
            .values()
            .map(|s| InventoryEntryDto {
                session_id: s.session_id.clone(),
                pane_id: s.pane_id.clone(),
                name: s.name.clone(),
                tags: s.tags.clone(),
            })
            .collect();
        drop(sessions);

        // Also surface daemon-wide xacpx-relay-* names so a maintenance
        // sidecar can reconcile leftovers owned by another process.
        if let Ok(names) = self.rmux.list_sessions().await {
            let known: std::collections::HashSet<String> =
                entries.iter().map(|e| e.session_id.clone()).collect();
            for name in names {
                let name_str = name.as_str().to_owned();
                if !name_str.starts_with("xacpx-relay-") || known.contains(&name_str) {
                    continue;
                }
                entries.push(InventoryEntryDto {
                    session_id: name_str.clone(),
                    pane_id: String::new(),
                    name: name_str,
                    tags: Vec::new(),
                });
            }
        }
        entries
    }

    pub async fn kill(&self, session_id: &str) -> Result<(), String> {
        if !self.daemon_is_live().await {
            return Ok(());
        }
        let mut sessions = self.sessions.lock().await;
        if let Some(mut actor) = sessions.remove(session_id) {
            if let Some(handle) = actor.recover_abort.take() {
                handle.abort();
            }
            self.panes.lock().await.remove(&actor.pane_id);
            let _ = actor.owned.cleanup().await;
            let became_empty = sessions.is_empty();
            drop(sessions);
            if became_empty {
                let mut lifecycle = self.daemon.lock().await;
                if *lifecycle == DaemonLifecycle::Live {
                    *lifecycle = DaemonLifecycle::Empty;
                }
            }
            return Ok(());
        }
        drop(sessions);

        // Temporary/maintenance sidecars do not hold the daemon process's
        // OwnedSession map. Still force-kill by durable name (we store the
        // unique RMUX session name as session_id) so disable/remove cannot
        // leave a live shell behind after a false inventory miss.
        let name = SessionName::new(session_id)
            .map_err(|e| format!("invalid session name for kill: {e}"))?;
        match self.rmux.has_session(name.clone()).await {
            Ok(false) => Ok(()), // already gone — idempotent
            Ok(true) => {
                let session = self
                    .rmux
                    .session(name)
                    .await
                    .map_err(|e| format!("session lookup for kill failed: {e}"))?;
                let _ = session
                    .kill()
                    .await
                    .map_err(|e| format!("foreign session kill failed: {e}"))?;
                Ok(())
            }
            Err(e) => Err(format!("has_session failed: {e}")),
        }
    }

    pub async fn input(&self, pane_id: &str, bytes: &[u8]) -> Result<(), String> {
        let text = std::str::from_utf8(bytes).map_err(|_| "input must be valid UTF-8".to_owned())?;
        let pane_id_parsed = parse_pane_id(pane_id)?;
        let session_id = self
            .panes
            .lock()
            .await
            .get(pane_id)
            .cloned()
            .ok_or_else(|| format!("pane not found: {pane_id}"))?;
        let sessions = self.sessions.lock().await;
        let actor = sessions
            .get(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        let pane = actor
            .owned
            .pane_by_id(pane_id_parsed)
            .await
            .map_err(|e| format!("pane_by_id failed: {e}"))?;
        pane.send_text(text)
            .await
            .map_err(|e| format!("send_text failed: {e}"))?;
        Ok(())
    }

    pub async fn resize(&self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session_id = self
            .panes
            .lock()
            .await
            .get(pane_id)
            .cloned()
            .ok_or_else(|| format!("pane not found: {pane_id}"))?;
        let sessions = self.sessions.lock().await;
        let actor = sessions
            .get(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        actor
            .owned
            .window(actor.window_index)
            .resize(Some(cols), Some(rows))
            .await
            .map_err(|e| format!("window resize failed: {e}"))?;
        Ok(())
    }

    pub async fn start_recover(
        self: &Arc<Self>,
        pane_id: String,
        out_tx: &mpsc::Sender<ServerMessage>,
    ) -> Result<(), String> {
        let pane_id_parsed = parse_pane_id(&pane_id)?;
        let session_id = self
            .panes
            .lock()
            .await
            .get(&pane_id)
            .cloned()
            .ok_or_else(|| format!("pane not found: {pane_id}"))?;

        let (mut stream, first_dtos) = with_initial_rebase_deadline(async {
            let mut stream = {
                let mut sessions = self.sessions.lock().await;
                let actor = sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| format!("session not found: {session_id}"))?;
                if let Some(prev) = actor.recover_abort.take() {
                    // Explicit recover always restarts. Node only sends recover from
                    // the pane start barrier (never for a late live viewer).
                    prev.abort();
                    let _ = prev.await;
                }
                let pane = actor
                    .owned
                    .pane_by_id(pane_id_parsed)
                    .await
                    .map_err(|e| format!("pane_by_id failed: {e}"))?;
                pane.recover_output()
                    .await
                    .map_err(|e| format!("recover_output failed: {e}"))?
            };

            // Recover RPC succeeds only after the initial Rebase. A spawned task
            // can still exit on the first next(); waiting here makes "OK" mean
            // the authority snapshot exists, not merely that a task was spawned.
            let first_dtos = loop {
                match stream.next().await {
                    Ok(Some(event)) => match classify_startup_event(event) {
                        StartupPoll::Skip => continue,
                        StartupPoll::Ready(dtos) => break dtos,
                        StartupPoll::Failed(message) => return Err(message),
                    },
                    Ok(None) => {
                        return Err("recovery stream ended before initial rebase".to_owned());
                    }
                    Err(err) => {
                        return Err(format!("recover_output failed: {err}"));
                    }
                }
            };
            Ok((stream, first_dtos))
        })
        .await?;

        // Queue the snapshot on the stdout channel *before* spawning the
        // follow-up reader, and have that reader use the same channel. Bytes
        // cannot enter out_tx until after this send completes.
        for dto in first_dtos {
            out_tx
                .send(ServerMessage::Event {
                    pane_id: pane_id.clone(),
                    event: dto,
                })
                .await
                .map_err(|_| "stdout closed during recover start".to_owned())?;
        }

        let out_tx_follow = out_tx.clone();
        let pane_id_for_task = pane_id.clone();
        let handle = tokio::spawn(async move {
            loop {
                match stream.next().await {
                    Ok(Some(event)) => {
                        let ended = followup_event_ends_reader(&event);
                        let dtos = map_recovery_events(event);
                        let mut send_failed = false;
                        for dto in dtos {
                            if out_tx_follow
                                .send(ServerMessage::Event {
                                    pane_id: pane_id_for_task.clone(),
                                    event: dto,
                                })
                                .await
                                .is_err()
                            {
                                send_failed = true;
                                break;
                            }
                        }
                        if ended || send_failed {
                            break;
                        }
                    }
                    other => {
                        let dto = match other {
                            Ok(None) => unexpected_stream_end_event(),
                            Err(err) => stream_transport_error_event(&format!("{err}")),
                            Ok(Some(_)) => unreachable!(),
                        };
                        let _ = out_tx_follow
                            .send(ServerMessage::Event {
                                pane_id: pane_id_for_task,
                                event: dto,
                            })
                            .await;
                        break;
                    }
                }
            }
        });

        {
            let mut sessions = self.sessions.lock().await;
            match sessions.get_mut(&session_id) {
                Some(actor) => actor.recover_abort = Some(handle),
                None => {
                    handle.abort();
                    return Err("session gone during recover start".to_owned());
                }
            }
        }

        Ok(())
    }

    pub async fn stop_recover(&self, pane_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let Some(session_id) = self.panes.lock().await.get(pane_id).cloned() else {
            return Ok(());
        };
        if let Some(actor) = sessions.get_mut(&session_id) {
            if let Some(handle) = actor.recover_abort.take() {
                handle.abort();
            }
        }
        Ok(())
    }

    pub async fn shutdown_all(&self) {
        let should_shutdown = {
            let mut lifecycle = self.daemon.lock().await;
            match *lifecycle {
                DaemonLifecycle::Dormant => {
                    *lifecycle = DaemonLifecycle::Shutdown;
                    false
                }
                DaemonLifecycle::Live | DaemonLifecycle::Empty => {
                    *lifecycle = DaemonLifecycle::Shutdown;
                    true
                }
                DaemonLifecycle::Shutdown => false,
            }
        };
        if !should_shutdown {
            return;
        }

        {
            let mut sessions = self.sessions.lock().await;
            for actor in sessions.values_mut() {
                if let Some(handle) = actor.recover_abort.take() {
                    handle.abort();
                }
            }
        }

        let builder = Rmux::builder()
            .endpoint(self.rmux.endpoint().clone())
            .default_timeout(Duration::from_secs(15));
        let Ok(rmux) = builder.connect().await else {
            return;
        };
        if let Err(err) = rmux.shutdown().await {
            eprintln!("xacpx-rmux-bridge daemon shutdown failed: {err}");
        }
    }

    pub fn diagnostics(&self) -> (String, String, Vec<String>) {
        (
            BRIDGE_VERSION.to_owned(),
            "0.10.0".to_owned(),
            bridge_capabilities(std::env::consts::FAMILY),
        )
    }
}

fn bridge_capabilities(family: &str) -> Vec<String> {
    let mut capabilities = vec![
        "terminal.rmux.recovery.v1".to_owned(),
        "terminal.multi-view.v1".to_owned(),
        "process-owned.v1".to_owned(),
    ];
    if family == "unix" {
        capabilities.push(POSIX_WEB_TERMINAL_DIALECT_CAPABILITY.to_owned());
    }
    capabilities
}

/// Process environment overrides for xacpx-created shell work windows.
///
/// `family` is [`std::env::consts::FAMILY`] (`unix`, `windows`, ...).
///
/// RMUX recovery deliberately forwards the pane's raw terminal bytes to
/// relay-web, so the shell application and the browser renderer must agree on
/// one terminal dialect. relay-web uses xterm.js; therefore POSIX work panes
/// advertise `xterm-256color` rather than inheriting RMUX's `tmux-256color` or
/// using the previous macOS-only `screen-256color` fallback. That keeps title
/// integration and other terminal-control choices on xterm-compatible
/// sequences end to end. Windows does not use the POSIX TERM contract.
fn production_work_window_env(family: &str) -> Vec<(&'static str, &'static str)> {
    match family {
        "unix" => vec![("TERM", POSIX_WEB_TERMINAL_DIALECT)],
        _ => Vec::new(),
    }
}

fn apply_production_work_window_env<'a>(
    mut builder: NewWindowBuilder<'a>,
    family: &str,
) -> NewWindowBuilder<'a> {
    for (key, value) in production_work_window_env(family) {
        builder = builder.env(key, value);
    }
    builder
}

fn parse_pane_id(raw: &str) -> Result<PaneId, String> {
    let trimmed = raw.trim().trim_start_matches('%');
    let n: u32 = trimmed
        .parse()
        .map_err(|_| format!("invalid pane id: {raw}"))?;
    Ok(PaneId::new(n))
}

enum StartupPoll {
    Skip,
    Ready(Vec<RecoveryEventDto>),
    Failed(String),
}

fn classify_startup_event(event: PaneRecoveryEvent) -> StartupPoll {
    match event {
        PaneRecoveryEvent::Lifecycle(_) => StartupPoll::Skip,
        PaneRecoveryEvent::End(_) => {
            StartupPoll::Failed("recovery ended before initial rebase".to_owned())
        }
        PaneRecoveryEvent::Bytes { .. } => {
            StartupPoll::Failed("recovery started with bytes instead of rebase".to_owned())
        }
        PaneRecoveryEvent::Rebase(_) => {
            let dtos = map_recovery_events(event);
            if let Some(message) = dtos.iter().find_map(|d| match d {
                RecoveryEventDto::Error { message, .. } => Some(message.clone()),
                _ => None,
            }) {
                StartupPoll::Failed(message)
            } else if dtos.is_empty() {
                StartupPoll::Failed("initial rebase produced no events".to_owned())
            } else {
                StartupPoll::Ready(dtos)
            }
        }
        _ => StartupPoll::Skip,
    }
}

fn map_recovery_events(event: PaneRecoveryEvent) -> Vec<RecoveryEventDto> {
    match event {
        PaneRecoveryEvent::Rebase(rebase) => encode_rebase_events(
            rebase.epoch,
            rebase.next_sequence,
            rebase.cols,
            rebase.rows,
            rebase.alternate,
            &rebase.keyframe,
            Some(rebase_reason_name(rebase.reason).to_owned()),
        )
        .unwrap_or_else(|err| {
            vec![RecoveryEventDto::Error {
                code: "rebase-too-large".to_owned(),
                message: err,
            }]
        }),
        PaneRecoveryEvent::Bytes {
            epoch,
            sequence,
            bytes,
        } => vec![RecoveryEventDto::Bytes {
            epoch,
            sequence,
            data_base64: encode_b64(&bytes),
        }],
        PaneRecoveryEvent::End(_) => vec![RecoveryEventDto::Exit { code: None }],
        PaneRecoveryEvent::Lifecycle(_) => Vec::new(),
        _ => Vec::new(),
    }
}

fn rebase_reason_name(reason: PaneRecoveryRebaseReason) -> &'static str {
    match reason {
        PaneRecoveryRebaseReason::Initial => "initial",
        PaneRecoveryRebaseReason::Resize => "resize",
        PaneRecoveryRebaseReason::ClearHistory => "clear-history",
        PaneRecoveryRebaseReason::Lag => "lag",
        PaneRecoveryRebaseReason::GenerationChanged => "generation-changed",
        _ => "other",
    }
}

fn followup_event_ends_reader(event: &PaneRecoveryEvent) -> bool {
    matches!(event, PaneRecoveryEvent::End(_))
}

fn unexpected_stream_end_event() -> RecoveryEventDto {
    RecoveryEventDto::Error {
        code: RECOVERY_STREAM_ENDED_CODE.to_owned(),
        message: "recovery stream ended unexpectedly".to_owned(),
    }
}

fn stream_transport_error_event(err: &str) -> RecoveryEventDto {
    RecoveryEventDto::Error {
        code: RECOVERY_STREAM_FAILED_CODE.to_owned(),
        message: redact_error_message(&format!("recover_output failed: {err}")),
    }
}

async fn with_initial_rebase_deadline<T>(
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match tokio::time::timeout(INITIAL_REBASE_TIMEOUT, fut).await {
        Ok(inner) => inner,
        Err(_) => Err("recovery timed out waiting for initial rebase".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmux_sdk::PaneStreamEndReason;

    #[test]
    fn unix_work_window_uses_xterm_renderer_dialect() {
        assert_eq!(
            production_work_window_env("unix"),
            vec![("TERM", "xterm-256color")]
        );
    }

    #[test]
    fn unix_work_window_does_not_advertise_screen_or_tmux_dialect() {
        let term = production_work_window_env("unix")
            .into_iter()
            .find_map(|(key, value)| (key == "TERM").then_some(value))
            .expect("unix work window must set TERM");
        assert!(!term.starts_with("screen"));
        assert!(!term.starts_with("tmux"));
        assert!(term.starts_with("xterm"));
    }

    #[test]
    fn windows_work_window_does_not_inject_posix_term() {
        assert!(production_work_window_env("windows").is_empty());
    }

    #[test]
    fn host_work_window_env_matches_renderer_contract() {
        let env = production_work_window_env(std::env::consts::FAMILY);
        #[cfg(unix)]
        assert_eq!(env, vec![("TERM", POSIX_WEB_TERMINAL_DIALECT)]);
        #[cfg(windows)]
        assert!(env.is_empty());
    }

    #[test]
    fn bridge_capabilities_publish_renderer_dialect_only_on_posix() {
        assert!(bridge_capabilities("unix")
            .iter()
            .any(|value| value == POSIX_WEB_TERMINAL_DIALECT_CAPABILITY));
        assert!(!bridge_capabilities("windows")
            .iter()
            .any(|value| value == POSIX_WEB_TERMINAL_DIALECT_CAPABILITY));
        assert_eq!(
            POSIX_WEB_TERMINAL_DIALECT_CAPABILITY,
            "terminal.posix-dialect.xterm-256color.v1"
        );
    }

    #[test]
    fn bridge_rmux_endpoint_is_process_scoped_instead_of_default() {
        let first = process_scoped_rmux_builder(42, 0xabc).expect("process endpoint");
        let second = process_scoped_rmux_builder(42, 0xdef).expect("process endpoint");

        assert!(!first.configured_endpoint().is_default());
        assert!(!second.configured_endpoint().is_default());
        assert_ne!(first.configured_endpoint(), second.configured_endpoint());
        assert!(format!("{:?}", first.configured_endpoint()).contains("xacpx-relay-42-abc"));
    }

    #[test]
    fn injected_endpoint_label_rejects_paths_and_accepts_supervisor_labels() {
        assert!(validate_endpoint_label("../default".to_owned()).is_err());
        assert!(validate_endpoint_label("xacpx-relay-42_nonce".to_owned()).is_ok());
    }

    #[tokio::test]
    async fn bridge_stays_dormant_until_terminal_work_and_dormant_shutdown_starts_nothing() {
        let bridge = new_bridge_state(42, 0xabc).expect("bridge state");

        assert_eq!(bridge.daemon_lifecycle().await, DaemonLifecycle::Dormant);
        assert!(bridge.list().await.is_empty());
        assert_eq!(bridge.daemon_lifecycle().await, DaemonLifecycle::Dormant);
        bridge.shutdown_all().await;
        assert_eq!(bridge.daemon_lifecycle().await, DaemonLifecycle::Shutdown);
    }

    #[test]
    fn startup_rejects_bytes_before_rebase() {
        let event = PaneRecoveryEvent::Bytes {
            epoch: 1,
            sequence: 0,
            bytes: b"x".to_vec(),
        };
        match classify_startup_event(event) {
            StartupPoll::Failed(message) => {
                assert!(message.contains("bytes instead of rebase"), "{message}");
            }
            StartupPoll::Skip => panic!("expected Failed, got Skip"),
            StartupPoll::Ready(_) => panic!("expected Failed, got Ready"),
        }
    }

    #[test]
    fn startup_rejects_end_before_rebase() {
        let event = PaneRecoveryEvent::End(PaneStreamEndReason::PaneRemoved);
        match classify_startup_event(event) {
            StartupPoll::Failed(message) => {
                assert!(message.contains("ended before initial rebase"), "{message}");
            }
            StartupPoll::Skip => panic!("expected Failed, got Skip"),
            StartupPoll::Ready(_) => panic!("expected Failed, got Ready"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pending_first_rebase_times_out() {
        let err = with_initial_rebase_deadline(std::future::pending::<
            Result<Vec<RecoveryEventDto>, String>,
        >())
        .await
        .expect_err("pending rebase must fail closed");
        assert_eq!(err, "recovery timed out waiting for initial rebase");
    }

    #[test]
    fn end_stops_followup_reader_before_eof() {
        let event = PaneRecoveryEvent::End(PaneStreamEndReason::PaneRemoved);
        assert!(followup_event_ends_reader(&event));
        assert!(!followup_event_ends_reader(&PaneRecoveryEvent::Bytes {
            epoch: 1,
            sequence: 0,
            bytes: b"x".to_vec(),
        }));
    }

    #[test]
    fn followup_none_is_a_transport_error_not_exit() {
        let event = unexpected_stream_end_event();
        match event {
            RecoveryEventDto::Error { code, message } => {
                assert_eq!(code, RECOVERY_STREAM_ENDED_CODE);
                assert!(message.contains("ended unexpectedly"), "{message}");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn followup_err_is_a_transport_error_not_exit() {
        let event = stream_transport_error_event("connection reset");
        match event {
            RecoveryEventDto::Error { code, message } => {
                assert_eq!(code, RECOVERY_STREAM_FAILED_CODE);
                assert!(message.contains("recover_output failed"), "{message}");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }
}