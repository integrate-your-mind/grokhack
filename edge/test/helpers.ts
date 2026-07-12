import { SELF } from "cloudflare:test";

import type { RouteTicketInput } from "../src/protocol";
import type { AuthorizeJoinRequest } from "../src/player-session";
import {
  floorObjectName,
  issueResumeProofGrant,
  issueRouteTicket,
  verifyRouteTicket,
  type RouteTicketClaims,
} from "../src/protocol";

export const TEST_ROUTE_TICKET_SECRET =
  "local-workers-runtime-test-key-2026-07-10-change-me";
export const TEST_PREVIOUS_ROUTE_TICKET_SECRET =
  "local-workers-runtime-previous-test-key-2026-07-10";

export function ticketInput(overrides: Partial<RouteTicketInput> = {}): RouteTicketInput {
  return {
    playerId: crypto.randomUUID(),
    playerName: "TestHero",
    audience: "grokhack-edge-game",
    issuer: "grokhack-session-control",
    environment: "test",
    keyId: "test-v1",
    realmId: `test-${crypto.randomUUID().slice(0, 8)}`,
    floorInstanceId: "primary",
    locationHint: "wnam",
    depth: 1,
    floorEpoch: 1,
    sessionEpoch: 1,
    authorityEpoch: 1,
    leaseId: crypto.randomUUID(),
    resumeProofHash: "a".repeat(64),
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    jti: crypto.randomUUID(),
    ...overrides,
  };
}

export async function authorityJoinRequest(
  input: RouteTicketInput,
  connectionId = crypto.randomUUID(),
): Promise<AuthorizeJoinRequest> {
  return {
    environment: input.environment,
    playerId: input.playerId,
    sessionEpoch: input.sessionEpoch,
    authorityEpoch: input.authorityEpoch,
    leaseId: input.leaseId,
    floorObjectName: floorObjectName(input),
    locationHint: input.locationHint,
    operationId: input.jti,
    connectionId,
    resumeProofGrant: await issueResumeProofGrant(input, TEST_ROUTE_TICKET_SECRET),
    keyId: input.keyId,
    expiresAt: input.expiresAt,
  };
}

export function testTicketClaims(
  ticket: string,
  input: RouteTicketInput,
): Promise<RouteTicketClaims> {
  return verifyRouteTicket(ticket, TEST_ROUTE_TICKET_SECRET, {
    nowSeconds: Math.floor(Date.now() / 1_000),
    maximumTtlSeconds: 65,
    expectedAudience: input.audience,
    expectedIssuer: input.issuer,
    expectedEnvironment: input.environment,
    expectedKeyId: input.keyId,
  });
}

export async function connect(
  input: RouteTicketInput,
): Promise<{ response: Response; socket?: WebSocket; ticket: string }> {
  const ticket = await issueRouteTicket(input, TEST_ROUTE_TICKET_SECRET);
  return connectWithTicket(ticket);
}

export async function connectWithTicket(
  ticket: string,
  origin?: string,
): Promise<{ response: Response; socket?: WebSocket; ticket: string }> {
  const headers = new Headers({
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": `grokhack.v4, grokhack.ticket.${ticket}`,
  });
  if (origin) headers.set("Origin", origin);
  const response = await SELF.fetch("https://edge.test/ws", {
    headers,
  });
  const socket = response.webSocket ?? undefined;
  socket?.accept();
  return { response, socket, ticket };
}

export function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), 2_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

export function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), 2_000);
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
  });
}

export async function join(socket: WebSocket, name: string): Promise<Record<string, unknown>> {
  const response = nextJson(socket);
  socket.send(JSON.stringify({ type: "join", name }));
  return response;
}
