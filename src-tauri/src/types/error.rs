use serde::Serialize;

/// All SSH-related errors surfaced to the frontend via Tauri command results.
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Channel error: {0}")]
    ChannelError(String),

    #[error("Key parse error: {0}")]
    KeyParseError(String),

    #[error("I/O error: {0}")]
    IoError(String),

    #[allow(dead_code)]
    #[error("Session already disconnected")]
    AlreadyDisconnected,
}

impl Serialize for SshError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("SshError", 2)?;
        let kind = match self {
            SshError::ConnectionFailed(_) => "connection_failed",
            SshError::AuthenticationFailed(_) => "authentication_failed",
            SshError::SessionNotFound(_) => "session_not_found",
            SshError::ChannelError(_) => "channel_error",
            SshError::KeyParseError(_) => "key_parse_error",
            SshError::IoError(_) => "io_error",
            SshError::AlreadyDisconnected => "already_disconnected",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<std::io::Error> for SshError {
    fn from(e: std::io::Error) -> Self {
        SshError::IoError(e.to_string())
    }
}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        SshError::ConnectionFailed(e.to_string())
    }
}

impl From<russh_keys::Error> for SshError {
    fn from(e: russh_keys::Error) -> Self {
        SshError::KeyParseError(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize(err: &SshError) -> serde_json::Value {
        serde_json::to_value(err).expect("serialize SshError")
    }

    #[test]
    fn display_uses_human_readable_prefix() {
        let err = SshError::ConnectionFailed("timed out".to_string());
        assert_eq!(err.to_string(), "Connection failed: timed out");
    }

    #[test]
    fn serialize_emits_kind_and_message() {
        // The frontend dispatches on the `kind` discriminator, so its exact
        // value is part of the public IPC contract.
        let cases: &[(SshError, &str, &str)] = &[
            (
                SshError::ConnectionFailed("host unreachable".into()),
                "connection_failed",
                "Connection failed: host unreachable",
            ),
            (
                SshError::AuthenticationFailed("bad password".into()),
                "authentication_failed",
                "Authentication failed: bad password",
            ),
            (
                SshError::SessionNotFound("abc-123".into()),
                "session_not_found",
                "Session not found: abc-123",
            ),
            (
                SshError::ChannelError("closed early".into()),
                "channel_error",
                "Channel error: closed early",
            ),
            (
                SshError::KeyParseError("invalid pem".into()),
                "key_parse_error",
                "Key parse error: invalid pem",
            ),
            (
                SshError::IoError("permission denied".into()),
                "io_error",
                "I/O error: permission denied",
            ),
            (
                SshError::AlreadyDisconnected,
                "already_disconnected",
                "Session already disconnected",
            ),
        ];

        for (err, expected_kind, expected_msg) in cases {
            let value = serialize(err);
            assert_eq!(
                value["kind"], *expected_kind,
                "wrong kind for {err:?}"
            );
            assert_eq!(
                value["message"], *expected_msg,
                "wrong message for {err:?}"
            );
        }
    }

    #[test]
    fn serialize_payload_has_exactly_two_fields() {
        // Guards against accidentally widening the payload (e.g. exposing
        // internal context the frontend isn't ready for).
        let value = serialize(&SshError::IoError("x".into()));
        let obj = value.as_object().expect("object");
        assert_eq!(obj.len(), 2);
        assert!(obj.contains_key("kind"));
        assert!(obj.contains_key("message"));
    }

    #[test]
    fn from_io_error_maps_to_io_variant() {
        let io_err =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope");
        let ssh_err: SshError = io_err.into();
        match ssh_err {
            SshError::IoError(msg) => assert!(msg.contains("nope")),
            other => panic!("expected IoError, got {other:?}"),
        }
    }
}
