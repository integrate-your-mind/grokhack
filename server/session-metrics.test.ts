import { describe, expect, it } from "vitest";

import {
  bumpMetric,
  finalizeSession,
  getSessionMetrics,
  initSession,
  rekeySession,
} from "./session-metrics.js";

describe("sticky session metrics", () => {
  it("moves provisional metrics to the validated client session and finalizes them", () => {
    const provisional = crypto.randomUUID();
    const sticky = crypto.randomUUID();
    initSession(provisional, "websocket");
    bumpMetric(provisional, "inputCount", 2);

    rekeySession(provisional, sticky);
    expect(getSessionMetrics(provisional)).toBeUndefined();
    expect(getSessionMetrics(sticky)).toMatchObject({
      sessionId: sticky,
      inputCount: 2,
      activeConnections: 1,
    });

    finalizeSession(sticky);
    expect(getSessionMetrics(sticky)).toBeUndefined();
  });

  it("keeps overlapping reconnect metrics alive until both sockets close", () => {
    const sticky = crypto.randomUUID();
    const reconnect = crypto.randomUUID();
    initSession(sticky, "websocket");
    initSession(reconnect, "websocket");
    bumpMetric(sticky, "inputCount", 1);
    bumpMetric(reconnect, "errors", 1);

    rekeySession(reconnect, sticky);
    expect(getSessionMetrics(sticky)).toMatchObject({
      inputCount: 1,
      errors: 1,
      activeConnections: 2,
    });
    finalizeSession(sticky);
    expect(getSessionMetrics(sticky)?.activeConnections).toBe(1);
    finalizeSession(sticky);
    expect(getSessionMetrics(sticky)).toBeUndefined();
  });
});
