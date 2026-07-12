import http from "node:http";
import fs from "node:fs";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttpServer } from "./http.js";
import {
  _resetSocialForTests,
  getProfile,
  postWall,
  requestFriend,
  sendDM,
  touchProfile,
} from "./social.js";
import { WorldServer } from "./world.js";

interface HttpResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

describe("social profile HTTP path decoding", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    _resetSocialForTests();
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

  function request(pathname: string, method = "GET"): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method, path: pathname },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              headers: res.headers,
            });
          });
        }
      );
      req.setTimeout(1_000, () => req.destroy(new Error("HTTP request timed out")));
      req.on("error", reject);
      req.end();
    });
  }

  function get(pathname: string): Promise<HttpResult> {
    return request(pathname);
  }

  it("returns 400 for malformed percent-encoded profile names and stays responsive", async () => {
    for (const pathname of [
      "/api/social/profile/%E0%A4%A",
      "/api/social/profile/%",
      "/api/social/profile/%C0%AF",
    ]) {
      const response = await get(pathname);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "Malformed profile name" });
    }

    expect((await get("/health")).status).toBe(200);
  });

  it("rejects invalid or unknown names without creating profiles", async () => {
    const invalid = await get("/api/social/profile/Alice%20Smith");
    expect(invalid.status).toBe(400);
    expect(getProfile("Alice Smith")).toBeNull();

    const missing = await get("/api/social/profile/NeverJoined");
    expect(missing.status).toBe(404);
    expect(getProfile("NeverJoined")).toBeNull();

    expect((await get("/api/social/profile/Alice/nested")).status).toBe(404);
    const wrongMethod = await request("/api/social/profile/Alice", "POST");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET");
  });

  it("returns only the public projection without pending requests or unread DMs", async () => {
    requestFriend("Bob", "Alice");
    sendDM("Bob", "Alice", "private-message-swordfish");
    postWall("Alice", "public wall post");
    const writeSpy = vi.spyOn(fs, "writeFileSync");

    const response = await get("/api/social/profile/Alice");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body).toHaveProperty("profile.name", "Alice");
    expect(body).toHaveProperty("wall.0.text", "public wall post");
    expect(body).not.toHaveProperty("pendingIn");
    expect(body).not.toHaveProperty("pendingOut");
    expect(body).not.toHaveProperty("unreadDMs");
    expect(response.body).not.toContain("private-message-swordfish");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("treats prototype-like player names as ordinary own profile keys", async () => {
    expect((await get("/api/social/profile/constructor")).status).toBe(404);
    expect((await get("/health")).status).toBe(200);

    touchProfile("constructor");
    const profile = await get("/api/social/profile/constructor");
    expect(profile.status).toBe(200);
    expect(JSON.parse(profile.body)).toHaveProperty("profile.name", "constructor");
  });
});
