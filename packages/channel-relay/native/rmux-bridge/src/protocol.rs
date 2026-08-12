//! Versioned, bounded NDJSON protocol for the process-owned RMUX sidecar.
//!
//! Wire rules:
//! - stdin/stdout are NDJSON, one JSON object per line
//! - stdout is protocol-only; diagnostics go to stderr
//! - every request gets exactly one response with the same `id`
//! - line / decoded payload sizes are hard-capped before parse/decode

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const BRIDGE_VERSION: &str = "0.1.0";

/// Hard caps (decoded / line lengths).
pub const MAX_LINE_BYTES: usize = 96 * 1024;
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_OUTSTANDING_REQUESTS: usize = 64;

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
    /// Unsolicited recovery stream event (after a successful Recover).
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
    Rebase {
        epoch: u64,
        next_sequence: u64,
        cols: u16,
        rows: u16,
        alternate: bool,
        keyframe_base64: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
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
    if lower.contains("credential")
        || lower.contains("password")
        || lower.contains("token")
        || lower.contains("/users/")
        || lower.contains("\\users\\")
    {
        return "redacted error".to_owned();
    }
    // Cap length.
    if raw.len() > 200 {
        format!("{}…", &raw[..200])
    } else {
        raw.to_owned()
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
    }
}
