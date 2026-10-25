import { createHash, timingSafeEqual } from "node:crypto";

export const RACE_PROTOCOL = "asrp/1";
const MAX_REQUEST_BYTES = 64 * 1024;
const TASK_TYPES = new Set([
  "respond",
  "extract",
  "use_tools",
  "answer_from_source",
  "converse",
  "run_workflow",
]);

type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "limit_exceeded";

export function raceJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function raceError(
  status: number,
  code: ErrorCode,
  message: string,
  nonce: string | null = null,
): Response {
  return raceJson(
    {
      protocol: RACE_PROTOCOL,
      nonce,
      status: "error",
      error: { code, message },
    },
    status,
  );
}

// Authenticate before reading task data. Never expose or log the verifier token.
export function authenticateRaceRequest(request: Request): Response | null {
  const token = process.env.AGENT_STUDIO_VERIFIER_TOKEN;
  if (!token?.trim()) {
    return raceError(
      503,
      "upstream_unavailable",
      "The verifier token is not configured on this deployment.",
    );
  }

  const authorization = request.headers.get("authorization") ?? "";
  const actual = createHash("sha256").update(authorization).digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  if (!timingSafeEqual(actual, expected)) {
    return raceError(401, "unauthorized", "A valid verifier token is required.");
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength = 2048): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function readNonce(value: unknown): string | null {
  return isRecord(value) && nonEmptyString(value.nonce, 512) ? value.nonce : null;
}

export class RaceInputError extends Error {}

// Bound chunked requests too; Content-Length alone is not an input-size limit.
export async function readRaceBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_REQUEST_BYTES) {
    throw new RaceInputError("The request body exceeds 64 KB.");
  }
  if (!request.body) throw new RaceInputError("A JSON request body is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RaceInputError("The request body exceeds 64 KB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RaceInputError("The request body must contain valid JSON.");
  }
}

function validHttpsUrl(value: unknown): boolean {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

// Validation does not execute a model, fetch a supplied URL, or spend funds.
export function validateRaceTask(value: unknown): string | null {
  if (!isRecord(value) || value.protocol !== RACE_PROTOCOL) {
    return "The protocol must be asrp/1.";
  }
  if (!readNonce(value)) return "A non-empty nonce of at most 512 characters is required.";
  if (!isRecord(value.task)) return "A task object is required.";

  const task = value.task;
  if (typeof task.type !== "string" || !TASK_TYPES.has(task.type)) {
    return "The task type is not supported by ASRP/1.";
  }
  if (!("input" in task) || task.input === null || task.input === "") {
    return "The task requires an input value.";
  }
  if (
    (task.type === "extract" || task.type === "run_workflow") &&
    !isRecord(task.schema) &&
    typeof task.schema !== "boolean"
  ) {
    return "This task requires a JSON schema.";
  }
  if (task.type === "converse" && !nonEmptyString(task.sessionId, 512)) {
    return "A conversation task requires a sessionId.";
  }
  if (task.type === "use_tools") {
    if (!Array.isArray(task.tools) || task.tools.length === 0) {
      return "A tool task requires at least one tool.";
    }
    if (
      task.tools.some(
        (tool) => !isRecord(tool) || !nonEmptyString(tool.name) || !validHttpsUrl(tool.url),
      )
    ) {
      return "Each tool requires a name and an HTTPS URL without credentials.";
    }
  }
  if (
    task.type === "answer_from_source" &&
    (!isRecord(task.source) || !validHttpsUrl(task.source.url))
  ) {
    return "A source task requires a source with an HTTPS URL without credentials.";
  }
  if (task.limits !== undefined) {
    if (!isRecord(task.limits)) return "Task limits must be an object.";
    for (const name of ["maxToolCalls", "maxSpendUsd", "timeoutMs"]) {
      const limit = task.limits[name];
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) {
        return "Task limits must be finite, non-negative numbers.";
      }
    }
  }
  return null;
}
