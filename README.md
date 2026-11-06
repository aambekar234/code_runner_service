# code_runner_service

Runs a learner's Python or SQL in a sandbox and reports what came out. It never decides right or
wrong: the caller holds the expected answers and compares. Only PrepZap's live service calls it,
over Railway's private network.

## How it works

- The service keeps `POOL_SIZE` sandboxes loaded. A sandbox is a separate Deno process running
  [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) with every Deno permission off:
  no network, environment, files or programs. It may only read Pyodide's files and the harness.
- Each sandbox runs exactly one job, then is killed and replaced, so nothing leaks between runs.
  Within one run, the cases share one interpreter: module-level state carries over between them.
- Python may use 256 MB; past that the code gets a `MemoryError`. On Linux, `prlimit` also caps the
  whole sandbox process at 1 GB, JavaScript included. A run past its time limit is killed.
- SQL runs on SQLite (3.39) inside the same sandbox, a fresh in-memory database per dataset.

```
src/
  main.ts        starts the pool and the HTTP server
  config.ts      limits and environment settings
  contract.ts    request, response and sandbox message schemas
  server.ts      routes and the token check
  pool.ts        keeps sandboxes loaded and hands one to each run
  sandbox.ts     starts one sandbox process, runs one job in it, kills it
  inside/        the only code that runs inside a sandbox
    worker.ts    loads Pyodide, reads the job, writes results
    harness.py   runs the Python cases or the SQL script
```

## API

Every `/run` request needs `Authorization: Bearer <RUNNER_TOKEN>`.

**Python:** call one function once per case. Inputs and outputs are plain JSON data, with integers
within ±(2^53 − 1), since JSON numbers are doubles; exchange bigger ones as strings.

```json
{
  "language": "python",
  "code": "def two_sum(nums, target): ...",
  "entry": "two_sum",
  "cases": [{ "id": "t1", "args": [[2, 7, 11, 15], 9] }],
  "time_limit_seconds": 2,
  "label": "user-123"
}
```

**SQL:** any SQLite script (queries, data changes, tables, transactions). Each dataset gets a fresh
database: its `setup` runs, then the code statement by statement, then its optional `check` query,
so data changes can be graded too.

```json
{
  "language": "sql",
  "code": "UPDATE users SET active = 0 WHERE last_login < '2026-01-01';",
  "datasets": [
    { "id": "d1", "setup": "CREATE TABLE users (...); INSERT ...", "check": "SELECT * FROM users" }
  ]
}
```

`time_limit_seconds` defaults to 2 (most 10). `label` is only written to logs.

**Response** (HTTP 200 whenever the run happened):

```json
{
  "status": "ok",
  "error": null,
  "results": [
    { "id": "t1", "output": [0, 1], "error": null, "stdout": "", "duration_seconds": 0.00003 }
  ],
  "duration_seconds": 0.02
}
```

| `status`  | Meaning                                                                          |
| --------- | -------------------------------------------------------------------------------- |
| `ok`      | The code loaded and every case or dataset ran; each may hold its own `error`.    |
| `error`   | The code could not run at all, such as a syntax error or a missing function.     |
| `timeout` | The run's time limit ran out. `results` holds what finished, in request order.   |
| `crashed` | The sandbox died or broke the protocol, such as by sending results out of order. |

Results always come back in request order. A SQL result has `statements` (each with `sql`,
`columns`, `rows`, `rows_changed`), `check` (`columns` and `rows`, or null) and `error` instead of
`output` and `stdout`. A failing statement stops that dataset. Errors read like
`ZeroDivisionError: division by zero (line 3)` or
`statement 2: OperationalError: no such table: users`. One result may take 100 KB of JSON; a bigger
one comes back emptied, with an error saying so.

Other answers: `400` for a request that breaks the contract, `401` for a missing or wrong token,
`503` with `Retry-After` when every sandbox is busy. `GET /health` answers 200 once a sandbox has
started. All limits live in `src/config.ts`.

## Configuration

| Variable                | Default  |                                                                        |
| ----------------------- | -------- | ---------------------------------------------------------------------- |
| `RUNNER_TOKEN`          | required | At least 32 characters. Make one with `openssl rand -hex 32`.          |
| `RUNNER_TOKEN_PREVIOUS` | unset    | Also accepted, while rotating the token.                               |
| `POOL_SIZE`             | `2`      | Sandboxes kept loaded, which is also how many runs can happen at once. |
| `PORT`                  | `8080`   | Railway sets it.                                                       |
| `HOST`                  | `::`     | Listens on IPv6 and IPv4. Use `0.0.0.0` on a machine without IPv6.     |

**Rotating the token:** move the current value to `RUNNER_TOKEN_PREVIOUS`, put a new one in
`RUNNER_TOKEN`, switch the live service to the new one, then clear `RUNNER_TOKEN_PREVIOUS`.

## Develop

Needs Deno 2.9. On macOS there is no `prlimit`, so local sandboxes run with only Python's memory
capped; Linux (CI, Docker, Railway) has the full cap.

```bash
deno install                 # dependencies, Pyodide included
RUNNER_TOKEN=$(openssl rand -hex 32) deno task start
deno task check              # format, lint, types
deno task test               # unit tests and real sandboxes
```

## Deploy on Railway

1. Create a service from this repo. Railway builds the `Dockerfile`.
2. Do **not** generate a public domain. The live service calls
   `http://<service-name>.railway.internal:8080/run`.
3. Set `RUNNER_TOKEN` (and `POOL_SIZE` if not 2). Share the same token with the live service, for
   example as a shared variable. Set `PORT=8080` so the internal address is fixed.
4. Set the healthcheck path to `/health`, so a deploy only goes live once sandboxes start.

Memory: about 250 MB idle with 2 sandboxes. A typical run adds little, but each sandbox may grow to
1 GB, so give the service `POOL_SIZE` × 1 GB to be safe from a hostile run.

## Security notes

- The sandbox boundary is Deno's permission system around WebAssembly. Python can call into the
  sandbox's JavaScript (Pyodide allows that), so the permissions, not Python, are what hold.
- The second layer is the service itself: it holds only the token, no other secrets, no volume and
  no database, and has no public address.
- A solution can make its own sandbox report anything. That only fakes its own outputs, which is why
  expected answers never enter the sandbox and graders keep hidden cases.
- Known limit: CPU is shared. A hostile run can start JavaScript workers and slow the runs beside it
  until its own time limit kills it, which can push an honest neighbour into a timeout.
