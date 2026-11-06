/**
 * The HTTP API: `GET /health` for Railway's deploy check, and `POST /run` for the live service,
 * which must send `Authorization: Bearer <RUNNER_TOKEN>`.
 */

import { timingSafeEqual } from "@std/crypto/timing-safe-equal";
import { z } from "zod";
import { RunRequest, type RunResponse } from "./contract.ts";

export interface Runner {
  readonly healthy: boolean;
  /** Null when no sandbox is free. */
  run(request: RunRequest): Promise<RunResponse | null>;
}

const encoder = new TextEncoder();

export function createHandler(
  runner: Runner,
  tokens: string[],
): (request: Request) => Promise<Response> {
  const allowed = tokens.map((token) => encoder.encode(token));

  async function run(request: Request): Promise<Response> {
    if (!authorized(request.headers.get("authorization"), allowed)) {
      return reply({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return reply({ error: "the body is not JSON" }, 400);
    }
    const parsed = RunRequest.safeParse(body);
    if (!parsed.success) return reply({ error: z.prettifyError(parsed.error) }, 400);

    const result = await runner.run(parsed.data);
    if (!result) return reply({ error: "every sandbox is busy" }, 503, { "retry-after": "1" });
    logRun(parsed.data, result);
    return reply(result);
  }

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      if (request.method !== "GET") return reply({ error: "method not allowed" }, 405);
      return runner.healthy ? reply({ status: "ok" }) : reply({ status: "starting" }, 503);
    }
    if (pathname === "/run") {
      if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
      return await run(request);
    }
    return reply({ error: "not found" }, 404);
  };
}

function authorized(header: string | null, allowed: Uint8Array[]): boolean {
  const token = header?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return false;
  const given = encoder.encode(token);
  return allowed.some((one) => one.length === given.length && timingSafeEqual(one, given));
}

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function logRun(request: RunRequest, result: RunResponse): void {
  console.info(JSON.stringify({
    event: "run",
    label: request.label ?? null,
    language: request.language,
    status: result.status,
    error: result.error,
    results: result.results.length,
    duration_seconds: result.duration_seconds,
  }));
}
