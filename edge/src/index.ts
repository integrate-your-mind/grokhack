import type { Env } from "./env";
import { BoundedBodyError, readBoundedBytes, readBoundedText } from "./bounded-body";
import {
  MAX_CONTROL_BODY_BYTES,
  directoryBucketFor,
  parseAllocationRequest,
  parseRetirementRequest,
  realmDirectoryObjectName,
  verifyControlSignature,
  type AllocationResult,
  type RetirementResult,
} from "./allocation-protocol";
import { browserOriginAllowed, readEdgeConfig, type EdgeConfig } from "./config";
import { FloorInstance } from "./floor-instance";
import { PlayerSession } from "./player-session";
import { RealmDirectory } from "./realm-directory";
import { ShadowReplay } from "./shadow-replay";
import {
  MAX_SHADOW_BATCH_BYTES,
  MAX_SHADOW_BATCH_ENTRIES,
  validateMovementTurnEnvelope,
  validateShadowJournalEntry,
  validateShadowRoute,
} from "../../src/shadow-journal";
import { validateCombatTurnEnvelopeV1 } from "../../src/combat-turn-envelope";
import {
  EDGE_PROTOCOL_VERSION,
  MAX_ROUTE_TICKET_BYTES,
  RouteTicketError,
  floorObjectName,
  type RouteTicketClaims,
  verifyRouteTicketWithKeyring,
} from "./protocol";

export { FloorInstance, PlayerSession, RealmDirectory, ShadowReplay };

const ROUTE_PROTOCOL = "grokhack.v4";
const ROUTE_TICKET_PROTOCOL_PREFIX = "grokhack.ticket.";

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

function routeTicketFromSubprotocol(request: Request): string {
  const header = request.headers.get("Sec-WebSocket-Protocol") ?? "";
  if (header.length > MAX_ROUTE_TICKET_BYTES + 128) {
    throw new RouteTicketError("Route protocol header is too large");
  }
  const protocols = header
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!protocols.includes(ROUTE_PROTOCOL)) throw new RouteTicketError("Missing edge protocol");
  const ticketProtocols = protocols.filter((entry) =>
    entry.startsWith(ROUTE_TICKET_PROTOCOL_PREFIX),
  );
  if (ticketProtocols.length !== 1) throw new RouteTicketError("Ambiguous route ticket");
  return ticketProtocols[0]!.slice(ROUTE_TICKET_PROTOCOL_PREFIX.length);
}

function durableObjectFailure(error: unknown): {
  overloaded: boolean;
  retryable: boolean;
  remote: boolean;
} {
  if (!error || typeof error !== "object") {
    return { overloaded: false, retryable: false, remote: false };
  }
  const candidate = error as { overloaded?: unknown; retryable?: unknown; remote?: unknown };
  return {
    overloaded: candidate.overloaded === true,
    retryable: candidate.retryable === true,
    remote: candidate.remote === true,
  };
}

async function routeWebSocket(request: Request, env: Env, config: EdgeConfig): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_upgrade_required" }, 426, { Upgrade: "websocket" });
  }
  if (!browserOriginAllowed(request, config)) {
    return json({ error: "browser_origin_not_allowed" }, 403);
  }

  let ticket: string;
  try {
    ticket = routeTicketFromSubprotocol(request);
  } catch {
    return json({ error: "missing_or_invalid_route_protocol" }, 401);
  }

  let claims: RouteTicketClaims;
  try {
    claims = await verifyRouteTicketWithKeyring(ticket, config.routeTicketVerificationKeys, {
      maximumTtlSeconds: config.routeTicketTtlSeconds + 5,
      expectedAudience: config.routeTicketAudience,
      expectedIssuer: config.routeTicketIssuer,
      expectedEnvironment: config.environment,
    });
  } catch {
    return json({ error: "invalid_route_ticket" }, 401);
  }

  const objectId = env.FLOOR_INSTANCES.idFromName(floorObjectName(claims));
  const floor = env.FLOOR_INSTANCES.get(objectId, { locationHint: claims.locationHint });
  const forwarded = new Request("https://floor.internal/connect", request);
  forwarded.headers.set("X-GrokHack-Route-Ticket", ticket);
  forwarded.headers.set("Sec-WebSocket-Protocol", ROUTE_PROTOCOL);
  try {
    return await floor.fetch(forwarded);
  } catch (error) {
    const failure = durableObjectFailure(error);
    console.error(
      JSON.stringify({
        event: "floor_route_failed",
        floor: floorObjectName(claims),
        overloaded: failure.overloaded,
        retryable: failure.retryable,
        remote: failure.remote,
      }),
    );
    // Never retry an overloaded object here; the signed assignment must be rerouted.
    return json(
      {
        error: failure.overloaded ? "floor_overloaded" : "floor_unavailable",
        retryable: failure.retryable && !failure.overloaded,
        requiresFreshAssignment: failure.overloaded,
      },
      503,
      {
        "Retry-After": failure.overloaded ? "3" : "1",
      },
    );
  }
}

async function secretsEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < aa.length; index++) difference |= aa[index]! ^ bb[index]!;
  return difference === 0;
}

export async function routeShadowCatchup(request: Request, env: Env, config: EdgeConfig): Promise<Response> {
  if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405, { Allow: "POST" });
  const authorization = request.headers.get("Authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!(await secretsEqual(supplied, config.shadowIngestSecret))) return json({ code: "unauthorized" }, 401);
  let text: string;
  try { text = await readBoundedText(request, MAX_SHADOW_BATCH_BYTES); }
  catch (error) {
    if (error instanceof BoundedBodyError && error.code === "body_too_large") {
      return json({ code: "batch_too_large" }, 413);
    }
    return json({ code: error instanceof BoundedBodyError ? error.code : "body_read_failed" }, 400);
  }
  let candidate: unknown;
  try { candidate = JSON.parse(text); } catch { return json({ code: "malformed_json" }, 400); }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return json({ code: "invalid_batch" }, 400);
  const batch = candidate as { v?: unknown; route?: unknown; entries?: unknown; envelopes?: unknown; combatEnvelopes?: unknown };
  const hasEntries = Array.isArray(batch.entries);
  const hasEnvelopes = Array.isArray(batch.envelopes);
  const hasCombatEnvelopes = Array.isArray(batch.combatEnvelopes);
  if (batch.v !== 1 || Number(hasEntries) + Number(hasEnvelopes) + Number(hasCombatEnvelopes) !== 1 ||
      (hasEntries && batch.envelopes !== undefined) ||
      (hasEntries && batch.combatEnvelopes !== undefined) ||
      (hasEnvelopes && (batch.entries !== undefined || batch.combatEnvelopes !== undefined)) ||
      (hasCombatEnvelopes && (batch.entries !== undefined || batch.envelopes !== undefined))) {
    return json({ code: "invalid_batch" }, 400);
  }
  const rawRecords = hasCombatEnvelopes
    ? batch.combatEnvelopes as unknown[]
    : hasEnvelopes ? batch.envelopes as unknown[] : batch.entries as unknown[];
  if (rawRecords.length < 1) return json({ code: "invalid_batch" }, 400);
  if (rawRecords.length > MAX_SHADOW_BATCH_ENTRIES) {
    return json({ code: "shadow_backpressure", limit: MAX_SHADOW_BATCH_ENTRIES }, 429, { "Retry-After": "1" });
  }
  let route;
  let records;
  try {
    route = validateShadowRoute(batch.route);
    records = hasCombatEnvelopes
      ? rawRecords.map(validateCombatTurnEnvelopeV1)
      : hasEnvelopes ? rawRecords.map(validateMovementTurnEnvelope) : rawRecords.map(validateShadowJournalEntry);
  } catch (error) {
    return json({ code: error instanceof Error ? error.message : "invalid_batch", checkpoint: 0 }, 400);
  }
  if (records.some((record) => record.streamId !== records[0]!.streamId)) {
    return json({ code: "mixed_stream_batch", checkpoint: 0 }, 400);
  }
  const name = `shadow:v1:${floorObjectName(route)}:r${route.rulesetVersion}:s${records[0]!.streamId}`;
  const replay = env.SHADOW_REPLAYS.get(env.SHADOW_REPLAYS.idFromName(name));
  try {
    return await replay.fetch("https://shadow.internal/catch-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hasCombatEnvelopes
        ? { route, combatEnvelopes: records }
        : hasEnvelopes ? { route, envelopes: records } : { route, entries: records }),
    });
  } catch (error) {
    const failure = durableObjectFailure(error);
    const retryable = failure.retryable || failure.overloaded;
    console.error(JSON.stringify({
      event: "shadow_replay_route_failed",
      realmId: route.realmId,
      floorInstanceId: route.floorInstanceId,
      depth: route.depth,
      floorEpoch: route.floorEpoch,
      rulesetVersion: route.rulesetVersion,
      overloaded: failure.overloaded,
      retryable: failure.retryable,
      remote: failure.remote,
    }));
    return json(
      {
        code: failure.overloaded ? "shadow_replay_overloaded" : "shadow_replay_unavailable",
        retryable,
      },
      503,
      retryable ? { "Retry-After": failure.overloaded ? "3" : "1" } : undefined,
    );
  }
}

function controlStatus(result: AllocationResult | RetirementResult): number {
  if (result.ok) return "phase" in result && result.phase === "draining" ? 202 : 200;
  switch (result.code) {
    case "invalid_request":
      return 400;
    case "operation_reused":
    case "affinity_capacity_conflict":
    case "stale_floor_epoch":
      return 409;
    case "identity_mismatch":
    case "floor_slot_not_found":
      return 404;
    default:
      return 503;
  }
}

async function routeAllocationControl(
  request: Request,
  env: Env,
  config: EdgeConfig,
  path: "/internal/allocation/assign" | "/internal/allocation/retire",
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ code: "method_not_allowed" }, 405, { Allow: "POST" });
  }
  const url = new URL(request.url);
  if (url.search || url.hash) return json({ code: "invalid_request" }, 400);
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (contentType !== "application/json" && contentType !== "application/json; charset=utf-8") {
    return json({ code: "unsupported_media_type" }, 415);
  }
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = await readBoundedBytes(request, MAX_CONTROL_BODY_BYTES);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.code === "body_too_large") {
      return json({ code: "request_too_large" }, 413);
    }
    return json({ code: "body_read_failed" }, 400);
  }
  const authorized = await verifyControlSignature({
    method: request.method,
    path,
    timestamp: request.headers.get("X-GrokHack-Control-Timestamp"),
    keyId: request.headers.get("X-GrokHack-Control-Key-Id"),
    signature: request.headers.get("X-GrokHack-Control-Signature"),
    body: bodyBytes,
    environment: config.environment,
    keys: config.routeTicketVerificationKeys,
  });
  if (!authorized) return json({ code: "unauthorized" }, 401);

  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    return json({ code: "invalid_utf8" }, 400);
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(body);
  } catch {
    return json({ code: "malformed_json" }, 400);
  }
  try {
    let result: AllocationResult | RetirementResult;
    let bucket: number;
    if (path === "/internal/allocation/assign") {
      const allocation = parseAllocationRequest(candidate);
      bucket = directoryBucketFor(allocation, config.realmDirectoryBuckets);
      const name = realmDirectoryObjectName(
        config.environment,
        allocation,
        config.realmDirectoryBuckets,
        bucket,
      );
      result = await env.REALM_DIRECTORIES.getByName(name, {
        locationHint: allocation.locationHint,
      }).allocate({
        ...allocation,
        bucketCount: config.realmDirectoryBuckets,
        bucket,
      });
    } else {
      const retirement = parseRetirementRequest(candidate);
      bucket = retirement.bucket;
      const name = realmDirectoryObjectName(
        config.environment,
        retirement,
        retirement.bucketCount,
        bucket,
      );
      result = await env.REALM_DIRECTORIES.getByName(name, {
        locationHint: retirement.locationHint,
      }).retire(retirement);
    }
    console.log(
      JSON.stringify({
        event: path.endsWith("/assign") ? "floor_allocation_decision" : "floor_retirement_decision",
        ok: result.ok,
        bucket,
        ...(result.ok
          ? "phase" in result
            ? { phase: result.phase }
            : { decision: result.decision, probes: result.probes }
          : {
              code: result.code,
              retryable: result.retryable,
              requiresFreshAssignment: result.requiresFreshAssignment,
              overloaded: result.overloaded === true,
            }),
      }),
    );
    const status = controlStatus(result);
    return json(
      result,
      status,
      status === 202 || status === 503 ? { "Retry-After": "3" } : undefined,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AllocationProtocolError") {
      return json({ code: "invalid_request" }, 400);
    }
    const failure = durableObjectFailure(error);
    console.error(
      JSON.stringify({
        event: "realm_directory_route_failed",
        overloaded: failure.overloaded,
        retryable: failure.retryable,
        remote: failure.remote,
      }),
    );
    return json(
      {
        ok: false,
        code: failure.overloaded ? "directory_overloaded" : "directory_unavailable",
        retryable: failure.retryable && !failure.overloaded,
        overloaded: failure.overloaded,
        requiresFreshAssignment: true,
      },
      503,
      { "Retry-After": failure.overloaded ? "3" : "1" },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const config = readEdgeConfig(env);
    if (url.pathname === "/health") {
      return json({
        ok: true,
        ready: config.ok,
        service: "grokhack-edge-game",
        environment: env.EDGE_ENVIRONMENT,
        protocolVersion: EDGE_PROTOCOL_VERSION,
        architecture: "sharded-floor-durable-objects",
      });
    }
    if (url.pathname === "/ready") {
      return config.ok
        ? json({ ok: true, ready: true })
        : json({ ok: false, ready: false, errors: config.errors }, 503);
    }
    if (!config.ok) {
      console.error(JSON.stringify({ event: "edge_config_invalid", errors: config.errors }));
      return json({ error: "service_not_ready" }, 503, { "Retry-After": "10" });
    }
    if (url.pathname === "/ws") return routeWebSocket(request, env, config.value);
    if (url.pathname === "/internal/allocation/assign") {
      return routeAllocationControl(request, env, config.value, url.pathname);
    }
    if (url.pathname === "/internal/allocation/retire") {
      return routeAllocationControl(request, env, config.value, url.pathname);
    }
    if (url.pathname === "/internal/shadow/catch-up") return routeShadowCatchup(request, env, config.value);
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
