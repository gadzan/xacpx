//! NDJSON stdin/stdout loop for the process-owned RMUX bridge.

mod actors;
mod protocol;

use std::process::ExitCode;

use actors::connect_bridge;
use protocol::{
    decode_b64_capped, parse_client_line, redact_error_message, ClientMessage, ServerMessage,
    BRIDGE_VERSION, MAX_INPUT_BYTES, MAX_LINE_BYTES, MAX_OUTSTANDING_REQUESTS, PROTOCOL_VERSION,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("xacpx-rmux-bridge {BRIDGE_VERSION} (process-owned; rmux-sdk=0.10.0)");
        return ExitCode::SUCCESS;
    }

    if let Err(err) = run().await {
        eprintln!("xacpx-rmux-bridge fatal: {err}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

async fn run() -> Result<(), String> {
    let (event_tx, mut event_rx) = mpsc::channel::<ServerMessage>(256);
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(512);

    let bridge = connect_bridge(event_tx)
        .await
        .map_err(|e| format!("bridge connect: {e}"))?;

    // stdout writer task — sole owner of stdout.
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

    // Forward recovery events to stdout queue.
    let out_tx_events = out_tx.clone();
    tokio::spawn(async move {
        while let Some(msg) = event_rx.recv().await {
            if out_tx_events.send(msg).await.is_err() {
                break;
            }
        }
    });

    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.split(b'\n');
    let mut outstanding: usize = 0;
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

        if outstanding >= MAX_OUTSTANDING_REQUESTS {
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
        outstanding += 1;

        let response = handle_message(&bridge, msg, &mut handshaken, &out_tx).await;
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
        outstanding = outstanding.saturating_sub(1);
        if out_tx.send(response).await.is_err() {
            break;
        }
        if is_shutdown {
            break;
        }
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

async fn handle_message(
    bridge: &std::sync::Arc<actors::BridgeState>,
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
        ClientMessage::Recover { id, pane_id } => match bridge.start_recover(pane_id.clone()).await {
            Ok(dtos) => {
                // Emit the initial rebase before the RPC ack so Node's start
                // barrier means "snapshot ready", not merely "task spawned".
                for dto in dtos {
                    if out_tx
                        .send(ServerMessage::Event {
                            pane_id: pane_id.clone(),
                            event: dto,
                        })
                        .await
                        .is_err()
                    {
                        return ServerMessage::Error {
                            id,
                            code: "terminal-rmux-unavailable".to_owned(),
                            message: "stdout closed during recover start".to_owned(),
                        };
                    }
                }
                ServerMessage::Ok { id }
            }
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
