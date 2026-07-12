import { describe, expect, it } from "vitest";

import {
  RouteTicketError,
  MAX_GAME_DEPTH,
  floorObjectName,
  openResumeProofGrant,
  issueRouteTicket,
  verifyRouteTicket,
  verifyRouteTicketWithKeyring,
} from "../src/protocol";
import {
  TEST_PREVIOUS_ROUTE_TICKET_SECRET,
  TEST_ROUTE_TICKET_SECRET,
  ticketInput,
} from "./helpers";

describe("route ticket protocol", () => {
  function policy(nowSeconds: number) {
    return {
      nowSeconds,
      maximumTtlSeconds: 65,
      expectedAudience: "grokhack-edge-game",
      expectedIssuer: "grokhack-session-control",
      expectedEnvironment: "test",
      expectedKeyId: "test-v1",
    };
  }

  it("round-trips a bounded, signed routing claim", async () => {
    const now = 2_000_000_000;
    const input = ticketInput({
      realmId: "wnam-42",
      depth: 7,
      floorEpoch: 19,
      sessionEpoch: 4,
      expiresAt: now + 60,
    });
    const ticket = await issueRouteTicket(input, TEST_ROUTE_TICKET_SECRET);
    const claims = await verifyRouteTicket(ticket, TEST_ROUTE_TICKET_SECRET, policy(now));

    expect(claims).toMatchObject({
      playerId: input.playerId,
      playerName: input.playerName,
      aud: "grokhack-edge-game",
      iss: "grokhack-session-control",
      environment: "test",
      kid: "test-v1",
      realmId: "wnam-42",
      floorInstanceId: "primary",
      locationHint: "wnam",
      depth: 7,
      floorEpoch: 19,
      sessionEpoch: 4,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      resumeProofGrant: expect.stringMatching(/^[A-Za-z0-9_-]{32,2048}$/),
      exp: now + 60,
    });
    expect(floorObjectName(claims)).toBe("floor:v1:wnam-42:iprimary:d7:e19");
    await expect(
      openResumeProofGrant(claims.resumeProofGrant, TEST_ROUTE_TICKET_SECRET, {
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: floorObjectName(input),
        keyId: input.keyId,
        jti: input.jti,
        expiresAt: input.expiresAt,
      }),
    ).resolves.toBe(input.resumeProofHash);
    expect(JSON.stringify(claims)).not.toContain(input.resumeProofHash);
  });

  it("canonicalizes signed UUID identities before any shard or session lookup", async () => {
    const now = 2_000_000_000;
    const input = ticketInput({
      playerId: "A0B1C2D3-E4F5-4A67-8B90-A1B2C3D4E5F6",
      leaseId: "F0E1D2C3-B4A5-4987-8A10-F1E2D3C4B5A6",
      allocationReservationId: "B0C1D2E3-F4A5-4678-9B01-B2C3D4E5F6A7",
      expiresAt: now + 60,
    });
    const ticket = await issueRouteTicket(input, TEST_ROUTE_TICKET_SECRET);
    const claims = await verifyRouteTicket(ticket, TEST_ROUTE_TICKET_SECRET, policy(now));

    expect(claims.playerId).toBe(input.playerId.toLowerCase());
    expect(claims.leaseId).toBe(input.leaseId.toLowerCase());
    expect(claims.allocationReservationId).toBe(input.allocationReservationId!.toLowerCase());
    await expect(
      openResumeProofGrant(claims.resumeProofGrant, TEST_ROUTE_TICKET_SECRET, {
        playerId: claims.playerId,
        sessionEpoch: claims.sessionEpoch,
        authorityEpoch: claims.authorityEpoch,
        leaseId: claims.leaseId,
        floorObjectName: floorObjectName(claims),
        keyId: claims.kid,
        jti: claims.jti,
        expiresAt: claims.exp,
      }),
    ).resolves.toBe(input.resumeProofHash);
  });

  it("rejects tampered or context-replayed opaque proof grants", async () => {
    const now = 2_000_000_000;
    const input = ticketInput({ expiresAt: now + 60 });
    const ticket = await issueRouteTicket(input, TEST_ROUTE_TICKET_SECRET);
    const claims = await verifyRouteTicket(ticket, TEST_ROUTE_TICKET_SECRET, policy(now));
    const expected = {
      playerId: claims.playerId,
      sessionEpoch: claims.sessionEpoch,
      authorityEpoch: claims.authorityEpoch,
      leaseId: claims.leaseId,
      floorObjectName: floorObjectName(claims),
      keyId: claims.kid,
      jti: claims.jti,
      expiresAt: claims.exp,
    };
    const tampered = `${claims.resumeProofGrant[0] === "A" ? "B" : "A"}${claims.resumeProofGrant.slice(1)}`;

    await expect(
      openResumeProofGrant(tampered, TEST_ROUTE_TICKET_SECRET, expected),
    ).rejects.toThrow("Invalid resume proof grant");
    await expect(
      openResumeProofGrant(claims.resumeProofGrant, TEST_ROUTE_TICKET_SECRET, {
        ...expected,
        playerId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Invalid resume proof grant");
  });

  it("rejects tampering, expiry, excessive lifetime, and weak secrets", async () => {
    const now = 2_000_000_000;
    const input = ticketInput({ expiresAt: now + 60 });
    const ticket = await issueRouteTicket(input, TEST_ROUTE_TICKET_SECRET);
    const [payload, signature] = ticket.split(".");
    const tampered = `${payload?.slice(0, -1)}A.${signature}`;

    await expect(
      verifyRouteTicket(tampered, TEST_ROUTE_TICKET_SECRET, policy(now)),
    ).rejects.toBeInstanceOf(RouteTicketError);
    await expect(
      verifyRouteTicket(ticket, TEST_ROUTE_TICKET_SECRET, policy(now + 60)),
    ).rejects.toThrow("expired");
    await expect(
      verifyRouteTicket(ticket, TEST_ROUTE_TICKET_SECRET, policy(now - 10)),
    ).rejects.toThrow("lifetime");
    await expect(issueRouteTicket(input, "too-short")).rejects.toThrow("at least 32");
  });

  it("binds audience, issuer, environment, and signing key identity", async () => {
    const now = 2_000_000_000;
    const input = ticketInput({ expiresAt: now + 60 });
    const ticket = await issueRouteTicket(input, TEST_ROUTE_TICKET_SECRET);

    for (const override of [
      { expectedAudience: "other-audience" },
      { expectedIssuer: "other-issuer" },
      { expectedEnvironment: "production" },
      { expectedKeyId: "rotated-v2" },
    ]) {
      await expect(
        verifyRouteTicket(ticket, TEST_ROUTE_TICKET_SECRET, { ...policy(now), ...override }),
      ).rejects.toBeInstanceOf(RouteTicketError);
    }
  });

  it("accepts an active and previous key during bounded overlap", async () => {
    const now = 2_000_000_000;
    const active = await issueRouteTicket(
      ticketInput({ keyId: "test-v1", expiresAt: now + 60 }),
      TEST_ROUTE_TICKET_SECRET,
    );
    const previous = await issueRouteTicket(
      ticketInput({ keyId: "test-v0", expiresAt: now + 60 }),
      TEST_PREVIOUS_ROUTE_TICKET_SECRET,
    );
    const keys = [
      { keyId: "test-v1", secret: TEST_ROUTE_TICKET_SECRET },
      { keyId: "test-v0", secret: TEST_PREVIOUS_ROUTE_TICKET_SECRET },
    ];
    const { expectedKeyId: _expectedKeyId, ...keyringPolicy } = policy(now);

    await expect(verifyRouteTicketWithKeyring(active, keys, keyringPolicy)).resolves.toMatchObject({
      kid: "test-v1",
    });
    await expect(
      verifyRouteTicketWithKeyring(previous, keys, keyringPolicy),
    ).resolves.toMatchObject({ kid: "test-v0" });

    const unknown = await issueRouteTicket(
      ticketInput({ keyId: "test-v2", expiresAt: now + 60 }),
      "unknown-route-ticket-key-that-is-still-long-enough",
    );
    await expect(verifyRouteTicketWithKeyring(unknown, keys, keyringPolicy)).rejects.toThrow(
      "Unknown",
    );
  });

  it("rejects identities that cannot be safely mapped to a shard", async () => {
    const deepestTicket = await issueRouteTicket(
      ticketInput({ depth: MAX_GAME_DEPTH }),
      TEST_ROUTE_TICKET_SECRET,
    );
    await expect(
      verifyRouteTicket(deepestTicket, TEST_ROUTE_TICKET_SECRET, policy(Math.floor(Date.now() / 1_000))),
    ).resolves.toMatchObject({ depth: MAX_GAME_DEPTH });
    await expect(
      issueRouteTicket(ticketInput({ realmId: "../../global" }), TEST_ROUTE_TICKET_SECRET),
    ).rejects.toThrow("realm");
    await expect(
      issueRouteTicket(ticketInput({ playerName: "name with spaces" }), TEST_ROUTE_TICKET_SECRET),
    ).rejects.toThrow("player name");
    await expect(
      issueRouteTicket(ticketInput({ depth: MAX_GAME_DEPTH + 1 }), TEST_ROUTE_TICKET_SECRET),
    ).rejects.toThrow("depth");
    await expect(
      issueRouteTicket(ticketInput({ floorInstanceId: "../../hot" }), TEST_ROUTE_TICKET_SECRET),
    ).rejects.toThrow("floor instance");
    await expect(
      issueRouteTicket(ticketInput({ authorityEpoch: 0 }), TEST_ROUTE_TICKET_SECRET),
    ).rejects.toThrow("authority epoch");
    await expect(
      issueRouteTicket(ticketInput({ leaseId: "not-a-lease" }), TEST_ROUTE_TICKET_SECRET),
    ).rejects.toThrow("authority lease");
    await expect(
      issueRouteTicket(ticketInput({ resumeProofHash: "raw-secret" }), TEST_ROUTE_TICKET_SECRET),
    ).rejects.toThrow("resume proof hash");
    await expect(
      issueRouteTicket(
        ticketInput({ locationHint: "moon" as DurableObjectLocationHint }),
        TEST_ROUTE_TICKET_SECRET,
      ),
    ).rejects.toThrow("location hint");
  });
});
