/**
 * What callers send, what they get back, and what a sandbox may report. The runner only runs
 * code and reports what came out; deciding right or wrong is the caller's job.
 */

import { z } from "zod";
import { LIMITS } from "./config.ts";

const Id = z.string().min(1).max(64);
const Code = z.string().min(1).max(LIMITS.codeChars);
const TimeLimit = z.number().positive().max(LIMITS.maxTimeLimitSeconds)
  .default(LIMITS.defaultTimeLimitSeconds);
/** Who the run is for, such as a user id. Only ever written to logs. */
const Label = z.string().max(100).optional();

const uniqueIds = (items: { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length;

/** JSON numbers are doubles: an integer past 2^53 arrives changed, so it has to come as a string. */
function hasUnsafeInteger(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasUnsafeInteger);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasUnsafeInteger);
  }
  return false;
}

const Args = z.array(z.json()).refine(
  (args) => !hasUnsafeInteger(args),
  "integers must be within ±(2^53 - 1); send bigger ones as strings",
);

export const PythonRequest = z.object({
  language: z.literal("python"),
  code: Code,
  /** The function the cases call. */
  entry: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a Python function name"),
  cases: z.array(z.object({ id: Id, args: Args }))
    .min(1).max(LIMITS.cases).refine(uniqueIds, "case ids must be unique"),
  time_limit_seconds: TimeLimit,
  label: Label,
});

export const SqlRequest = z.object({
  language: z.literal("sql"),
  /** Any SQLite script: queries, data changes, tables, transactions. */
  code: Code,
  /** Each dataset runs the code on a fresh database: `setup` first, then the code, then `check`. */
  datasets: z.array(z.object({
    id: Id,
    setup: z.string().max(LIMITS.setupChars),
    check: z.string().min(1).max(LIMITS.checkChars).optional(),
  })).min(1).max(LIMITS.datasets).refine(uniqueIds, "dataset ids must be unique"),
  time_limit_seconds: TimeLimit,
  label: Label,
});

export const RunRequest = z.discriminatedUnion("language", [PythonRequest, SqlRequest]);

export const CaseResult = z.object({
  id: Id,
  /** The function's return value; null when it raised. */
  output: z.json(),
  error: z.string().nullable(),
  stdout: z.string(),
  duration_seconds: z.number(),
});

const Rows = {
  columns: z.array(z.string()),
  rows: z.array(z.array(z.json())),
};

export const DatasetResult = z.object({
  id: Id,
  /** One entry per statement that ran, in order; a failing statement stops the rest. */
  statements: z.array(z.object({ sql: z.string(), ...Rows, rows_changed: z.number().int() })),
  /** What the dataset's check query returned, once the code has run without an error. */
  check: z.object(Rows).nullable(),
  error: z.string().nullable(),
  duration_seconds: z.number(),
});

/** The lines a sandbox writes, one JSON object each: ready, then results, then done. */
export const SandboxMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("result"), result: z.unknown() }),
  z.object({
    type: z.literal("done"),
    status: z.enum(["ok", "error"]),
    error: z.string().nullable(),
  }),
]);

export type RunRequest = z.infer<typeof RunRequest>;
export type CaseResult = z.infer<typeof CaseResult>;
export type DatasetResult = z.infer<typeof DatasetResult>;
export type SandboxMessage = z.infer<typeof SandboxMessage>;

export interface RunResponse {
  /**
   * ok: the code loaded and every case or dataset ran (each may hold its own error).
   * error: the code could not run at all, such as a syntax error.
   * timeout: the time limit ran out; results holds what finished before it.
   * crashed: the sandbox died or broke the protocol, such as by sending too much.
   */
  status: "ok" | "error" | "timeout" | "crashed";
  error: string | null;
  /** Case results for Python, dataset results for SQL, in the order they ran. */
  results: (CaseResult | DatasetResult)[];
  duration_seconds: number;
}
