import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { dataPath } from "./data-paths.js";

const CREDITS = dataPath("store", "credits.json");
const BAK = dataPath("store", "credits.test.bak");

describe("compute credits economy", () => {
  beforeEach(async () => {
    if (fs.existsSync(CREDITS)) fs.copyFileSync(CREDITS, BAK);
    if (fs.existsSync(CREDITS)) fs.unlinkSync(CREDITS);
    const { resetCreditJobIdCache } = await import("./credits.js");
    resetCreditJobIdCache();
  });
  afterEach(() => {
    if (fs.existsSync(BAK)) {
      fs.copyFileSync(BAK, CREDITS);
      fs.unlinkSync(BAK);
    }
  });

  it("awards 1 credit per validated job and tracks lifetime", async () => {
    const { awardComputeCredits, getCredits } = await import("./credits.js");
    awardComputeCredits("CreditBot", 1, { jobType: "hash_check", jobId: "cj_t1" });
    awardComputeCredits("CreditBot", 1, { jobType: "fov_rays", jobId: "cj_t2" });
    const acc = getCredits("CreditBot");
    expect(acc?.balance).toBe(2);
    expect(acc?.lifetimeEarned).toBe(2);
  });

  it("refuses mint without jobId (no free credit mint)", async () => {
    const { awardComputeCredits, getCredits } = await import("./credits.js");
    expect(awardComputeCredits("NoJob", 1, { jobType: "hash_check" })).toBeNull();
    expect(awardComputeCredits("NoJob", 1, {})).toBeNull();
    expect(getCredits("NoJob")).toBeNull();
  });

  it("is idempotent on same jobId (no double-mint)", async () => {
    const { awardComputeCredits, getCredits } = await import("./credits.js");
    awardComputeCredits("IdemBot", 1, { jobId: "cj_same" });
    awardComputeCredits("IdemBot", 1, { jobId: "cj_same" });
    awardComputeCredits("IdemBot", 1, { jobId: "cj_same" });
    expect(getCredits("IdemBot")?.balance).toBe(1);
    expect(getCredits("IdemBot")?.lifetimeEarned).toBe(1);
  });

  it("clamps award amount to 1 and rejects non-positive", async () => {
    const { awardComputeCredits, getCredits } = await import("./credits.js");
    expect(awardComputeCredits("ClampBot", 0, { jobId: "cj_z" })).toBeNull();
    expect(awardComputeCredits("ClampBot", -5, { jobId: "cj_neg" })).toBeNull();
    awardComputeCredits("ClampBot", 99, { jobId: "cj_big" });
    expect(getCredits("ClampBot")?.balance).toBe(1);
  });

  it("rejects invalid player names for award and redeem", async () => {
    const { awardComputeCredits, redeemWithCredits } = await import("./credits.js");
    expect(awardComputeCredits("../evil", 1, { jobId: "cj_path" })).toBeNull();
    expect(awardComputeCredits("", 1, { jobId: "cj_empty" })).toBeNull();
    expect(awardComputeCredits("has space", 1, { jobId: "cj_sp" })).toBeNull();
    expect(redeemWithCredits("../evil", "agent_cup_entry").ok).toBe(false);
    if (!redeemWithCredits("!!!", "agent_cup_entry").ok) {
      expect(redeemWithCredits("!!!", "agent_cup_entry")).toMatchObject({
        ok: false,
        error: "invalid_player_name",
      });
    }
  });

  it("redeems cosmetics with credits but not tips", async () => {
    const { awardComputeCredits, redeemWithCredits, getCredits } = await import("./credits.js");
    for (let i = 0; i < 100; i++) awardComputeCredits("Spender", 1, { jobId: `cj_fund_${i}` });
    const tip = redeemWithCredits("Spender", "tip_3");
    expect(tip.ok).toBe(false);
    if (!tip.ok) expect(tip.error).toBe("tips_require_usdc");
    const frames = redeemWithCredits("Spender", "death_frames_pro");
    expect(frames.ok).toBe(true);
    if (frames.ok) {
      expect(frames.grants).toContain("death_frames_pro");
      expect(getCredits("Spender")?.balance).toBe(0);
    }
  });

  it("rejects insufficient credits and unknown sku", async () => {
    const { awardComputeCredits, redeemWithCredits, getCredits } = await import("./credits.js");
    awardComputeCredits("Poor", 1, { jobId: "cj_poor" });
    const low = redeemWithCredits("Poor", "agent_cup_entry");
    expect(low.ok).toBe(false);
    if (!low.ok) {
      expect(low.error).toBe("insufficient_credits");
      expect(low.balance).toBe(1);
      expect(low.need).toBe(50);
    }
    expect(getCredits("Poor")?.balance).toBe(1);
    const unk = redeemWithCredits("Poor", "not_a_real_sku");
    expect(unk.ok).toBe(false);
    if (!unk.ok) expect(unk.error).toBe("unknown_sku");
  });

  it("leaderboard sorts by lifetime earned", async () => {
    const { awardComputeCredits, creditsLeaderboard } = await import("./credits.js");
    awardComputeCredits("Low", 1, { jobId: "cj_low" });
    for (let i = 0; i < 5; i++) awardComputeCredits("High", 1, { jobId: `cj_high_${i}` });
    const board = creditsLeaderboard(10);
    expect(board[0].playerName).toBe("High");
    expect(board[0].lifetimeEarned).toBeGreaterThanOrEqual(5);
  });
});
