use super::*;

use std::io::Cursor;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite};

const C: u64 = CHUNK_SIZE as u64;

#[test]
fn upload_checkpoint_keeps_each_region_cursor() {
    let file = tempfile::NamedTempFile::new().unwrap();
    file.as_file().set_len((CHUNK_SIZE as u64) * 4).unwrap();
    let checkpoint = UploadCheckpoint::new(&file.as_file().metadata().unwrap());
    let pending = checkpoint.pending_regions();

    checkpoint.advance(pending[1].0, 4096);

    assert_eq!(checkpoint.transferred(), 4096);
    assert_eq!(checkpoint.pending_regions()[1].1, pending[1].1 + 4096);
}

#[test]
fn plan_regions_empty_file_has_no_regions() {
    assert!(plan_upload_regions(0).is_empty());
}

#[test]
fn plan_regions_small_files_get_a_single_region() {
    for size in [1, C - 1, C, 2 * C - 1] {
        assert_eq!(plan_upload_regions(size), vec![(0, size)], "size {size}");
    }
}

#[test]
fn plan_regions_depth_scales_with_size_up_to_pipeline_depth() {
    assert_eq!(plan_upload_regions(2 * C).len(), 3);
    assert_eq!(plan_upload_regions(100 * C).len(), PIPELINE_DEPTH as usize);
}

#[test]
fn plan_regions_cover_the_file_exactly_without_overlap() {
    let sizes = [
        1,
        2,
        C - 1,
        C,
        C + 1,
        2 * C,
        2 * C + 1,
        3 * C,
        4 * C,
        10 * C + 7,
        1_000_000_007,
    ];
    for size in sizes {
        let regions = plan_upload_regions(size);
        assert!(!regions.is_empty(), "size {size}");
        assert!(regions.len() <= PIPELINE_DEPTH as usize, "size {size}");
        assert_eq!(regions.first().unwrap().0, 0, "size {size}");
        assert_eq!(regions.last().unwrap().1, size, "size {size}");
        for (start, end) in &regions {
            assert!(start < end, "empty region at size {size}");
        }
        for pair in regions.windows(2) {
            assert_eq!(pair[0].1, pair[1].0, "gap/overlap at size {size}");
        }
    }
}

fn test_data(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

struct TrickleReader {
    inner: Cursor<Vec<u8>>,
    max: usize,
}

impl AsyncRead for TrickleReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let cap = self.max.min(buf.remaining());
        let mut tmp = vec![0u8; cap];
        let n = std::io::Read::read(&mut self.inner, &mut tmp).unwrap();
        buf.put_slice(&tmp[..n]);
        Poll::Ready(Ok(()))
    }
}

struct FailingWriter {
    written: usize,
    accept: usize,
}

impl AsyncWrite for FailingWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.written + buf.len() > self.accept {
            return Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "connection lost",
            )));
        }
        self.written += buf.len();
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn copy_region_copies_exact_bytes_and_reports_progress() {
    let data = test_data(3 * CHUNK_SIZE + 17);
    let mut source = Cursor::new(data.clone());
    let mut destination = Cursor::new(Vec::new());
    let token = CancellationToken::new();
    let mut progressed = 0u64;

    copy_region(
        &mut source,
        &mut destination,
        data.len() as u64,
        &token,
        |bytes| {
            progressed += bytes;
            Ok(())
        },
    )
    .await
    .unwrap();

    assert_eq!(destination.into_inner(), data);
    assert_eq!(progressed, data.len() as u64);
}

#[tokio::test]
async fn copy_region_handles_short_reads() {
    let data = test_data(10_000);
    let mut source = TrickleReader {
        inner: Cursor::new(data.clone()),
        max: 337,
    };
    let mut destination = Cursor::new(Vec::new());
    let token = CancellationToken::new();

    copy_region(
        &mut source,
        &mut destination,
        data.len() as u64,
        &token,
        |_| Ok(()),
    )
    .await
    .unwrap();

    assert_eq!(destination.into_inner(), data);
}

#[tokio::test]
async fn copy_region_errors_when_source_runs_dry() {
    let mut source = Cursor::new(test_data(400));
    let mut destination = Cursor::new(Vec::new());
    let token = CancellationToken::new();

    let error = copy_region(&mut source, &mut destination, 1000, &token, |_| Ok(()))
        .await
        .unwrap_err();

    match error {
        SftpError::LocalIoError(message) => assert!(message.contains("shrank")),
        other => panic!("expected LocalIoError, got {other:?}"),
    }
}

#[tokio::test]
async fn copy_region_stops_immediately_when_already_cancelled() {
    let mut source = Cursor::new(test_data(1000));
    let mut destination = Cursor::new(Vec::new());
    let token = CancellationToken::new();
    token.cancel();

    let error = copy_region(&mut source, &mut destination, 1000, &token, |_| Ok(()))
        .await
        .unwrap_err();

    assert!(matches!(error, SftpError::TransferCancelled));
    assert!(destination.into_inner().is_empty());
}

#[tokio::test]
async fn copy_region_stops_at_next_chunk_after_cancellation() {
    let mut source = TrickleReader {
        inner: Cursor::new(test_data(1000)),
        max: 100,
    };
    let mut destination = Cursor::new(Vec::new());
    let token = CancellationToken::new();
    let cancel_after_progress = token.clone();

    let error = copy_region(&mut source, &mut destination, 1000, &token, |_| {
        cancel_after_progress.cancel();
        Ok(())
    })
    .await
    .unwrap_err();

    assert!(matches!(error, SftpError::TransferCancelled));
    assert_eq!(destination.into_inner().len(), 100);
}

#[tokio::test]
async fn copy_region_surfaces_write_failures() {
    let data = test_data(2 * CHUNK_SIZE);
    let mut source = Cursor::new(data);
    let mut destination = FailingWriter {
        written: 0,
        accept: CHUNK_SIZE,
    };
    let token = CancellationToken::new();

    let error = copy_region(
        &mut source,
        &mut destination,
        (2 * CHUNK_SIZE) as u64,
        &token,
        |_| Ok(()),
    )
    .await
    .unwrap_err();

    assert!(matches!(error, SftpError::TransportError(_)));
}

#[tokio::test]
async fn copy_region_propagates_progress_errors() {
    let mut source = Cursor::new(test_data(100));
    let mut destination = Cursor::new(Vec::new());
    let token = CancellationToken::new();

    let error = copy_region(&mut source, &mut destination, 100, &token, |_| {
        Err(SftpError::ChannelError("progress sink gone".into()))
    })
    .await
    .unwrap_err();

    assert!(matches!(error, SftpError::ChannelError(_)));
}

#[tokio::test]
async fn planned_regions_reassemble_into_identical_file() {
    let data = test_data(3 * CHUNK_SIZE + 1234);
    let regions = plan_upload_regions(data.len() as u64);
    assert!(regions.len() > 1);

    let token = CancellationToken::new();
    let mut assembled = vec![0u8; data.len()];
    for &(start, end) in &regions {
        let mut source = Cursor::new(data[start as usize..end as usize].to_vec());
        let mut destination = Cursor::new(Vec::new());
        copy_region(&mut source, &mut destination, end - start, &token, |_| {
            Ok(())
        })
        .await
        .unwrap();
        assembled[start as usize..end as usize].copy_from_slice(&destination.into_inner());
    }

    assert_eq!(assembled, data);
}
