import { describe, expect, it, vi } from "vitest";

import { resolveReleaseSha } from "./release.js";

describe("release revision resolution", () => {
  it("uses an explicitly configured immutable revision without invoking git", () => {
    const gitRevision = vi.fn(() => "f".repeat(40));
    expect(
      resolveReleaseSha(
        { GROKHACK_RELEASE_SHA: " A1234567890ABCDEF " },
        "/unused",
        gitRevision,
      ),
    ).toBe("a1234567890abcdef");
    expect(gitRevision).not.toHaveBeenCalled();
  });

  it("derives the checked-out revision when no valid override exists", () => {
    const gitRevision = vi.fn(() => `${"b".repeat(40)}\n`);
    expect(resolveReleaseSha({ GROKHACK_RELEASE_SHA: "not-a-sha" }, "/repo", gitRevision)).toBe(
      "b".repeat(40),
    );
    expect(gitRevision).toHaveBeenCalledWith("/repo");
  });

  it.each([
    ["git is unavailable", () => { throw new Error("missing"); }],
    ["git returns an invalid revision", () => "HEAD"],
  ])("fails closed to local when %s", (_scenario, gitRevision) => {
    expect(resolveReleaseSha({}, "/repo", gitRevision)).toBe("local");
  });
});
