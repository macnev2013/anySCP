# Keyboard-interactive-only SSH server (issue #131).
#
# PAM / privileged-access gateways (e.g. `user@domain%admin%target` logins)
# commonly disable the SSH `password` method and accept the password only via
# `keyboard-interactive`. This target reproduces that: PasswordAuthentication
# is off, KbdInteractiveAuthentication is on and backed by PAM, so a client
# that only tries `password` is rejected with "server rejected credentials".
#
# Debian rather than the linuxserver/Alpine base used elsewhere: Alpine's sshd
# is built without PAM, which leaves keyboard-interactive with no backend.
#
# Built by the e2e compose stack (service: sshd-kbdint).
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && useradd -m -s /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd \
    && { \
        echo 'Port 2222'; \
        echo 'UsePAM yes'; \
        echo 'PasswordAuthentication no'; \
        echo 'KbdInteractiveAuthentication yes'; \
        echo 'PubkeyAuthentication no'; \
        echo 'AuthenticationMethods keyboard-interactive'; \
    } > /etc/ssh/sshd_config.d/kbdint-only.conf

EXPOSE 2222
CMD ["/usr/sbin/sshd", "-D", "-e"]
