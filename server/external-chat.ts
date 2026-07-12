/**
 * Rate limits and duplicate filtering for IRC / Discord → in-game global chat.
 */

import { createHash } from "node:crypto";

export type ExternalChatTier = "irc" | "discord_unlinked" | "discord_linked";

export interface ExternalChatDecision {
  ok: boolean;
  reason?: "rate_limit" | "global_cap" | "duplicate" | "empty";
}

const buckets = new Map<string, number[]>();
const recentHashes = new Map<string, number>();

const TIER_LIMITS: Record<ExternalChatTier, { max: number; windowMs: number }> = {
  irc: { max: 3, windowMs: 30_000 },
  discord_unlinked: { max: 2, windowMs: 60_000 },
  discord_linked: { max: 5, windowMs: 30_000 },
};

const GLOBAL_MAX = parseInt(process.env.EXTERNAL_CHAT_GLOBAL_MAX || "20", 10);
const GLOBAL_WINDOW_MS = 60_000;
const DUPLICATE_MS = 60_000;

let globalHits: number[] = [];

function prune(key: string, windowMs: number): number[] {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  buckets.set(key, hits);
  return hits;
}

function hashContent(sourceKey: string, text: string): string {
  return createHash("sha256")
    .update(`${sourceKey}:${text.toLowerCase().trim()}`)
    .digest("hex")
    .slice(0, 16);
}

export function checkExternalChat(
  tier: ExternalChatTier,
  sourceKey: string,
  text: string
): ExternalChatDecision {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const now = Date.now();
  const { max, windowMs } = TIER_LIMITS[tier];
  const hits = prune(sourceKey, windowMs);
  if (hits.length >= max) return { ok: false, reason: "rate_limit" };

  globalHits = globalHits.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (globalHits.length >= GLOBAL_MAX) return { ok: false, reason: "global_cap" };

  const dupKey = hashContent(sourceKey, trimmed);
  const lastDup = recentHashes.get(dupKey);
  if (lastDup && now - lastDup < DUPLICATE_MS) return { ok: false, reason: "duplicate" };

  hits.push(now);
  buckets.set(sourceKey, hits);
  globalHits.push(now);
  recentHashes.set(dupKey, now);

  if (recentHashes.size > 5000) {
    for (const [k, t] of recentHashes) {
      if (now - t > DUPLICATE_MS) recentHashes.delete(k);
    }
  }

  return { ok: true };
}

export function externalChatLimits() {
  return { tiers: TIER_LIMITS, globalMax: GLOBAL_MAX, globalWindowMs: GLOBAL_WINDOW_MS };
}

/** @internal test helper */
export function resetExternalChatLimits(): void {
  buckets.clear();
  recentHashes.clear();
  globalHits = [];
}