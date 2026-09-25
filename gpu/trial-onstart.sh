#!/usr/bin/env bash
# Optional Vast onstart script for a disposable, synthetic-data test only.
# Deletes this instance after three hours, or the one or two that gpu/rent.mjs --hours asked for, including its
# model/build files; sooner once an earlier time is written into /root/.simple-chat-trial-deadline, never later.
# Does not provide a platform-enforced dollar cap; verify deletion externally.
set -euo pipefail
umask 077
# A dedicated public key may be supplied for this instance, never the account. It goes in before the trial guard's
# own preconditions are checked: an instance Vast gave no API key to still has to be one its owner can log into.
if [[ -n "${SIMPLE_CHAT_SSH_PUBLIC_KEY:-}" ]]; then
  [[ "$SIMPLE_CHAT_SSH_PUBLIC_KEY" = ssh-ed25519\ * && "$SIMPLE_CHAT_SSH_PUBLIC_KEY" != *$'\n'* ]] || exit 1
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  # Some hosts write this file as the host's own user (2026-09-22, instance 52079556: owner `vastai_kaalia`), and sshd's
  # StrictModes then refuses every key in it, the account key included. A file that root does not own is replaced.
  [[ ! -e /root/.ssh/authorized_keys || -O /root/.ssh/authorized_keys ]] || rm -f /root/.ssh/authorized_keys
  touch /root/.ssh/authorized_keys
  grep -Fqx -- "$SIMPLE_CHAT_SSH_PUBLIC_KEY" /root/.ssh/authorized_keys || printf '%s\n' "$SIMPLE_CHAT_SSH_PUBLIC_KEY" >> /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi

[[ "${CONTAINER_ID:-}" =~ ^[1-9][0-9]*$ && -n "${CONTAINER_API_KEY:-}" ]] || exit 1
command -v curl >/dev/null
command -v flock >/dev/null

# Used by the trial guard, the owner's SSH setup and simple-serving's launcher; never echo it.
printf '%s' "$CONTAINER_API_KEY" > /root/.simple-chat-instance-api-key
printf '%s' "$CONTAINER_ID" > /root/.simple-chat-instance-id
# The rental's length, set by gpu/rent.mjs ahead of this body; anything but one, two or three hours is three.
seconds="${SIMPLE_CHAT_TRIAL_SECONDS:-10800}"
[[ "$seconds" = 3600 || "$seconds" = 7200 || "$seconds" = 10800 ]] || seconds=10800
if [[ ! -f /root/.simple-chat-trial-deadline ]]; then
  printf '%s' "$(( $(date +%s) + seconds ))" > /root/.simple-chat-trial-deadline
fi

cat > /root/.simple-chat-trial-guard.sh <<'GUARD'
#!/usr/bin/env bash
set -euo pipefail
deadline="$(cat /root/.simple-chat-trial-deadline)"
instance="$(cat /root/.simple-chat-instance-id)"
[[ "$deadline" =~ ^[0-9]+$ && "$instance" =~ ^[1-9][0-9]*$ ]] || exit 1
# The file is read again on every turn, so that `date +%s > /root/.simple-chat-trial-deadline` over ssh ends the
# rental within ten seconds. Only an earlier time is taken: a later one, or a file caught half-written, extends
# nothing.
while (( $(date +%s) < deadline )); do
  sleep 10
  earlier="$(cat /root/.simple-chat-trial-deadline 2>/dev/null || true)"
  if [[ "$earlier" =~ ^[1-9][0-9]*$ ]] && (( earlier < deadline )); then deadline="$earlier"; fi
done
while true; do
  if printf 'header = "Authorization: Bearer %s"\n' "$(cat /root/.simple-chat-instance-api-key)" \
    | curl --config - --silent --fail --output /dev/null --connect-timeout 10 --max-time 20 \
      --request DELETE "https://console.vast.ai/api/v0/instances/$instance/"; then
    exit 0
  fi
  sleep 30
done
GUARD
chmod 700 /root/.simple-chat-trial-guard.sh
nohup flock -n /root/.simple-chat-trial-guard.lock bash /root/.simple-chat-trial-guard.sh </dev/null >/dev/null 2>&1 &

# Starts simple-serving's service once its preparation has put it on the persistent disk, and returns at once.
if [[ -f /workspace/simple-serving/card/onstart.sh ]]; then bash /workspace/simple-serving/card/onstart.sh; fi
