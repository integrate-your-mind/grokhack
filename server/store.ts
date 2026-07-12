/**
 * GrokHack revenue store — cosmetics / tips only (no pay-to-win).
 * Payments via x402 (USDC) when configured; entitlements keyed by game name + optional wallet.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { dataPath } from "./data-paths.js";

const DATA_DIR = dataPath("store");
const ENTITLEMENTS_FILE = path.join(DATA_DIR, "entitlements.json");
const PAYMENTS_LOG = path.join(DATA_DIR, "payments.jsonl");
/** Replay ledger: sha256(PAYMENT-SIGNATURE) → first claim metadata */
const USED_PAYMENTS_FILE = path.join(DATA_DIR, "used-payments.json");

/** Combat / godmode grants must never be sold or written via purchase path */
const FORBIDDEN_GRANT_RE =
  /^(hp|max_?hp|damage|dmg|atk|attack|def|defense|str|dex|con|int|wis|cha|godmode|immortal|invuln|unlimited|level|xp|exp|loot_mult|crit|one.?shot|power|stat_)/i;

/** Allowlist for sellable/milestone cosmetic grants (defense in depth) */
const SAFE_GRANT_RE =
  /^(supporter|badge_[a-z0-9_]+|frame_[a-z0-9_]+|death_frames_pro|wall_shout|agent_cup_entry)$/i;

const MAX_USED_PAYMENT_ENTRIES = 20_000;

/** USDC on Base (6 decimals). 1 USDC = 1_000_000 */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const NETWORK_BASE = "eip155:8453";

export type ProductSku =
  | "tip_3"
  | "tip_10"
  | "tip_25"
  | "death_frames_pro"
  | "agent_cup_entry";

export interface Product {
  sku: ProductSku;
  name: string;
  description: string;
  /** Human display price */
  priceUsd: number;
  /** Atomic USDC (6 decimals) as string for x402 */
  amountAtomic: string;
  kind: "tip" | "cosmetic" | "tournament";
  /** Entitlement keys granted on purchase */
  grants: string[];
}

/** Catalog — never sell power, only support + cosmetics + tournament entry */
export const PRODUCTS: Product[] = [
  {
    sku: "tip_3",
    name: "Dungeon tip $3",
    description: "Buy the dungeon a coffee. Supporter badge on your next death card.",
    priceUsd: 3,
    amountAtomic: "3000000",
    kind: "tip",
    grants: ["supporter", "badge_tip"],
  },
  {
    sku: "tip_10",
    name: "Dungeon tip $10",
    description: "Serious support. Gold supporter frame on death cards.",
    priceUsd: 10,
    amountAtomic: "10000000",
    kind: "tip",
    grants: ["supporter", "badge_tip", "frame_gold"],
  },
  {
    sku: "tip_25",
    name: "Dungeon tip $25",
    description: "Patron of the abyss. Legendary frame + wall shout-out entitlement.",
    priceUsd: 25,
    amountAtomic: "25000000",
    kind: "tip",
    grants: ["supporter", "badge_tip", "frame_gold", "frame_legend", "wall_shout"],
  },
  {
    sku: "death_frames_pro",
    name: "Death Frames Pro",
    description: "Unlock extra death-card frames for shareable 𝕏 posts. No gameplay power.",
    priceUsd: 5,
    amountAtomic: "5000000",
    kind: "cosmetic",
    grants: ["death_frames_pro", "frame_neon", "frame_void"],
  },
  {
    sku: "agent_cup_entry",
    name: "Agent Cup entry",
    description: "Enter the next agent depth cup (same rules as free play — entry fee only).",
    priceUsd: 5,
    amountAtomic: "5000000",
    kind: "tournament",
    grants: ["agent_cup_entry"],
  },
];

export interface EntitlementRecord {
  playerName: string;
  grants: string[];
  purchases: { sku: string; at: string; txHint?: string; amountUsd: number }[];
  updatedAt: string;
}

interface EntitlementStore {
  byPlayer: Record<string, EntitlementRecord>;
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore(): EntitlementStore {
  ensureDir();
  if (!fs.existsSync(ENTITLEMENTS_FILE)) return { byPlayer: {} };
  try {
    return JSON.parse(fs.readFileSync(ENTITLEMENTS_FILE, "utf8")) as EntitlementStore;
  } catch {
    return { byPlayer: {} };
  }
}

function saveStore(store: EntitlementStore): void {
  ensureDir();
  fs.writeFileSync(ENTITLEMENTS_FILE, JSON.stringify(store, null, 2));
}

function normalizeName(name: string): string {
  return name.trim().slice(0, 16);
}

export function getProduct(sku: string): Product | undefined {
  return PRODUCTS.find((p) => p.sku === sku);
}

export function listProducts(): Product[] {
  return PRODUCTS.map((p) => ({ ...p }));
}

/** True if grant may appear on a purchase/milestone path (never combat power). */
export function isSafeGrant(grant: string): boolean {
  if (!grant || typeof grant !== "string") return false;
  if (FORBIDDEN_GRANT_RE.test(grant)) return false;
  return SAFE_GRANT_RE.test(grant);
}

/** Reject catalog SKUs that would sell combat power (belt-and-suspenders). */
export function assertProductSafe(product: Product): { ok: true } | { ok: false; reason: string } {
  if (product.kind !== "tip" && product.kind !== "cosmetic" && product.kind !== "tournament") {
    return { ok: false, reason: `unsafe_product_kind:${product.kind}` };
  }
  for (const g of product.grants) {
    if (!isSafeGrant(g)) {
      return { ok: false, reason: `unsafe_grant:${g}` };
    }
  }
  const atomic = Number(product.amountAtomic);
  if (!Number.isFinite(atomic) || atomic <= 0 || atomic !== product.priceUsd * 1_000_000) {
    return { ok: false, reason: "amount_price_mismatch" };
  }
  return { ok: true };
}

/** EVM address: 0x + 40 hex (hardware wallet receive address). */
export function isValidTreasuryAddress(addr: string): boolean {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

/** Stable fingerprint for PAYMENT-SIGNATURE (or other proof material). */
export function paymentFingerprint(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

interface UsedPaymentStore {
  byFp: Record<string, { at: string; sku?: string; playerName?: string; payer?: string }>;
}

function loadUsedPayments(): UsedPaymentStore {
  ensureDir();
  if (!fs.existsSync(USED_PAYMENTS_FILE)) return { byFp: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(USED_PAYMENTS_FILE, "utf8")) as UsedPaymentStore;
    if (!raw || typeof raw.byFp !== "object" || raw.byFp == null) return { byFp: {} };
    return raw;
  } catch {
    return { byFp: {} };
  }
}

function saveUsedPayments(store: UsedPaymentStore): void {
  ensureDir();
  const keys = Object.keys(store.byFp);
  if (keys.length > MAX_USED_PAYMENT_ENTRIES) {
    const sorted = keys
      .map((k) => ({ k, at: store.byFp[k]?.at || "" }))
      .sort((a, b) => a.at.localeCompare(b.at));
    const drop = sorted.slice(0, keys.length - MAX_USED_PAYMENT_ENTRIES);
    for (const d of drop) delete store.byFp[d.k];
  }
  fs.writeFileSync(USED_PAYMENTS_FILE, JSON.stringify(store, null, 2));
}

/**
 * Atomically claim a payment fingerprint so the same PAYMENT-SIGNATURE
 * cannot unlock twice (replay). Returns ok:false on replay.
 */
export function claimPaymentFingerprint(
  fp: string,
  meta: { sku?: string; playerName?: string; payer?: string } = {}
): { ok: true } | { ok: false; reason: "replay" | "invalid_fingerprint" } {
  if (!fp || typeof fp !== "string" || fp.length < 32) {
    return { ok: false, reason: "invalid_fingerprint" };
  }
  const store = loadUsedPayments();
  if (store.byFp[fp]) {
    return { ok: false, reason: "replay" };
  }
  store.byFp[fp] = {
    at: new Date().toISOString(),
    sku: meta.sku,
    playerName: meta.playerName,
    payer: meta.payer,
  };
  saveUsedPayments(store);
  return { ok: true };
}

/** Test helper — only for unit tests. */
export function _resetUsedPaymentsForTests(): void {
  ensureDir();
  if (fs.existsSync(USED_PAYMENTS_FILE)) fs.unlinkSync(USED_PAYMENTS_FILE);
}

export function getEntitlements(playerName: string): EntitlementRecord | null {
  const key = normalizeName(playerName).toLowerCase();
  if (!key) return null;
  const store = loadStore();
  return store.byPlayer[key] ?? null;
}

export function hasGrant(playerName: string, grant: string): boolean {
  const ent = getEntitlements(playerName);
  return !!ent?.grants.includes(grant);
}

export function grantPurchase(
  playerName: string,
  product: Product,
  meta: { txHint?: string; payer?: string } = {}
): EntitlementRecord {
  const safeCheck = assertProductSafe(product);
  if (!safeCheck.ok) {
    throw new Error(`refusing_pay_to_win_grant:${safeCheck.reason}`);
  }
  const key = normalizeName(playerName).toLowerCase();
  const display = normalizeName(playerName);
  const store = loadStore();
  const prev = store.byPlayer[key] || {
    playerName: display,
    grants: [],
    purchases: [],
    updatedAt: new Date().toISOString(),
  };
  // Only merge safe grants (strip any accidental power keys from prior bad data)
  const safeIncoming = product.grants.filter(isSafeGrant);
  const grants = new Set([...prev.grants.filter(isSafeGrant), ...safeIncoming]);
  prev.grants = [...grants];
  prev.purchases.push({
    sku: product.sku,
    at: new Date().toISOString(),
    txHint: meta.txHint,
    amountUsd: product.priceUsd,
  });
  if (prev.purchases.length > 50) prev.purchases = prev.purchases.slice(-50);
  prev.updatedAt = new Date().toISOString();
  prev.playerName = display;
  store.byPlayer[key] = prev;
  saveStore(store);

  ensureDir();
  fs.appendFileSync(
    PAYMENTS_LOG,
    JSON.stringify({
      id: randomUUID(),
      at: new Date().toISOString(),
      sku: product.sku,
      playerName: display,
      amountUsd: product.priceUsd,
      amountAtomic: product.amountAtomic,
      payer: meta.payer,
      txHint: meta.txHint,
    }) + "\n"
  );

  return prev;
}

/**
 * Hardware-wallet treasury that receives USDC. Invalid / missing addresses
 * return "" so challenges never advertise a bad payTo.
 */
export function getPayToAddress(): string {
  const raw = (
    process.env.X402_PAY_TO ||
    process.env.GROKHACK_TREASURY_ADDRESS ||
    process.env.SIGILX_TREASURY_ADDRESS ||
    ""
  ).trim();
  return isValidTreasuryAddress(raw) ? raw : "";
}

export function x402Configured(): boolean {
  return isValidTreasuryAddress(getPayToAddress());
}

export function buildPaymentRequired(product: Product): Record<string, unknown> {
  const payTo = getPayToAddress();
  return {
    x402Version: 2,
    error: "Payment required",
    errorCode: "payment_required",
    paymentRequired: true,
    product: {
      sku: product.sku,
      name: product.name,
      priceUsd: product.priceUsd,
      grants: product.grants,
    },
    accepts: payTo
      ? [
          {
            scheme: "exact",
            network: NETWORK_BASE,
            asset: USDC_BASE,
            amount: product.amountAtomic,
            payTo,
            maxTimeoutSeconds: 300,
            extra: {
              name: "USD Coin",
              version: "2",
            },
          },
        ]
      : [],
    configure:
      payTo
        ? undefined
        : "Set X402_PAY_TO (or GROKHACK_TREASURY_ADDRESS) to a Base wallet that receives USDC.",
    how: {
      agents:
        "Retry this request with header PAYMENT-SIGNATURE (x402 proof) after paying USDC on Base.",
      humans: "Open /store.html — pay with an x402-capable wallet, or tip from the death screen.",
      docs: "/api/store",
    },
  };
}

export function revenueSummary(): {
  products: number;
  configured: boolean;
  payTo: string;
  totalPurchases: number;
  totalUsd: number;
} {
  const store = loadStore();
  let totalPurchases = 0;
  let totalUsd = 0;
  for (const rec of Object.values(store.byPlayer)) {
    for (const p of rec.purchases) {
      totalPurchases++;
      totalUsd += p.amountUsd;
    }
  }
  const payTo = getPayToAddress();
  return {
    products: PRODUCTS.length,
    configured: x402Configured(),
    payTo: payTo ? `${payTo.slice(0, 6)}…${payTo.slice(-4)}` : "",
    totalPurchases,
    totalUsd,
  };
}
