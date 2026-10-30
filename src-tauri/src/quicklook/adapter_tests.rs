//! Opt-in real protocol tests against tests/quicklook/compose.yml. No real
//! credentials or existing user sessions are used.
use super::{
    staging::{self, Source, StagingRoot},
    MAX_BYTES,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const PDF_FIXTURE: &[u8] = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 53 >>\nstream\nBT /F1 16 Tf 30 100 Td (anySCP Quick Look PDF) Tj ET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000241 00000 n \n0000000343 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n413\n%%EOF\n";

type Handle = crate::ssh::handle::SharedHandle;

async fn connect(port: u16) -> Handle {
    let config = Arc::new(russh::client::Config::default());
    let mut handle = russh::client::connect(
        config,
        ("127.0.0.1", port),
        crate::ssh::handler::SshClientHandler,
    )
    .await
    .unwrap();
    assert!(handle
        .authenticate_password("testuser", "testpass")
        .await
        .unwrap());
    Arc::new(crate::ssh::handle::ConnectionHandle::new(handle))
}

#[tokio::test]
#[ignore = "requires loopback SSH/SCP fixture containers from tests/quicklook/compose.yml"]
async fn quicklook_real_ssh_adapters() {
    for (port, is_sftp, expected_flavor) in [
        (24222, true, crate::scp::listing::Flavor::Gnu),
        (24223, false, crate::scp::listing::Flavor::Gnu),
        (24224, false, crate::scp::listing::Flavor::Busybox),
    ] {
        let handle = connect(port).await;
        let flavor = crate::scp::exec::detect_flavor(handle.clone())
            .await
            .unwrap();
        assert_eq!(flavor, expected_flavor);
        let remote_dir = format!("/tmp/anyscp-preview-{}", uuid::Uuid::new_v4());
        let cmd = format!("mkdir {}", crate::scp::shell_quote(&remote_dir));
        crate::scp::exec::ssh_exec(handle.clone(), &cmd)
            .await
            .unwrap();
        let parent = tempfile::tempdir().unwrap();
        let staging = StagingRoot::new(parent.path()).unwrap();
        let source = |path: String| {
            if is_sftp {
                Source::Sftp {
                    handle: handle.clone(),
                    sudo: false,
                    path,
                    ssh_id: "fixture".into(),
                }
            } else {
                Source::Scp {
                    handle: handle.clone(),
                    flavor,
                    path,
                    ssh_id: "fixture".into(),
                }
            }
        };
        let token = CancellationToken::new();
        let scope = crate::ssh::channel_scope::ChannelScope::new(&token);
        for (name, contents) in [
            ("Unicode 測試.txt", b"preview text\n".as_slice()),
            (
                "image.png",
                include_bytes!("../../icons/32x32.png").as_slice(),
            ),
            ("document.pdf", PDF_FIXTURE),
            ("empty.txt", b"".as_slice()),
        ] {
            let local = parent.path().join(name);
            std::fs::write(&local, contents).unwrap();
            let remote = format!("{remote_dir}/{name}");
            crate::scp::transfer::upload_file(handle.clone(), &local, &remote, &token, |_| {})
                .await
                .unwrap();
            let file = staging.request(name).unwrap();
            staging::download(&source(remote), &file, &token, &scope, |_, _| {})
                .await
                .unwrap();
            assert_eq!(std::fs::read(&file.complete).unwrap(), contents);
        }
        // Exercise cache reuse through each real protocol. Fixed mtimes avoid
        // sleeps and catch implementations that trust a stale Explorer row.
        let remote = format!("{remote_dir}/Unicode 測試.txt");
        let quoted = crate::scp::shell_quote(&remote);
        assert_eq!(
            crate::scp::exec::ssh_exec(handle.clone(), &format!("touch -t 202001010000 {quoted}"))
                .await
                .unwrap()
                .2,
            0
        );
        let cache_source = source(remote.clone());
        let prepare = |cached| {
            let fresh = Arc::new(staging.request("Unicode 測試.txt").unwrap());
            let source = &cache_source;
            async move {
                let token = CancellationToken::new();
                let scope = crate::ssh::channel_scope::ChannelScope::new(&token);
                let result = super::with_deadline(
                    &token,
                    tokio::time::Instant::now() + std::time::Duration::from_secs(10),
                    super::cache::prepare(source, &fresh, cached, &token, &scope, |_, _| {}),
                )
                .await;
                scope.finish().await;
                result.unwrap()
            }
        };
        let first = prepare(None).await;
        let second = prepare(Some(first.clone())).await;
        assert!(
            Arc::ptr_eq(&first, &second),
            "unchanged {port} file must reuse its completed download"
        );
        let local = parent.path().join("updated.txt");
        std::fs::write(&local, b"updated text\n").unwrap();
        crate::scp::transfer::upload_file(handle.clone(), &local, &remote, &token, |_| {})
            .await
            .unwrap();
        assert_eq!(
            crate::scp::exec::ssh_exec(handle.clone(), &format!("touch -t 203701010000 {quoted}"))
                .await
                .unwrap()
                .2,
            0
        );
        let third = prepare(Some(second)).await;
        assert_ne!(first.file.complete, third.file.complete);
        assert_eq!(
            std::fs::read(&third.file.complete).unwrap(),
            b"updated text\n"
        );

        let base = crate::scp::shell_quote(&remote_dir);
        let command = format!("ln -s {base}/image.png {base}/link.png; mkdir {base}/folder; touch {base}/denied.txt; chmod 000 {base}/denied.txt; truncate -s {} {base}/large.txt", MAX_BYTES + 1);
        // busybox's truncate is also supported by the fixture image.
        assert_eq!(
            crate::scp::exec::ssh_exec(handle.clone(), &command)
                .await
                .unwrap()
                .2,
            0
        );
        for (name, kind) in [
            ("link.png", "invalid_selection"),
            ("folder", "invalid_selection"),
            ("missing.txt", "download_failed"),
            ("denied.txt", "permission_denied"),
            ("large.txt", "too_large"),
        ] {
            let file = staging.request(name).unwrap();
            let error = staging::download(
                &source(format!("{remote_dir}/{name}")),
                &file,
                &token,
                &scope,
                |_, _| {},
            )
            .await
            .unwrap_err();
            assert_eq!(error.kind, kind, "port {port}, {name}: {error}");
            assert!(!file.complete.exists());
        }
        scope.finish().await;
        let command = format!("rm -rf {}", crate::scp::shell_quote(&remote_dir));
        crate::scp::exec::ssh_exec(handle, &command).await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires local MinIO fixture from tests/quicklook/compose.yml"]
async fn quicklook_real_s3_adapter() {
    use s3::{bucket_ops::BucketConfiguration, creds::Credentials, Bucket, Region};
    let credentials =
        Credentials::new(Some("minioadmin"), Some("minioadmin"), None, None, None).unwrap();
    let region = Region::Custom {
        region: "us-east-1".into(),
        endpoint: "http://127.0.0.1:24900".into(),
    };
    let name = format!("quicklook-{}", uuid::Uuid::new_v4());
    let bucket =
        Bucket::create_with_path_style(&name, region, credentials, BucketConfiguration::default())
            .await
            .unwrap()
            .bucket;
    let parent = tempfile::tempdir().unwrap();
    let staging = StagingRoot::new(parent.path()).unwrap();
    let token = CancellationToken::new();
    let scope = crate::ssh::channel_scope::ChannelScope::new(&token);
    for (key, contents) in [
        ("a/測試.txt", b"preview from S3".as_slice()),
        (
            "b/image.png",
            include_bytes!("../../icons/32x32.png").as_slice(),
        ),
        ("c/empty.txt", b"".as_slice()),
        ("d/document.pdf", PDF_FIXTURE),
    ] {
        bucket.put_object(key, contents).await.unwrap();
        let file = staging.request(key.rsplit('/').next().unwrap()).unwrap();
        staging::download(
            &Source::S3 {
                bucket: bucket.clone(),
                key: key.into(),
            },
            &file,
            &token,
            &scope,
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&file.complete).unwrap(), contents);
        bucket.delete_object(key).await.unwrap();
    }
    let file = staging.request("missing.txt").unwrap();
    assert!(staging::download(
        &Source::S3 {
            bucket: bucket.clone(),
            key: "missing.txt".into()
        },
        &file,
        &token,
        &scope,
        |_, _| {}
    )
    .await
    .is_err());
    // A request retains its original bucket even after a session switches to
    // a different bucket with the exact same object key.
    let other_name = format!("quicklook-{}", uuid::Uuid::new_v4());
    let other = Bucket::create_with_path_style(
        &other_name,
        bucket.region().clone(),
        bucket.credentials().await.unwrap(),
        BucketConfiguration::default(),
    )
    .await
    .unwrap()
    .bucket;
    bucket
        .put_object("same-name.txt", b"bucket A")
        .await
        .unwrap();
    other
        .put_object("same-name.txt", b"bucket B")
        .await
        .unwrap();
    let manager = crate::s3::S3Manager::new();
    manager
        .connect(
            "fixture".into(),
            "test".into(),
            &name,
            "us-east-1",
            Some("http://127.0.0.1:24900"),
            "minioadmin",
            "minioadmin",
            true,
        )
        .unwrap();
    let snapshot = manager.get_bucket("fixture").unwrap();
    manager.switch_bucket("fixture", &other_name).await.unwrap();
    for (pinned, expected) in [
        (snapshot, b"bucket A".as_slice()),
        (
            manager.get_bucket("fixture").unwrap(),
            b"bucket B".as_slice(),
        ),
    ] {
        let file = staging.request("same-name.txt").unwrap();
        staging::download(
            &Source::S3 {
                bucket: pinned,
                key: "same-name.txt".into(),
            },
            &file,
            &token,
            &scope,
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&file.complete).unwrap(), expected);
    }
    bucket.delete_object("same-name.txt").await.unwrap();
    other.delete_object("same-name.txt").await.unwrap();
    other.delete().await.unwrap();
    manager.disconnect("fixture");
    scope.finish().await;
    bucket.delete().await.unwrap();
}

#[tokio::test]
#[ignore = "requires loopback SSH/SCP fixtures from tests/quicklook/compose.yml"]
async fn quicklook_repeated_real_cancellation_releases_channels() {
    for (port, sftp) in [(24222, true), (24223, false), (24224, false)] {
        let handle = connect(port).await;
        let flavor = crate::scp::exec::detect_flavor(handle.clone())
            .await
            .unwrap();
        let remote = format!("/tmp/preview-cancel-{}", uuid::Uuid::new_v4());
        let command = format!("truncate -s 20971520 {}", crate::scp::shell_quote(&remote));
        assert_eq!(
            crate::scp::exec::ssh_exec(handle.clone(), &command)
                .await
                .unwrap()
                .2,
            0
        );
        let parent = tempfile::tempdir().unwrap();
        let staging = StagingRoot::new(parent.path()).unwrap();
        let source = if sftp {
            Source::Sftp {
                handle: handle.clone(),
                sudo: false,
                path: remote.clone(),
                ssh_id: "fixture".into(),
            }
        } else {
            Source::Scp {
                handle: handle.clone(),
                flavor,
                path: remote.clone(),
                ssh_id: "fixture".into(),
            }
        };
        for _ in 0..12 {
            let token = CancellationToken::new();
            let scope = crate::ssh::channel_scope::ChannelScope::new(&token);
            let file = staging.request("cancel.txt").unwrap();
            let result = super::with_deadline(
                &token,
                tokio::time::Instant::now() + std::time::Duration::from_secs(10),
                staging::download(&source, &file, &token, &scope, |bytes, _| {
                    if bytes > 0 {
                        token.cancel();
                    }
                }),
            )
            .await;
            scope.finish().await;
            assert_eq!(result.unwrap_err().kind, "cancelled");
            assert!(!file.complete.exists());
        }
        // Leaked channels would exceed OpenSSH's MaxSessions before this point.
        let token = CancellationToken::new();
        let scope = crate::ssh::channel_scope::ChannelScope::new(&token);
        let file = staging.request("complete.txt").unwrap();
        super::with_deadline(
            &token,
            tokio::time::Instant::now() + std::time::Duration::from_secs(20),
            staging::download(&source, &file, &token, &scope, |_, _| {}),
        )
        .await
        .unwrap();
        scope.finish().await;
        assert_eq!(
            std::fs::metadata(&file.complete).unwrap().len(),
            20 * 1024 * 1024
        );
        let command = format!("rm -f {}", crate::scp::shell_quote(&remote));
        assert_eq!(
            crate::scp::exec::ssh_exec(handle, &command)
                .await
                .unwrap()
                .2,
            0
        );
    }
}

#[tokio::test]
#[ignore = "requires local MinIO fixture from tests/quicklook/compose.yml"]
async fn quicklook_s3_if_match_is_enforced_without_mutating_shared_bucket() {
    use s3::{bucket_ops::BucketConfiguration, creds::Credentials, Bucket, Region};
    let credentials =
        Credentials::new(Some("minioadmin"), Some("minioadmin"), None, None, None).unwrap();
    let region = Region::Custom {
        region: "us-east-1".into(),
        endpoint: "http://127.0.0.1:24900".into(),
    };
    let name = format!("quicklook-{}", uuid::Uuid::new_v4());
    let bucket =
        Bucket::create_with_path_style(&name, region, credentials, BucketConfiguration::default())
            .await
            .unwrap()
            .bucket;
    bucket.put_object("object", b"old version").await.unwrap();
    let (head, _) = bucket.head_object("object").await.unwrap();
    bucket.put_object("object", b"new version").await.unwrap();
    let mut pinned = bucket.clone();
    pinned
        .extra_headers_mut()
        .insert("if-match", head.e_tag.unwrap().parse().unwrap());
    assert_ne!(
        pinned
            .get_object_stream("object")
            .await
            .map(|response| response.status_code)
            .ok(),
        Some(200)
    );
    assert!(bucket.extra_headers().get("if-match").is_none());
    bucket.delete_object("object").await.unwrap();
    bucket.delete().await.unwrap();
}

#[tokio::test]
#[ignore = "requires loopback SSH fixture from tests/quicklook/compose.yml"]
async fn quicklook_cancels_real_stalled_sftp_and_scp_readers() {
    let handle = connect(24222).await;
    for sftp in [true, false] {
        let channel = handle.channel_open_session().await.unwrap();
        channel.exec(true, "sleep 30").await.unwrap();
        let cancel = CancellationToken::new();
        let scope = crate::ssh::channel_scope::ChannelScope::new(&cancel);
        let mut stream = scope.stream(channel);
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            trigger.cancel();
        });
        let start = std::time::Instant::now();
        let read = async {
            if sftp {
                let _ = russh_sftp::client::SftpSession::new(stream).await;
            } else {
                let _ = crate::scp::wire::read_msg(&mut stream).await;
            }
            Ok(())
        };
        assert_eq!(
            super::with_deadline(
                &cancel,
                tokio::time::Instant::now() + std::time::Duration::from_secs(5),
                read
            )
            .await
            .unwrap_err()
            .kind,
            "cancelled"
        );
        scope.finish().await;
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }
    assert_eq!(
        crate::scp::exec::ssh_exec(handle, "true").await.unwrap().2,
        0
    );
}
