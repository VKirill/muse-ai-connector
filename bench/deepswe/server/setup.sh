#!/bin/bash
# setup.sh [--dry-run] [--uninstall] [authorized_keys-file]
#
# Installs the DeepSWE bench sandbox on ovh-main: user `muse`, whose only SSH
# path is the forced command muse-task-shell -> sudo muse-docker-exec -> docker
# exec into the current task container. Idempotent; run as root.
#
# Muse's public key comes from $MUSE_SSH_PUBKEY or the file argument.
set -euo pipefail

DRY=0
UNINSTALL=0
KEYFILE=
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) KEYFILE=$arg ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
RUNNER_USER=${RUNNER_USER:-ubuntu}
MUSE_FROM=${MUSE_FROM:-100.100.68.99}
BENCH=/srv/muse-bench
EXEC_BIN=/usr/local/sbin/muse-docker-exec
SHELL_BIN=/usr/local/bin/muse-task-shell
SUDOERS=/etc/sudoers.d/muse-bench
SSHD_DROP=/etc/ssh/sshd_config.d/muse-bench.conf

run() {
  echo "+ $*"
  if [ "$DRY" = 0 ]; then "$@"; fi
}

install_file() { # install_file <src> <dest> <mode> [owner]
  local src=$1 dest=$2 mode=$3 owner=${4:-root}
  if [ "$DRY" = 1 ]; then
    echo "+ write $dest (mode $mode, owner $owner):"
    sed 's/^/    /' "$src"
  else
    install -m "$mode" -o "$owner" "$src" "$dest"
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  run rm -f "$SSHD_DROP"
  run sshd -t
  run systemctl reload ssh
  run rm -f "$SUDOERS" "$EXEC_BIN" "$SHELL_BIN"
  if id -u muse >/dev/null 2>&1 || [ "$DRY" = 1 ]; then
    run userdel -r muse
  fi
  run rm -rf "$BENCH"
  echo "uninstall done"
  exit 0
fi

if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then
  echo "setup.sh must run as root (or use --dry-run)" >&2
  exit 1
fi

# 1. user muse: no password (locked), no supplementary groups
if id -u muse >/dev/null 2>&1; then
  echo "+ user muse already exists"
else
  run useradd --create-home --shell /bin/bash muse
fi

# 2. Muse's key: only from its tailnet node, forced into the task shell
PUBKEY=${MUSE_SSH_PUBKEY:-}
if [ -z "$PUBKEY" ] && [ -n "$KEYFILE" ]; then
  PUBKEY=$(head -n 1 "$KEYFILE")
fi
KEY_LINE="from=\"$MUSE_FROM\",restrict,pty,command=\"$SHELL_BIN\" ${PUBKEY:-<MUSE_SSH_PUBKEY>}"
if [ "$DRY" = 1 ]; then
  echo "+ write ~muse/.ssh/authorized_keys (mode 600, owner muse):"
  echo "    $KEY_LINE"
elif [ -n "$PUBKEY" ]; then
  install -d -m 700 -o muse -g muse /home/muse/.ssh
  KEY_TMP=$(mktemp /tmp/muse-bench-key.XXXXXX)
  printf '%s\n' "from=\"$MUSE_FROM\",restrict,pty,command=\"$SHELL_BIN\" $PUBKEY" > "$KEY_TMP"
  install -m 600 -o muse -g muse "$KEY_TMP" /home/muse/.ssh/authorized_keys
  rm -f "$KEY_TMP"
elif [ ! -s /home/muse/.ssh/authorized_keys ]; then
  echo "WARNING: no public key given (MUSE_SSH_PUBKEY or file arg); authorized_keys not written" >&2
fi

# 3. the two sandbox scripts
install_file "$HERE/muse-docker-exec" "$EXEC_BIN" 0755
install_file "$HERE/muse-task-shell" "$SHELL_BIN" 0755

# 4. sudoers: the one and only privilege muse has
SUDO_TMP=$(mktemp /tmp/muse-bench-sudoers.XXXXXX)
printf 'muse ALL=(root) NOPASSWD: %s\n' "$EXEC_BIN" > "$SUDO_TMP"
if [ "$DRY" = 1 ]; then
  echo "+ write $SUDOERS (mode 440, owner root):"
  sed 's/^/    /' "$SUDO_TMP"
  echo "+ visudo -cf $SUDOERS"
else
  visudo -cf "$SUDO_TMP" >/dev/null
  install -m 440 -o root -g root "$SUDO_TMP" "$SUDOERS"
fi
rm -f "$SUDO_TMP"

# 5. bench dirs owned by the runner user
if [ "$DRY" = 1 ]; then
  echo "+ install -d -o $RUNNER_USER $BENCH $BENCH/queue $BENCH/runs"
  echo "+ touch $BENCH/current (owner $RUNNER_USER)"
else
  install -d -o "$RUNNER_USER" -g "$RUNNER_USER" "$BENCH" "$BENCH/queue" "$BENCH/runs"
  [ -e "$BENCH/current" ] || install -m 644 -o "$RUNNER_USER" -g "$RUNNER_USER" /dev/null "$BENCH/current"
fi

# 6. sshd: belt-and-suspenders restrictions on top of the key options
SSHD_TMP=$(mktemp /tmp/muse-bench-sshd.XXXXXX)
cat > "$SSHD_TMP" <<'EOF'
Match User muse
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PasswordAuthentication no
Match all
EOF
install_file "$SSHD_TMP" "$SSHD_DROP" 0644
rm -f "$SSHD_TMP"
run sshd -t
run systemctl reload ssh

echo "setup done"
