#!/usr/bin/env bash
# The pre-deploy gate for the Python side. Run from firebase/functions/.
#
# EVERY FILE IN A FRESH INTERPRETER — this is the whole point of the script.
# The test files stub firebase_admin/google.cloud into sys.modules before
# importing handlers, and those stubs are process-wide: `unittest discover`
# would let one file's stubs leak into the next and prove nothing. pytest is
# not installed in the venv, so the documented `pytest tests/` has never run;
# this is the invocation that actually exists.
#
#   ./tests/run_all.sh
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.."
PY="venv/bin/python"
[ -x "$PY" ] || { echo "geen venv op $PWD/$PY"; exit 2; }

fail=0
for f in tests/test_*.py; do
  if ! "$PY" "$f" >/tmp/stelz-test-out 2>&1; then
    echo "✕ $f"
    tail -20 /tmp/stelz-test-out
    fail=1
  else
    tally=$(grep -Eo "Ran [0-9]+ tests" /tmp/stelz-test-out | tail -1)
    echo "✓ $f (${tally:-ok})"
  fi
done
exit $fail
