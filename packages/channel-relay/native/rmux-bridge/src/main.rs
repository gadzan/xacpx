//! NDJSON stdin/stdout loop for the process-owned RMUX bridge.

mod actors;
mod protocol;

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use actors::connect_bridge;
use protocol::{
    decode_b64_capped, parse_client_line, redact_error_message, ClientMessage, ServerMessage,
    BRIDGE_VERSION, MAX_INPUT_BYTES, MAX_LINE_BYTES, MAX_OUTSTANDING_REQUESTS, PROTOCOL_VERSION,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const INTERNAL_DAEMON_FLAG: &str = "--__internal-daemon";
const DAEMON_BINARY_ENV: &str = "XACPX_RMUX_DAEMON_BINARY";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().collect();
    if let Some(exit) = delegate_daemon_if_requested(&args) {
        return exit;
    }
    if args
        .iter()
        .any(|arg| arg == OsStr::new("--version") || arg == OsStr::new("-V"))
    {
        println!("xacpx-rmux-bridge {BRIDGE_VERSION} (process-owned; rmux-sdk=0.10.0)");
        return ExitCode::SUCCESS;
    }

    if let Err(err) = run().await {
        eprintln!("xacpx-rmux-bridge fatal: {err}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

fn delegate_daemon_if_requested(args: &[OsString]) -> Option<ExitCode> {
    if args.get(1).map(OsString::as_os_str) != Some(OsStr::new(INTERNAL_DAEMON_FLAG)) {
        return None;
    }

    let daemon = match std::env::var_os(DAEMON_BINARY_ENV).map(PathBuf::from) {
        Some(path) if path.is_absolute() => path,
        _ => {
            eprintln!("xacpx-rmux-bridge fatal: missing absolute {DAEMON_BINARY_ENV}");
            return Some(ExitCode::from(1));
        }
    };
    let rewritten = match rewrite_daemon_args(args.iter().skip(1).cloned().collect()) {
        Ok(args) => args,
        Err(err) => {
            eprintln!("xacpx-rmux-bridge fatal: {err}");
            return Some(ExitCode::from(1));
        }
    };
    let mut command = Command::new(daemon);
    command.args(rewritten).env_remove(DAEMON_BINARY_ENV);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;

        let err = command.exec();
        eprintln!("xacpx-rmux-bridge fatal: daemon exec failed: {err}");
        Some(ExitCode::from(1))
    }
    #[cfg(windows)]
    {
        match command.status() {
            Ok(status) => Some(ExitCode::from(
                status.code().and_then(|code| u8::try_from(code).ok()).unwrap_or(1),
            )),
            Err(err) => {
                eprintln!("xacpx-rmux-bridge fatal: daemon spawn failed: {err}");
                Some(ExitCode::from(1))
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = command;
        eprintln!("xacpx-rmux-bridge fatal: daemon delegation unsupported on this platform");
        Some(ExitCode::from(1))
    }
}

fn rewrite_daemon_args(args: Vec<OsString>) -> Result<Vec<OsString>, String> {
    if args.first().map(OsString::as_os_str) != Some(OsStr::new(INTERNAL_DAEMON_FLAG)) {
        return Err("daemon delegation requires --__internal-daemon".to_owned());
    }

    let mut rewritten = Vec::with_capacity(args.len() + 1);
    let mut replaced_default = false;
    for arg in args {
        if arg == OsStr::new("--config-file") {
            return Err("unexpected explicit RMUX config from SDK launcher".to_owned());
        }
        if arg == OsStr::new("--config-default") {
            if replaced_default {
                return Err("duplicate --config-default from SDK launcher".to_owned());
            }
            rewritten.push(OsString::from("--config-file"));
            rewritten.push(OsString::from(if cfg!(windows) { "NUL" } else { "/dev/null" }));
            replaced_default = true;
        } else {
            rewritten.push(arg);
        }
    }
    if !replaced_default {
        return Err("SDK daemon launcher omitted --config-default".to_owned());
    }
    Ok(rewritten)
}

async fn run() -> Result<(), String> {
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(512);

    let bridge = connect_bridge()
        .await
        .map_err(|e| format!("bridge connect: {e}"))?;

    // stdout writer task — sole owner of stdout. Recover events and RPC
    // replies share this FIFO so initial Rebase cannot race follow-up Bytes.
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(msg) = out_rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(line) => {
                    if stdout.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    if stdout.write_all(b"\n").await.is_err() {
                        break;
                    }
                    if stdout.flush().await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    eprintln!("serialize error: {err}");
                }
            }
        }
    });

    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.split(b'\n');
    let outstanding = Arc::new(AtomicUsize::new(0));
    let mut handshaken = false;

    while let Some(chunk) = lines
        .next_segment()
        .await
        .map_err(|e| format!("stdin read: {e}"))?
    {
        if chunk.len() > MAX_LINE_BYTES {
            let _ = out_tx
                .send(ServerMessage::Error {
                    id: "unknown".to_owned(),
                    code: "terminal-protocol-error".to_owned(),
                    message: "line too large".to_owned(),
                })
                .await;
            break;
        }
        let line = match std::str::from_utf8(&chunk) {
            Ok(s) => s.trim_end_matches('\r'),
            Err(_) => {
                let _ = out_tx
                    .send(ServerMessage::Error {
                        id: "unknown".to_owned(),
                        code: "terminal-protocol-error".to_owned(),
                        message: "line is not utf-8".to_owned(),
                    })
                    .await;
                break;
            }
        };
        if line.is_empty() {
            continue;
        }

        let msg = match parse_client_line(line) {
            Ok(m) => m,
            Err(err) => {
                let _ = out_tx
                    .send(ServerMessage::Error {
                        id: "unknown".to_owned(),
                        code: "terminal-protocol-error".to_owned(),
                        message: redact_error_message(&err),
                    })
                    .await;
                continue;
            }
        };

        if outstanding.load(Ordering::SeqCst) >= MAX_OUTSTANDING_REQUESTS {
            let id = request_id(&msg).to_owned();
            let _ = out_tx
                .send(ServerMessage::Error {
                    id,
                    code: "terminal-protocol-error".to_owned(),
                    message: "too many outstanding requests".to_owned(),
                })
                .await;
            continue;
        }

        // Handshake/shutdown stay on the stdin task. Only Recover is spawned:
        // its first-rebase wait must not HOL-block other RPCs, but Create/List
        // stay serial so reconciler cannot observe a half-created session.
        let inline = !handshaken || !matches!(msg, ClientMessage::Recover { .. });
        outstanding.fetch_add(1, Ordering::SeqCst);
        if inline {
            let response = handle_message(&bridge, msg, &mut handshaken, &out_tx).await;
            outstanding.fetch_sub(1, Ordering::SeqCst);
            let is_shutdown = matches!(
                &response,
                ServerMessage::Ok { id } if id.ends_with("\u{0}shutdown")
            );
            let response = match response {
                ServerMessage::Ok { id } if id.ends_with("\u{0}shutdown") => ServerMessage::Ok {
                    id: id.trim_end_matches("\u{0}shutdown").to_owned(),
                },
                other => other,
            };
            if out_tx.send(response).await.is_err() {
                break;
            }
            if is_shutdown {
                break;
            }
            continue;
        }

        let bridge = Arc::clone(&bridge);
        let out_tx = out_tx.clone();
        let outstanding = Arc::clone(&outstanding);
        tokio::spawn(async move {
            let mut handshaken = true;
            let response = handle_message(&bridge, msg, &mut handshaken, &out_tx).await;
            let _ = out_tx.send(response).await;
            outstanding.fetch_sub(1, Ordering::SeqCst);
        });
    }

    bridge.shutdown_all().await;
    drop(out_tx);
    let _ = writer.await;
    Ok(())
}

fn request_id(msg: &ClientMessage) -> &str {
    match msg {
        ClientMessage::Handshake { id, .. }
        | ClientMessage::Create { id, .. }
        | ClientMessage::List { id }
        | ClientMessage::Kill { id, .. }
        | ClientMessage::Input { id, .. }
        | ClientMessage::Resize { id, .. }
        | ClientMessage::Recover { id, .. }
        | ClientMessage::StopRecover { id, .. }
        | ClientMessage::Diagnostics { id }
        | ClientMessage::Shutdown { id } => id,
    }
}

#[cfg(test)]
mod daemon_launcher_tests {
    use std::ffi::OsString;

    use super::rewrite_daemon_args;

    #[test]
    fn daemon_launcher_replaces_default_config_with_explicit_empty_config() {
        let rewritten = rewrite_daemon_args(vec![
            OsString::from("--__internal-daemon"),
            OsString::from("endpoint"),
            OsString::from("--config-default"),
            OsString::from("--config-quiet"),
            OsString::from("--config-cwd"),
            OsString::from("workspace"),
        ])
        .expect("daemon args rewrite");

        assert!(!rewritten.iter().any(|arg| arg == "--config-default"));
        let config_index = rewritten
            .iter()
            .position(|arg| arg == "--config-file")
            .expect("explicit config flag");
        assert_eq!(
            rewritten.get(config_index + 1),
            Some(&OsString::from(if cfg!(windows) { "NUL" } else { "/dev/null" })),
        );
        assert!(rewritten.iter().any(|arg| arg == "--config-cwd"));
    }
}

async fn handle_message(
    bridge: &Arc<actors::BridgeState>,
    msg: ClientMessage,
    handshaken: &mut bool,
    out_tx: &mpsc::Sender<ServerMessage>,
) -> ServerMessage {
    match msg {
        ClientMessage::Handshake {
            id,
            protocol_version,
        } => {
            if protocol_version != PROTOCOL_VERSION {
                return ServerMessage::Error {
                    id,
                    code: "terminal-protocol-error".to_owned(),
                    message: format!("unsupported protocol_version {protocol_version}"),
                };
            }
            *handshaken = true;
            let (bridge_version, rmux_wire_version, capabilities) = bridge.diagnostics();
            ServerMessage::HandshakeOk {
                id,
                bridge_version,
                protocol_version: PROTOCOL_VERSION,
                rmux_wire_version,
                capabilities,
            }
        }
        other if !*handshaken => ServerMessage::Error {
            id: request_id(&other).to_owned(),
            code: "terminal-protocol-error".to_owned(),
            message: "handshake required".to_owned(),
        },
        ClientMessage::Create {
            id,
            name,
            cwd,
            cols,
            rows,
            history_limit,
            tags,
            owner_lease_ttl_seconds,
        } => match bridge
            .create(
                name,
                cwd,
                cols,
                rows,
                history_limit,
                tags,
                owner_lease_ttl_seconds,
            )
            .await
        {
            Ok((session_id, pane_id, name, tags)) => ServerMessage::Session {
                id,
                session_id,
                pane_id,
                name,
                tags,
            },
            Err(err) => ServerMessage::Error {
                id,
                code: "terminal-rmux-unavailable".to_owned(),
                message: redact_error_message(&err),
            },
        },
        ClientMessage::List { id } => ServerMessage::Inventory {
            id,
            entries: bridge.list().await,
        },
        ClientMessage::Kill { id, session_id } => match bridge.kill(&session_id).await {
            Ok(()) => ServerMessage::Ok { id },
            Err(err) => ServerMessage::Error {
                id,
                code: "terminal-rmux-unavailable".to_owned(),
                message: redact_error_message(&err),
            },
        },
        ClientMessage::Input {
            id,
            pane_id,
            data_base64,
        } => match decode_b64_capped(&data_base64, MAX_INPUT_BYTES) {
            Ok(bytes) => match bridge.input(&pane_id, &bytes).await {
                Ok(()) => ServerMessage::Ok { id },
                Err(err) if err.contains("UTF-8") => ServerMessage::Error {
                    id,
                    code: "terminal-protocol-error".to_owned(),
                    message: "input must be valid UTF-8".to_owned(),
                },
                Err(err) => ServerMessage::Error {
                    id,
                    code: "terminal-rmux-unavailable".to_owned(),
                    message: redact_error_message(&err),
                },
            },
            Err(err) => ServerMessage::Error {
                id,
                code: "terminal-protocol-error".to_owned(),
                message: err,
            },
        },
        ClientMessage::Resize {
            id,
            pane_id,
            cols,
            rows,
        } => match bridge.resize(&pane_id, cols, rows).await {
            Ok(()) => ServerMessage::Ok { id },
            Err(err) => ServerMessage::Error {
                id,
                code: "terminal-rmux-unavailable".to_owned(),
                message: redact_error_message(&err),
            },
        },
        ClientMessage::Recover { id, pane_id } => match bridge.start_recover(pane_id, out_tx).await
        {
            Ok(()) => ServerMessage::Ok { id },
            Err(err) => ServerMessage::Error {
                id,
                code: "terminal-rmux-unavailable".to_owned(),
                message: redact_error_message(&err),
            },
        },
        ClientMessage::StopRecover { id, pane_id } => match bridge.stop_recover(&pane_id).await {
            Ok(()) => ServerMessage::Ok { id },
            Err(err) => ServerMessage::Error {
                id,
                code: "terminal-rmux-unavailable".to_owned(),
                message: redact_error_message(&err),
            },
        },
        ClientMessage::Diagnostics { id } => {
            let (bridge_version, rmux_wire_version, capabilities) = bridge.diagnostics();
            ServerMessage::Diagnostics {
                id,
                bridge_version,
                rmux_wire_version,
                capabilities,
            }
        }
        ClientMessage::Shutdown { id } => {
            bridge.shutdown_all().await;
            ServerMessage::Ok {
                id: format!("{id}\u{0}shutdown"),
            }
        }
    }
}
