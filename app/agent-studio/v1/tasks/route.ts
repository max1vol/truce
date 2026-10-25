import {
  authenticateRaceRequest,
  raceError,
  readNonce,
  readRaceBody,
  validateRaceTask,
} from "@/lib/race";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // App-live readiness is independent of the AI milestone. A model integration
  // must replace this response before any AI task can truthfully succeed.
  return raceError(
    503,
    "upstream_unavailable",
    "This deployment does not yet execute AI tasks. No AI result has been generated.",
    nonce,
  );
}
