/**
 * x402 payment verification for GrokHack store unlocks.
 * Verifies PAYMENT-SIGNATURE via facilitator when configured; supports safe dev bypass.
 *
 * Security (sec-pay):
 * - Explicit facilitator valid flag required (no soft-accept of empty 200)
 * - Treasury payTo must be a valid 0x address before any accept/verify
 * - Payment fingerprint returned for server-side replay claim
 * - Dev bypass disabled in production; secret min length 16
 */
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Product } from "./store.js";
import {
  getPayToAddress,
  paymentFingerprint,
  USDC_BASE,
  NETWORK_BASE,
} from "./store.js";

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  failureKind?: "payment_required" | "invalid_payment" | "configuration" | "upstream";
  retryable?: boolean;
  payer?: string;
  txHint?: string;
  /** sha256 of proof material — caller must claimPaymentFingerprint before grant */
  paymentFingerprint?: string;
}

function rejected(
  reason: string,
  failureKind: NonNullable<VerifyResult["failureKind"]>,
  retryable = false,
): VerifyResult {
  return { ok: false, reason, failureKind, retryable };
}

function getPaymentHeader(req: IncomingMessage): string {
  const h =
    req.headers["payment-signature"] ||
    req.headers["PAYMENT-SIGNATURE"] ||
    req.headers["x-payment"] ||
    req.headers["x-payment-signature"];
  if (Array.isArray(h)) return h[0] || "";
  return typeof h === "string" ? h : "";
}

export function isProductionRuntime(): boolean {
  const env = (process.env.NODE_ENV || "").toLowerCase();
  const gh = (process.env.GROKHACK_ENV || "").toLowerCase();
  return env === "production" || gh === "production" || process.env.X402_FORCE_PROD === "1";
}

/**
 * Production must never start with the local payment bypass enabled. Keeping
 * this as a boot invariant prevents a missing launcher flag from turning a
 * development convenience into a public entitlement grant path.
 */
export function assertX402RuntimeSafety(): void {
  if (!isProductionRuntime()) return;
  const bypassEnabled = process.env.X402_DEV_BYPASS === "1";
  delete process.env.X402_DEV_BYPASS;
  delete process.env.X402_DEV_SECRET;
  if (bypassEnabled) {
    throw new Error("X402_DEV_BYPASS must be disabled in production");
  }
}

export function x402ProductionGuardActive(): boolean {
  return isProductionRuntime() && process.env.X402_DEV_BYPASS !== "1";
}

function facilitatorExplicitlyValid(data: Record<string, unknown>): boolean {
  if (data.valid === true) return true;
  if (data.isValid === true) return true;
  if (data.ok === true) return true;
  if (data.success === true) return true;
  const verification = data.verification as { valid?: boolean } | undefined;
  if (verification && verification.valid === true) return true;
  return false;
}

function facilitatorExplicitlyInvalid(data: Record<string, unknown>): boolean {
  if (data.valid === false) return true;
  if (data.isValid === false) return true;
  if (data.ok === false) return true;
  if (data.success === false) return true;
  const verification = data.verification as { valid?: boolean } | undefined;
  if (verification && verification.valid === false) return true;
  return false;
}

/**
 * Verify an x402 payment for a product.
 * Production: POST to facilitator verify and require confirmed settlement.
 * Dev: X402_DEV_BYPASS=1 + header X-GrokHack-Dev-Pay: <X402_DEV_SECRET> (not in prod).
 */
export async function verifyX402Payment(
  req: IncomingMessage,
  product: Product
): Promise<VerifyResult> {
  const payTo = getPayToAddress();
  if (!payTo) {
    return rejected("Treasury not configured (X402_PAY_TO)", "configuration", true);
  }

  // Dev bypass for local QA only — hard-disabled in production
  const devBypass = process.env.X402_DEV_BYPASS === "1";
  const devSecret = process.env.X402_DEV_SECRET || "";
  const devHeader = String(req.headers["x-grokhack-dev-pay"] || "");
  if (devBypass) {
    if (isProductionRuntime()) {
      return rejected("dev_bypass_disabled_in_production", "configuration", true);
    }
    if (!devSecret || devSecret.length < 16) {
      return rejected("dev_bypass_misconfigured", "configuration", true);
    }
    if (devHeader === devSecret) {
      // Unique fingerprint per attempt so QA can re-unlock; real payments use sig hash
      const nonce = randomUUID();
      return {
        ok: true,
        payer: "dev-bypass",
        txHint: `dev:${product.sku}:${nonce}`,
        paymentFingerprint: paymentFingerprint(`dev-bypass:${nonce}:${product.sku}`),
      };
    }
    // Wrong secret with bypass enabled still falls through to normal path
  }

  const paymentSig = getPaymentHeader(req);
  if (!paymentSig) {
    return rejected("missing_payment_signature", "payment_required");
  }
  if (paymentSig.length > 16_384) {
    return rejected("payment_signature_too_large", "invalid_payment");
  }

  const facilitator =
    process.env.X402_FACILITATOR_URL ||
    process.env.THIRDWEB_FACILITATOR_URL ||
    "https://api.thirdweb.com/v1/x402";

  const secret = process.env.THIRDWEB_SECRET_KEY || process.env.X402_FACILITATOR_KEY || "";

  try {
    const body = {
      x402Version: 2,
      paymentHeader: paymentSig,
      paymentPayload: paymentSig,
      paymentRequirements: {
        scheme: "exact",
        network: NETWORK_BASE,
        maxAmountRequired: product.amountAtomic,
        amount: product.amountAtomic,
        resource: `grokhack:store:${product.sku}`,
        payTo,
        asset: USDC_BASE,
        maxTimeoutSeconds: 300,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret) {
      headers.Authorization = `Bearer ${secret}`;
      headers["x-secret-key"] = secret;
    }

    const verifyUrl = facilitator.replace(/\/$/, "") + "/verify";
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });

    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-json */
    }

    if (!res.ok) {
      return rejected(
        `facilitator_http_${res.status}:${String(data.error || data.message || text).slice(0, 120)}`,
        res.status >= 500 || res.status === 429 ? "upstream" : "invalid_payment",
        res.status >= 500 || res.status === 429,
      );
    }

    // P0: never soft-accept ambiguous 200 bodies — require explicit valid
    if (facilitatorExplicitlyInvalid(data)) {
      return rejected(
        String(data.error || data.message || "payment_not_valid").slice(0, 160),
        "invalid_payment",
      );
    }
    if (!facilitatorExplicitlyValid(data)) {
      return rejected(
        data.error
          ? String(data.error).slice(0, 160)
          : "payment_not_valid:facilitator_missing_valid_flag",
        "invalid_payment",
      );
    }

    // Settlement is the grant boundary. Verification only proves that the
    // payload appears payable; the resource must not be delivered until the
    // facilitator confirms an on-chain settlement.
    const settleUrl = facilitator.replace(/\/$/, "") + "/settle";
    const settleResponse = await fetch(settleUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const settleText = await settleResponse.text();
    let settlement: Record<string, unknown> | undefined;
    try {
      const candidate = JSON.parse(settleText) as unknown;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        settlement = candidate as Record<string, unknown>;
      }
    } catch {
      // A non-JSON or truncated response is an unknown settlement outcome and
      // therefore cannot authorize an entitlement.
    }
    if (!settleResponse.ok) {
      const detail = String(
        settlement?.errorReason || settlement?.error || settlement?.message || "settlement_failed"
      ).slice(0, 120);
      return rejected(
        `facilitator_settle_http_${settleResponse.status}:${detail}`,
        settleResponse.status >= 500 || settleResponse.status === 429
          ? "upstream"
          : "invalid_payment",
        settleResponse.status >= 500 || settleResponse.status === 429,
      );
    }
    if (settlement?.success !== true) {
      const reason = String(
          settlement?.errorReason || settlement?.error || "facilitator_settle_missing_success"
        ).slice(0, 160);
      return rejected(
        reason,
        settlement?.success === false ? "invalid_payment" : "upstream",
        settlement?.success !== false,
      );
    }

    const settlementPayer = typeof settlement.payer === "string" ? settlement.payer.trim() : "";
    const settlementTransaction =
      typeof settlement.transaction === "string" ? settlement.transaction.trim() : "";
    const settlementNetwork = typeof settlement.network === "string" ? settlement.network.trim() : "";
    const basePayer = /^0x[0-9a-f]{40}$/i.test(settlementPayer);
    const baseTransaction = /^0x[0-9a-f]{64}$/i.test(settlementTransaction);
    const expectedNetwork = settlementNetwork === NETWORK_BASE || settlementNetwork === "base";
    if (!basePayer || !baseTransaction || !expectedNetwork) {
      return rejected("facilitator_settle_invalid_receipt", "upstream", true);
    }
    const verifiedPayer = String(data.payer || data.from || data.payerAddress || "").trim();
    if (
      /^0x[0-9a-f]{40}$/i.test(verifiedPayer) &&
      verifiedPayer.toLowerCase() !== settlementPayer.toLowerCase()
    ) {
      return rejected("facilitator_settle_payer_mismatch", "upstream", true);
    }

    const fp = paymentFingerprint(paymentSig);
    return {
      ok: true,
      payer: settlementPayer,
      txHint: settlementTransaction,
      paymentFingerprint: fp,
    };
  } catch (err) {
    return rejected(
      `facilitator_error:${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
      "upstream",
      true,
    );
  }
}
