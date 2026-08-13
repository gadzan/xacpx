//! Process-owned RMUX session actors backed by public `rmux-sdk` 0.10.0 APIs.
//!
//! Create path (no rmux patches):
//! 1. `OwnedSession` with `KillOnOwnerExit` + lease TTL
//! 2. `new_window_with().cwd(...)` for the work pane
//! 3. close default window 0
//! 4. resize + `history-limit` on the stable pane id

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rmux_sdk::{
    CleanupPolicy, OwnedSession, PaneId, PaneRecoveryEvent, PaneRecoveryRebaseReason, Rmux,
    SessionName, TerminalSizeSpec,
};
use tokio::sync::{mpsc, Mutex};

use crate::protocol::{
    encode_b64, encode_rebase_events, InventoryEntryDto, RecoveryEventDto, ServerMessage,
    BRIDGE_VERSION,
};

pub struct BridgeState {
    rmux: Rmux,
    sessions: Mutex<HashMap<String, SessionActor>>,
    panes: Mutex<HashMap<String, String>>, // pane_id → session_id
    event_tx: mpsc::Sender<ServerMessage>,
}

struct SessionActor {
    owned: OwnedSession,
    session_id: String,
    pane_id: String,
    name: String,
    tags: Vec<String>,
    recover_abort: Option<tokio::task::JoinHandle<()>>,
}

pub async fn connect_bridge(
    event_tx: mpsc::Sender<ServerMessage>,
) -> Result<Arc<BridgeState>, String> {
    let rmux = Rmux::builder()
        .default_timeout(Duration::from_secs(15))
        .connect_or_start()
        .await
        .map_err(|e| format!("rmux connect failed: {e}"))?;
    Ok(Arc::new(BridgeState {
        rmux,
        sessions: Mutex::new(HashMap::new()),
        panes: Mutex::new(HashMap::new()),
        event_tx,
    }))
}

impl BridgeState {
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

        let work = match owned.new_window_with().name("shell").cwd(PathBuf::from(&cwd)).await {
            Ok(w) => w,
            Err(e) => {
                let _ = owned.cleanup().await;
                return Err(format!("new_window failed: {e}"));
            }
        };

        let _ = owned.window(0).close().await;

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

        if let Err(e) = pane.resize(TerminalSizeSpec::new(cols, rows)).await {
            let _ = owned.cleanup().await;
            return Err(format!("resize failed: {e}"));
        }
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
        let mut sessions = self.sessions.lock().await;
        if let Some(mut actor) = sessions.remove(session_id) {
            if let Some(handle) = actor.recover_abort.take() {
                handle.abort();
            }
            self.panes.lock().await.remove(&actor.pane_id);
            let _ = actor.owned.cleanup().await;
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
        pane.resize(TerminalSizeSpec::new(cols, rows))
            .await
            .map_err(|e| format!("resize failed: {e}"))?;
        Ok(())
    }

    pub async fn start_recover(self: &Arc<Self>, pane_id: String) -> Result<(), String> {
        let pane_id_parsed = parse_pane_id(&pane_id)?;
        let session_id = self
            .panes
            .lock()
            .await
            .get(&pane_id)
            .cloned()
            .ok_or_else(|| format!("pane not found: {pane_id}"))?;
        let mut sessions = self.sessions.lock().await;
        let actor = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        if let Some(prev) = actor.recover_abort.take() {
            // Idempotent re-subscribe from Node: keep the live stream rather than
            // tearing down multi-viewer fanout. Only replace when the task finished.
            if !prev.is_finished() {
                actor.recover_abort = Some(prev);
                return Ok(());
            }
        }

        let pane = actor
            .owned
            .pane_by_id(pane_id_parsed)
            .await
            .map_err(|e| format!("pane_by_id failed: {e}"))?;
        let mut stream = pane
            .recover_output()
            .await
            .map_err(|e| format!("recover_output failed: {e}"))?;

        let event_tx = self.event_tx.clone();
        let pane_id_for_task = pane_id.clone();
        let handle = tokio::spawn(async move {
            loop {
                match stream.next().await {
                    Ok(Some(event)) => {
                        let dtos = map_recovery_events(event);
                        let mut send_failed = false;
                        for dto in dtos {
                            if event_tx
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
                        if send_failed {
                            break;
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        });
        actor.recover_abort = Some(handle);
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
        let keys: Vec<String> = {
            let sessions = self.sessions.lock().await;
            sessions.keys().cloned().collect()
        };
        for key in keys {
            let _ = self.kill(&key).await;
        }
    }

    pub fn diagnostics(&self) -> (String, String, Vec<String>) {
        (
            BRIDGE_VERSION.to_owned(),
            "0.10.0".to_owned(),
            vec![
                "terminal.rmux.recovery.v1".to_owned(),
                "terminal.multi-view.v1".to_owned(),
                "process-owned.v1".to_owned(),
            ],
        )
    }
}

fn parse_pane_id(raw: &str) -> Result<PaneId, String> {
    let trimmed = raw.trim().trim_start_matches('%');
    let n: u32 = trimmed
        .parse()
        .map_err(|_| format!("invalid pane id: {raw}"))?;
    Ok(PaneId::new(n))
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
