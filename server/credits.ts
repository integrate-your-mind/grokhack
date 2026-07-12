/**
 * Compute Credits — Phase 1 agent economy (off-chain ledger).
 *
 * Earn: 1 credit per server-validated compute job.
 * Spend: cosmetics / cup entry only (never combat power).
 * Later: optional claim-to-chain / token; not this module.
 */
import fs from "node:fs";
import path from "node:path";
import { getProduct, grantPurchase, type ProductSku } from "./store.js";
import { dataPath } from "./data-paths.js";

const DATA_DIR = dataPath("store");
const CREDITS_FILE = path.join(DATA_DIR, "credits.json");
const LEDGER_LOG = path.join(DATA_DIR, "credits-ledger.jsonl");

/** Max credits per single award call (compute always uses 1). */
export const MAX_AWARD_AMOUNT = 1;
/** Rolling set of jobIds already credited — prevents double-mint on replay bugs. */
const MAX_SEEN_JOB_IDS = 20_000;
const seenJobIds = new Set<string>();
const seenJobIdOrder: string[] = [];

/** Credits required to redeem a store SKU (USDC tips stay fiat/x402 only). */
export const CREDIT_PRICES: Partial<Record<ProductSku, number>> = {
  death_frames_pro: 100,
  agent_cup_entry: 50,
};

/** Lifetime thresholds → auto cosmetic grants (no power). */
const MILESTONES: { at: number; grant: string; label: string }[] = [
  { at: 10, grant: "badge_compute", label: "Compute Contributor" },
  { at: 100, grant: "frame_compute", label: "Compute Frame" },
  { at: 500, grant: "badge_compute_elite", label: "Compute Elite" },
];

export interface CreditAccount {
  playerName: string;
  /** Spendable balance */
  balance: number;
  /** Lifetime earned (never decreases) */
  lifetimeEarned: number;
  /** Lifetime spent */
  lifetimeSpent: number;
  updatedAt: string;
}

interface CreditStore {
  byPlayer: Record<string, CreditAccount>;
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load(): CreditStore {
  ensureDir();
  if (!fs.existsSync(CREDITS_FILE)) return { byPlayer: {} };
  try {
    return JSON.parse(fs.readFileSync(CREDITS_FILE, "utf8")) as CreditStore;
  } catch {
    return { byPlayer: {} };
  }
}

function save(store: CreditStore): void {
  ensureDir();
  fs.writeFileSync(CREDITS_FILE, JSON.stringify(store, null, 2));
}

function keyName(name: string): string {
  return name.trim().slice(0, 16).toLowerCase();
}

function displayName(name: string): string {
  return name.trim().slice(0, 16);
}

/** Game-name style only — blocks empty/control/path junk as ledger keys. */
function safePlayerName(name: string): string | null {
  const trimmed = name.trim().slice(0, 16);
  if (!trimmed || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed)) return null;
  return trimmed;
}

function rememberJobId(jobId: string): boolean {
  if (seenJobIds.has(jobId)) return false;
  seenJobIds.add(jobId);
  seenJobIdOrder.push(jobId);
  while (seenJobIdOrder.length > MAX_SEEN_JOB_IDS) {
    const old = seenJobIdOrder.shift();
    if (old) seenJobIds.delete(old);
  }
  return true;
}

/** Test helper — clear jobId idempotency set (does not wipe ledger file). */
export function resetCreditJobIdCache(): void {
  seenJobIds.clear();
  seenJobIdOrder.length = 0;
}

function appendLedger(entry: Record<string, unknown>): void {
  ensureDir();
  fs.appendFileSync(LEDGER_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

function ensureAccount(store: CreditStore, playerName: string): CreditAccount {
  const k = keyName(playerName);
  const display = displayName(playerName);
  if (!store.byPlayer[k]) {
    store.byPlayer[k] = {
      playerName: display,
      balance: 0,
      lifetimeEarned: 0,
      lifetimeSpent: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  store.byPlayer[k].playerName = display;
  return store.byPlayer[k];
}

/**
 * Award credits after a server-validated compute job.
 * Requires jobId for mint path (idempotent). amount clamped to MAX_AWARD_AMOUNT.
 */
export function awardComputeCredits(
  playerName: string | undefined,
  amount = 1,
  meta: { jobType?: string; jobId?: string } = {}
): CreditAccount | null {
  const safe = playerName ? safePlayerName(playerName) : null;
  if (!safe) return null;
  if (amount <= 0) return null;
  // Security: no open-ended mint size; compute always awards 1
  const grant = Math.min(Math.floor(amount), MAX_AWARD_AMOUNT);
  if (grant <= 0) return null;

  // Must be tied to a concrete job — prevents free mint without compute accept path
  const jobId = meta.jobId?.trim();
  if (!jobId || jobId.length > 80) return null;
  if (!rememberJobId(jobId)) {
    // Already credited this jobId — return current balance, do not re-mint
    return getCredits(safe);
  }

  const store = load();
  const acc = ensureAccount(store, safe);
  acc.balance += grant;
  acc.lifetimeEarned += grant;
  acc.updatedAt = new Date().toISOString();
  save(store);
  appendLedger({
    type: "earn",
    playerName: acc.playerName,
    amount: grant,
    balance: acc.balance,
    lifetimeEarned: acc.lifetimeEarned,
    jobType: meta.jobType,
    jobId,
  });

  // Auto cosmetic milestones via store entitlements (never combat power)
  for (const m of MILESTONES) {
    if (acc.lifetimeEarned >= m.at) {
      grantMilestone(acc.playerName, m.grant);
    }
  }
  return { ...acc };
}

function grantMilestone(playerName: string, grant: string): void {
  // Lightweight: write grant into entitlements without a purchase row
  const entPath = path.join(DATA_DIR, "entitlements.json");
  ensureDir();
  let store: { byPlayer: Record<string, { playerName: string; grants: string[]; purchases: unknown[]; updatedAt: string }> } = {
    byPlayer: {},
  };
  try {
    if (fs.existsSync(entPath)) store = JSON.parse(fs.readFileSync(entPath, "utf8"));
  } catch {
    /* empty */
  }
  const k = keyName(playerName);
  const prev = store.byPlayer[k] || {
    playerName: displayName(playerName),
    grants: [],
    purchases: [],
    updatedAt: new Date().toISOString(),
  };
  if (prev.grants.includes(grant)) return;
  prev.grants = [...prev.grants, grant];
  prev.updatedAt = new Date().toISOString();
  store.byPlayer[k] = prev;
  fs.writeFileSync(entPath, JSON.stringify(store, null, 2));
}

export function getCredits(playerName: string): CreditAccount | null {
  const k = keyName(playerName);
  if (!k) return null;
  const store = load();
  return store.byPlayer[k] ?? null;
}

export function creditsLeaderboard(limit = 25): CreditAccount[] {
  const store = load();
  return Object.values(store.byPlayer)
    .sort((a, b) => b.lifetimeEarned - a.lifetimeEarned || b.balance - a.balance)
    .slice(0, Math.min(100, limit));
}

export type RedeemResult =
  | { ok: true; account: CreditAccount; product: string; grants: string[] }
  | { ok: false; error: string; balance?: number; need?: number };

/** Spend credits on an allowed cosmetic/tournament SKU. Never combat power. */
export function redeemWithCredits(playerName: string, sku: string): RedeemResult {
  const safe = safePlayerName(playerName);
  if (!safe) return { ok: false, error: "invalid_player_name" };

  const product = getProduct(sku);
  if (!product) return { ok: false, error: "unknown_sku" };
  // Tips are USDC/x402 only — never burn compute credits on tips
  if (product.kind === "tip") {
    return { ok: false, error: "tips_require_usdc" };
  }
  const price = CREDIT_PRICES[product.sku as ProductSku];
  if (price == null) {
    return { ok: false, error: "sku_not_redeemable_with_credits", need: undefined };
  }

  const store = load();
  const acc = ensureAccount(store, safe);
  if (acc.balance < price) {
    return { ok: false, error: "insufficient_credits", balance: acc.balance, need: price };
  }
  acc.balance -= price;
  acc.lifetimeSpent += price;
  acc.updatedAt = new Date().toISOString();
  save(store);
  appendLedger({
    type: "spend",
    playerName: acc.playerName,
    amount: price,
    sku: product.sku,
    balance: acc.balance,
  });

  grantPurchase(acc.playerName, product, { txHint: `credits:${price}`, payer: "compute-credits" });
  return {
    ok: true,
    account: { ...acc },
    product: product.sku,
    grants: product.grants,
  };
}

export function creditsDocs(): Record<string, unknown> {
  return {
    name: "GrokHack Compute Credits",
    phase: 1,
    token: false,
    note: "Off-chain ledger. 1 validated compute job = 1 credit. Future token optional; not launched.",
    earn: "Server-validated compute_result → +1 credit (see /api/compute)",
    spend: CREDIT_PRICES,
    milestones: MILESTONES,
    policy: "Never spend credits on combat power. Tips still use x402 USDC.",
    endpoints: {
      me: "GET /api/credits?player=Name",
      leaderboard: "GET /api/credits/leaderboard",
      redeem: "POST /api/credits/redeem { playerName, sku, resumeToken }",
    },
  };
}
