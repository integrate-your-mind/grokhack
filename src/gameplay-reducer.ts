export interface GameplayState {
  turns: number;
  depth: number;
  hunger: number;
  maxHunger: number;
  hungerState: HungerState;
  hp: number;
  alive: boolean;
}

export type HungerState = "satiated" | "normal" | "hungry" | "weak" | "fainting" | "starving";
export type GameplayCommand = { type: "advance_turn"; action: "wait" | "other" };

export type GameplayEvent =
  | { type: "message"; text: string }
  | { type: "starved" };

export interface GameplayTransition {
  state: GameplayState;
  events: readonly GameplayEvent[];
}

export interface GameplayTraceStep {
  command: GameplayCommand;
  expectedStateHash?: string;
}

export interface GameplayTraceResult {
  state: GameplayState;
  stateHash: string;
  transitions: readonly GameplayTransition[];
}

/** Stable non-cryptographic fingerprint for drift detection, never for authentication. */
export function gameplayStateHash(state: Readonly<GameplayState>): string {
  const canonical = [state.turns, state.depth, state.hunger, state.maxHunger,
    state.hungerState, state.hp, state.alive ? 1 : 0].join("|");
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonical)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function replayGameplayTrace(
  initialState: Readonly<GameplayState>,
  trace: readonly GameplayTraceStep[],
): GameplayTraceResult {
  let state = { ...initialState };
  const transitions: GameplayTransition[] = [];
  for (let index = 0; index < trace.length; index++) {
    const step = trace[index]!;
    const transition = reduceGameplay(state, step.command);
    const stateHash = gameplayStateHash(transition.state);
    if (step.expectedStateHash !== undefined && step.expectedStateHash !== stateHash) {
      throw new Error(`gameplay trace drift at step ${index}: expected ${step.expectedStateHash}, received ${stateHash}`);
    }
    transitions.push(transition);
    state = transition.state;
  }
  return { state, stateHash: gameplayStateHash(state), transitions };
}

export function hungerDrainForDepth(depth: number): number {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new RangeError("depth must be positive");
  return 2 + Math.floor((depth - 1) / 3) + (depth >= 6 ? 1 : 0) +
    (depth >= 9 ? 1 : 0) + (depth >= 11 ? 1 : 0) + (depth >= 14 ? 1 : 0);
}

function hungerStateFor(hunger: number, maxHunger: number): HungerState {
  const ratio = hunger / maxHunger;
  if (ratio > 0.8) return "satiated";
  if (ratio > 0.5) return "normal";
  if (ratio > 0.3) return "hungry";
  if (ratio > 0.15) return "weak";
  if (ratio > 0.05) return "fainting";
  return "starving";
}

function hungerDamage(state: HungerState): number {
  return state === "weak" ? 1 : state === "fainting" ? 2 : state === "starving" ? 3 : 0;
}

/** Pure, deterministic gameplay transition shared by the origin and edge runtimes. */
export function reduceGameplay(
  state: Readonly<GameplayState>,
  command: GameplayCommand,
): GameplayTransition {
  if (!Number.isSafeInteger(state.turns) || state.turns < 0) {
    throw new RangeError("turns must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(state.hunger) || state.hunger < 0 ||
      !Number.isSafeInteger(state.maxHunger) || state.maxHunger < 1 ||
      !Number.isSafeInteger(state.hp)) {
    throw new RangeError("invalid gameplay vitals");
  }
  switch (command.type) {
    case "advance_turn": {
      if (state.turns === Number.MAX_SAFE_INTEGER) throw new RangeError("turn counter exhausted");
      const hunger = Math.max(0, state.hunger - hungerDrainForDepth(state.depth));
      const hungerState = hungerStateFor(hunger, state.maxHunger);
      const hp = state.alive ? state.hp - hungerDamage(hungerState) : state.hp;
      const alive = state.alive && hp > 0;
      const events: GameplayEvent[] = [];
      if (command.action === "wait") events.push({ type: "message", text: "You wait." });
      if (state.hungerState !== hungerState && hungerState !== "normal" && hungerState !== "satiated") {
        events.push({ type: "message", text: `You are ${hungerState}.` });
      }
      const damage = state.alive ? hungerDamage(hungerState) : 0;
      if (damage > 0) events.push({ type: "message", text: `Hunger deals ${damage} damage.` });
      if (state.alive && !alive) {
        events.push({ type: "starved" }, { type: "message", text: "You have starved to death..." });
      }
      return {
        state: { ...state, turns: state.turns + 1, hunger, hungerState, hp, alive },
        events,
      };
    }
  }
}
