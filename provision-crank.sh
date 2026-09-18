#!/usr/bin/env bash
# provision-crank.sh — install the Prize Draw crank on a fresh Ubuntu 24.04 machine, AND update an
# existing one. The same command does both, which is the point: an update you have to remember four
# steps for is an update that eventually gets done wrong.
#
# Run ON THE MACHINE, as root. Download it from the exact commit you are pinning, then pass that
# commit's full id:
#
#     curl -fsSLo provision-crank.sh \
#       https://raw.githubusercontent.com/SmartPacts/prize-draw-crank/<commit>/provision-crank.sh
#     bash provision-crank.sh <commit>
#
# TO UPDATE, run exactly the same thing with the new commit. It checks out the new code, reinstalls
# dependencies from the lockfile, replaces the unit — and RESTARTS the service if it was running,
# because replacing files does not replace the process: node read its code at startup, so without a
# restart you get new files on disk and the old bot still settling rounds, silently.
#
# What it NEVER touches: your key (/etc/prize-draw/crank-key.json) and your settings
# (/etc/prize-draw/crank.env). Both live outside the checkout precisely so an update cannot reach
# them. It never regenerates a key — that would orphan whatever the old account holds — and it
# never starts a bot that was not already running: enabling it is what starts sending transactions,
# and that stays a human decision.
#
# Modelled on block-history's provision-droplet.sh, which has run this shape on a live droplet
# since September 2026. The comments that look over-specific are all scars: read them before
# "simplifying" one.
set -euo pipefail

NODE_VERSION="v24.21.0"
# node-v24.21.0-linux-x64.tar.xz, read in full from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
NODE_SHA256="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
APP=/opt/prize-draw-crank
SVC_USER=prizedraw
CONF_DIR=/etc/prize-draw
KEY="$CONF_DIR/crank-key.json"
ENV_FILE="$CONF_DIR/crank.env"
UNIT=prize-draw-crank.service

PIN="${1:?usage: provision-crank.sh <full-commit-id>}"
REPO="${CRANK_REPO:-https://github.com/SmartPacts/prize-draw-crank.git}"

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
skip() { printf '    SKIPPED: %s\n' "$*"; SKIPPED+=("$*"); }
die()  { printf '\n!! STOPPED: %s\n   Nothing after this point was done.\n' "$*" >&2; exit 1; }
SKIPPED=()

HAVE_SYSTEMD=0; [ -d /run/systemd/system ] && HAVE_SYSTEMD=1
IN_CONTAINER=0; [ -f /.dockerenv ] && IN_CONTAINER=1

# ---------------------------------------------------------------------------------------------
say "0. Preconditions"
[ "$(id -u)" = 0 ] || die "run as root"
# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu required (found ${ID:-unknown})"
[ "$(uname -m)" = x86_64 ] || die "x86_64 required — the Node pin is for linux-x64"
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || die "the pin must be a full 40-character commit id, got: $PIN"
if [ $HAVE_SYSTEMD = 0 ] && [ $IN_CONTAINER = 0 ]; then die "no systemd and not a container — unsupported host"; fi
[ $IN_CONTAINER = 1 ] && echo "    NOTE: running in a CONTAINER (rehearsal). Firewall, swap and service steps will be skipped."
# Is this an update of a bot that is currently running? Decided BEFORE anything changes, because
# after the checkout the answer would describe the new state instead of the one we must restore.
WAS_ACTIVE=0
if [ $HAVE_SYSTEMD = 1 ] && systemctl is-active --quiet "$UNIT"; then WAS_ACTIVE=1; fi
ok "Ubuntu ${VERSION_ID:-?}, x86_64, root$([ $WAS_ACTIVE = 1 ] && echo ' — the crank is RUNNING and will be restarted at the end')"

# ---------------------------------------------------------------------------------------------
say "1. Swap — a small box can spike past its RAM while installing"
if [ $IN_CONTAINER = 1 ]; then skip "swap (container)"
elif [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then ok "swap already present"
else
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "1 GiB swap enabled and made permanent"
fi

# ---------------------------------------------------------------------------------------------
say "2. System packages"
# A fresh droplet runs its own apt jobs in its first minutes. Measured on apt 2.8:
# -o DPkg::Lock::Timeout makes `install` wait for the dpkg lock but NOT `update` for the
# package-list lock, so the retry loop is what actually covers a held lock.
if command -v cloud-init >/dev/null 2>&1; then timeout 600 cloud-init status --wait >/dev/null 2>&1 || true; fi
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
apt_retry() {
  local i out
  for i in $(seq 1 60); do
    if out=$(apt-get -o DPkg::Lock::Timeout=60 -qq "$@" 2>&1); then return 0; fi
    grep -q 'Could not get lock' <<<"$out" || { printf '%s\n' "$out" >&2; return 1; }
    [ "$i" = 1 ] && echo "    NOTE: another apt job holds a lock (normal on a fresh droplet) — waiting for it, up to ~10 minutes"
    sleep 10
  done
  printf '%s\n' "$out" >&2; return 1
}
apt_retry update || die "apt-get update failed"
apt_retry install -y git ca-certificates curl xz-utils ufw unattended-upgrades || die "installing system packages failed"
ok "git, curl, ufw, unattended-upgrades"

say "3. Automatic security updates"
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
ok "security updates install themselves daily"

# ---------------------------------------------------------------------------------------------
say "4. Firewall — nothing listens except SSH; the crank only makes outbound connections"
if [ $IN_CONTAINER = 1 ]; then skip "firewall (container)"
else
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw --force enable >/dev/null
  ok "inbound: SSH only"
fi

say "5. SSH — keys only"
# sshd keeps the FIRST value it reads for each setting and cloud-init writes 50-cloud-init.conf,
# so this file is named 01-… to be read first: measured on a clean Ubuntu 24.04, the same file
# named 60-… was silently overridden by cloud-init's "PasswordAuthentication yes".
SSHD_DROPIN=/etc/ssh/sshd_config.d/01-prize-draw.conf
if ! command -v sshd >/dev/null 2>&1 || [ ! -d /etc/ssh/sshd_config.d ]; then
  skip "SSH hardening (no sshd on this host)"
elif [ ! -s /root/.ssh/authorized_keys ]; then
  # Refusing here is the point: turning passwords off with no key installed locks you out for good.
  skip "password login left as it was — /root/.ssh/authorized_keys is empty, and disabling passwords now would lock you out"
else
  mkdir -p /run/sshd     # sshd -t fails with "Missing privilege separation directory" without it
  if ! pre=$(sshd -t 2>&1); then
    skip "SSH hardening — sshd's existing configuration already fails its own check, so it was left alone: ${pre:0:160}"
  else
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > "$SSHD_DROPIN"
    if ! err=$(sshd -t 2>&1); then
      rm -f "$SSHD_DROPIN"; die "the hardening made sshd's own check fail, so it was removed: ${err:0:160}"
    fi
    # Read what sshd will ACTUALLY use, captured first and matched without a pipe: `sshd -T | grep -q`
    # under pipefail fails whenever grep exits early and sshd -T dies of SIGPIPE.
    if ! effective=$(sshd -T 2>/dev/null); then
      rm -f "$SSHD_DROPIN"; die "could not read sshd's effective configuration, so the hardening was removed"
    fi
    if ! grep -qx 'passwordauthentication no' <<<"$effective"; then
      rm -f "$SSHD_DROPIN"; die "password login is still ON in sshd's effective configuration (another file overrides it), so the hardening was removed"
    fi
    [ $HAVE_SYSTEMD = 1 ] && { systemctl try-reload-or-restart ssh.service 2>/dev/null || systemctl try-reload-or-restart sshd.service 2>/dev/null \
        || echo "    NOTE: ssh could not be reloaded now; the setting applies the next time ssh starts"; }
    ok "password login disabled in sshd's effective configuration; your SSH key still works"
  fi
fi

# ---------------------------------------------------------------------------------------------
say "6. Node $NODE_VERSION, verified against its pinned checksum"
if [ -x "/opt/node-$NODE_VERSION/bin/node" ]; then ok "already installed"
else
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" || { rm -rf "$tmp"; die "could not download Node"; }
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c - >/dev/null || { rm -rf "$tmp"; die "Node tarball checksum MISMATCH — refusing to install it"; }
  mkdir -p "/opt/node-$NODE_VERSION"
  tar -xJf "$tmp/node.tar.xz" -C "/opt/node-$NODE_VERSION" --strip-components=1
  rm -rf "$tmp"
  ok "installed from a checksum-verified tarball"
fi
for b in node npm npx; do ln -sf "/opt/node-$NODE_VERSION/bin/$b" "/usr/local/bin/$b"; done
[ "$(/usr/local/bin/node --version)" = "$NODE_VERSION" ] || die "node --version is not $NODE_VERSION"
ok "node $NODE_VERSION on the path"

# ---------------------------------------------------------------------------------------------
say "7. The service user"
# No login shell, no sudo, and it does NOT own the code: the code is root's and the service can
# only read it, so a compromised crank cannot rewrite what it runs.
if id "$SVC_USER" >/dev/null 2>&1; then ok "exists"
else useradd --system --home-dir "/var/lib/$SVC_USER" --create-home --shell /usr/sbin/nologin "$SVC_USER"; ok "created"; fi

# ---------------------------------------------------------------------------------------------
say "8. The code, at exactly the pinned commit"
G="git -c safe.directory=$APP -C $APP"
if [ ! -d "$APP/.git" ]; then git clone -q "$REPO" "$APP" || die "could not clone $REPO"; ok "cloned $REPO"
else $G fetch -q --tags "$REPO" '+refs/heads/*:refs/remotes/origin/*' || die "could not fetch $REPO"; ok "fetched $REPO into the existing clone"; fi
OLD=$($G rev-parse HEAD 2>/dev/null || echo none)
$G -c advice.detachedHead=false checkout -q "$PIN" 2>/dev/null || die "commit $PIN is not in $REPO — a mistyped commit, or the wrong repository"
HEAD=$($G rev-parse HEAD)
[ "$HEAD" = "$PIN" ] || die "checked out $HEAD, which is not the pinned $PIN"
$G fsck --full --no-progress >/dev/null 2>&1 || die "git fsck found corruption in the repository"
[ -z "$($G status --porcelain)" ] || die "the working tree is not clean at the pinned commit"
# The script you ran must be the one the pinned commit contains, or the pin means nothing.
cmp -s "$0" "$APP/provision-crank.sh" || die "this script differs from the copy inside commit $PIN — download it from that exact commit"
if [ "$OLD" = "$HEAD" ]; then ok "already at $HEAD (nothing to update)"; else ok "$OLD -> $HEAD, fsck clean, working tree clean"; fi

say "9. Dependencies, exactly as locked"
cd "$APP"
# npm verifies every package against the sha512 integrity recorded in package-lock.json. Re-run on
# every update: a new commit can carry a new lockfile, and "it already has node_modules" is how a
# bot ends up running one version's code against another's dependencies.
npm ci --omit=dev --no-audit --no-fund --loglevel=error || die "npm ci failed"
ok "installed from package-lock.json"

# ---------------------------------------------------------------------------------------------
say "10. Your settings and your key — created if missing, NEVER overwritten"
install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$CONF_DIR"
if [ -f "$ENV_FILE" ]; then ok "$ENV_FILE kept exactly as it is"
else
  install -m 0600 -o root -g root "$APP/crank.env.example" "$ENV_FILE"
  ok "$ENV_FILE created from the example — edit it to set DRAW_PAYEE and HEARTBEAT_URL"
fi
if [ -f "$KEY" ]; then ok "key already exists — NOT regenerated"
else
  runuser -u "$SVC_USER" -- /usr/local/bin/node "$APP/crank-keygen.mjs" "$KEY" >/dev/null || die "key generation failed"
  ok "new key generated"
fi
[ "$(stat -c '%a %U' "$KEY")" = "600 $SVC_USER" ] || die "key file must be mode 600 owned by $SVC_USER, found: $(stat -c '%a %U' "$KEY")"
PUB=$(runuser -u "$SVC_USER" -- /usr/local/bin/node -e "const k=require('$KEY');const e=k.crank??Object.values(k).find(v=>v&&v.publicKey)??k;process.stdout.write(e.publicKey)")
[[ "$PUB" =~ ^[0-9a-f]{64}$ ]] || die "the service user could not read a valid public key from its own key file"
ok "mode 600, owned by $SVC_USER, readable by the service"

# ---------------------------------------------------------------------------------------------
say "11. The service"
if [ $HAVE_SYSTEMD = 1 ]; then
  install -m 644 "$APP/$UNIT" "/etc/systemd/system/$UNIT"
  systemctl daemon-reload
  systemd-analyze verify "/etc/systemd/system/$UNIT" || die "systemd rejected the unit file"
  if [ $WAS_ACTIVE = 1 ]; then
    # THE STEP THAT MAKES THIS AN UPDATE. Node read its code at startup: without this the new
    # commit sits on disk while the old process keeps settling rounds.
    systemctl restart "$UNIT" || die "the crank did not come back up — check: journalctl -u $UNIT -n 50"
    sleep 3
    systemctl is-active --quiet "$UNIT" || die "the crank started and then exited — check: journalctl -u $UNIT -n 50"
    ok "restarted at $HEAD and running"
  elif systemctl is-enabled "$UNIT" >/dev/null 2>&1; then
    ok "installed and verified. It is ENABLED but was not running — start it when you mean to: systemctl start $UNIT"
  else
    ok "installed and verified. Deliberately NOT enabled and NOT started."
  fi
else skip "systemd registration (container)"; fi

# ---------------------------------------------------------------------------------------------
say "12. Can this machine reach the chain? (read-only, one pass, nothing is sent)"
# Run as the service user with the unit's own environment, so a setting that would stop the crank
# shows up now rather than after you enable it. Before the contract is deployed the right answer
# is a refusal naming the missing module: that proves the network, the interlocks and the key file
# all work, and only the contract is missing.
# Built as an ARRAY, never as a word-split string: one Environment= value containing a space
# would otherwise silently become two arguments and the test would run a different configuration
# from the service it is meant to be testing.
RUN=(systemd-run --quiet --wait --pipe --collect --uid="$SVC_USER" --gid="$SVC_USER"
     --working-directory="$APP" -p "EnvironmentFile=-$ENV_FILE")
while IFS= read -r line; do RUN+=(-E "${line#Environment=}"); done < <(grep '^Environment=' "$APP/$UNIT")
set +e
OUT=$("${RUN[@]}" /usr/local/bin/node crank.mjs --once 2>&1)
RC=$?
set -e
if [ $RC = 0 ]; then ok "it read the live raffles and made one pass"
elif grep -q 'the contract must be deployed on this chain' <<<"$OUT"; then
  ok "reached the network and passed every interlock; the contract is not deployed on this chain yet"
else
  printf '%s\n' "$OUT" | tail -5 >&2
  die "the crank could not make a pass here (exit $RC) — the lines above say why"
fi

# ---------------------------------------------------------------------------------------------
PAYEE=$( (grep -s '^DRAW_PAYEE=' "$ENV_FILE" || true) | tail -1 | cut -d= -f2- )
cat <<EOF

================================================================================
  Crank at commit $HEAD.

  ITS ACCOUNT (pays gas, holds no privilege):

      k:$PUB

  Earnings go to: ${PAYEE:-its own account — set DRAW_PAYEE in $ENV_FILE to send them elsewhere}
================================================================================
EOF
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "  Skipped on this host:"; for s in "${SKIPPED[@]}"; do echo "    - $s"; done
fi
if [ $WAS_ACTIVE = 1 ]; then
  cat <<EOF

  It was running, so it has been restarted on the new commit:
      journalctl -u $UNIT -n 20 --no-pager
EOF
else
  cat <<EOF

  Next, in this order:
    1. Back up the key, and prove the backup opens:
         node $APP/key-backup.mjs save $KEY /root/crank-key.backup
         node $APP/key-backup.mjs check /root/crank-key.backup
       Then copy it off this machine and delete the copy here.
    2. Edit $ENV_FILE — at least DRAW_PAYEE and HEARTBEAT_URL.
    3. Fund k:$PUB on the raffle's chain.
    4. Only when the contract is deployed, start sending:
         systemctl enable --now $UNIT
         journalctl -u $UNIT -f
EOF
fi
