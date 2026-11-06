import { assertEquals, assertThrows } from "@std/assert";
import { readConfig } from "../src/config.ts";

const TOKEN = "t".repeat(32);

function envOf(values: Record<string, string>) {
  return (name: string) => values[name];
}

Deno.test("defaults apply when only the token is set", () => {
  assertEquals(readConfig(envOf({ RUNNER_TOKEN: TOKEN })), {
    host: "::",
    port: 8080,
    tokens: [TOKEN],
    poolSize: 2,
  });
});

Deno.test("the previous token is accepted during a rotation", () => {
  const config = readConfig(envOf({ RUNNER_TOKEN: TOKEN, RUNNER_TOKEN_PREVIOUS: "p".repeat(32) }));
  assertEquals(config.tokens, [TOKEN, "p".repeat(32)]);
});

Deno.test("a missing or short token is refused", () => {
  assertThrows(() => readConfig(envOf({})), Error, "RUNNER_TOKEN");
  assertThrows(() => readConfig(envOf({ RUNNER_TOKEN: "short" })), Error, "RUNNER_TOKEN");
  assertThrows(
    () => readConfig(envOf({ RUNNER_TOKEN: TOKEN, RUNNER_TOKEN_PREVIOUS: "1" })),
    Error,
    "RUNNER_TOKEN_PREVIOUS",
  );
});

Deno.test("numbers out of range are refused", () => {
  assertThrows(
    () => readConfig(envOf({ RUNNER_TOKEN: TOKEN, POOL_SIZE: "0" })),
    Error,
    "POOL_SIZE",
  );
  assertThrows(() => readConfig(envOf({ RUNNER_TOKEN: TOKEN, PORT: "http" })), Error, "PORT");
});
