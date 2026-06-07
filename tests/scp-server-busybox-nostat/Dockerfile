# Stripped-busybox SCP-only SSH server — reproduces issue #3.
#
# This models a minimal embedded userland (e.g. Buildroot 2020.02.1) where the
# busybox `stat` applet is compiled OUT entirely. With no `stat` AND no GNU
# `find -printf`, the SCP backend's flavor detection cannot use either the
# `busybox` (`stat -c`) or `bsd` (`stat -f`) listing path — it must fall through
# to the universal `ls -la`-based `Posix` path. Without that fallback the
# Explorer connects but lists NO files (the exact symptom reported in #3).
#
# Contrast with tests/scp-server-busybox, whose Alpine busybox DOES ship `stat`
# and therefore exercises the `busybox` flavor path instead.
#
# Built by the e2e compose stack (service: sshd-scp-busybox-nostat).
FROM alpine:3.20

# openssh brings sshd + scp. We deliberately do NOT install coreutils/findutils,
# so find/ls stay busybox; then we remove the `stat` applet to mimic a build
# that compiled it out.
RUN apk add --no-cache openssh \
    && ssh-keygen -A \
    && adduser -D testuser \
    && echo 'testuser:testpass' | chpasswd \
    # Strip the SFTP subsystem so only SCP works.
    && sed -i -E 's|^[[:space:]]*Subsystem[[:space:]]+sftp.*|# sftp disabled (busybox scp-only)|' /etc/ssh/sshd_config \
    && sed -i -E 's|^#?[[:space:]]*PasswordAuthentication.*|PasswordAuthentication yes|' /etc/ssh/sshd_config \
    # Remove the busybox `stat` applet symlink(s) wherever they landed.
    && for p in /usr/bin/stat /bin/stat /usr/local/bin/stat /sbin/stat; do rm -f "$p"; done \
    # Seed the home dir so a working listing has something to render.
    && mkdir -p /home/testuser/seeddir \
    && echo 'hello from busybox (no stat)' > /home/testuser/seed.txt \
    && echo 'nested' > /home/testuser/seeddir/inner.txt \
    && chown -R testuser:testuser /home/testuser

# Confirm at build time that this host matches the issue-#3 profile: busybox
# find (no -printf) AND no `stat` applet at all. Documents and enforces intent.
RUN ! find / -maxdepth 0 -printf '' 2>/dev/null && echo "confirmed: busybox find (no -printf)" \
    && ! command -v stat >/dev/null 2>&1 && echo "confirmed: no stat applet (Posix ls path)" \
    && command -v scp >/dev/null 2>&1 && echo "confirmed: scp present"

EXPOSE 2222
# Run sshd in the foreground on 2222 to match the other test targets.
CMD ["/usr/sbin/sshd", "-D", "-e", "-p", "2222"]
