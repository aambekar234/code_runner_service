/**
 * One sandbox: loads Pyodide, runs one job and exits. The runner starts it with every Deno
 * permission off except reading Pyodide's files and the harness (`../sandbox.ts`), so this code,
 * and the solution with it, has no network, environment, files or programs.
 *
 * It writes one JSON line per message: `ready` once Pyodide has loaded, then reads the job from
 * stdin until the runner closes it, then writes a `result` per case or dataset, and `done`.
 */

import { loadPyodide } from "pyodide";
import type { SandboxMessage } from "../contract.ts";

const pyodide = await loadPyodide({
  stdin: () => null, // input() raises EOFError
  stdout: () => {}, // the harness keeps what each case prints; anything else is dropped
  stderr: () => {},
});
pyodide.runPython(await Deno.readTextFile(new URL("./harness.py", import.meta.url)));
send({ type: "ready" });

const job = await new Response(Deno.stdin.readable).text();
const run = pyodide.globals.get(JSON.parse(job).language === "sql" ? "run_sql" : "run_python");
// The harness hands each result over as JSON already.
const outcome = run(job, (result: string) => console.log(`{"type":"result","result":${result}}`));
send({ type: "done", ...JSON.parse(outcome) });

function send(message: SandboxMessage): void {
  console.log(JSON.stringify(message));
}
