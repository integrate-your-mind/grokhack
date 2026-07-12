import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  paymentFingerprint,
  claimPaymentFingerprint,
  _resetUsedPaymentsForTests,
  getProduct,
  isValidTreasuryAddress,
} from "./store.js";

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("x402 payment verification security", () => {
  const payer = "0x1234567890123456789012345678901234567890";
  const transaction = `0x${"ab".repeat(32)}`;
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      "X402_PAY_TO",
      "X402_DEV_BYPASS",
      "X402_DEV_SECRET",
      "NODE_ENV",
      "GROKHACK_ENV",
      "X402_FORCE_PROD",
      "X402_FACILITATOR_URL",
      "THIRDWEB_SECRET_KEY",
    ]) {
      prev[k] = process.env[k];
    }
    _resetUsedPaymentsForTests();
    process.env.X402_PAY_TO = "0x1234567890123456789012345678901234567890";
    delete process.env.X402_DEV_BYPASS;
    delete process.env.X402_DEV_SECRET;
    delete process.env.X402_FORCE_PROD;
    delete process.env.GROKHACK_ENV;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects missing treasury", async () => {
    delete process.env.X402_PAY_TO;
    delete process.env.GROKHACK_TREASURY_ADDRESS;
    delete process.env.SIGILX_TREASURY_ADDRESS;
    const { verifyX402Payment } = await import("./x402.js");
    const product = getProduct("tip_3")!;
    const r = await verifyX402Payment(fakeReq({}), product);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Treasury/i);
    expect(r).toMatchObject({ failureKind: "configuration", retryable: true });
  });

  it("rejects invalid treasury format via getPayToAddress", () => {
    process.env.X402_PAY_TO = "not-an-address";
    expect(isValidTreasuryAddress("not-an-address")).toBe(false);
    expect(isValidTreasuryAddress("0x1234567890123456789012345678901234567890")).toBe(true);
    expect(isValidTreasuryAddress("0x123")).toBe(false);
  });

  it("rejects missing PAYMENT-SIGNATURE with missing_payment_signature", async () => {
    const { verifyX402Payment } = await import("./x402.js");
    const product = getProduct("death_frames_pro")!;
    const r = await verifyX402Payment(fakeReq({}), product);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_payment_signature");
    expect(r.failureKind).toBe("payment_required");
  });

  it("rejects facilitator 200 without explicit valid flag (no soft-accept forge)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message: "ok" }),
      }))
    );
    const { verifyX402Payment } = await import("./x402.js");
    const product = getProduct("tip_3")!;
    const r = await verifyX402Payment(
      fakeReq({ "payment-signature": "forged-empty-body-proof" }),
      product
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/payment_not_valid/);
  });

  it("rejects facilitator valid:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ valid: false, error: "insufficient" }),
      }))
    );
    const { verifyX402Payment } = await import("./x402.js");
    const product = getProduct("tip_3")!;
    const r = await verifyX402Payment(fakeReq({ "payment-signature": "bad-sig" }), product);
    expect(r.ok).toBe(false);
  });

  it("accepts facilitator valid:true and returns fingerprint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/settle")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                success: true,
                payer,
                transaction,
                network: "eip155:8453",
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              valid: true,
              payer,
              txHash: transaction,
            }),
        };
      })
    );
    const { verifyX402Payment } = await import("./x402.js");
    const product = getProduct("tip_3")!;
    const sig = "real-payment-signature-material-v1";
    const r = await verifyX402Payment(fakeReq({ "payment-signature": sig }), product);
    expect(r.ok).toBe(true);
    expect(r.paymentFingerprint).toBe(paymentFingerprint(sig));
    expect(r.txHint).toBe(transaction);
  });

  it("rejects a verified payment when settlement returns an HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/settle")) {
          return {
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ errorReason: "settle_exact_failed_onchain" }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ valid: true, payer: "0xabc" }),
        };
      })
    );

    const { verifyX402Payment } = await import("./x402.js");
    const r = await verifyX402Payment(
      fakeReq({ "payment-signature": "verified-but-unsettled-http-500" }),
      getProduct("tip_3")!
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toMatch(/settle|500/i);
    expect(r).toMatchObject({ failureKind: "upstream", retryable: true });
    expect(r.paymentFingerprint).toBeUndefined();
  });

  it("rejects a verified payment when settlement is ambiguous or unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ valid: true, payer: "0xabc" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchMock);

    const { verifyX402Payment } = await import("./x402.js");
    const ambiguous = await verifyX402Payment(
      fakeReq({ "payment-signature": "verified-but-ambiguous-settle" }),
      getProduct("tip_3")!
    );
    expect(ambiguous).toMatchObject({ ok: false });
    expect(ambiguous.reason).toMatch(/settle/i);
    expect(ambiguous).toMatchObject({ failureKind: "upstream", retryable: true });
    expect(ambiguous.paymentFingerprint).toBeUndefined();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ valid: true, payer: "0xabc" }),
      })
      .mockRejectedValueOnce(new Error("settlement network unavailable"));
    const unavailable = await verifyX402Payment(
      fakeReq({ "payment-signature": "verified-but-settle-network-failed" }),
      getProduct("tip_3")!
    );
    expect(unavailable).toMatchObject({ ok: false });
    expect(unavailable.reason).toMatch(/settle|facilitator_error/i);
    expect(unavailable).toMatchObject({ failureKind: "upstream", retryable: true });
    expect(unavailable.paymentFingerprint).toBeUndefined();
  });

  it("rejects settlement success without the required receipt identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ valid: true, payer: "0xabc" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
        })
    );

    const { verifyX402Payment } = await import("./x402.js");
    const r = await verifyX402Payment(
      fakeReq({ "payment-signature": "settled-without-transaction-receipt" }),
      getProduct("tip_3")!
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toMatch(/settle|receipt|transaction/i);
    expect(r.paymentFingerprint).toBeUndefined();
  });

  it("blocks payment signature replay via claim ledger", () => {
    const fp = paymentFingerprint("same-sig-twice");
    const a = claimPaymentFingerprint(fp, { sku: "tip_3", playerName: "Alice" });
    const b = claimPaymentFingerprint(fp, { sku: "tip_3", playerName: "Bob" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("replay");
  });

  it("disables dev bypass in production even with secret", async () => {
    process.env.X402_DEV_BYPASS = "1";
    process.env.X402_DEV_SECRET = "sixteen-chars-min";
    process.env.X402_FORCE_PROD = "1";
    const { verifyX402Payment } = await import("./x402.js");
    const product = getProduct("tip_3")!;
    const r = await verifyX402Payment(
      fakeReq({ "x-grokhack-dev-pay": "sixteen-chars-min" }),
      product
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("dev_bypass_disabled_in_production");
  });

  it("refuses to boot a production runtime with the development bypass enabled", async () => {
    process.env.GROKHACK_ENV = "production";
    process.env.X402_DEV_BYPASS = "1";
    process.env.X402_DEV_SECRET = "must-not-survive-production";
    const { assertX402RuntimeSafety } = await import("./x402.js");
    expect(() => assertX402RuntimeSafety()).toThrow(/X402_DEV_BYPASS/);
    expect(process.env.X402_DEV_BYPASS).toBeUndefined();
    expect(process.env.X402_DEV_SECRET).toBeUndefined();
  });

  it("scrubs a leftover development secret from a safe production runtime", async () => {
    process.env.NODE_ENV = "production";
    process.env.X402_DEV_BYPASS = "0";
    process.env.X402_DEV_SECRET = "must-not-survive-production";
    const { assertX402RuntimeSafety, x402ProductionGuardActive } = await import("./x402.js");
    expect(() => assertX402RuntimeSafety()).not.toThrow();
    expect(process.env.X402_DEV_BYPASS).toBeUndefined();
    expect(process.env.X402_DEV_SECRET).toBeUndefined();
    expect(x402ProductionGuardActive()).toBe(true);
  });

  it("rejects weak/missing dev secret when bypass enabled", async () => {
    process.env.X402_DEV_BYPASS = "1";
    process.env.X402_DEV_SECRET = "short";
    delete process.env.X402_FORCE_PROD;
    process.env.NODE_ENV = "test";
    const { verifyX402Payment } = await import("./x402.js");
    const product = getProduct("tip_3")!;
    const r = await verifyX402Payment(fakeReq({ "x-grokhack-dev-pay": "short" }), product);
    // falls through: misconfigured returns early
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dev_bypass_misconfigured|missing_payment/);
  });

  it("allows dev bypass only with long secret outside production", async () => {
    process.env.X402_DEV_BYPASS = "1";
    process.env.X402_DEV_SECRET = "sixteen-chars-min";
    process.env.NODE_ENV = "test";
    delete process.env.X402_FORCE_PROD;
    delete process.env.GROKHACK_ENV;
    const { verifyX402Payment } = await import("./x402.js");
    const product = getProduct("death_frames_pro")!;
    const r = await verifyX402Payment(
      fakeReq({ "x-grokhack-dev-pay": "sixteen-chars-min" }),
      product
    );
    expect(r.ok).toBe(true);
    expect(r.payer).toBe("dev-bypass");
    expect(r.paymentFingerprint).toBeTruthy();
    expect(r.paymentFingerprint!.length).toBe(64);
  });
});
