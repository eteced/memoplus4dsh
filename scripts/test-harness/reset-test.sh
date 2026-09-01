#!/usr/bin/env bash
# reset-test.sh — stop the test instance and wipe its isolated DSH_HOME
# (test/dsh-home), so the next start-test.sh begins from a pristine profile.
# The dsh npm installation (test/dsh-install) is kept as a cache; delete it by
# hand if you want to re-resolve the dsh package itself. All removals stay
# inside the test directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="${MEMOPLUS4DSH_TEST_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)/test}"

# Guard against a dangerous MEMOPLUS4DSH_TEST_DIR (this script rm -rf's under it).
if [[ -z "$TEST_DIR" || "$TEST_DIR" == "/" || "$TEST_DIR" != *test* ]]; then
  echo "reset-test.sh: refusing to operate on suspicious TEST_DIR='$TEST_DIR'" >&2
  echo "  (must be non-empty, not '/', and contain 'test')" >&2
  exit 1
fi

"$SCRIPT_DIR/stop-test.sh"

echo "==> removing $TEST_DIR/dsh-home"
rm -rf "$TEST_DIR/dsh-home"
rm -f "$TEST_DIR/run/web.url"
echo "==> reset done (dsh-install cache kept)"
