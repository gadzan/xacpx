//! Versioned, bounded NDJSON protocol for the process-owned RMUX sidecar.
//!
//! Wire rules:
//! - stdin/stdout are NDJSON, one JSON object per line
//! - stdout is protocol-only; diagnostics go to stderr
//! - every request gets exactly one response with the same `id`
//! - line / decoded payload sizes are hard-capped before parse/decode

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 2;
pub const BRIDGE_VERSION: &str = "0.1.0";

/// Hard caps (decoded / line lengths).
pub const MAX_LINE_BYTES: usize = 96 * 1024;
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_OUTSTANDING_REQUESTS: usize = 64;
/// Decoded rebase chunk size. Base64+JSON stays well under `MAX_LINE_BYTES`.
pub const REBASE_CHUNK_BYTES: usize = 48 * 1024;
/// Single rebase keyframe cap (decoded).
pub const MAX_REBASE_TOTAL_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    Handshake {
        id: String,
        protocol_version: u32,
    },
    Create {
        id: String,
        name: String,
        cwd: String,
        cols: u16,
        rows: u16,
        history_limit: u32,
        tags: Vec<String>,
        owner_lease_ttl_seconds: u32,
    },
    List {
        id: String,
    },
    Kill {
        id: String,
        session_id: String,
    },
    Input {
        id: String,
        pane_id: String,
        /// Canonical base64 of UTF-8 text bytes.
        data_base64: String,
    },
    Resize {
        id: String,
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    Recover {
        id: String,
        pane_id: String,
    },
    StopRecover {
        id: String,
        pane_id: String,
    },
    Diagnostics {
        id: String,
    },
    Shutdown {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMessage {
    HandshakeOk {
        id: String,
        bridge_version: String,
        protocol_version: u32,
        rmux_wire_version: String,
        capabilities: Vec<String>,
    },
    Ok {
        id: String,
    },
    Session {
        id: String,
        session_id: String,
        pane_id: String,
        name: String,
        tags: Vec<String>,
    },
    Inventory {
        id: String,
        entries: Vec<InventoryEntryDto>,
    },
    Diagnostics {
        id: String,
        bridge_version: String,
        rmux_wire_version: String,
        capabilities: Vec<String>,
    },
    Error {
        id: String,
        code: String,
        message: String,
    },
    /// Recovery stream event. The initial rebase is written immediately before
    /// the Recover RPC ack; later bytes follow asynchronously.
    Event {
        pane_id: String,
        event: RecoveryEventDto,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryEntryDto {
    pub session_id: String,
    pub pane_id: String,
    pub name: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RecoveryEventDto {
    RebaseStart {
        epoch: u64,
        next_sequence: u64,
        cols: u16,
        rows: u16,
        alternate: bool,
        total_bytes: usize,
        chunk_count: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    RebaseChunk {
        epoch: u64,
        index: usize,
        data_base64: String,
    },
    RebaseEnd {
        epoch: u64,
    },
    Bytes {
        epoch: u64,
        sequence: u64,
        data_base64: String,
    },
    Exit {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
    },
    Error {
        code: String,
        message: String,
    },
}

/// Split a rebase keyframe into start/chunk/end events so each NDJSON line
/// stays under `MAX_LINE_BYTES`. Returns `Err` when the keyframe exceeds the
/// public 2 MiB cap — callers must not serialize an unbounded frame.
pub fn encode_rebase_events(
    epoch: u64,
    next_sequence: u64,
    cols: u16,
    rows: u16,
    alternate: bool,
    keyframe: &[u8],
    reason: Option<String>,
) -> Result<Vec<RecoveryEventDto>, String> {
    if keyframe.len() > MAX_REBASE_TOTAL_BYTES {
        return Err("rebase keyframe too large".to_owned());
    }
    let total_bytes = keyframe.len();
    let chunk_count = if total_bytes == 0 {
        0
    } else {
        total_bytes.div_ceil(REBASE_CHUNK_BYTES)
    };
    let mut out = Vec::with_capacity(chunk_count + 2);
    out.push(RecoveryEventDto::RebaseStart {
        epoch,
        next_sequence,
        cols,
        rows,
        alternate,
        total_bytes,
        chunk_count,
        reason,
    });
    for (index, chunk) in keyframe.chunks(REBASE_CHUNK_BYTES).enumerate() {
        out.push(RecoveryEventDto::RebaseChunk {
            epoch,
            index,
            data_base64: encode_b64(chunk),
        });
    }
    out.push(RecoveryEventDto::RebaseEnd { epoch });
    Ok(out)
}

pub fn encode_b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn decode_b64_capped(input: &str, max_decoded: usize) -> Result<Vec<u8>, String> {
    // Encoded length bound before decode (4/3 expansion, padding).
    let max_encoded = max_decoded
        .checked_mul(4)
        .map(|n| n / 3 + 4)
        .ok_or_else(|| "size overflow".to_owned())?;
    if input.len() > max_encoded {
        return Err("base64 payload too large".to_owned());
    }
    let decoded = B64
        .decode(input.as_bytes())
        .map_err(|_| "invalid base64".to_owned())?;
    if decoded.len() > max_decoded {
        return Err("decoded payload too large".to_owned());
    }
    // Canonical round-trip check.
    let reencoded = B64.encode(&decoded);
    if reencoded != input {
        return Err("non-canonical base64".to_owned());
    }
    Ok(decoded)
}

pub fn parse_client_line(line: &str) -> Result<ClientMessage, String> {
    if line.len() > MAX_LINE_BYTES {
        return Err("line too large".to_owned());
    }
    serde_json::from_str(line).map_err(|e| format!("invalid json: {e}"))
}

pub fn redact_error_message(raw: &str) -> String {
    // Never echo cwd/env/terminal bytes/credentials in error responses.
    let lower = raw.to_ascii_lowercase();
    if looks_sensitive(&lower) {
        return "redacted error".to_owned();
    }
    truncate_chars(raw, 200)
}

fn looks_sensitive(lower: &str) -> bool {
    lower.contains("credential")
        || lower.contains("password")
        || lower.contains("token")
        || lower.contains("/users/")
        || lower.contains("\\users\\")
        || lower.contains("/home/")
        || lower.contains("/root/")
        || lower.contains("/tmp/")
        || lower.contains("/var/")
        || lower.contains("/opt/")
        || lower.contains("/etc/")
        || lower.contains(":\\")
        || lower.contains("\\\\")
}

fn truncate_chars(raw: &str, max_chars: usize) -> String {
    let mut chars = raw.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversize_line() {
        let huge = "x".repeat(MAX_LINE_BYTES + 1);
        assert!(parse_client_line(&huge).is_err());
    }

    #[test]
    fn rejects_non_canonical_base64() {
        // Standard encoding of empty is ""; padded variants of "hi" must match exactly.
        let bytes = b"hi";
        let canon = encode_b64(bytes);
        assert!(decode_b64_capped(&canon, 64).is_ok());
        // Insert whitespace → invalid / non-canonical.
        assert!(decode_b64_capped("aGk=", 64).is_ok()); // "hi"
        assert!(decode_b64_capped("aGk", 64).is_err());
    }

    #[test]
    fn redacts_sensitive_error_text() {
        assert_eq!(
            redact_error_message("failed path /Users/me/secret"),
            "redacted error"
        );
        assert_eq!(
            redact_error_message("cwd /home/alice/project"),
            "redacted error"
        );
        assert_eq!(
            redact_error_message("path /home/用户/很长的中文目录名/secret"),
            "redacted error"
        );
    }

    #[test]
    fn truncates_long_errors_on_utf8_char_boundary() {
        let raw = "错误".repeat(120);
        let redacted = redact_error_message(&raw);
        assert!(redacted.ends_with('…'));
        assert!(redacted.chars().count() <= 201);
        assert!(std::str::from_utf8(redacted.as_bytes()).is_ok());
    }

    #[test]
    fn rebase_chunks_stay_under_line_cap() {
        let keyframe = vec![b'x'; 200_000];
        let events = encode_rebase_events(1, 1, 80, 24, false, &keyframe, Some("lag".into()))
            .expect("encode");
        assert!(events.len() > 3);
        for event in events {
            let line = serde_json::to_string(&ServerMessage::Event {
                pane_id: "%1".to_owned(),
                event,
            })
            .unwrap();
            assert!(line.len() <= MAX_LINE_BYTES, "line {} bytes", line.len());
        }
    }

    #[test]
    fn rejects_rebase_over_two_mib() {
        let keyframe = vec![0u8; MAX_REBASE_TOTAL_BYTES + 1];
        assert!(encode_rebase_events(1, 1, 80, 24, false, &keyframe, None).is_err());
        let event = RecoveryEventDto::Error {
            code: "rebase-too-large".to_owned(),
            message: "rebase keyframe too large".to_owned(),
        };
        let line = serde_json::to_string(&event).unwrap();
        assert!(line.contains("\"type\":\"error\""));
        assert!(line.contains("rebase-too-large"));
    }
}
