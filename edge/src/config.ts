import type { Env } from "./env";
import { isPowerOfTwo } from "./allocation-protocol";
import type { RouteTicketVerificationKey } from "./protocol";

export interface EdgeConfig {
  environment: string;
  floorSocketCap: number;
  floorMessagesPerMinute: number;
  floorMessageBurst: number;
  floorEventsPerSecond: number;
  floorEventBurst: number;
  floorSessionTombstoneCap: number;
  floorReplayGraceSeconds: number;
  realmDirectoryBuckets: number;
  realmDirectorySupportedBucketCounts: ReadonlySet<number>;
  realmDirectoryFloorLimit: number;
  realmDirectoryReservationSeconds: number;
  realmDirectoryReceiptLimit: number;
  routeTicketTtlSeconds: number;
  routeTicketAudience: string;
  routeTicketIssuer: string;
  routeTicketKeyId: string;
  routeTicketSecret: string;
  shadowIngestSecret: string;
  routeTicketVerificationKeys: readonly RouteTicketVerificationKey[];
  allowedBrowserOrigins: ReadonlySet<string>;
}

export type EdgeConfigResult =
  | { ok: true; value: EdgeConfig }
  | { ok: false; errors: string[] };

export class EdgeConfigError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid edge configuration: ${errors.join(", ")}`);
    this.name = "EdgeConfigError";
    this.errors = errors;
  }
}

function strictInteger(
  name: string,
  raw: unknown,
  minimum: number,
  maximum: number,
  errors: string[],
): number {
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    errors.push(`${name} must be a base-10 integer`);
    return minimum;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${name} must be between ${minimum} and ${maximum}`);
    return minimum;
  }
  return parsed;
}

function requiredToken(name: string, raw: unknown, errors: string[]): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9._:-]{3,128}$/u.test(raw)) {
    errors.push(`${name} is missing or invalid`);
    return "invalid";
  }
  return raw;
}

function parseOrigins(raw: unknown, environment: string, errors: string[]): ReadonlySet<string> {
  if (typeof raw !== "string" || !raw.trim()) {
    errors.push("ALLOWED_BROWSER_ORIGINS is missing");
    return new Set();
  }
  const origins = new Set<string>();
  for (const entry of raw.split(",")) {
    const candidate = entry.trim();
    try {
      const url = new URL(candidate);
      if (url.origin !== candidate || url.username || url.password) throw new Error("not an origin");
      if (
        (environment === "production" || environment === "staging") &&
        url.protocol !== "https:"
      ) {
        throw new Error("secure origin required");
      }
      origins.add(candidate);
    } catch {
      errors.push(`ALLOWED_BROWSER_ORIGINS contains invalid origin: ${candidate || "<empty>"}`);
    }
  }
  return origins;
}

function parseBucketCounts(raw: unknown, errors: string[]): ReadonlySet<number> {
  if (typeof raw !== "string" || !raw) {
    errors.push("REALM_DIRECTORY_SUPPORTED_BUCKET_COUNTS is missing");
    return new Set();
  }
  const counts = new Set<number>();
  for (const entry of raw.split(",")) {
    if (!/^[1-9][0-9]{0,3}$/u.test(entry)) {
      errors.push("REALM_DIRECTORY_SUPPORTED_BUCKET_COUNTS contains an invalid integer");
      continue;
    }
    const count = Number(entry);
    if (!isPowerOfTwo(count)) {
      errors.push("REALM_DIRECTORY_SUPPORTED_BUCKET_COUNTS must contain only powers of two");
      continue;
    }
    counts.add(count);
  }
  return counts;
}

export function readEdgeConfig(env: Env): EdgeConfigResult {
  const errors: string[] = [];
  if (
    !env.FLOOR_INSTANCES ||
    typeof env.FLOOR_INSTANCES.idFromName !== "function" ||
    typeof env.FLOOR_INSTANCES.get !== "function"
  ) {
    errors.push("FLOOR_INSTANCES binding is missing or invalid");
  }
  if (
    !env.PLAYER_SESSIONS ||
    typeof env.PLAYER_SESSIONS.getByName !== "function"
  ) {
    errors.push("PLAYER_SESSIONS binding is missing or invalid");
  }
  if (
    !env.REALM_DIRECTORIES ||
    typeof env.REALM_DIRECTORIES.getByName !== "function"
  ) {
    errors.push("REALM_DIRECTORIES binding is missing or invalid");
  }
  const environment = requiredToken("EDGE_ENVIRONMENT", env.EDGE_ENVIRONMENT, errors);
  const floorSocketCap = strictInteger("FLOOR_SOCKET_CAP", env.FLOOR_SOCKET_CAP, 1, 500, errors);
  const floorMessagesPerMinute = strictInteger(
    "FLOOR_MESSAGES_PER_MINUTE",
    env.FLOOR_MESSAGES_PER_MINUTE,
    1,
    60_000,
    errors,
  );
  const floorMessageBurst = strictInteger(
    "FLOOR_MESSAGE_BURST",
    env.FLOOR_MESSAGE_BURST,
    1,
    1_000,
    errors,
  );
  const floorEventsPerSecond = strictInteger(
    "FLOOR_EVENTS_PER_SECOND",
    env.FLOOR_EVENTS_PER_SECOND,
    1,
    10_000,
    errors,
  );
  const floorEventBurst = strictInteger(
    "FLOOR_EVENT_BURST",
    env.FLOOR_EVENT_BURST,
    1,
    20_000,
    errors,
  );
  if (floorEventBurst < floorEventsPerSecond) {
    errors.push("FLOOR_EVENT_BURST must be greater than or equal to FLOOR_EVENTS_PER_SECOND");
  }
  const floorSessionTombstoneCap = strictInteger(
    "FLOOR_SESSION_TOMBSTONE_CAP",
    env.FLOOR_SESSION_TOMBSTONE_CAP,
    1,
    1_000_000,
    errors,
  );
  if (floorSessionTombstoneCap < floorSocketCap) {
    errors.push("FLOOR_SESSION_TOMBSTONE_CAP must be greater than or equal to FLOOR_SOCKET_CAP");
  }
  const floorReplayGraceSeconds = strictInteger(
    "FLOOR_REPLAY_GRACE_SECONDS",
    env.FLOOR_REPLAY_GRACE_SECONDS,
    30,
    86_400,
    errors,
  );
  const realmDirectoryBuckets = strictInteger(
    "REALM_DIRECTORY_BUCKETS",
    env.REALM_DIRECTORY_BUCKETS,
    1,
    4_096,
    errors,
  );
  if (!isPowerOfTwo(realmDirectoryBuckets)) {
    errors.push("REALM_DIRECTORY_BUCKETS must be a power of two");
  }
  const realmDirectorySupportedBucketCounts = parseBucketCounts(
    env.REALM_DIRECTORY_SUPPORTED_BUCKET_COUNTS,
    errors,
  );
  if (!realmDirectorySupportedBucketCounts.has(realmDirectoryBuckets)) {
    errors.push("REALM_DIRECTORY_SUPPORTED_BUCKET_COUNTS must include REALM_DIRECTORY_BUCKETS");
  }
  const realmDirectoryFloorLimit = strictInteger(
    "REALM_DIRECTORY_FLOOR_LIMIT",
    env.REALM_DIRECTORY_FLOOR_LIMIT,
    1,
    4_096,
    errors,
  );
  const realmDirectoryReservationSeconds = strictInteger(
    "REALM_DIRECTORY_RESERVATION_SECONDS",
    env.REALM_DIRECTORY_RESERVATION_SECONDS,
    15,
    600,
    errors,
  );
  const realmDirectoryReceiptLimit = strictInteger(
    "REALM_DIRECTORY_RECEIPT_LIMIT",
    env.REALM_DIRECTORY_RECEIPT_LIMIT,
    16,
    1_000_000,
    errors,
  );
  const routeTicketTtlSeconds = strictInteger(
    "ROUTE_TICKET_TTL_SECONDS",
    env.ROUTE_TICKET_TTL_SECONDS,
    10,
    300,
    errors,
  );
  if (realmDirectoryReservationSeconds < routeTicketTtlSeconds + 5) {
    errors.push(
      "REALM_DIRECTORY_RESERVATION_SECONDS must be at least ROUTE_TICKET_TTL_SECONDS plus 5",
    );
  }
  const routeTicketAudience = requiredToken(
    "ROUTE_TICKET_AUDIENCE",
    env.ROUTE_TICKET_AUDIENCE,
    errors,
  );
  const routeTicketIssuer = requiredToken("ROUTE_TICKET_ISSUER", env.ROUTE_TICKET_ISSUER, errors);
  const routeTicketKeyId = requiredToken("ROUTE_TICKET_KEY_ID", env.ROUTE_TICKET_KEY_ID, errors);
  const routeTicketPreviousKeyId = requiredToken(
    "ROUTE_TICKET_PREVIOUS_KEY_ID",
    env.ROUTE_TICKET_PREVIOUS_KEY_ID,
    errors,
  );
  const routeTicketSecret = typeof env.ROUTE_TICKET_SECRET === "string" ? env.ROUTE_TICKET_SECRET : "";
  if (new TextEncoder().encode(routeTicketSecret).byteLength < 32) {
    errors.push("ROUTE_TICKET_SECRET must contain at least 32 UTF-8 bytes");
  }
  const routeTicketPreviousSecret =
    typeof env.ROUTE_TICKET_PREVIOUS_SECRET === "string" ? env.ROUTE_TICKET_PREVIOUS_SECRET : "";
  if (new TextEncoder().encode(routeTicketPreviousSecret).byteLength < 32) {
    errors.push("ROUTE_TICKET_PREVIOUS_SECRET must contain at least 32 UTF-8 bytes");
  }
  if (routeTicketPreviousKeyId === routeTicketKeyId) {
    errors.push("ROUTE_TICKET_PREVIOUS_KEY_ID must differ from ROUTE_TICKET_KEY_ID");
  }
  if (routeTicketPreviousSecret === routeTicketSecret) {
    errors.push("ROUTE_TICKET_PREVIOUS_SECRET must differ from ROUTE_TICKET_SECRET");
  }
  const shadowIngestSecret = typeof env.SHADOW_INGEST_SECRET === "string" ? env.SHADOW_INGEST_SECRET : "";
  if (new TextEncoder().encode(shadowIngestSecret).byteLength < 32) {
    errors.push("SHADOW_INGEST_SECRET must contain at least 32 UTF-8 bytes");
  }
  const allowedBrowserOrigins = parseOrigins(env.ALLOWED_BROWSER_ORIGINS, environment, errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      environment,
      floorSocketCap,
      floorMessagesPerMinute,
      floorMessageBurst,
      floorEventsPerSecond,
      floorEventBurst,
      floorSessionTombstoneCap,
      floorReplayGraceSeconds,
      realmDirectoryBuckets,
      realmDirectorySupportedBucketCounts,
      realmDirectoryFloorLimit,
      realmDirectoryReservationSeconds,
      realmDirectoryReceiptLimit,
      routeTicketTtlSeconds,
      routeTicketAudience,
      routeTicketIssuer,
      routeTicketKeyId,
      routeTicketSecret,
      shadowIngestSecret,
      routeTicketVerificationKeys: [
        { keyId: routeTicketKeyId, secret: routeTicketSecret },
        { keyId: routeTicketPreviousKeyId, secret: routeTicketPreviousSecret },
      ],
      allowedBrowserOrigins,
    },
  };
}

export function requireEdgeConfig(env: Env): EdgeConfig {
  const result = readEdgeConfig(env);
  if (!result.ok) throw new EdgeConfigError(result.errors);
  return result.value;
}

export function browserOriginAllowed(request: Request, config: EdgeConfig): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || config.allowedBrowserOrigins.has(origin);
}
