import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { beginHttpDrain, startHttpServer } from "./http.js";
import { closePersistence, initPersistence } from "./persistence.js";
import { WorldServer } from "./world.js";

describe("origin liveness and readiness", () => {
  let server: http.Server;
  let baseUrl = "";

  beforeEach(async () => {
    server = startHttpServer(new WorldServer(), 0);
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server has no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server.listening) {
      const drain = beginHttpDrain(server);
      drain.forceClose();
      await drain.drained;
    }
  });

  it("keeps liveness distinct from failed persistence readiness", async () => {
    const live = await fetch(`${baseUrl}/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true, releaseSha: "local" });

    const ready = await fetch(`${baseUrl}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      ok: false,
      ready: false,
      draining: false,
      persistence: false,
    });

    const health = await fetch(`${baseUrl}/health?format=json`);
    expect(health.status).toBe(200);
    const payload = (await health.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, ready: false, persistence: false });
    expect(payload.processUptimeMs).toEqual(expect.any(Number));
    expect(payload.worldUptimeMs).toEqual(expect.any(Number));
    expect(payload.uptimeMs).toBe(payload.worldUptimeMs);
    expect(payload.uptimeKind).toBe("world");
  });
});

describe("production readiness", () => {
  it("becomes ready only after persistence and the production payment guard are active", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-ready-"));
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.GROKHACK_DB_PATH = path.join(directory, "ready.duckdb");
    delete process.env.X402_DEV_BYPASS;
    await initPersistence();

    const server = startHttpServer(new WorldServer(), 0);
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server has no port");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        ready: true,
        persistence: true,
        productionSafe: true,
      });
    } finally {
      const drain = beginHttpDrain(server);
      drain.forceClose();
      await drain.drained;
      await closePersistence();
      fs.rmSync(directory, { recursive: true, force: true });
      delete process.env.GROKHACK_DB_PATH;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("redirects forwarded plaintext requests to the canonical HTTPS host", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const server = startHttpServer(new WorldServer(), 0);
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server has no port");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/play.html?from=http`, {
        headers: { Host: "attacker.example", "X-Forwarded-Proto": "http" },
        redirect: "manual",
      });
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(
        "https://grokhack.mondello.dev/play.html?from=http",
      );
      expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
      expect(await response.text()).toBe("");
    } finally {
      const drain = beginHttpDrain(server);
      drain.forceClose();
      await drain.drained;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
