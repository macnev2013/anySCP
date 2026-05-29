#!/bin/bash
# Runs from /custom-cont-init.d/ after the linuxserver base has generated
# /config/sshd/sshd_config and before sshd starts. Strips the SFTP
# subsystem so the container only serves SCP (legacy rcp-over-ssh).
set -eu

config=/config/sshd/sshd_config
if [ -f "$config" ]; then
    sed -i -E 's|^[[:space:]]*Subsystem[[:space:]]+sftp.*|# Subsystem sftp disabled (SCP-only test container)|' "$config"
    echo "[scp-only] SFTP subsystem disabled in $config"
else
    echo "[scp-only] WARNING: $config not found; SFTP disabling skipped" >&2
fi
