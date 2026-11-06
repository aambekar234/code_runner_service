# code_runner_service

A small HTTP service that runs untrusted Python and SQL in a WebAssembly sandbox and tells you
exactly what came out. It never decides right or wrong: you keep the expected answers and the
judging.

## Why

AI products keep generating code and asking people to write it: tutors, interview agents, coding
assistants, eval harnesses. At some point that code has to actually run, safely.

- **Check before you show.** Run the model's reference solution against the tests it wrote, and
  catch a wrong test before a learner ever sees it.
- **Grade what comes back.** Run a learner's submission against hidden cases. Expected answers never
  enter the sandbox, so code can't read them or fake a pass.
- **Give an agent a tool.** Let the model try code and read the real output instead of guessing.
- **Deploy anywhere.** No privileged containers, VMs or KVM: one Docker image that runs on any
  container platform, including the ones that forbid privileged mode.
- **Fast.** Sandboxes are loaded ahead of time, so a run usually takes tens of milliseconds.

## How it works

- Each run gets its own Deno process running [Pyodide](https://pyodide.org) (CPython 3.14 compiled
  to WebAssembly) with every permission off: no network, environment, files or programs.
- A process runs one job and is then killed and replaced, so nothing carries over between runs.
- Python runs a named function once per test case. SQL runs any SQLite script on a fresh database
  per dataset, then an optional check query, so data changes can be graded too.
- Memory and time are capped per run; everything the sandbox sends back is size-limited and
  validated.

## Quick start

```bash
export RUNNER_TOKEN=$(openssl rand -hex 32)
docker build -t code-runner .
docker run --rm -p 8080:8080 -e RUNNER_TOKEN code-runner
```

```bash
curl -s localhost:8080/run -H "Authorization: Bearer $RUNNER_TOKEN" -d '{
  "language": "python",
  "code": "def add(a, b):\n    return a + b\n",
  "entry": "add",
  "cases": [{ "id": "t1", "args": [2, 3] }, { "id": "t2", "args": ["a", 1] }]
}'
```

```json
{
  "status": "ok",
  "error": null,
  "results": [
    { "id": "t1", "output": 5, "error": null, "stdout": "", "duration_seconds": 0.00002 },
    {
      "id": "t2",
      "output": null,
      "error": "TypeError: can only concatenate str (not \"int\") to str (line 2)",
      "stdout": "",
      "duration_seconds": 0.00004
    }
  ],
  "duration_seconds": 0.018
}
```

## API

`POST /run` with `Authorization: Bearer <RUNNER_TOKEN>`. `GET /health` answers 200 once a sandbox is
ready.

**Python:** `code`, the `entry` function to call, and `cases` of `{ id, args }`. Arguments and
return values are plain JSON; integers beyond ±(2^53 − 1) travel as strings.

**SQL:** `code` (any SQLite script) and `datasets` of `{ id, setup, check? }`:

```json
{
  "language": "sql",
  "code": "UPDATE users SET active = 0 WHERE last_login < '2026-01-01';",
  "datasets": [{ "id": "d1", "setup": "CREATE TABLE users ...", "check": "SELECT * FROM users" }]
}
```

Each SQL result lists every statement that ran (`sql`, `columns`, `rows`, `rows_changed`), then what
`check` returned.

Both take an optional `time_limit_seconds` (default 2, at most 10) and a `label` that is only
logged.

| `status`  | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `ok`      | Every case or dataset ran; each carries its own `output` or `error`. |
| `error`   | The code could not run at all, such as a syntax error.               |
| `timeout` | The time limit ran out; `results` holds what finished.               |
| `crashed` | The sandbox died or broke the protocol.                              |

Invalid requests get `400`, a bad token `401`, and a full pool `503` with `Retry-After`. Every limit
lives in `src/config.ts`.

## Configuration

| Variable                | Default  |                                                            |
| ----------------------- | -------- | ---------------------------------------------------------- |
| `RUNNER_TOKEN`          | required | Shared secret, at least 32 characters.                     |
| `RUNNER_TOKEN_PREVIOUS` | unset    | Also accepted, so the token can be rotated with no outage. |
| `POOL_SIZE`             | `2`      | Sandboxes kept ready, and how many runs happen at once.    |
| `PORT`                  | `8080`   |                                                            |
| `HOST`                  | `::`     | IPv6 and IPv4. Use `0.0.0.0` where there is no IPv6.       |

Plan about 250 MB idle for two sandboxes, and up to 1 GB per sandbox under a hostile run.

## Security model

- The boundary is Deno's permission system around WebAssembly. On Linux, `prlimit` also caps each
  sandbox's total memory.
- Run it on a private network with nothing else in the container. It holds no secrets beyond its
  token.
- Code can make its own sandbox report anything, but that only fakes its own outputs: keep expected
  answers and hidden cases on your side.
- CPU is shared, so a hostile run can slow its neighbours until its own time limit stops it.

## License

[Apache 2.0](LICENSE)
