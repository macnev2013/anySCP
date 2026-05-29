# Pure-busybox SCP-only SSH server.
#
# Unlike tests/scp-server (linuxserver, which ships GNU coreutils/findutils),
# this is a bare Alpine with ONLY busybox `find`/`stat` — no GNU tools. It
# exercises the SCP backend's busybox flavor path (`find … -exec stat -c …`,
# since busybox find has no `-printf`). The SFTP subsystem is stripped so the
# app must fall back to SCP.
#
# Built by the e2e compose stack (service: sshd-scp-busybox).
FROM alpine:3.20

# openssh meta-package brings sshd + scp (openssh-client). We deliberately do
# NOT install coreutils/findutils, so find/stat stay busybox.
RUN apk add --no-cache openssh \
    && ssh-keygen -A \
    && adduser -D testuser \
    && echo 'testuser:testpass' | chpasswd \
    # Strip the SFTP subsystem so only SCP works.
    && sed -i -E 's|^[[:space:]]*Subsystem[[:space:]]+sftp.*|# sftp disabled (busybox scp-only)|' /etc/ssh/sshd_config \
    && sed -i -E 's|^#?[[:space:]]*PasswordAuthentication.*|PasswordAuthentication yes|' /etc/ssh/sshd_config \
    # Seed the home dir so listing has something to render.
    && mkdir -p /home/testuser/seeddir \
    && echo 'hello from busybox' > /home/testuser/seed.txt \
    && echo 'nested' > /home/testuser/seeddir/inner.txt \
    && chown -R testuser:testuser /home/testuser

# Confirm at build time that find is busybox (no -printf) — documents intent.
RUN ! find / -maxdepth 0 -printf '' 2>/dev/null && echo "confirmed: busybox find (no -printf)"

EXPOSE 2222
# Run sshd in the foreground on 2222 to match the other test targets.
CMD ["/usr/sbin/sshd", "-D", "-e", "-p", "2222"]
