import { authenticateRaceRequest, raceJson, RACE_PROTOCOL } from "@/lib/race";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const authError = authenticateRaceRequest(request);
  if (authError) return authError;

  return raceJson({ protocol: RACE_PROTOCOL, status: "ready", name: "Truce" });
}
