# SCP-only test SSH server.
#
# Extends the upstream linuxserver/openssh-server image with a single init
# script that comments out the `Subsystem sftp` line in sshd_config after
# the base image has generated it. SSH sessions and the legacy SCP protocol
# (scp -O) still work; SFTP and modern scp (>= OpenSSH 9.0, which defaults
# to SFTP) fail at channel-open.
#
# Built by `make scp-build` (or implicitly by `make start-scp-pass` and
# `make start-scp-key`).
FROM lscr.io/linuxserver/openssh-server:latest

# NOTE: SCP-mode directory listings use GNU `find -printf` / `stat -c`. This
# base image already ships GNU findutils + coreutils (verified: findutils
# 4.10.0), so no extra packages are needed — but that GNU dependency is the
# documented target for SCP browsing. A pure-busybox host would not list.

COPY disable-sftp.sh /custom-cont-init.d/disable-sftp.sh
RUN chmod +x /custom-cont-init.d/disable-sftp.sh
