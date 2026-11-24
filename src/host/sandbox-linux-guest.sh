#!/bin/bash
set -euo pipefail

# Lima's QEMU network maps these gateway addresses to the host's loopback.
# Filter before Lima redirects DNS to its dedicated host resolver. Keep SSH replies.
cat > /etc/godbot-host-network.nft <<'RULES'
table inet godbot_host_network {
  chain output {
    type filter hook output priority mangle; policy accept;
    ct state established,related accept
    ip daddr { 0.0.0.0, 192.168.5.2 } reject
    ip6 daddr fec0::2 reject
  }
}
RULES
cat > /etc/systemd/system/godbot-host-network.service <<'UNIT'
[Unit]
Description=Block sandbox access to the host loopback
Before=network-pre.target
Wants=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/godbot-host-network.nft
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable --now godbot-host-network.service

# Only Lima's fixed, read-only boot probe needs sudo after system provisioning.
umask 077
cat > /etc/sudoers.d/.godbot-setup <<'SUDOERS'
godbot ALL=(ALL:ALL) !ALL
godbot ALL=(root) NOPASSWD: /usr/bin/cat /mnt/lima-cidata/param.env
SUDOERS
visudo -qcf /etc/sudoers.d/.godbot-setup
chmod 0440 /etc/sudoers.d/.godbot-setup
mv /etc/sudoers.d/.godbot-setup /etc/sudoers.d/zz-godbot
