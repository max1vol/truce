import {
  authenticateRaceRequest,
  isRecord,
  raceError,
  raceJson,
  RACE_PROTOCOL,
  readNonce,
  readRaceBody,
  validateRaceTask,
} from "@/lib/race";
import { AiTaskError, executeAiTask } from "@/lib/ai";
import { PaymentTaskError, executePaymentTask } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const authError = authenticateRaceRequest(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await readRaceBody(request);
  } catch {
    return raceError(400, "invalid_input", "A valid JSON request body of at most 64 KB is required.");
  }

  const nonce = readNonce(body);
  const validationError = validateRaceTask(body);
  if (validationError) return raceError(400, "invalid_input", validationError, nonce);

  if (isRecord(body) && isRecord(body.task) && body.task.type === "run_workflow") {
    try {
      const output = await executePaymentTask(body, { signal: request.signal });
      return raceJson({ protocol: RACE_PROTOCOL, nonce, status: "ok", output });
    } catch (error) {
      if (error instanceof PaymentTaskError) return raceError(error.status, error.code, error.message, nonce);
      return raceError(503, "upstream_unavailable", "The devnet payment could not be completed.", nonce);
    }
  }

  if (isRecord(body) && isRecord(body.task) && (body.task.type === "respond" || body.task.type === "use_tools")) {
    try {
      const output = await executeAiTask(body.task, { signal: request.signal });
      const envelope = { protocol: RACE_PROTOCOL, nonce, status: "ok", output };
      if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 256 * 1024) {
        return raceError(422, "limit_exceeded", "The task result exceeded the supported response size.", nonce);
      }
      return raceJson(envelope);
    } catch (error) {
      if (error instanceof AiTaskError) return raceError(error.status, error.code, error.message, nonce);
      return raceError(503, "upstream_unavailable", "The task could not be completed.", nonce);
    }
  }

  return raceError(
    503,
    "upstream_unavailable",
    "This task capability has not been implemented. No result has been generated.",
    nonce,
  );
}
