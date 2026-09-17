#!/usr/bin/env bash
# Optional Vast onstart script for a disposable, synthetic-data test only.
# Deletes this instance after three hours, including its model/build files.
# Does not provide a platform-enforced dollar cap; verify deletion externally.
set -euo pipefail
umask 077
[[ "${CONTAINER_ID:-}" =~ ^[1-9][0-9]*$ && -n "${CONTAINER_API_KEY:-}" ]] || exit 1
command -v curl >/dev/null
command -v flock >/dev/null

# A dedicated public key may be supplied for this instance, never the account.
if [[ -n "${SIMPLE_CHAT_SSH_PUBLIC_KEY:-}" ]]; then
  [[ "$SIMPLE_CHAT_SSH_PUBLIC_KEY" = ssh-ed25519\ * && "$SIMPLE_CHAT_SSH_PUBLIC_KEY" != *$'\n'* ]] || exit 1
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  grep -Fqx -- "$SIMPLE_CHAT_SSH_PUBLIC_KEY" /root/.ssh/authorized_keys || printf '%s\n' "$SIMPLE_CHAT_SSH_PUBLIC_KEY" >> /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi

# Used only by the trial guard and the owner's SSH setup; never echo it.
printf '%s' "$CONTAINER_API_KEY" > /root/.simple-chat-instance-api-key
printf '%s' "$CONTAINER_ID" > /root/.simple-chat-instance-id
if [[ ! -f /root/.simple-chat-trial-deadline ]]; then
  printf '%s' "$(( $(date +%s) + 10800 ))" > /root/.simple-chat-trial-deadline
fi

cat > /root/.simple-chat-trial-guard.sh <<'GUARD'
#!/usr/bin/env bash
set -euo pipefail
deadline="$(cat /root/.simple-chat-trial-deadline)"
instance="$(cat /root/.simple-chat-instance-id)"
[[ "$deadline" =~ ^[0-9]+$ && "$instance" =~ ^[1-9][0-9]*$ ]] || exit 1
while (( $(date +%s) < deadline )); do sleep 10; done
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
