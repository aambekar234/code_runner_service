/** The service's limits, and the settings it reads from the environment. */

const MAX_CASES = 50;
const MAX_DATASETS = 10;
const RESULT_BYTES = 100_000;

export const LIMITS = {
  /** Longest submission, in characters. */
  codeChars: 20_000,
  /** Most Python test cases, or SQL datasets, in one run. */
  cases: MAX_CASES,
  datasets: MAX_DATASETS,
  /** Longest SQL setup script and check query, in characters. */
  setupChars: 200_000,
  checkChars: 10_000,
  /** Printed text kept per case, in characters. */
  stdoutChars: 4_000,
  /** Most rows a SQL statement may return. */
  rows: 500,
  /** Largest result for one case or dataset, in bytes of JSON (a non-ASCII character takes 6). */
  resultBytes: RESULT_BYTES,
  /** Most a sandbox may send for one run: every result at its largest, plus room for the rest. */
  replyBytes: RESULT_BYTES * Math.max(MAX_CASES, MAX_DATASETS) + 10_000,
  /** Wall-clock time for one run, in seconds. */
  defaultTimeLimitSeconds: 2,
  maxTimeLimitSeconds: 10,
  /** Memory Python may use in a sandbox, in MB; past it the solution gets a MemoryError. */
  pythonMemoryMb: 256,
  /** Memory a whole sandbox process may use, JavaScript included, in MB (Linux only). */
  sandboxMemoryMb: 1024,
  /** How long a sandbox may take to load Pyodide before it is killed and replaced, in seconds. */
  startSeconds: 30,
  /** How long a run waits for a free sandbox before the service answers busy, in seconds. */
  waitSeconds: 5,
} as const;

const MIN_TOKEN_CHARS = 32;
/** IPv6 and IPv4 together, since some private networks reach services over IPv6 only. */
const DEFAULT_HOST = "::";
const DEFAULT_PORT = 8080;
const DEFAULT_POOL_SIZE = 2;
const MAX_POOL_SIZE = 16;

export interface Config {
  host: string;
  port: number;
  /** The current token first; the previous one too while a rotation is under way. */
  tokens: string[];
  poolSize: number;
}

export function readConfig(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Config {
  const current = token(env, "RUNNER_TOKEN");
  if (!current) throw new Error("RUNNER_TOKEN must be set");
  const previous = token(env, "RUNNER_TOKEN_PREVIOUS");
  return {
    host: env("HOST") || DEFAULT_HOST,
    port: wholeNumber(env, "PORT", DEFAULT_PORT, 1, 65_535),
    tokens: previous ? [current, previous] : [current],
    poolSize: wholeNumber(env, "POOL_SIZE", DEFAULT_POOL_SIZE, 1, MAX_POOL_SIZE),
  };
}

function token(env: (name: string) => string | undefined, name: string): string | undefined {
  const value = env(name);
  if (value && value.length < MIN_TOKEN_CHARS) {
    throw new Error(`${name} must be at least ${MIN_TOKEN_CHARS} characters long`);
  }
  return value || undefined;
}

function wholeNumber(
  env: (name: string) => string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${raw}`);
  }
  return value;
}
