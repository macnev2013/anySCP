//! Non-blocking PostHog telemetry.
//!
//! All events are fire-and-forget.  If PostHog is unreachable, events are
//! silently dropped.  No PII is ever sent — only safe metadata such as auth
//! type strings, provider names, and counters.

use serde_json::{json, Value};
use std::sync::OnceLock;
use tokio::sync::mpsc;

const POSTHOG_KEY: &str = "phc_P7W8CuYM9uU4mnP8xAplcRNuBjOYTESTI9dTDNDo58A";
const POSTHOG_HOST: &str = "https://us.i.posthog.com";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

static TX: OnceLock<mpsc::UnboundedSender<(String, Value)>> = OnceLock::new();

/// Initialize the telemetry background worker.
/// Safe to call from `.setup()` — the worker is spawned on a background thread
/// with its own Tokio runtime, so it does not require an active reactor.
pub fn init() {
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Value)>();
    if TX.set(tx).is_err() {
        return;
    }

    let distinct_id = get_or_create_device_id();

    // Spawn on a dedicated background thread with its own runtime
    // so we don't depend on Tauri's async runtime being active yet.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("telemetry runtime");

        rt.block_on(async move {
            let client = reqwest::Client::new();
            while let Some((event, mut properties)) = rx.recv().await {
                if let Some(obj) = properties.as_object_mut() {
                    obj.insert("$app_version".to_string(), json!(APP_VERSION));
                    obj.insert("$os".to_string(), json!(std::env::consts::OS));
                    obj.insert("$os_arch".to_string(), json!(std::env::consts::ARCH));
                    obj.insert("$geoip_disable".to_string(), json!(false));
                }

                let body = json!({
                    "api_key": POSTHOG_KEY,
                    "event": event,
                    "distinct_id": distinct_id,
                    "properties": properties,
                });

                let _ = client
                    .post(format!("{}/capture/", POSTHOG_HOST))
                    .json(&body)
                    .send()
                    .await;
            }
        });
    });

    capture("app_started", json!({}));
}

/// Send a telemetry event.  Non-blocking; safe to call from any thread or task.
///
/// If `init()` has not been called yet (e.g. in unit tests) the call is a
/// silent no-op.
pub fn capture(event: &str, properties: Value) {
    if let Some(tx) = TX.get() {
        let _ = tx.send((event.to_string(), properties));
    }
}

/// Return a stable, anonymous device identifier.
///
/// The ID is a random UUID that is persisted to disk on first launch.  It is
/// not linked to any user account, email address, or system identity.
fn get_or_create_device_id() -> String {
    let id_path = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.macnev2013.anyscp")
        .join(".device_id");

    if let Ok(id) = std::fs::read_to_string(&id_path) {
        let trimmed = id.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = id_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&id_path, &id);
    id
}
