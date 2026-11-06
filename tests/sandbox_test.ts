/** Real sandboxes, real Pyodide: what a run reports, and what the sandbox keeps out. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type CaseResult, type DatasetResult, RunRequest } from "../src/contract.ts";
import { Sandbox } from "../src/sandbox.ts";

async function runOnce(request: Record<string, unknown>) {
  const sandbox = await Sandbox.start();
  return await sandbox.run(RunRequest.parse(request));
}

function python(code: string, args: unknown[][], extra: Record<string, unknown> = {}) {
  const cases = args.map((caseArgs, i) => ({ id: `t${i + 1}`, args: caseArgs }));
  return runOnce({ language: "python", code, entry: "solve", cases, ...extra });
}

function sql(
  code: string,
  datasets: Record<string, string>[],
  extra: Record<string, unknown> = {},
) {
  return runOnce({ language: "sql", code, datasets, ...extra });
}

/** One function, many behaviours: each case passes the name of the one it wants. */
const CASES = `
import sys
from pyodide.code import run_js

class Broken(Exception):
    def __str__(self):
        raise ValueError("no message")

def solve(kind):
    if kind == "sum":
        return [1 + 2, "three", None]
    if kind == "print":
        print("hello")
        return True
    if kind == "flood":
        print("x" * 10_000)
    if kind == "raise":
        return 1 / 0
    if kind == "broken":
        raise Broken()
    if kind == "set":
        return {1, 2}
    if kind == "big_int":
        return 2**64
    if kind == "huge":
        return "x" * 200_000
    if kind == "bytes":
        sys.stdout.write(b"hi")
    if kind == "memory":
        return len(bytearray(600 * 1024 * 1024))
    if kind == "input":
        return input()
    if kind == "listen":
        return run_js("Deno.listen({ port: 0 })")
    if kind == "websocket":
        return run_js('new WebSocket("ws://example.com")')
    if kind == "env":
        return run_js("Deno.env.toObject()")
    if kind == "file":
        return run_js('Deno.readTextFileSync("/etc/hostname")')
    if kind == "program":
        return run_js('new Deno.Command("/bin/ls").outputSync()')
    if kind == "js_memory":
        return run_js("const a = []; for (let i = 0; i < 40; i++) a.push(new Uint8Array(128 << 20).fill(1))")
`;

Deno.test("python: each case reports its output, prints and errors", async () => {
  const kinds = ["sum", "print", "flood", "raise", "broken", "set", "big_int", "huge", "bytes"];
  const response = await python(CASES, kinds.map((kind) => [kind]));
  assertEquals(response.status, "ok");
  const [sum, printed, flood, raised, broken, set, bigInt, huge, bytes] = response
    .results as CaseResult[];
  assertEquals(sum.output, [3, "three", null]);
  assertEquals(printed.stdout, "hello\n");
  assert(flood.stdout.length < 4_100);
  assertStringIncludes(flood.stdout, "[output cut off]");
  assertEquals(raised.error, "ZeroDivisionError: division by zero (line 18)");
  assertEquals(raised.output, null);
  assertEquals(broken.error, "Broken (line 20)");
  assertStringIncludes(set.error!, "not plain JSON data");
  assertStringIncludes(bigInt.error!, "return it as a string");
  assertStringIncludes(huge.error!, "larger than 100000 bytes");
  assertStringIncludes(bytes.error!, "TypeError: write() argument must be str");
});

Deno.test("python: memory runs out inside the case, not the sandbox", async () => {
  // Only Linux caps the sandbox's JavaScript memory (see sandbox.ts).
  const kinds = ["memory", "input", ...(Deno.build.os === "linux" ? ["js_memory"] : [])];
  const response = await python(CASES, kinds.map((kind) => [kind]));
  assertEquals(response.status, "ok");
  const [memory, input, jsMemory] = response.results as CaseResult[];
  assertEquals(memory.error, "MemoryError (line 30)");
  assertStringIncludes(input.error!, "EOFError");
  if (jsMemory) assertStringIncludes(jsMemory.error!, "RangeError");
});

Deno.test("python: the solution has no network, environment, files or programs", async () => {
  const kinds = ["listen", "websocket", "env", "file", "program"];
  const response = await python(CASES, kinds.map((kind) => [kind]));
  assertEquals(response.status, "ok");
  for (const result of response.results as CaseResult[]) {
    assert(result.error?.includes("NotCapable"), `${result.id} got ${result.error}`);
  }
});

Deno.test("python: code that cannot load is a run error", async () => {
  const syntax = await python("def solve(:\n    pass\n", [[]]);
  assertEquals(syntax.status, "error");
  assertEquals(syntax.error, "SyntaxError: invalid syntax (line 1)");

  const missing = await python("def other():\n    pass\n", [[]]);
  assertEquals(missing.error, "the code defines no function named 'solve'");

  const crashing = await python("x = 1\nundefined_name\n", [[]]);
  assertEquals(crashing.error, "NameError: name 'undefined_name' is not defined (line 2)");
});

Deno.test("python: a run past its time limit keeps the cases that finished", async () => {
  const code = "def solve(n):\n    while n:\n        pass\n    return n\n";
  const response = await python(code, [[0], [1]], { time_limit_seconds: 1 });
  assertEquals(response.status, "timeout");
  assertEquals(response.results.length, 1);
  assertEquals((response.results[0] as CaseResult).output, 0);
});

Deno.test("python: a sandbox that breaks the protocol is reported as crashed", async () => {
  const say = (js: string) =>
    python(`from pyodide.code import run_js\ndef solve():\n    run_js(${JSON.stringify(js)})\n`, [
      [],
    ]);

  const garbage = await say('console.log("not json")');
  assertEquals(garbage.status, "crashed");
  assertStringIncludes(garbage.error!, "not JSON");

  const flood = await say('console.log("x".repeat(6e6))');
  assertEquals(flood.status, "crashed");
  assertStringIncludes(flood.error!, "more than");

  const forged = await say(
    'console.log(JSON.stringify({ type: "result", result: { id: "zzz", output: 1, error: null, stdout: "", duration_seconds: 0 } }))',
  );
  assertEquals(forged.status, "crashed");
  assertStringIncludes(forged.error!, "out of order");
});

Deno.test("sql: a script runs statement by statement, then the check", async () => {
  const code = `
    CREATE TABLE logins (user_id INT, day TEXT);
    INSERT INTO logins VALUES (1, 'mon'), (1, 'tue'), (2, 'mon');
    -- a trigger body holds semicolons of its own
    CREATE TRIGGER no_sunday BEFORE INSERT ON logins
      WHEN NEW.day = 'sun' BEGIN SELECT RAISE(ABORT, 'closed; come back monday'); END;
    SELECT user_id, COUNT(*) AS days FROM logins GROUP BY user_id ORDER BY user_id;
    BEGIN; DELETE FROM logins; ROLLBACK;
    UPDATE logins SET day = 'wed' WHERE user_id = 2; -- the last one
  `;
  const response = await sql(code, [{ id: "d1", setup: "", check: "SELECT COUNT(*) FROM logins" }]);
  assertEquals(response.status, "ok");
  const [dataset] = response.results as DatasetResult[];
  assertEquals(dataset.error, null);
  assertEquals(dataset.statements.length, 8);
  assertEquals(dataset.statements[1].rows_changed, 3);
  assertStringIncludes(dataset.statements[2].sql, "END;");
  assertEquals(dataset.statements[3].columns, ["user_id", "days"]);
  assertEquals(dataset.statements[3].rows, [[1, 2], [2, 1]]);
  assertEquals(dataset.statements[7].rows_changed, 1);
  assertEquals(dataset.check, { columns: ["COUNT(*)"], rows: [[3]] });
});

Deno.test("sql: every dataset gets a fresh database", async () => {
  const response = await sql("INSERT INTO t VALUES (9); SELECT COUNT(*) FROM t;", [
    { id: "one", setup: "CREATE TABLE t (x INT); INSERT INTO t VALUES (1);" },
    { id: "two", setup: "CREATE TABLE t (x INT); INSERT INTO t VALUES (1), (2);" },
  ]);
  const [one, two] = response.results as DatasetResult[];
  assertEquals(one.statements[1].rows, [[2]]);
  assertEquals(two.statements[1].rows, [[3]]);
});

Deno.test("sql: errors stop the dataset and say where", async () => {
  const datasetError = async (code: string, setup = "") =>
    ((await sql(code, [{ id: "d1", setup }])).results[0] as DatasetResult).error ?? "";

  assertEquals(
    await datasetError("SELECT 1; SELECT * FROM missing; SELECT 2;"),
    "statement 2: OperationalError: no such table: missing",
  );
  assertStringIncludes(await datasetError("SELECT 1", "CREATE TABLE"), "setup failed");
  assertStringIncludes(
    await datasetError(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 501) SELECT i FROM n",
    ),
    "more than 500 rows",
  );
  assertStringIncludes(await datasetError("SELECT 9223372036854775807"), "return it as a string");
  assertStringIncludes(
    await datasetError("SELECT length(randomblob(300000000))"),
    "statement 1: MemoryError",
  );
});

Deno.test("sql: code with only comments holds no statements", async () => {
  const response = await sql("-- nothing here\n/* nor here */;", [{ id: "d1", setup: "" }]);
  assertEquals(response.status, "error");
  assertEquals(response.error, "the code holds no SQL statements");
});

Deno.test("sql: a query that never ends hits the time limit", async () => {
  const response = await sql(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n",
    [{ id: "d1", setup: "" }],
    { time_limit_seconds: 1 },
  );
  assertEquals(response.status, "timeout");
});
