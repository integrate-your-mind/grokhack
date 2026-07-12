import { logEvent } from "./audit.js";

export interface SessionMetrics {
  sessionId: string;
  connectedAt: number;
  transport: string;
  playerId?: string;
  playerName?: string;
  kind?: string;
  inputCount: number;
  chatCount: number;
  socialCount: number;
  combatCount: number;
  maxDepth: number;
  clientEventCount: number;
  errors: number;
  activeConnections: number;
}

const sessions = new Map<string, SessionMetrics>();

export function initSession(sessionId: string, transport: string): void {
  sessions.set(sessionId, {
    sessionId,
    connectedAt: Date.now(),
    transport,
    inputCount: 0,
    chatCount: 0,
    socialCount: 0,
    combatCount: 0,
    maxDepth: 0,
    clientEventCount: 0,
    errors: 0,
    activeConnections: 1,
  });
}

/** Move the provisional server UUID onto the browser's validated sticky UUID. */
export function rekeySession(fromSessionId: string, toSessionId: string): void {
  if (fromSessionId === toSessionId) return;
  const source = sessions.get(fromSessionId);
  if (!source) return;
  const target = sessions.get(toSessionId);
  if (target) {
    target.connectedAt = Math.min(target.connectedAt, source.connectedAt);
    target.inputCount += source.inputCount;
    target.chatCount += source.chatCount;
    target.socialCount += source.socialCount;
    target.combatCount += source.combatCount;
    target.clientEventCount += source.clientEventCount;
    target.errors += source.errors;
    target.maxDepth = Math.max(target.maxDepth, source.maxDepth);
    target.activeConnections += source.activeConnections;
  } else {
    source.sessionId = toSessionId;
    sessions.set(toSessionId, source);
  }
  sessions.delete(fromSessionId);
}

export function attachPlayer(
  sessionId: string,
  playerId: string,
  playerName: string,
  kind: string,
  depth = 1
): void {
  const m = sessions.get(sessionId);
  if (!m) return;
  m.playerId = playerId;
  m.playerName = playerName;
  m.kind = kind;
  m.maxDepth = Math.max(m.maxDepth, depth);
}

export function bumpMetric(
  sessionId: string,
  field: "inputCount" | "chatCount" | "socialCount" | "combatCount" | "clientEventCount" | "errors",
  n = 1
): void {
  const m = sessions.get(sessionId);
  if (!m) return;
  m[field] += n;
}

export function updateMaxDepth(sessionId: string, depth: number): void {
  const m = sessions.get(sessionId);
  if (!m) return;
  m.maxDepth = Math.max(m.maxDepth, depth);
}

export function getSessionMetrics(sessionId: string): SessionMetrics | undefined {
  return sessions.get(sessionId);
}

export function finalizeSession(sessionId: string, playerId?: string): void {
  const m = sessions.get(sessionId);
  if (!m) {
    logEvent("session_summary", sessionId, {
      playerId,
      detail: { durationMs: 0, note: "no_metrics" },
    });
    return;
  }
  m.activeConnections = Math.max(0, m.activeConnections - 1);
  if (m.activeConnections > 0) return;

  const durationMs = Date.now() - m.connectedAt;
  logEvent("session_summary", sessionId, {
    playerId: m.playerId ?? playerId,
    playerName: m.playerName,
    transport: m.transport,
    detail: {
      durationMs,
      durationSec: Math.round(durationMs / 1000),
      inputCount: m.inputCount,
      chatCount: m.chatCount,
      socialCount: m.socialCount,
      combatCount: m.combatCount,
      maxDepth: m.maxDepth,
      clientEventCount: m.clientEventCount,
      errors: m.errors,
      kind: m.kind,
    },
  });
  sessions.delete(sessionId);
}
