//! Verify ssh2-config 0.7 populates `unsupported_fields["proxycommand"]`
//! the way our import code expects.

use ssh2_config::{ParseRule, SshConfig};
use std::io::BufReader;

#[test]
fn proxy_command_lands_in_unsupported_fields() {
    let cfg = "Host testhost\n  HostName 198.51.100.10\n  User alice\n  ProxyCommand ssh -W %h:%p user@bastion.example.com\n\nHost *\n  ServerAliveInterval 30\n";
    let mut reader = BufReader::new(cfg.as_bytes());

    let config = SshConfig::default()
        .parse(
            &mut reader,
            ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS,
        )
        .expect("parse ok");

    let params = config.query("testhost");
    eprintln!("unsupported_fields keys: {:?}", params.unsupported_fields.keys().collect::<Vec<_>>());
    eprintln!("unsupported_fields full: {:?}", params.unsupported_fields);

    let pcmd = params.unsupported_fields.get("proxycommand");
    assert!(pcmd.is_some(), "expected proxycommand key, got {:?}", params.unsupported_fields);
    let joined = pcmd.unwrap().join(" ");
    eprintln!("joined ProxyCommand: {}", joined);
    assert!(joined.contains("bastion.example.com"));
}
