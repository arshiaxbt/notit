#!/usr/bin/env bash
# Make a deployment immutable: delete every access key of the contract account.
# After this nobody, including the deployer, can redeploy code, change state
# directly, or move the account's NEAR. This cannot be undone.
#
#   scripts/lock.sh <account.testnet>
set -euo pipefail

ACCOUNT="${1:?usage: scripts/lock.sh <account.testnet>}"

keys() {
  near account list-keys "$ACCOUNT" network-config testnet now 2>&1 | grep -oE 'ed25519:[1-9A-HJ-NP-Za-km-z]+' | sort -u
}

KEYS=$(keys)
if [ -z "$KEYS" ]; then
  echo "$ACCOUNT has no access keys: already locked."
  exit 0
fi

echo "Deleting $(echo "$KEYS" | wc -l) access key(s) of $ACCOUNT:"
echo "$KEYS"
# shellcheck disable=SC2086
near account delete-keys "$ACCOUNT" public-keys $(echo $KEYS | tr ' ' ',') \
  network-config testnet sign-with-legacy-keychain send

REMAINING=$(keys || true)
if [ -z "$REMAINING" ]; then
  echo "$ACCOUNT is locked: no access keys remain."
else
  echo "Keys still present:" >&2
  echo "$REMAINING" >&2
  exit 1
fi
