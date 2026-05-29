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

# The base image is Alpine, whose busybox `find`/`stat` lack the GNU flags
# (`find -printf`, `stat -c`) the SCP backend uses for directory listings.
# Install GNU coreutils + findutils so this fixture behaves like a typical
# GNU/Linux server — the documented target for SCP-mode browsing.
RUN apk add --no-cache coreutils findutils

COPY disable-sftp.sh /custom-cont-init.d/disable-sftp.sh
RUN chmod +x /custom-cont-init.d/disable-sftp.sh
