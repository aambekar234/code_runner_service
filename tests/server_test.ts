import { assertEquals, assertStringIncludes } from "@std/assert";
import type { RunRequest, RunResponse } from "../src/contract.ts";
import { createHandler, type Runner } from "../src/server.ts";

const TOKEN = "current-token-current-token-1234";
const PREVIOUS = "previous-token-previous-token-12";
const DONE: RunResponse = { status: "ok", error: null, results: [], duration_seconds: 0.01 };
const PYTHON = {
  language: "python",
  code: "def f():\n    return 1\n",
  entry: "f",
  cases: [{ id: "t1", args: [] }],
};

function fakeRunner(result: RunResponse | null = DONE, healthy = true) {
  const received: RunRequest[] = [];
  const runner: Runner = {
    healthy,
    run: (request) => {
      received.push(request);
      return Promise.resolve(result);
    },
  };
  return { runner, received };
}

function post(body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://runner/run", { method: "POST", headers, body: text });
}

Deno.test("health is ok once a sandbox has started, and 503 before", async () => {
  const ready = createHandler(fakeRunner().runner, [TOKEN]);
  assertEquals((await ready(new Request("http://runner/health"))).status, 200);
  const starting = createHandler(fakeRunner(DONE, false).runner, [TOKEN]);
  assertEquals((await starting(new Request("http://runner/health"))).status, 503);
});

Deno.test("a run needs the current or the previous token", async () => {
  const handle = createHandler(fakeRunner().runner, [TOKEN, PREVIOUS]);
  assertEquals((await handle(post(PYTHON, null))).status, 401);
  assertEquals((await handle(post(PYTHON, "wrong"))).status, 401);
  assertEquals((await handle(post(PYTHON, TOKEN))).status, 200);
  assertEquals((await handle(post(PYTHON, PREVIOUS))).status, 200);
});

Deno.test("a valid run reaches the runner with defaults filled in", async () => {
  const { runner, received } = fakeRunner();
  const response = await createHandler(runner, [TOKEN])(post(PYTHON));
  assertEquals(await response.json(), DONE);
  assertEquals(received[0].time_limit_seconds, 2);
});

Deno.test("a body that is not JSON, or breaks the contract, is a 400", async () => {
  const handle = createHandler(fakeRunner().runner, [TOKEN]);
  assertEquals((await handle(post("{not json"))).status, 400);
  const invalid = await handle(post({ ...PYTHON, entry: "not a name" }));
  assertEquals(invalid.status, 400);
  assertStringIncludes((await invalid.json()).error, "entry");
});

Deno.test("an integer too big for JSON numbers is a 400, not a changed input", async () => {
  const handle = createHandler(fakeRunner().runner, [TOKEN]);
  const body = JSON.stringify(PYTHON).replace('"args":[]', '"args":[12345678901234567891]');
  const response = await handle(post(body));
  assertEquals(response.status, 400);
  assertStringIncludes((await response.json()).error, "as strings");
});

Deno.test("a busy runner is a 503 with Retry-After", async () => {
  const response = await createHandler(fakeRunner(null).runner, [TOKEN])(post(PYTHON));
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "1");
});

Deno.test("unknown paths and wrong methods are refused", async () => {
  const handle = createHandler(fakeRunner().runner, [TOKEN]);
  assertEquals((await handle(new Request("http://runner/run"))).status, 405);
  assertEquals((await handle(new Request("http://runner/health", { method: "POST" }))).status, 405);
  assertEquals((await handle(new Request("http://runner/other"))).status, 404);
});
