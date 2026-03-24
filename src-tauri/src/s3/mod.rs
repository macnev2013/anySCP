pub mod commands;
pub mod transfer_manager;

use dashmap::DashMap;
use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde::{Deserialize, Serialize};

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum S3Error {
    #[error("S3 session not found: {0}")]
    SessionNotFound(String),
    #[error("S3 error: {0}")]
    OperationError(String),
    #[error("Invalid credentials: {0}")]
    CredentialError(String),
    #[error("I/O error: {0}")]
    IoError(String),
    #[error("Transfer cancelled")]
    TransferCancelled,
}

impl Serialize for S3Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("S3Error", 2)?;
        let kind = match self {
            S3Error::SessionNotFound(_) => "session_not_found",
            S3Error::OperationError(_) => "operation_error",
            S3Error::CredentialError(_) => "credential_error",
            S3Error::IoError(_) => "io_error",
            S3Error::TransferCancelled => "transfer_cancelled",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

// ─── Transfer types ──────────────────────────────────────────────────────────

/// Event payload emitted to the frontend on the `s3:transfer` channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3TransferEvent {
    pub transfer_id: String,
    pub s3_session_id: String,
    /// Display name — file name for single-file transfers, directory name for dirs.
    pub name: String,
    pub direction: S3TransferDirection,
    pub status: S3TransferStatus,
    /// Populated only when status is `Failed`.
    pub error: Option<String>,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    /// Unix timestamp in milliseconds.
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum S3TransferDirection {
    Download,
    Upload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum S3TransferStatus {
    Queued,
    InProgress,
    Completed,
    Failed(String),
    Cancelled,
}

// ─── Additional error variant for transfer cancellation ──────────────────────

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Entry {
    pub name: String,
    pub key: String,
    pub entry_type: S3EntryType,
    pub size: u64,
    pub last_modified: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum S3EntryType {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3BucketInfo {
    pub name: String,
    pub creation_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3ListResult {
    pub entries: Vec<S3Entry>,
    pub continuation_token: Option<String>,
    pub is_truncated: bool,
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Connection {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub path_style: bool,
    pub group_id: Option<String>,
    pub color: Option<String>,
    pub environment: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
}

// ─── Manager ─────────────────────────────────────────────────────────────────

struct S3Session {
    bucket: Box<Bucket>,
    #[allow(dead_code)]
    label: String,
}

pub struct S3Manager {
    sessions: DashMap<String, S3Session>,
}

impl S3Manager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    pub fn connect(
        &self,
        session_id: String,
        label: String,
        bucket_name: &str,
        region: &str,
        endpoint: Option<&str>,
        access_key: &str,
        secret_key: &str,
        path_style: bool,
    ) -> Result<(), S3Error> {
        let credentials = Credentials::new(
            Some(access_key),
            Some(secret_key),
            None,
            None,
            None,
        )
        .map_err(|e| S3Error::CredentialError(e.to_string()))?;

        let region = if let Some(ep) = endpoint {
            Region::Custom {
                region: region.to_string(),
                endpoint: ep.to_string(),
            }
        } else {
            region
                .parse::<Region>()
                .map_err(|e| S3Error::OperationError(format!("Invalid region: {e}")))?
        };

        let mut bucket = Bucket::new(bucket_name, region, credentials)
            .map_err(|e| S3Error::OperationError(e.to_string()))?;

        if path_style {
            bucket = bucket.with_path_style();
        }

        self.sessions.insert(
            session_id,
            S3Session {
                bucket,
                label,
            },
        );

        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub fn get_bucket(
        &self,
        session_id: &str,
    ) -> Result<Box<Bucket>, S3Error> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| S3Error::SessionNotFound(session_id.to_string()))?;
        Ok(session.bucket.clone())
    }

    pub async fn switch_bucket(
        &self,
        session_id: &str,
        bucket_name: &str,
    ) -> Result<(), S3Error> {
        let mut session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| S3Error::SessionNotFound(session_id.to_string()))?;

        let creds = session.bucket.credentials().await
            .map_err(|e| S3Error::CredentialError(e.to_string()))?;

        let new_bucket = Bucket::new(
            bucket_name,
            session.bucket.region().clone(),
            creds,
        )
        .map_err(|e| S3Error::OperationError(e.to_string()))?;

        session.bucket = if session.bucket.is_path_style() {
            new_bucket.with_path_style()
        } else {
            new_bucket
        };

        Ok(())
    }
}
