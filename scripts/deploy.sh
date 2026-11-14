#!/usr/bin/env bash
# Deploy Not It to a NEAR testnet account and initialise it.
#
#   scripts/deploy.sh <account.testnet> <fast|live>
#
# The account must exist and its key must be in the legacy keychain
# (~/.near-credentials/testnet/<account>.json). Create one with:
#   near account create-account sponsor-by-faucet-service <account.testnet> \
#     autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
set -euo pipefail

ACCOUNT="${1:?usage: scripts/deploy.sh <account.testnet> <fast|live>}"
PRESET="${2:?usage: scripts/deploy.sh <account.testnet> <fast|live>}"

case "$PRESET" in
  fast) ROUND_NS=180000000000 ;;   # 3 minutes
  live) ROUND_NS=3600000000000 ;;  # 1 hour
  *) echo "preset must be fast or live" >&2; exit 1 ;;
esac

cd "$(dirname "$0")/../contract"
cargo near build non-reproducible-wasm

PARAMS=$(cat <<JSON
{"params":{"round_ns":"$ROUND_NS","max_cost_ppm":50000,"min_cost_ppm":2000,"cut_ppm":150000,"claim_amount":"1000000000000000000000","claim_cap":100000}}
JSON
)

near contract deploy "$ACCOUNT" use-file target/near/notit.wasm \
  with-init-call new json-args "$PARAMS" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send

echo
echo "Deployed $PRESET preset to $ACCOUNT. Lock it with: scripts/lock.sh $ACCOUNT"
