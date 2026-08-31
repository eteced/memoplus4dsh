#!/usr/bin/env bash
# reset-test.sh — stop the test instance and wipe its isolated DSH_HOME
# (test/dsh-home), so the next start-test.sh begins from a pristine profile.
# The dsh npm installation (test/dsh-install) is kept as a cache; delete it by
# hand if you want to re-resolve the dsh package itself. All removals stay
# inside /home/claw/kimi_code_workspace/test/.
set -euo pipefail

TEST_DIR="/home/claw/kimi_code_workspace/test"
HARNESS_ROOT="/home/claw/kimi_code_workspace"

"$HARNESS_ROOT/memoplus4dsh/scripts/test-harness/stop-test.sh"

echo "==> removing $TEST_DIR/dsh-home"
rm -rf "$TEST_DIR/dsh-home"
rm -f "$TEST_DIR/run/web.url"
echo "==> reset done (dsh-install cache kept)"
