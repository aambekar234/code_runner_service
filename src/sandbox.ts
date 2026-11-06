/**
 * One sandbox process, as the runner sees it: start it, wait until Pyodide has loaded, hand it
 * one job, collect what it reports within the time limit, and kill it. A sandbox never runs a
 * second job, so nothing one run leaves behind can reach the next.
 *
 * Everything a sandbox sends is untrusted: it is size-capped and checked against the contract.
 */

import { fromFileUrl } from "@std/path";
import { TextLineStream } from "@std/streams";
import type { z } from "zod";
import { LIMITS } from "./config.ts";
import {
  CaseResult,
  DatasetResult,
  type RunRequest,
  type RunResponse,
  SandboxMessage,
} from "./contract.ts";

const WORKER = fromFileUrl(new URL("./inside/worker.ts", import.meta.url));
const HARNESS = fromFileUrl(new URL("./inside/harness.py", import.meta.url));
const NODE_MODULES = fromFileUrl(new URL("../node_modules", import.meta.url));
const WASM_PAGES_PER_MB = 16;

/**
 * Every Deno permission off, except reading Pyodide's files and the harness. `--no-remote` and
 * `--cached-only` matter too: Deno otherwise lets code import modules from the web.
 */
const DENO_ARGS = [
  "run",
  "--no-prompt",
  "--no-remote",
  "--cached-only",
  `--allow-read=${NODE_MODULES},${HARNESS}`,
  `--v8-flags=--wasm-max-mem-pages=${LIMITS.pythonMemoryMb * WASM_PAGES_PER_MB}`,
  WORKER,
];

/**
 * On Linux, prlimit caps the whole process's memory, JavaScript included. Other systems have no
 * prlimit, so sandboxes there (a developer's Mac) run with only Python's memory capped.
 */
function sandboxCommand(): Deno.Command {
  const io = { clearEnv: true, stdin: "piped", stdout: "piped", stderr: "piped" } as const;
  if (Deno.build.os !== "linux") return new Deno.Command("deno", { args: DENO_ARGS, ...io });
  const memory = `--data=${LIMITS.sandboxMemoryMb * 1024 * 1024}`;
  return new Deno.Command("prlimit", { args: [memory, Deno.execPath(), ...DENO_ARGS], ...io });
}

export class Sandbox {
  private constructor(
    private readonly child: Deno.ChildProcess,
    private readonly lines: ReadableStreamDefaultReader<string>,
  ) {}

  /** Starts a sandbox and resolves once Pyodide has loaded in it. */
  static async start(): Promise<Sandbox> {
    const child = sandboxCommand().spawn();
    const lines = child.stdout
      .pipeThrough(capBytes(LIMITS.replyBytes))
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
      .getReader();
    const sandbox = new Sandbox(child, lines);

    const timer = setTimeout(() => sandbox.kill(), LIMITS.startSeconds * 1000);
    const first = await sandbox.next().catch(() => undefined);
    clearTimeout(timer);
    if (first?.type !== "ready") {
      // No solution has run yet, so what the sandbox wrote to stderr is Deno's own error.
      const [status, stderr] = await Promise.all([
        sandbox.close(),
        new Response(child.stderr).text(),
      ]);
      throw new Error(`the sandbox exited with code ${status.code} before it was ready: ${stderr}`);
    }
    // From here on stderr is the solution's to write, and nothing reads it.
    await child.stderr.cancel();
    return sandbox;
  }

  /** Runs one job, then kills the sandbox, whatever happened. */
  async run(request: RunRequest): Promise<RunResponse> {
    const start = performance.now();
    const results: (CaseResult | DatasetResult)[] = [];
    const [resultSchema, ids]: [z.ZodType<CaseResult | DatasetResult>, string[]] =
      request.language === "python"
        ? [CaseResult, request.cases.map((item) => item.id)]
        : [DatasetResult, request.datasets.map((item) => item.id)];
    let done: Extract<SandboxMessage, { type: "done" }> | undefined;
    let problem: string | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.kill();
    }, request.time_limit_seconds * 1000);

    try {
      await this.send(jobFor(request));
      while (!done) {
        const message = await this.next();
        if (!message) break;
        if (message.type === "result") {
          const result = checked(resultSchema, message.result);
          if (result.id !== ids[results.length]) {
            throw new Error("the sandbox sent results out of order");
          }
          results.push(result);
        } else if (message.type === "done") {
          if (message.status === "ok" && results.length !== ids.length) {
            throw new Error("the sandbox finished without every result");
          }
          done = message;
        } else {
          throw new Error(`the sandbox sent an unexpected ${message.type} message`);
        }
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      await this.close();
    }

    const duration_seconds = Math.round(performance.now() - start) / 1000;
    if (done) return { status: done.status, error: done.error, results, duration_seconds };
    if (timedOut) {
      const error = `the run took longer than ${request.time_limit_seconds} seconds`;
      return { status: "timeout", error, results, duration_seconds };
    }
    const error = problem ?? "the sandbox stopped before it finished";
    return { status: "crashed", error, results, duration_seconds };
  }

  /** Kills the process and releases its output; resolves with how it exited. */
  async close(): Promise<Deno.CommandStatus> {
    this.kill();
    const status = await this.child.status;
    // Canceling output that already failed rejects with that failure; nothing is left to release.
    await this.lines.cancel().catch(() => {});
    return status;
  }

  private kill(): void {
    try {
      this.child.kill("SIGKILL");
    } catch {
      // It has exited already.
    }
  }

  private async send(job: object): Promise<void> {
    const writer = this.child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(job)));
    await writer.close();
  }

  /** The next message, or undefined once the sandbox has stopped writing. */
  private async next(): Promise<SandboxMessage | undefined> {
    const { value, done } = await this.lines.read();
    if (done) return undefined;
    let line: unknown;
    try {
      line = JSON.parse(value);
    } catch {
      throw new Error("the sandbox sent a line that is not JSON");
    }
    return checked(SandboxMessage, line);
  }
}

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("the sandbox sent a message that breaks the contract");
  return parsed.data;
}

/** What goes into the sandbox: the code, its inputs and the limits. Nothing about the caller. */
function jobFor(request: RunRequest): object {
  const limits = {
    stdout_chars: LIMITS.stdoutChars,
    rows: LIMITS.rows,
    result_bytes: LIMITS.resultBytes,
  };
  return request.language === "python"
    ? { language: "python", code: request.code, entry: request.entry, cases: request.cases, limits }
    : { language: "sql", code: request.code, datasets: request.datasets, limits };
}

/** Passes bytes through until more than `max` have gone by, then fails the stream. */
function capBytes(max: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) throw new Error(`the sandbox sent more than ${max} bytes`);
      controller.enqueue(chunk);
    },
  });
}
