#!/bin/bash
# Runs from /custom-cont-init.d/ after the linuxserver base has written its
# sshd_config (the running sshd reads /config/sshd/sshd_config via `-f`) and
# before sshd starts. The image ships `AllowTcpForwarding no`, which blocks the
# direct-tcpip channels a ProxyJump bastion opens to reach the next hop. Flip it
# to `yes` in whichever config file is present so the tunnel can be established.
set -eu

for cfg in /config/sshd/sshd_config /etc/ssh/sshd_config; do
    [ -f "$cfg" ] || continue
    if grep -qE '^[[:space:]]*AllowTcpForwarding[[:space:]]' "$cfg"; then
        sed -i -E 's/^[[:space:]]*AllowTcpForwarding[[:space:]].*/AllowTcpForwarding yes/' "$cfg"
    else
        printf '\nAllowTcpForwarding yes\n' >> "$cfg"
    fi
    echo "[tcp-forwarding] enabled in $cfg"
done
