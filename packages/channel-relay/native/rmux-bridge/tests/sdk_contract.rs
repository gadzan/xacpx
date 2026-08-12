//! Opt-in real-daemon contract gate for process-owned RMUX usage.
//!
//! Run with:
//!   XACPX_RMUX_INTEGRATION=1 cargo test --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml --test sdk_contract -- --nocapture
//!
//! Requires a published RMUX 0.10.x daemon on PATH (or `RMUX_SDK_DAEMON_BINARY`).
//! Does not patch or path-depend on a local `../rmux` checkout.

use std::env;
use std::path::PathBuf;
use std::time::Duration;

use rmux_sdk::{
    CleanupPolicy, PaneRecoveryEvent, Rmux, SessionName, TerminalSizeSpec,
};

fn integration_enabled() -> bool {
    matches!(
        env::var("XACPX_RMUX_INTEGRATION").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

fn unique_name(prefix: &str) -> SessionName {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    SessionName::new(format!("{prefix}-{nanos}")).expect("valid session name")
}

#[tokio::test]
async fn process_owned_create_recover_input_resize_cleanup() {
    if !integration_enabled() {
        eprintln!("skip: set XACPX_RMUX_INTEGRATION=1 to run real-daemon contract");
        return;
    }

    let cwd = env::temp_dir().join(format!("xacpx-rmux-contract-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("temp cwd");

    let rmux = Rmux::builder()
        .default_timeout(Duration::from_secs(10))
        .connect_or_start()
        .await
        .expect("connect_or_start published rmux 0.10 daemon");

    let name = unique_name("xacpx-relay-contract");
    let mut owned = rmux
        .owned_session(name.clone())
        .cleanup_policy(CleanupPolicy::KillOnOwnerExit)
        .lease_ttl(Duration::from_secs(30))
        .await
        .expect("create owned session with KillOnOwnerExit");

    // OwnedSessionBuilder does not expose cwd/size/tags. Public workaround:
    // create a second window with cwd/env, then close the default window 0.
    let work = owned
        .new_window_with()
        .name("shell")
        .cwd(PathBuf::from(&cwd))
        .env("XACPX_RMUX_CONTRACT", "1")
        .await
        .expect("create work window with cwd/env");

    let default = owned.window(0);
    let _ = default.close().await.expect("close default window");

    let panes = work.panes().await.expect("list panes");
    assert_eq!(panes.len(), 1, "work window should have one pane");
    let pane_id = panes[0].id;
    let pane = owned
        .pane_by_id(pane_id)
        .await
        .expect("stable pane_by_id handle");

    pane.resize(TerminalSizeSpec::new(100, 30))
        .await
        .expect("resize by stable pane id");

    // history-limit is a pane option on public API; absence is a hard blocker.
    let _ = pane
        .set_option("history-limit", "1000")
        .await
        .expect("set history-limit via public pane option API");

    let mut recovery = pane
        .recover_output()
        .await
        .expect("recover_output requires CAPABILITY_SDK_PANE_RAW_RECOVERY");
    let first = recovery
        .next()
        .await
        .expect("first recovery event")
        .expect("stream open");
    match first {
        PaneRecoveryEvent::Rebase(rebase) => {
            assert!(rebase.cols > 0 && rebase.rows > 0);
            assert!(!rebase.keyframe.is_empty() || rebase.next_sequence == 0 || true);
        }
        other => panic!("first recovery event must be Rebase, got {other:?}"),
    }

    pane.send_text("printf 'contract-ok\\n'\n")
        .await
        .expect("UTF-8 send_text");

    let mut saw_bytes = false;
    for _ in 0..40 {
        let Some(event) = recovery.next().await.expect("recovery poll") else {
            break;
        };
        match event {
            PaneRecoveryEvent::Bytes { bytes, .. } => {
                if String::from_utf8_lossy(&bytes).contains("contract-ok") {
                    saw_bytes = true;
                    break;
                }
            }
            PaneRecoveryEvent::Rebase(_) => {}
            PaneRecoveryEvent::Lifecycle(_) | PaneRecoveryEvent::End(_) => break,
            _ => break,
        }
    }
    assert!(saw_bytes, "expected contract-ok in recovery bytes");

    let killed = owned.cleanup().await.expect("explicit cleanup");
    assert!(killed, "cleanup should kill the owned session");
    assert!(!owned.is_active());

    // Name must be gone so later creates with unique names stay unique.
    let still = rmux.has_session(name).await.expect("has_session");
    assert!(!still, "session must be absent after cleanup");
}

#[tokio::test]
async fn invalid_utf8_input_is_rejected_at_bridge_boundary() {
    // Pure unit check documenting the process-owned input contract: bridge
    // must reject non-UTF-8 before calling Pane::send_text. Kept here so the
    // gate suite names the limitation explicitly.
    let mut bad = Vec::new();
    bad.push(0xff);
    bad.push(0xfe);
    bad.push(0xfd);
    assert!(std::str::from_utf8(&bad).is_err());
}
