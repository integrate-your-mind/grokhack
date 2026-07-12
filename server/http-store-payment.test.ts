import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "./http.js";
import { _resetUsedPaymentsForTests, getEntitlements } from "./store.js";
import { WorldServer } from "./world.js";

describe("x402 HTTP grant boundary", () => {
  let server: http.Server;
  let port: number;
  const priorEnv: Record<string, string | undefined> = {};
  const payer = "0x1234567890123456789012345678901234567890";
  const transaction = `0x${"cd".repeat(32)}`;

  beforeEach(async () => {
    for (const key of ["X402_PAY_TO", "X402_FACILITATOR_URL", "X402_DEV_BYPASS"]) {
      priorEnv[key] = process.env[key];
    }
    process.env.X402_PAY_TO = payer;
    process.env.X402_FACILITATOR_URL = "https://facilitator.test/x402";
    delete process.env.X402_DEV_BYPASS;
    _resetUsedPaymentsForTests();
    server = startHttpServer(new WorldServer(), 0);
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server has no port");
    port = address.port;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  function unlock(signature: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ sku: "death_frames_pro", playerName: "PayingHero" });
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/store/unlock",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "PAYMENT-SIGNATURE": signature,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            });
          });
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
  }

  it("does not grant or consume a proof until settlement succeeds", async () => {
    const signature = "http-integration-payment-proof";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ valid: true, payer }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ errorReason: "settle_exact_failed_onchain" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ valid: true, payer }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true, payer, transaction, network: "base" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ valid: true, payer }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true, payer, transaction, network: "base" }),
        }),
    );

    const failed = await unlock(signature);
    expect(failed).toMatchObject({ status: 503, body: { retryable: true } });
    expect(getEntitlements("PayingHero")?.grants ?? []).not.toContain("death_frames_pro");

    const settled = await unlock(signature);
    expect(settled).toMatchObject({ status: 200, body: { ok: true } });
    expect(getEntitlements("PayingHero")?.grants ?? []).toContain("death_frames_pro");

    const replay = await unlock(signature);
    expect(replay.status).toBe(409);
  });
});
