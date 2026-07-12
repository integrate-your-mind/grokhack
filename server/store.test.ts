import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { dataPath } from "./data-paths.js";

const ENT = dataPath("store", "entitlements.json");
const BAK = dataPath("store", "entitlements.test.bak");

describe("store revenue catalog", () => {
  beforeEach(() => {
    if (fs.existsSync(ENT)) {
      fs.copyFileSync(ENT, BAK);
    }
  });
  afterEach(() => {
    if (fs.existsSync(BAK)) {
      fs.copyFileSync(BAK, ENT);
      fs.unlinkSync(BAK);
    }
  });

  it("lists products with atomic USDC amounts and no pay-to-win grants", async () => {
    const { listProducts, PRODUCTS } = await import("./store.js");
    const list = listProducts();
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(PRODUCTS.every((p) => Number(p.amountAtomic) === p.priceUsd * 1_000_000)).toBe(true);
    const grantBlob = PRODUCTS.flatMap((p) => p.grants).join(" ");
    expect(grantBlob).not.toMatch(/hp|damage|godmode|unlimited/i);
    expect(PRODUCTS.some((p) => p.kind === "cosmetic")).toBe(true);
    expect(PRODUCTS.some((p) => p.kind === "tip")).toBe(true);
  });

  it("builds 402 payment required payload with Base USDC accept", async () => {
    process.env.X402_PAY_TO = "0x1234567890123456789012345678901234567890";
    const { getProduct, buildPaymentRequired, USDC_BASE, NETWORK_BASE } = await import(
      "./store.js"
    );
    const p = getProduct("tip_3")!;
    const body = buildPaymentRequired(p);
    expect(body.paymentRequired).toBe(true);
    expect(body.x402Version).toBe(2);
    const accepts = body.accepts as { asset: string; network: string; amount: string; payTo: string }[];
    expect(accepts.length).toBe(1);
    expect(accepts[0].asset).toBe(USDC_BASE);
    expect(accepts[0].network).toBe(NETWORK_BASE);
    expect(accepts[0].amount).toBe("3000000");
    expect(accepts[0].payTo).toMatch(/^0x/);
  });

  it("grants entitlements on purchase without stacking duplicate grant noise", async () => {
    const { getProduct, grantPurchase, getEntitlements, hasGrant } = await import("./store.js");
    const p = getProduct("death_frames_pro")!;
    grantPurchase("RevTestHero", p, { txHint: "test-1" });
    grantPurchase("RevTestHero", p, { txHint: "test-2" });
    const ent = getEntitlements("RevTestHero");
    expect(ent?.grants).toContain("death_frames_pro");
    expect(ent?.grants.filter((g) => g === "death_frames_pro").length).toBe(1);
    expect(hasGrant("RevTestHero", "frame_neon")).toBe(true);
    expect(ent?.purchases.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects invalid treasury addresses (hardware wallet misconfig)", async () => {
    const { isValidTreasuryAddress, getPayToAddress, x402Configured } = await import("./store.js");
    expect(isValidTreasuryAddress("")).toBe(false);
    expect(isValidTreasuryAddress("0x0E4d1C7Ca47879C7Dd518526ef38f290C7081028")).toBe(true);
    expect(isValidTreasuryAddress("0xGGGG567890123456789012345678901234567890")).toBe(false);
    process.env.X402_PAY_TO = "0xtooShort";
    expect(getPayToAddress()).toBe("");
    expect(x402Configured()).toBe(false);
    process.env.X402_PAY_TO = "0x0E4d1C7Ca47879C7Dd518526ef38f290C7081028";
    expect(x402Configured()).toBe(true);
  });

  it("assertProductSafe and grantPurchase refuse pay-to-win grants", async () => {
    const { assertProductSafe, grantPurchase, PRODUCTS, isSafeGrant } = await import("./store.js");
    for (const p of PRODUCTS) {
      expect(assertProductSafe(p).ok).toBe(true);
      for (const g of p.grants) expect(isSafeGrant(g)).toBe(true);
    }
    expect(isSafeGrant("godmode")).toBe(false);
    expect(isSafeGrant("hp")).toBe(false);
    expect(isSafeGrant("damage_boost")).toBe(false);
    const evil = {
      ...PRODUCTS[0],
      sku: "tip_3" as const,
      grants: ["godmode", "hp"],
    };
    expect(assertProductSafe(evil).ok).toBe(false);
    expect(() => grantPurchase("Hacker", evil)).toThrow(/pay_to_win|unsafe/);
  });

  it("claimPaymentFingerprint is single-use (replay reject)", async () => {
    const {
      claimPaymentFingerprint,
      paymentFingerprint,
      _resetUsedPaymentsForTests,
    } = await import("./store.js");
    _resetUsedPaymentsForTests();
    const fp = paymentFingerprint("unique-payment-proof");
    expect(claimPaymentFingerprint(fp, { sku: "tip_3" }).ok).toBe(true);
    expect(claimPaymentFingerprint(fp, { sku: "tip_10" }).ok).toBe(false);
    expect(claimPaymentFingerprint("short", {}).ok).toBe(false);
  });

  it("buildPaymentRequired omits accepts when treasury invalid", async () => {
    process.env.X402_PAY_TO = "invalid";
    const { getProduct, buildPaymentRequired } = await import("./store.js");
    const body = buildPaymentRequired(getProduct("tip_3")!);
    expect((body.accepts as unknown[]).length).toBe(0);
    expect(body.configure).toMatch(/X402_PAY_TO/);
  });
});
