use super::error::RdpError;
use super::session::RdpSession;
use super::types::{RdpConfig, RdpKeyInput, RdpMouseInput, RdpStatusPayload};
use dashmap::DashMap;
use tauri::{AppHandle, Emitter};
use tracing::info;
use uuid::Uuid;

pub struct RdpManager {
    sessions: DashMap<String, RdpSession>,
}

impl RdpManager {
    pub fn new() -> Self {
        Self { sessions: DashMap::new() }
    }

    pub async fn connect(
        &self,
        config: RdpConfig,
        app_handle: AppHandle,
    ) -> Result<(String, u16), RdpError> {
        let session_id = Uuid::new_v4().to_string();
        let sid = session_id.clone();

        let session = RdpSession::connect(config, sid.clone(), app_handle).await?;
        let ws_port = session.ws_port;
        self.sessions.insert(sid.clone(), session);

        info!(session_id = %sid, ws_port, "RDP session created");
        Ok((sid, ws_port))
    }

    pub fn send_mouse(&self, session_id: &str, input: RdpMouseInput) -> Result<(), RdpError> {
        self.sessions.get(session_id)
            .ok_or_else(|| RdpError::SessionNotFound(session_id.into()))?
            .send_mouse(input)
    }

    pub fn send_key(&self, session_id: &str, input: RdpKeyInput) -> Result<(), RdpError> {
        self.sessions.get(session_id)
            .ok_or_else(|| RdpError::SessionNotFound(session_id.into()))?
            .send_key(input)
    }

    pub fn resize(&self, session_id: &str, width: u16, height: u16) -> Result<(), RdpError> {
        self.sessions.get(session_id)
            .ok_or_else(|| RdpError::SessionNotFound(session_id.into()))?
            .resize(width, height)
    }

    pub async fn disconnect(&self, session_id: &str, app_handle: AppHandle) -> Result<(), RdpError> {
        let _ = app_handle.emit("rdp:status", &RdpStatusPayload {
            session_id: session_id.to_string(),
            status: "Disconnecting".to_string(),
            message: None,
        });

        let (_, session) = self.sessions.remove(session_id)
            .ok_or_else(|| RdpError::SessionNotFound(session_id.into()))?;

        session.disconnect().await?;
        info!(session_id = %session_id, "RDP disconnected");
        Ok(())
    }
}
