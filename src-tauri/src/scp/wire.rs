//! SCP (rcp-over-ssh) wire protocol.
//!
//! Reference: the on-the-wire format used by OpenSSH `scp -t` (sink) and
//! `scp -f` (source). Messages are byte-oriented and synchronous:
//!
//! - **Ack byte**: `\0` = success. `\1 <msg>\n` = warning (continue).
//!   `\2 <msg>\n` = fatal (abort).
//! - **C record**: `C<mode_octal_4> <size_decimal> <name>\n` — a file
//!   header. After the ack, exactly `size` bytes follow, then the sender
//!   writes one `\0` byte and waits for an ack.
//! - **D record**: `D<mode_octal_4> 0 <name>\n` — enter a subdirectory.
//! - **E record**: `E\n` — leave the current subdirectory.
//! - **T record**: `T<mtime> 0 <atime> 0\n` — set timestamps on the next
//!   C or D record (only used with `-p`).
//!
//! This module operates on any `AsyncRead + AsyncWrite` so it can be unit
//! tested against a `tokio::io::duplex` pair without an SSH connection.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::ScpError;

/// Maximum length of a single header line. Real scp lines are well under
/// 4 KiB; cap reads to prevent a malicious peer from forcing unbounded
/// allocation.
const MAX_LINE_LEN: usize = 4096;

/// A single rcp-protocol record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScpMsg {
    /// `C<mode> <size> <name>\n` — file header.
    File { mode: u32, size: u64, name: String },
    /// `D<mode> 0 <name>\n` — enter directory.
    Dir { mode: u32, name: String },
    /// `E\n` — leave the current directory.
    EndDir,
    /// `T<mtime> 0 <atime> 0\n` — timestamp metadata for the next File/Dir.
    Time { mtime: u64, atime: u64 },
}

// ─── Ack handling ────────────────────────────────────────────────────────────

/// Read a single ack byte. `\0` returns Ok; `\1` / `\2` read the trailing
/// error message and surface it as `ScpError::RemoteError`.
pub async fn read_ack<R: AsyncRead + Unpin>(reader: &mut R) -> Result<(), ScpError> {
    let mut buf = [0u8; 1];
    reader.read_exact(&mut buf).await?;
    match buf[0] {
        0 => Ok(()),
        1 | 2 => {
            let msg = read_line(reader).await?;
            Err(ScpError::RemoteError(msg))
        }
        b => Err(ScpError::ProtocolError(format!(
            "unexpected ack byte: 0x{b:02x}"
        ))),
    }
}

/// Write a single `\0` ack byte and flush.
pub async fn write_ack<W: AsyncWrite + Unpin>(writer: &mut W) -> Result<(), ScpError> {
    writer.write_all(&[0u8]).await?;
    writer.flush().await?;
    Ok(())
}

// ─── Line reader ─────────────────────────────────────────────────────────────

/// Read bytes until `\n` (not included). Errors on EOF or oversized line.
async fn read_line<R: AsyncRead + Unpin>(reader: &mut R) -> Result<String, ScpError> {
    let mut buf = Vec::with_capacity(64);
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            return Err(ScpError::ProtocolError(
                "unexpected EOF while reading line".into(),
            ));
        }
        if byte[0] == b'\n' {
            break;
        }
        if buf.len() >= MAX_LINE_LEN {
            return Err(ScpError::ProtocolError("line exceeded 4 KiB".into()));
        }
        buf.push(byte[0]);
    }
    String::from_utf8(buf).map_err(|e| ScpError::ProtocolError(format!("invalid UTF-8: {e}")))
}

// ─── Message read/write ──────────────────────────────────────────────────────

/// Read the next protocol message from the source side.
///
/// Returns `Ok(None)` if the stream EOFs cleanly between records (this is
/// how `scp -f` signals "no more entries"). Errors on partial reads or
/// malformed records.
pub async fn read_msg<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<ScpMsg>, ScpError> {
    let mut byte = [0u8; 1];
    let n = reader.read(&mut byte).await?;
    if n == 0 {
        return Ok(None);
    }
    let kind = byte[0];
    let line = read_line(reader).await?;

    match kind {
        b'C' => {
            let (mode, size, name) = parse_c_or_d_payload(&line, true)?;
            Ok(Some(ScpMsg::File { mode, size, name }))
        }
        b'D' => {
            let (mode, _, name) = parse_c_or_d_payload(&line, false)?;
            Ok(Some(ScpMsg::Dir { mode, name }))
        }
        b'E' => {
            if !line.is_empty() {
                return Err(ScpError::ProtocolError(format!(
                    "E record had trailing data: {line:?}"
                )));
            }
            Ok(Some(ScpMsg::EndDir))
        }
        b'T' => {
            let (mtime, atime) = parse_t_payload(&line)?;
            Ok(Some(ScpMsg::Time { mtime, atime }))
        }
        1 | 2 => Err(ScpError::RemoteError(line)),
        b => Err(ScpError::ProtocolError(format!(
            "unexpected message kind: 0x{b:02x}"
        ))),
    }
}

/// Write a single record (header line only — caller is responsible for the
/// body bytes after a `File` record).
pub async fn write_msg<W: AsyncWrite + Unpin>(
    writer: &mut W,
    msg: &ScpMsg,
) -> Result<(), ScpError> {
    let line = match msg {
        ScpMsg::File { mode, size, name } => {
            validate_name(name)?;
            format!("C{:04o} {} {}\n", mode & 0o7777, size, name)
        }
        ScpMsg::Dir { mode, name } => {
            validate_name(name)?;
            format!("D{:04o} 0 {}\n", mode & 0o7777, name)
        }
        ScpMsg::EndDir => "E\n".to_string(),
        ScpMsg::Time { mtime, atime } => format!("T{mtime} 0 {atime} 0\n"),
    };
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

fn validate_name(name: &str) -> Result<(), ScpError> {
    // Names must not contain '/' (path separators) or '\n' (record terminator),
    // and must not be empty. scp itself wraps them as "basename only".
    if name.is_empty() {
        return Err(ScpError::ProtocolError("name is empty".into()));
    }
    if name.contains('/') {
        return Err(ScpError::ProtocolError(format!(
            "name contains '/': {name}"
        )));
    }
    if name.contains('\n') {
        return Err(ScpError::ProtocolError("name contains newline".into()));
    }
    Ok(())
}

// ─── Payload parsers ────────────────────────────────────────────────────────

/// Parse the payload after the leading `C` or `D` byte:
/// `<mode_octal> <size> <name>`. For directories `<size>` is always 0.
fn parse_c_or_d_payload(line: &str, _is_file: bool) -> Result<(u32, u64, String), ScpError> {
    // Format: "0644 1234 filename\n" — split into 3 fields, with name being
    // the rest after the second space (names may contain spaces themselves).
    let first_sp = line.find(' ').ok_or_else(|| {
        ScpError::ProtocolError(format!("C/D record missing first space: {line:?}"))
    })?;
    let mode_str = &line[..first_sp];
    let rest = &line[first_sp + 1..];

    let second_sp = rest.find(' ').ok_or_else(|| {
        ScpError::ProtocolError(format!("C/D record missing second space: {line:?}"))
    })?;
    let size_str = &rest[..second_sp];
    let name = &rest[second_sp + 1..];

    let mode = u32::from_str_radix(mode_str, 8)
        .map_err(|e| ScpError::ProtocolError(format!("invalid mode {mode_str:?}: {e}")))?;
    let size: u64 = size_str
        .parse()
        .map_err(|e| ScpError::ProtocolError(format!("invalid size {size_str:?}: {e}")))?;

    if name.is_empty() {
        return Err(ScpError::ProtocolError("C/D record has empty name".into()));
    }

    Ok((mode, size, name.to_string()))
}

/// Parse the payload after the leading `T` byte:
/// `<mtime> 0 <atime> 0`.
fn parse_t_payload(line: &str) -> Result<(u64, u64), ScpError> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() != 4 {
        return Err(ScpError::ProtocolError(format!(
            "T record expected 4 fields, got {}: {line:?}",
            parts.len()
        )));
    }
    let mtime: u64 = parts[0]
        .parse()
        .map_err(|e| ScpError::ProtocolError(format!("invalid mtime: {e}")))?;
    let atime: u64 = parts[2]
        .parse()
        .map_err(|e| ScpError::ProtocolError(format!("invalid atime: {e}")))?;
    Ok((mtime, atime))
}

// ─── Streaming helpers ───────────────────────────────────────────────────────

/// Stream `total` bytes from `reader` into `writer` in `CHUNK`-sized blocks,
/// invoking `on_progress(bytes_done_so_far, chunk_len)` after each write.
/// Polls `cancel()` between chunks — returns `TransferCancelled` if it goes
/// high.
///
/// The callback receives the *cumulative* bytes_transferred so far so it
/// matches the existing SFTP progress shape.
pub async fn stream_bytes<R, W, F, C>(
    reader: &mut R,
    writer: &mut W,
    total: u64,
    chunk_size: usize,
    cancel: C,
    mut on_progress: F,
) -> Result<(), ScpError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(u64),
    C: Fn() -> bool,
{
    let mut buf = vec![0u8; chunk_size];
    let mut remaining = total;
    let mut transferred: u64 = 0;

    while remaining > 0 {
        if cancel() {
            return Err(ScpError::TransferCancelled);
        }
        let want = (remaining as usize).min(chunk_size);
        let n = reader.read(&mut buf[..want]).await?;
        if n == 0 {
            return Err(ScpError::ProtocolError(format!(
                "unexpected EOF: {remaining} bytes still expected"
            )));
        }
        writer.write_all(&buf[..n]).await?;
        transferred += n as u64;
        remaining -= n as u64;
        on_progress(transferred);
    }
    writer.flush().await?;
    Ok(())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncWriteExt};

    #[tokio::test]
    async fn ack_ok_round_trip() {
        let (mut a, mut b) = duplex(64);
        write_ack(&mut a).await.unwrap();
        read_ack(&mut b).await.unwrap();
    }

    #[tokio::test]
    async fn ack_warning_surfaces_message() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"\x01boom\n").await.unwrap();
        let err = read_ack(&mut b).await.unwrap_err();
        assert!(matches!(err, ScpError::RemoteError(m) if m == "boom"));
    }

    #[tokio::test]
    async fn ack_fatal_surfaces_message() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"\x02file not found\n").await.unwrap();
        let err = read_ack(&mut b).await.unwrap_err();
        assert!(matches!(err, ScpError::RemoteError(m) if m == "file not found"));
    }

    #[tokio::test]
    async fn read_c_record() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"C0644 1234 hello.txt\n").await.unwrap();
        let msg = read_msg(&mut b).await.unwrap().unwrap();
        assert_eq!(
            msg,
            ScpMsg::File {
                mode: 0o644,
                size: 1234,
                name: "hello.txt".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn read_d_then_e() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"D0755 0 subdir\nE\n").await.unwrap();
        let msg1 = read_msg(&mut b).await.unwrap().unwrap();
        let msg2 = read_msg(&mut b).await.unwrap().unwrap();
        assert_eq!(
            msg1,
            ScpMsg::Dir {
                mode: 0o755,
                name: "subdir".into()
            }
        );
        assert_eq!(msg2, ScpMsg::EndDir);
    }

    #[tokio::test]
    async fn read_t_record() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"T1700000000 0 1700000001 0\n").await.unwrap();
        let msg = read_msg(&mut b).await.unwrap().unwrap();
        assert_eq!(
            msg,
            ScpMsg::Time {
                mtime: 1700000000,
                atime: 1700000001
            }
        );
    }

    #[tokio::test]
    async fn read_eof_returns_none() {
        let (a, mut b) = duplex(64);
        drop(a);
        let msg = read_msg(&mut b).await.unwrap();
        assert_eq!(msg, None);
    }

    #[tokio::test]
    async fn read_name_with_spaces() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"C0644 10 my file.txt\n").await.unwrap();
        let msg = read_msg(&mut b).await.unwrap().unwrap();
        assert_eq!(
            msg,
            ScpMsg::File {
                mode: 0o644,
                size: 10,
                name: "my file.txt".into()
            }
        );
    }

    #[tokio::test]
    async fn write_c_record_formats_correctly() {
        let (mut a, mut b) = duplex(64);
        write_msg(
            &mut a,
            &ScpMsg::File {
                mode: 0o644,
                size: 99,
                name: "data.bin".into(),
            },
        )
        .await
        .unwrap();
        let mut buf = [0u8; 32];
        let n = b.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"C0644 99 data.bin\n");
    }

    #[tokio::test]
    async fn write_d_e_round_trip() {
        let (mut a, mut b) = duplex(64);
        write_msg(
            &mut a,
            &ScpMsg::Dir {
                mode: 0o755,
                name: "sub".into(),
            },
        )
        .await
        .unwrap();
        write_msg(&mut a, &ScpMsg::EndDir).await.unwrap();
        let msg1 = read_msg(&mut b).await.unwrap().unwrap();
        let msg2 = read_msg(&mut b).await.unwrap().unwrap();
        assert!(matches!(msg1, ScpMsg::Dir { mode: 0o755, .. }));
        assert_eq!(msg2, ScpMsg::EndDir);
    }

    #[tokio::test]
    async fn write_rejects_name_with_slash() {
        let (mut a, _b) = duplex(64);
        let err = write_msg(
            &mut a,
            &ScpMsg::File {
                mode: 0o644,
                size: 1,
                name: "a/b".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ScpError::ProtocolError(_)));
    }

    #[tokio::test]
    async fn malformed_c_record_errors() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"C0644\n").await.unwrap();
        let err = read_msg(&mut b).await.unwrap_err();
        assert!(matches!(err, ScpError::ProtocolError(_)));
    }

    #[tokio::test]
    async fn invalid_octal_mode_errors() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"C9999 10 file\n").await.unwrap();
        let err = read_msg(&mut b).await.unwrap_err();
        assert!(matches!(err, ScpError::ProtocolError(_)));
    }

    #[tokio::test]
    async fn stream_bytes_copies_exact_count() {
        let (mut a, mut b) = duplex(1024);
        let payload = b"hello world".to_vec();
        let total = payload.len() as u64;

        // Writer drains into `a`, reader reads from a separate cursor.
        let (mut src_w, mut src_r) = duplex(1024);
        src_w.write_all(&payload).await.unwrap();
        drop(src_w);

        let mut progress_calls: Vec<u64> = Vec::new();
        stream_bytes(
            &mut src_r,
            &mut a,
            total,
            4,
            || false,
            |done| progress_calls.push(done),
        )
        .await
        .unwrap();

        let mut received = vec![0u8; payload.len()];
        b.read_exact(&mut received).await.unwrap();
        assert_eq!(received, payload);
        assert_eq!(*progress_calls.last().unwrap(), total);
    }

    #[tokio::test]
    async fn stream_bytes_honors_cancel() {
        let (mut sink, _drain) = duplex(1024);
        let (mut src_w, mut src_r) = duplex(1024);
        src_w.write_all(&vec![0u8; 100]).await.unwrap();
        drop(src_w);

        let err = stream_bytes(
            &mut src_r,
            &mut sink,
            100,
            8,
            || true, // cancelled from the start
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ScpError::TransferCancelled));
    }
}
