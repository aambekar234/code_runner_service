#!/usr/bin/env bash
# Checks a running service end to end: health, the token, Python, SQL, limits and isolation.
# Usage: RUNNER_TOKEN=<token> bash scripts/smoke_test.sh [base_url]
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
: "${RUNNER_TOKEN:?set RUNNER_TOKEN to the token the service runs with}"
failures=0

run() {
  curl -sS "$BASE_URL/run" -H "Authorization: Bearer $RUNNER_TOKEN" -d "$1"
}

# check <name> <text the response must contain> <response>
check() {
  if [[ "$3" == *"$2"* ]]; then
    echo "PASS  $1"
  else
    echo "FAIL  $1"
    echo "      expected to find: $2"
    echo "      got: $3"
    failures=$((failures + 1))
  fi
}

if ! health=$(curl -sS "$BASE_URL/health"); then
  echo "cannot reach $BASE_URL: is the service running?"
  exit 1
fi
check "health" '"status":"ok"' "$health"

check "a wrong token is refused" '"error":"unauthorized"' \
  "$(curl -sS "$BASE_URL/run" -H "Authorization: Bearer wrong" -d '{}')"

check "python returns the output" '"output":5' \
  "$(run '{"language":"python","code":"def add(a, b):\n    return a + b\n","entry":"add","cases":[{"id":"t1","args":[2,3]}]}')"

check "python errors name their line" 'ZeroDivisionError: division by zero (line 2)' \
  "$(run '{"language":"python","code":"def f():\n    return 1 / 0\n","entry":"f","cases":[{"id":"t1","args":[]}]}')"

check "python has no network" 'NotCapable' \
  "$(run '{"language":"python","code":"from pyodide.code import run_js\ndef f():\n    return run_js(\"Deno.listen({ port: 0 })\")\n","entry":"f","cases":[{"id":"t1","args":[]}]}')"

check "python memory is capped" 'MemoryError' \
  "$(run '{"language":"python","code":"def f():\n    return len(bytearray(600 * 1024 * 1024))\n","entry":"f","cases":[{"id":"t1","args":[]}]}')"

check "the whole sandbox's memory is capped" 'RangeError' \
  "$(run '{"language":"python","code":"from pyodide.code import run_js\ndef f():\n    return run_js(\"const a = []; for (let i = 0; i < 40; i++) a.push(new Uint8Array(128 << 20).fill(1))\")\n","entry":"f","cases":[{"id":"t1","args":[]}]}')"

check "an endless loop hits the time limit" '"status":"timeout"' \
  "$(run '{"language":"python","code":"def f():\n    while True:\n        pass\n","entry":"f","cases":[{"id":"t1","args":[]}],"time_limit_seconds":1}')"

check "sql runs the script, then the check" '"check":{"columns":["x"],"rows":[[2],[3]]}' \
  "$(run '{"language":"sql","code":"CREATE TABLE t (x INT); INSERT INTO t VALUES (1), (2); UPDATE t SET x = x + 1;","datasets":[{"id":"d1","setup":"","check":"SELECT x FROM t ORDER BY x"}]}')"

check "sql errors name their statement" 'statement 2: OperationalError: no such table: missing' \
  "$(run '{"language":"sql","code":"SELECT 1; SELECT * FROM missing;","datasets":[{"id":"d1","setup":""}]}')"

echo
if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
