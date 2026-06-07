use serde::{Deserialize, Serialize};
use tracing::instrument;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Keychain service name used as the top-level namespace for every entry.
/// All credentials are keyed as `(SERVICE_NAME, host_id)`.
const SERVICE_NAME: &str = "com.anyscp.credentials";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("Keychain error: {0}")]
    Keychain(String),

    #[error("Credential not found for host: {0}")]
    NotFound(String),

    #[error("Invalid credential data: {0}")]
    InvalidData(String),
}

/// Serialise `VaultError` as `{ kind, message }` so the frontend can
/// pattern-match on the `kind` discriminant — mirrors `SshError` / `DbError`.
impl Serialize for VaultError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("VaultError", 2)?;
        let kind = match self {
            VaultError::Keychain(_) => "keychain",
            VaultError::NotFound(_) => "not_found",
            VaultError::InvalidData(_) => "invalid_data",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

/// The kind of secret stored for a host.  Serialised as a tagged JSON object
/// so additional variants can be added without a breaking schema change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StoredCredential {
    /// SSH password credential.
    Password { password: String },
    /// Passphrase that unlocks an encrypted SSH private key.
    KeyPassphrase { passphrase: String },
}

// ---------------------------------------------------------------------------
// Core vault operations (synchronous — callers must use spawn_blocking)
// ---------------------------------------------------------------------------

/// Persist `credential` in the OS keychain under `host_id`.
///
/// The credential is JSON-encoded before being handed to the keychain so that
/// the `StoredCredential` variant is preserved and can be round-tripped via
/// [`get_credential`].
///
/// # Security
/// The plaintext value is only held in Rust memory long enough to pass it to
/// the keychain C-API.  It is never written to disk or emitted to logs.
#[instrument(skip(credential), fields(host_id = %host_id))]
pub fn save_credential(host_id: &str, credential: &StoredCredential) -> Result<(), VaultError> {
    let entry = keyring::Entry::new(SERVICE_NAME, host_id)
        .map_err(|e| VaultError::Keychain(e.to_string()))?;

    let json =
        serde_json::to_string(credential).map_err(|e| VaultError::InvalidData(e.to_string()))?;

    entry
        .set_password(&json)
        .map_err(|e| VaultError::Keychain(e.to_string()))?;

    tracing::debug!(host_id = %host_id, "credential saved to keychain");
    Ok(())
}

/// Retrieve the `StoredCredential` for `host_id` from the OS keychain.
///
/// Returns `VaultError::NotFound` when no entry exists for `host_id`.
#[instrument(fields(host_id = %host_id))]
pub fn get_credential(host_id: &str) -> Result<StoredCredential, VaultError> {
    let entry = keyring::Entry::new(SERVICE_NAME, host_id)
        .map_err(|e| VaultError::Keychain(e.to_string()))?;

    let json = entry.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => VaultError::NotFound(host_id.to_string()),
        other => VaultError::Keychain(other.to_string()),
    })?;

    serde_json::from_str(&json).map_err(|e| VaultError::InvalidData(e.to_string()))
}

/// Remove the credential for `host_id` from the OS keychain.
///
/// Treating a missing entry as success avoids spurious errors when
/// `delete_host` and `vault_delete_credential` are called together.
#[instrument(fields(host_id = %host_id))]
pub fn delete_credential(host_id: &str) -> Result<(), VaultError> {
    let entry = keyring::Entry::new(SERVICE_NAME, host_id)
        .map_err(|e| VaultError::Keychain(e.to_string()))?;

    match entry.delete_credential() {
        Ok(()) => {
            tracing::debug!(host_id = %host_id, "credential deleted from keychain");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()), // already absent — that is fine
        Err(e) => Err(VaultError::Keychain(e.to_string())),
    }
}

/// Return `true` when a credential exists for `host_id`, without retrieving
/// the secret value.
pub fn has_credential(host_id: &str) -> bool {
    keyring::Entry::new(SERVICE_NAME, host_id)
        .and_then(|e| e.get_password())
        .is_ok()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------
//
// All three commands delegate to `spawn_blocking` because the `keyring` crate
// may perform synchronous I/O or IPC to the OS credential store.  Blocking
// the tokio executor thread even briefly would degrade all concurrent tasks.

/// Save or replace the credential for a host in the OS keychain.
#[tauri::command]
pub async fn vault_save_credential(
    host_id: String,
    credential: StoredCredential,
) -> Result<(), VaultError> {
    tokio::task::spawn_blocking(move || save_credential(&host_id, &credential))
        .await
        .map_err(|e| VaultError::Keychain(format!("task panicked: {e}")))?
}

/// Delete the credential for a host from the OS keychain.
#[tauri::command]
pub async fn vault_delete_credential(host_id: String) -> Result<(), VaultError> {
    tokio::task::spawn_blocking(move || delete_credential(&host_id))
        .await
        .map_err(|e| VaultError::Keychain(format!("task panicked: {e}")))?
}

/// Return whether a credential exists for a host (does not return the secret).
#[tauri::command]
pub async fn vault_has_credential(host_id: String) -> Result<bool, VaultError> {
    tokio::task::spawn_blocking(move || Ok(has_credential(&host_id)))
        .await
        .map_err(|e| VaultError::Keychain(format!("task panicked: {e}")))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use keyring::credential::{
        Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
    };
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex, Once};

    // ── In-memory test keystore ────────────────────────────────────────────
    //
    // The real OS keychain (Windows Credential Manager / macOS Keychain /
    // libsecret) is process-global, comparatively slow, and — when many tests
    // hammer it in parallel — occasionally returns a transient miss right after
    // a successful write, which made `has_credential_returns_true_after_save`
    // flaky. These tests only need to verify *our* save/get/has/delete logic and
    // JSON round-tripping, not the OS store itself, so we install a deterministic
    // in-memory credential builder via `set_default_credential_builder`.
    //
    // keyring's built-in `mock` store can't be used here: it builds a fresh,
    // empty credential per `Entry` (CredentialPersistence::EntryOnly), so a save
    // on one Entry isn't visible to the separate Entry our code creates for the
    // matching get/has — exactly the cross-instance persistence these tests rely
    // on. This builder keeps a shared map keyed by (service, user) instead.

    /// Secrets keyed by `(service, user)` — the same key the real stores use.
    type MockStore = HashMap<(String, String), Vec<u8>>;

    static MOCK_STORE: LazyLock<Mutex<MockStore>> = LazyLock::new(|| Mutex::new(HashMap::new()));

    #[derive(Debug)]
    struct MemCredential {
        key: (String, String),
    }

    impl CredentialApi for MemCredential {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            MOCK_STORE
                .lock()
                .unwrap()
                .insert(self.key.clone(), secret.to_vec());
            Ok(())
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            MOCK_STORE
                .lock()
                .unwrap()
                .get(&self.key)
                .cloned()
                .ok_or(keyring::Error::NoEntry)
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            match MOCK_STORE.lock().unwrap().remove(&self.key) {
                Some(_) => Ok(()),
                None => Err(keyring::Error::NoEntry),
            }
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    #[derive(Debug)]
    struct MemBuilder;

    impl CredentialBuilderApi for MemBuilder {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(MemCredential {
                key: (service.to_string(), user.to_string()),
            }))
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }

        fn persistence(&self) -> CredentialPersistence {
            CredentialPersistence::UntilDelete
        }
    }

    /// Install the in-memory keystore exactly once, before any `Entry` is built.
    /// `Once` blocks every caller until the first finishes, so as long as each
    /// test calls this first, the mock is guaranteed to be active.
    fn init_mock_keystore() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            keyring::set_default_credential_builder(Box::new(MemBuilder));
        });
    }

    /// A unique per-test host_id prevents keychain collisions when tests run
    /// in parallel.  The credential is deleted in a `Drop`-style guard so the
    /// store is left clean regardless of whether the test passes.
    struct KeychainGuard(String);

    impl Drop for KeychainGuard {
        fn drop(&mut self) {
            // Best-effort cleanup — ignore errors (entry may already be gone).
            let _ = delete_credential(&self.0);
        }
    }

    fn unique_id(suffix: &str) -> String {
        format!("anyscp-test-{}-{}", suffix, uuid::Uuid::new_v4())
    }

    #[test]
    fn round_trip_password_credential() {
        init_mock_keystore();
        let id = unique_id("password");
        let _guard = KeychainGuard(id.clone());

        let cred = StoredCredential::Password {
            password: "hunter2".to_string(),
        };
        save_credential(&id, &cred).expect("save");

        let retrieved = get_credential(&id).expect("get");
        match retrieved {
            StoredCredential::Password { password } => assert_eq!(password, "hunter2"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn round_trip_key_passphrase_credential() {
        init_mock_keystore();
        let id = unique_id("passphrase");
        let _guard = KeychainGuard(id.clone());

        let cred = StoredCredential::KeyPassphrase {
            passphrase: "super-secret".to_string(),
        };
        save_credential(&id, &cred).expect("save");

        let retrieved = get_credential(&id).expect("get");
        match retrieved {
            StoredCredential::KeyPassphrase { passphrase } => {
                assert_eq!(passphrase, "super-secret")
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn get_missing_returns_not_found() {
        init_mock_keystore();
        let id = unique_id("missing");
        // Do not save anything — the entry must not exist.
        let err = get_credential(&id).expect_err("should be NotFound");
        assert!(
            matches!(err, VaultError::NotFound(_)),
            "expected NotFound, got: {err:?}"
        );
    }

    #[test]
    fn has_credential_returns_false_when_absent() {
        init_mock_keystore();
        let id = unique_id("absent");
        assert!(!has_credential(&id));
    }

    #[test]
    fn has_credential_returns_true_after_save() {
        init_mock_keystore();
        let id = unique_id("present");
        let _guard = KeychainGuard(id.clone());

        save_credential(
            &id,
            &StoredCredential::Password {
                password: "x".to_string(),
            },
        )
        .expect("save");
        assert!(has_credential(&id));
    }

    #[test]
    fn delete_removes_credential() {
        init_mock_keystore();
        let id = unique_id("delete");
        // Guard will also try to delete — that is fine because delete is idempotent.
        let _guard = KeychainGuard(id.clone());

        save_credential(
            &id,
            &StoredCredential::Password {
                password: "y".to_string(),
            },
        )
        .expect("save");
        assert!(has_credential(&id));

        delete_credential(&id).expect("delete");
        assert!(!has_credential(&id));
    }

    #[test]
    fn delete_absent_credential_is_ok() {
        init_mock_keystore();
        let id = unique_id("delete-absent");
        // Deleting a non-existent entry must succeed silently.
        delete_credential(&id).expect("delete of missing entry should be Ok");
    }

    #[test]
    fn overwrite_replaces_credential() {
        init_mock_keystore();
        let id = unique_id("overwrite");
        let _guard = KeychainGuard(id.clone());

        save_credential(
            &id,
            &StoredCredential::Password {
                password: "old".to_string(),
            },
        )
        .expect("first save");
        save_credential(
            &id,
            &StoredCredential::Password {
                password: "new".to_string(),
            },
        )
        .expect("second save");

        match get_credential(&id).expect("get") {
            StoredCredential::Password { password } => assert_eq!(password, "new"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn vault_error_serialises_as_kind_message() {
        let err = VaultError::NotFound("host-x".to_string());
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "not_found");
        assert!(json["message"].as_str().unwrap().contains("host-x"));
    }
}
