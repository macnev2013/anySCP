# Bastion (jump host) test SSH server for ProxyJump tunnelling.
#
# Extends upstream linuxserver/openssh-server, which ships `AllowTcpForwarding
# no` in its sshd_config and therefore REJECTS the `direct-tcpip` channels a
# ProxyJump jump host must open. This init script flips it to `yes` before sshd
# starts, so the bastion can actually tunnel to the next hop.
#
# Built implicitly by docker compose for the `sshd-bastion` and `sshd-bastion2`
# e2e services.
FROM lscr.io/linuxserver/openssh-server:latest

COPY enable-tcp-forwarding.sh /custom-cont-init.d/enable-tcp-forwarding.sh
RUN chmod +x /custom-cont-init.d/enable-tcp-forwarding.sh
