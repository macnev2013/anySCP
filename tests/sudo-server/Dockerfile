# Passwordless-sudo test SSH server.
#
# Extends the upstream linuxserver/openssh-server image. With SUDO_ACCESS=true
# the base grants the user `sudo` but still PROMPTS FOR A PASSWORD (it appends
# `<user> ALL=(ALL) ALL` to /etc/sudoers, after the @includedir line, so a
# /etc/sudoers.d drop-in can't override it). This init script appends a
# NOPASSWD rule as the final — and therefore winning — match, so the SFTP
# sudo-mode toggle (`sudo -n sftp-server`) actually succeeds here.
#
# Built implicitly by docker compose for the `sshd-sudo` e2e service.
FROM lscr.io/linuxserver/openssh-server:latest

COPY enable-nopasswd-sudo.sh /custom-cont-init.d/enable-nopasswd-sudo.sh
RUN chmod +x /custom-cont-init.d/enable-nopasswd-sudo.sh

# `zip`, so the explorer's Compress action (#133) is tested producing a .zip
# here; sshd-pass has no zip and exercises the tar.gz fallback.
RUN apk add --no-cache zip
