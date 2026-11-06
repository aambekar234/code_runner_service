import { assert, assertEquals } from "@std/assert";
import { RunRequest } from "../src/contract.ts";
import { SandboxPool } from "../src/pool.ts";

const QUICK = RunRequest.parse({
  language: "python",
  code: "def solve():\n    return 1\n",
  entry: "solve",
  cases: [{ id: "t1", args: [] }],
});
const ENDLESS = RunRequest.parse({
  ...QUICK,
  code: "def solve():\n    while True:\n        pass\n",
});

async function untilHealthy(pool: SandboxPool): Promise<void> {
  while (!pool.healthy) await new Promise((resolve) => setTimeout(resolve, 50));
}

Deno.test("a pool replaces each sandbox after its run", async () => {
  const pool = new SandboxPool(1);
  try {
    const first = await pool.run(QUICK);
    const second = await pool.run(QUICK);
    assertEquals(first?.status, "ok");
    assertEquals(second?.status, "ok");
  } finally {
    await pool.close();
  }
});

Deno.test("a pool with no free sandbox answers busy once the wait is over", async () => {
  const pool = new SandboxPool(1, 0);
  try {
    await untilHealthy(pool);
    const running = pool.run({ ...ENDLESS, time_limit_seconds: 1 });
    assertEquals(await pool.run(QUICK), null);
    assert(await running);
  } finally {
    await pool.close();
  }
});
