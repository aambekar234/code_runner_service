import { readConfig } from "./config.ts";
import { SandboxPool } from "./pool.ts";
import { createHandler } from "./server.ts";

const config = readConfig();
const pool = new SandboxPool(config.poolSize);
const server = Deno.serve(
  { hostname: config.host, port: config.port },
  createHandler(pool, config.tokens),
);

// Platforms send SIGTERM before stopping a container: finish the runs in flight, then stop the
// idle sandboxes.
Deno.addSignalListener("SIGTERM", async () => {
  await server.shutdown();
  await pool.close();
  Deno.exit(0);
});
