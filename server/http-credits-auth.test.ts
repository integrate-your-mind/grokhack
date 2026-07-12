import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { awardComputeCredits, getCredits, resetCreditJobIdCache } from "./credits.js";
import { startHttpServer } from "./http.js";
import { issueResumeToken, resetResumeAuthForTests } from "./resume-auth.js";
import { WorldServer } from "./world.js";

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

describe("compute-credit redemption authorization", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    resetCreditJobIdCache();
    resetResumeAuthForTests();
    server = startHttpServer(new WorldServer(), 0);
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server has no port");
    port = address.port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  function redeem(body: Record<string, unknown>): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/credits/redeem",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
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
        }
      );
      request.setTimeout(1_000, () => request.destroy(new Error("HTTP request timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  }

  it("does not let an anonymous caller or another character spend a player's credits", async () => {
    const victimToken = issueResumeToken("CreditVictim");
    const attackerToken = issueResumeToken("CreditAttacker");
    for (let index = 0; index < 50; index += 1) {
      awardComputeCredits("CreditVictim", 1, { jobId: `victim-job-${index}` });
    }

    await expect(
      redeem({ playerName: "CreditVictim", sku: "agent_cup_entry" })
    ).resolves.toMatchObject({ status: 401, body: { error: "character_auth_required" } });
    expect(getCredits("CreditVictim")?.balance).toBe(50);

    await expect(
      redeem({
        playerName: "CreditVictim",
        sku: "agent_cup_entry",
        resumeToken: attackerToken,
      })
    ).resolves.toMatchObject({ status: 401, body: { error: "character_auth_required" } });
    expect(getCredits("CreditVictim")?.balance).toBe(50);

    const authorized = await redeem({
      playerName: "CreditVictim",
      sku: "agent_cup_entry",
      resumeToken: victimToken,
    });
    expect(authorized).toMatchObject({ status: 200, body: { ok: true } });
    expect(getCredits("CreditVictim")?.balance).toBe(0);
  });
});
