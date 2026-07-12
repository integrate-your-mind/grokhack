import { describe, expect, it } from "vitest";
import { gameplayStateHash, hungerDrainForDepth, reduceGameplay, replayGameplayTrace, type GameplayState } from "./gameplay-reducer.js";

const healthy = (overrides: Partial<GameplayState> = {}): GameplayState => ({
  turns: 7, depth: 1, hunger: 1000, maxHunger: 1000,
  hungerState: "satiated", hp: 20, alive: true, ...overrides,
});

describe("reduceGameplay", () => {
  it("applies wait vitals deterministically without mutating input", () => {
    const state = Object.freeze(healthy());
    const first = reduceGameplay(state, { type: "advance_turn", action: "wait" });
    expect(first).toEqual({ state: healthy({ turns: 8, hunger: 998 }), events: [{ type: "message", text: "You wait." }] });
    expect(reduceGameplay(state, { type: "advance_turn", action: "wait" })).toEqual(first);
    expect(state).toEqual(healthy());
  });

  it("matches depth hunger escalation boundaries", () => {
    expect([1, 4, 6, 9, 11, 14].map(hungerDrainForDepth)).toEqual([2, 3, 4, 6, 8, 10]);
  });

  it("preserves legacy over-cap hunger while draining it", () => {
    const transition = reduceGameplay(healthy({ hunger: 2000 }), { type: "advance_turn", action: "other" });
    expect(transition.state.hunger).toBe(1998);
    expect(transition.state.hungerState).toBe("satiated");
  });

  it("replays a byte-stable trace and detects the exact drift step", () => {
    const commands = [
      { command: { type: "advance_turn", action: "wait" } as const },
      { command: { type: "advance_turn", action: "other" } as const },
    ];
    const first = replayGameplayTrace(healthy(), commands);
    expect(first.state).toMatchObject({ turns: 9, hunger: 996 });
    expect(first.stateHash).toBe(gameplayStateHash(first.state));
    expect(replayGameplayTrace(healthy(), commands)).toEqual(first);
    expect(() => replayGameplayTrace(healthy(), [
      commands[0]!,
      { ...commands[1]!, expectedStateHash: "0000000000000000" },
    ])).toThrow("gameplay trace drift at step 1");
  });

  it("emits state transition, hunger damage, and starvation exactly once", () => {
    const transition = reduceGameplay(healthy({ hunger: 3, hungerState: "fainting", hp: 3 }), { type: "advance_turn", action: "other" });
    expect(transition.state).toMatchObject({ turns: 8, hunger: 1, hungerState: "starving", hp: 0, alive: false });
    expect(transition.events).toEqual([
      { type: "message", text: "You are starving." },
      { type: "message", text: "Hunger deals 3 damage." },
      { type: "starved" },
      { type: "message", text: "You have starved to death..." },
    ]);
  });

  it.each([
    healthy({ turns: -1 }), healthy({ turns: 1.5 }), healthy({ turns: Number.MAX_SAFE_INTEGER }),
    healthy({ depth: 0 }), healthy({ hunger: -1 }), healthy({ maxHunger: 0 }),
  ])("rejects invalid state %#", (state) => {
    expect(() => reduceGameplay(state, { type: "advance_turn", action: "wait" })).toThrow(RangeError);
  });
});
