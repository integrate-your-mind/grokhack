export const EDGE_PROTOCOL_VERSION = 4 as const;
export const MAX_INBOUND_FRAME_BYTES = 8_192;
export const MAX_ROUTE_TICKET_BYTES = 4_096;
export const DEDUPE_WINDOW_PER_SESSION = 256;
export const MAX_GAME_DEPTH = 15;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYER_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;
const REALM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const FLOOR_INSTANCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const TOKEN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{3,64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const RESUME_PROOF_GRANT_RE = /^[A-Za-z0-9_-]{32,2048}$/;
const RESUME_PROOF_GRANT_DOMAIN = "grokhack-resume-proof-grant:v1";
const LOCATION_HINTS = new Set<DurableObjectLocationHint>([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
]);

export interface RouteTicketClaims {
  v: typeof EDGE_PROTOCOL_VERSION;
  playerId: string;
  playerName: string;
  aud: string;
  iss: string;
  environment: string;
  kid: string;
  realmId: string;
  floorInstanceId: string;
  locationHint: DurableObjectLocationHint;
  depth: number;
  floorEpoch: number;
  allocationReservationId?: string;
  sessionEpoch: number;
  authorityEpoch: number;
  leaseId: string;
  resumeProofGrant: string;
  exp: number;
  jti: string;
}

export interface RouteTicketInput {
  playerId: string;
  playerName: string;
  audience: string;
  issuer: string;
  environment: string;
  keyId: string;
  realmId: string;
  floorInstanceId: string;
  locationHint: DurableObjectLocationHint;
  depth: number;
  floorEpoch: number;
  allocationReservationId?: string;
  sessionEpoch: number;
  authorityEpoch: number;
  leaseId: string;
  resumeProofHash: string;
  expiresAt: number;
  jti: string;
}

export interface RouteTicketVerificationPolicy {
  nowSeconds?: number;
  maximumTtlSeconds: number;
  expectedAudience: string;
  expectedIssuer: string;
  expectedEnvironment: string;
  expectedKeyId: string;
}

export interface RouteTicketVerificationKey {
  keyId: string;
  secret: string;
}

interface ResumeProofGrantClaims {
  v: 1;
  resumeProofHash: string;
  playerId: string;
  sessionEpoch: number;
  authorityEpoch: number;
  leaseId: string;
  floorObjectName: string;
  keyId: string;
  jti: string;
  expiresAt: number;
}

export type RouteTicketKeyringPolicy = Omit<RouteTicketVerificationPolicy, "expectedKeyId">;

export class RouteTicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteTicketError";
  }
}

function assertSigningSecret(secret: string): void {
  if (encoder.encode(secret).byteLength < 32) {
    throw new RouteTicketError("Route ticket secret must contain at least 32 UTF-8 bytes");
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function resumeProofEncryptionKey(secret: string): Promise<CryptoKey> {
  assertSigningSecret(secret);
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${RESUME_PROOF_GRANT_DOMAIN}\0${secret}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function issueResumeProofGrant(
  input: RouteTicketInput,
  secret: string,
): Promise<string> {
  if (!isSha256Hex(input.resumeProofHash)) {
    throw new RouteTicketError("Invalid resume proof hash");
  }
  const claims: ResumeProofGrantClaims = {
    v: 1,
    resumeProofHash: input.resumeProofHash,
    playerId: input.playerId.toLowerCase(),
    sessionEpoch: input.sessionEpoch,
    authorityEpoch: input.authorityEpoch,
    leaseId: input.leaseId.toLowerCase(),
    floorObjectName: floorObjectName(input),
    keyId: input.keyId,
    jti: input.jti,
    expiresAt: input.expiresAt,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await resumeProofEncryptionKey(secret);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(RESUME_PROOF_GRANT_DOMAIN) },
      key,
      encoder.encode(JSON.stringify(claims)),
    ),
  );
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv);
  combined.set(ciphertext, iv.byteLength);
  return encodeBase64Url(combined);
}

export async function openResumeProofGrant(
  grant: string,
  secret: string,
  expected: {
    playerId: string;
    sessionEpoch: number;
    authorityEpoch: number;
    leaseId: string;
    floorObjectName: string;
    keyId: string;
    jti: string;
    expiresAt: number;
  },
): Promise<string> {
  if (!isResumeProofGrant(grant)) throw new RouteTicketError("Invalid resume proof grant");
  const combined = decodeBase64Url(grant);
  if (combined.byteLength <= 28) throw new RouteTicketError("Invalid resume proof grant");
  const key = await resumeProofEncryptionKey(secret);
  let candidate: unknown;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: combined.slice(0, 12),
        additionalData: encoder.encode(RESUME_PROOF_GRANT_DOMAIN),
      },
      key,
      combined.slice(12),
    );
    candidate = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new RouteTicketError("Invalid resume proof grant");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new RouteTicketError("Invalid resume proof grant");
  }
  const claims = candidate as Partial<ResumeProofGrantClaims>;
  if (
    claims.v !== 1 ||
    !isSha256Hex(claims.resumeProofHash) ||
    claims.playerId !== expected.playerId.toLowerCase() ||
    claims.sessionEpoch !== expected.sessionEpoch ||
    claims.authorityEpoch !== expected.authorityEpoch ||
    claims.leaseId !== expected.leaseId.toLowerCase() ||
    claims.floorObjectName !== expected.floorObjectName ||
    claims.keyId !== expected.keyId ||
    claims.jti !== expected.jti ||
    claims.expiresAt !== expected.expiresAt
  ) {
    throw new RouteTicketError("Invalid resume proof grant");
  }
  return claims.resumeProofHash;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new RouteTicketError("Malformed route ticket");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  } catch {
    throw new RouteTicketError("Malformed route ticket");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importSigningKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  assertSigningSecret(secret);
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function validateClaims(
  candidate: unknown,
  policy: Required<RouteTicketVerificationPolicy>,
): RouteTicketClaims {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new RouteTicketError("Malformed route ticket claims");
  }
  const claims = candidate as Record<string, unknown>;
  if (claims.v !== EDGE_PROTOCOL_VERSION) throw new RouteTicketError("Unsupported protocol version");
  if (claims.aud !== policy.expectedAudience) throw new RouteTicketError("Invalid route ticket audience");
  if (claims.iss !== policy.expectedIssuer) throw new RouteTicketError("Invalid route ticket issuer");
  if (claims.environment !== policy.expectedEnvironment) {
    throw new RouteTicketError("Route ticket environment mismatch");
  }
  if (claims.kid !== policy.expectedKeyId || typeof claims.kid !== "string" || !KEY_ID_RE.test(claims.kid)) {
    throw new RouteTicketError("Invalid route ticket key identifier");
  }
  if (typeof claims.playerId !== "string" || !UUID_RE.test(claims.playerId)) {
    throw new RouteTicketError("Invalid player identity");
  }
  if (typeof claims.playerName !== "string" || !PLAYER_NAME_RE.test(claims.playerName)) {
    throw new RouteTicketError("Invalid player name");
  }
  if (typeof claims.realmId !== "string" || !REALM_ID_RE.test(claims.realmId)) {
    throw new RouteTicketError("Invalid realm identifier");
  }
  if (
    typeof claims.floorInstanceId !== "string" ||
    !FLOOR_INSTANCE_ID_RE.test(claims.floorInstanceId)
  ) {
    throw new RouteTicketError("Invalid floor instance identifier");
  }
  if (typeof claims.locationHint !== "string" || !LOCATION_HINTS.has(claims.locationHint as DurableObjectLocationHint)) {
    throw new RouteTicketError("Invalid Durable Object location hint");
  }
  if (!isSafeIntegerInRange(claims.depth, 1, MAX_GAME_DEPTH)) {
    throw new RouteTicketError("Invalid floor depth");
  }
  if (!isSafeIntegerInRange(claims.floorEpoch, 1, Number.MAX_SAFE_INTEGER)) {
    throw new RouteTicketError("Invalid floor epoch");
  }
  if (
    claims.allocationReservationId !== undefined &&
    (typeof claims.allocationReservationId !== "string" ||
      !UUID_RE.test(claims.allocationReservationId))
  ) {
    throw new RouteTicketError("Invalid allocation reservation identifier");
  }
  if (!isSafeIntegerInRange(claims.sessionEpoch, 1, Number.MAX_SAFE_INTEGER)) {
    throw new RouteTicketError("Invalid session epoch");
  }
  if (!isSafeIntegerInRange(claims.authorityEpoch, 1, Number.MAX_SAFE_INTEGER)) {
    throw new RouteTicketError("Invalid authority epoch");
  }
  if (typeof claims.leaseId !== "string" || !UUID_RE.test(claims.leaseId)) {
    throw new RouteTicketError("Invalid authority lease");
  }
  if (!isResumeProofGrant(claims.resumeProofGrant)) {
    throw new RouteTicketError("Invalid resume proof grant");
  }
  if (!isSafeIntegerInRange(claims.exp, 1, Number.MAX_SAFE_INTEGER)) {
    throw new RouteTicketError("Invalid route ticket expiry");
  }
  if (claims.exp <= policy.nowSeconds) throw new RouteTicketError("Route ticket expired");
  if (claims.exp > policy.nowSeconds + policy.maximumTtlSeconds) {
    throw new RouteTicketError("Route ticket lifetime exceeds policy");
  }
  if (typeof claims.jti !== "string" || !TOKEN_ID_RE.test(claims.jti)) {
    throw new RouteTicketError("Invalid route ticket identifier");
  }

  return {
    ...(claims as unknown as RouteTicketClaims),
    playerId: String(claims.playerId).toLowerCase(),
    leaseId: String(claims.leaseId).toLowerCase(),
    ...(claims.allocationReservationId === undefined
      ? {}
      : { allocationReservationId: String(claims.allocationReservationId).toLowerCase() }),
  };
}

export async function issueRouteTicket(input: RouteTicketInput, secret: string): Promise<string> {
  const resumeProofGrant = await issueResumeProofGrant(input, secret);
  const claims: RouteTicketClaims = {
    v: EDGE_PROTOCOL_VERSION,
    playerId: input.playerId.toLowerCase(),
    playerName: input.playerName,
    aud: input.audience,
    iss: input.issuer,
    environment: input.environment,
    kid: input.keyId,
    realmId: input.realmId,
    floorInstanceId: input.floorInstanceId,
    locationHint: input.locationHint,
    depth: input.depth,
    floorEpoch: input.floorEpoch,
    ...(input.allocationReservationId === undefined
      ? {}
      : { allocationReservationId: input.allocationReservationId.toLowerCase() }),
    sessionEpoch: input.sessionEpoch,
    authorityEpoch: input.authorityEpoch,
    leaseId: input.leaseId.toLowerCase(),
    resumeProofGrant,
    exp: input.expiresAt,
    jti: input.jti,
  };
  validateClaims(claims, {
    nowSeconds: Math.min(input.expiresAt, Math.floor(Date.now() / 1_000)),
    maximumTtlSeconds: Number.MAX_SAFE_INTEGER,
    expectedAudience: input.audience,
    expectedIssuer: input.issuer,
    expectedEnvironment: input.environment,
    expectedKeyId: input.keyId,
  });

  const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const key = await importSigningKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyRouteTicket(
  ticket: string,
  secret: string,
  policy: RouteTicketVerificationPolicy,
): Promise<RouteTicketClaims> {
  if (ticket.length > MAX_ROUTE_TICKET_BYTES) {
    throw new RouteTicketError("Route ticket is too large");
  }
  const segments = ticket.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new RouteTicketError("Malformed route ticket");
  }

  const [payload, encodedSignature] = segments;
  const key = await importSigningKey(secret, "verify");
  const signature = decodeBase64Url(encodedSignature);
  const verified = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(payload));
  if (!verified) throw new RouteTicketError("Invalid route ticket signature");

  let candidate: unknown;
  try {
    candidate = JSON.parse(decoder.decode(decodeBase64Url(payload)));
  } catch (error) {
    if (error instanceof RouteTicketError) throw error;
    throw new RouteTicketError("Malformed route ticket claims");
  }
  return validateClaims(candidate, {
    ...policy,
    nowSeconds: policy.nowSeconds ?? Math.floor(Date.now() / 1_000),
  });
}

/**
 * Select a bounded verification key by the untrusted `kid`, then perform the
 * ordinary signature and claim validation. The decoded key id is never trusted
 * for routing and unknown keys fail closed.
 */
export async function verifyRouteTicketWithKeyring(
  ticket: string,
  keys: readonly RouteTicketVerificationKey[],
  policy: RouteTicketKeyringPolicy,
): Promise<RouteTicketClaims> {
  if (ticket.length > MAX_ROUTE_TICKET_BYTES) {
    throw new RouteTicketError("Route ticket is too large");
  }
  const segments = ticket.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new RouteTicketError("Malformed route ticket");
  }

  let keyId: unknown;
  try {
    const candidate = JSON.parse(decoder.decode(decodeBase64Url(segments[0]))) as unknown;
    keyId =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>).kid
        : undefined;
  } catch (error) {
    if (error instanceof RouteTicketError) throw error;
    throw new RouteTicketError("Malformed route ticket claims");
  }
  if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) {
    throw new RouteTicketError("Invalid route ticket key identifier");
  }
  const selected = keys.find((key) => key.keyId === keyId);
  if (!selected) throw new RouteTicketError("Unknown route ticket key identifier");
  return verifyRouteTicket(ticket, selected.secret, { ...policy, expectedKeyId: selected.keyId });
}

export function floorObjectName(
  claims: Pick<RouteTicketClaims, "realmId" | "floorInstanceId" | "depth" | "floorEpoch">,
): string {
  return `floor:v1:${claims.realmId}:i${claims.floorInstanceId}:d${claims.depth}:e${claims.floorEpoch}`;
}

export function playerSessionObjectName(environment: string, playerId: string): string {
  return `player-session:v1:${environment}:${playerId.toLowerCase()}`;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isTokenId(value: unknown): value is string {
  return typeof value === "string" && TOKEN_ID_RE.test(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

export function isResumeProofGrant(value: unknown): value is string {
  return typeof value === "string" && RESUME_PROOF_GRANT_RE.test(value);
}
