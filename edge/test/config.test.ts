import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { browserOriginAllowed, readEdgeConfig } from "../src/config";
import type { Env } from "../src/env";

describe("edge configuration", () => {
  it("accepts the generated test binding contract", () => {
    const result = readEdgeConfig(env as Env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      environment: "test",
      floorSocketCap: 2,
      floorMessagesPerMinute: 5,
      floorMessageBurst: 10,
      floorEventsPerSecond: 10,
      floorEventBurst: 15,
      floorSessionTombstoneCap: 3,
      realmDirectoryBuckets: 8,
      realmDirectorySupportedBucketCounts: new Set([4, 8]),
      realmDirectoryFloorLimit: 4,
      realmDirectoryReservationSeconds: 65,
      realmDirectoryReceiptLimit: 64,
      routeTicketTtlSeconds: 60,
      routeTicketKeyId: "test-v1",
    });
  });

  it("fails closed for missing secrets, partial integers, and insecure production origins", () => {
    const broken = {
      ...(env as Env),
      PLAYER_SESSIONS: undefined,
      REALM_DIRECTORIES: undefined,
      SHADOW_REPLAYS: undefined,
      EDGE_ENVIRONMENT: "production",
      FLOOR_SOCKET_CAP: "2players",
      ROUTE_TICKET_SECRET: "short",
      ALLOWED_BROWSER_ORIGINS: "http://grokhack.mondello.dev",
    } as unknown as Env;
    const result = readEdgeConfig(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/FLOOR_SOCKET_CAP/);
    expect(result.errors.join("\n")).toMatch(/PLAYER_SESSIONS/);
    expect(result.errors.join("\n")).toMatch(/REALM_DIRECTORIES/);
    expect(result.errors.join("\n")).toMatch(/SHADOW_REPLAYS/);
    expect(result.errors.join("\n")).toMatch(/ROUTE_TICKET_SECRET/);
    expect(result.errors.join("\n")).toMatch(/ALLOWED_BROWSER_ORIGINS/);
  });

  it("rejects an unknown environment before it can weaken origin transport rules", () => {
    const result = readEdgeConfig({
      ...(env as Env),
      EDGE_ENVIRONMENT: "preview-typo",
      ALLOWED_BROWSER_ORIGINS: "http://insecure.example",
    } as unknown as Env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/EDGE_ENVIRONMENT/);
  });

  it("requires an explicit power-of-two support window that includes the active layout", () => {
    const result = readEdgeConfig({
      ...(env as Env),
      REALM_DIRECTORY_SUPPORTED_BUCKET_COUNTS: "3,4",
    } as unknown as Env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/only powers of two/);
    expect(result.errors.join("\n")).toMatch(/must include REALM_DIRECTORY_BUCKETS/);
  });

  it("allows only configured browser origins while preserving non-browser clients", () => {
    const result = readEdgeConfig(env as Env);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(browserOriginAllowed(new Request("https://edge.test/ws"), result.value)).toBe(true);
    expect(
      browserOriginAllowed(
        new Request("https://edge.test/ws", { headers: { Origin: "https://edge.test" } }),
        result.value,
      ),
    ).toBe(true);
    expect(
      browserOriginAllowed(
        new Request("https://edge.test/ws", { headers: { Origin: "https://evil.example" } }),
        result.value,
      ),
    ).toBe(false);
  });
});
