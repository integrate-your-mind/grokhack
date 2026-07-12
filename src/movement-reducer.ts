import type { GamePhase, Tile } from "./types.js";

export type MovementOccupant = "none" | "player" | "monster";
export type MovementOutcome =
  | "ignored"
  | "struggle"
  | "blocked_terrain"
  | "blocked_player"
  | "combat_intent"
  | "moved";
export type MovementTurnCost = "none" | "consume" | "after_effects";

export interface MovementDestination {
  tile: Tile | null;
  occupant: MovementOccupant;
  trap: boolean;
  stairsDown: boolean;
}

export interface MovementAuthority {
  realmId: string;
  floorInstanceId: string;
  depth: number;
  floorEpoch: number;
  rulesetVersion: number;
}

export interface MovementState {
  authority: MovementAuthority;
  x: number;
  y: number;
  phase: GamePhase;
  alive: boolean;
  immobilizedTurns: number;
  destination: MovementDestination;
}

export interface MovementCommand {
  type: "move";
  dx: number;
  dy: number;
}

export type MovementEvent =
  | { type: "message"; code: "struggle" | "wall" }
  | { type: "blocked_player" }
  | { type: "combat_intent" }
  | { type: "moved" }
  | { type: "door_crossed" }
  | { type: "pickup_intent" }
  | { type: "trap_intent" }
  | { type: "room_step_intent" }
  | { type: "transfer_intent" }
  | { type: "turn_intent" }
  | { type: "visibility_intent" };

export interface MovementTransition {
  state: MovementState;
  outcome: MovementOutcome;
  turnCost: MovementTurnCost;
  events: readonly MovementEvent[];
}

function fnv64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function assertMovementCommand(command: Readonly<MovementCommand>): void {
  if (command.type !== "move" || !Number.isSafeInteger(command.dx) || !Number.isSafeInteger(command.dy) ||
      Math.abs(command.dx) > 1 || Math.abs(command.dy) > 1 || (command.dx === 0 && command.dy === 0)) {
    throw new RangeError("invalid movement direction");
  }
}

export function validateMovementState(value: unknown): MovementState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_movement_state");
  const state = value as Partial<MovementState>;
  const phases = new Set<GamePhase>(["playing", "inventory", "dead", "won"]);
  if (!state.authority || typeof state.authority !== "object" || Array.isArray(state.authority) ||
      !Number.isSafeInteger(state.x) || Number(state.x) < 0 ||
      !Number.isSafeInteger(state.y) || Number(state.y) < 0 ||
      typeof state.phase !== "string" || !phases.has(state.phase as GamePhase) ||
      typeof state.alive !== "boolean" ||
      !Number.isSafeInteger(state.immobilizedTurns) || Number(state.immobilizedTurns) < 0 ||
      !state.destination || typeof state.destination !== "object" || Array.isArray(state.destination)) {
    throw new Error("invalid_movement_state");
  }
  const authority = state.authority as Partial<MovementAuthority>;
  if (typeof authority.realmId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(authority.realmId) ||
      typeof authority.floorInstanceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(authority.floorInstanceId) ||
      !Number.isSafeInteger(authority.depth) || Number(authority.depth) < 1 || Number(authority.depth) > 64 ||
      !Number.isSafeInteger(authority.floorEpoch) || Number(authority.floorEpoch) < 1 ||
      !Number.isSafeInteger(authority.rulesetVersion) || Number(authority.rulesetVersion) < 1) {
    throw new Error("invalid_movement_state");
  }
  const destination = state.destination as Partial<MovementDestination>;
  const tiles = new Set<Tile | null>(["#", ".", ">", "<", "+", null]);
  const occupants = new Set<MovementOccupant>(["none", "player", "monster"]);
  if (!tiles.has(destination.tile as Tile | null) ||
      typeof destination.occupant !== "string" || !occupants.has(destination.occupant as MovementOccupant) ||
      typeof destination.trap !== "boolean" || typeof destination.stairsDown !== "boolean") {
    throw new Error("invalid_movement_state");
  }
  return state as MovementState;
}

/** Stable drift fingerprint only; this is not an authentication primitive. */
export function movementStateHash(state: Readonly<MovementState>): string {
  const validated = validateMovementState(state);
  return fnv64([
    validated.authority.realmId,
    validated.authority.floorInstanceId,
    validated.authority.depth,
    validated.authority.floorEpoch,
    validated.authority.rulesetVersion,
    validated.x,
    validated.y,
    validated.phase,
    validated.alive ? 1 : 0,
    validated.immobilizedTurns,
    validated.destination.tile ?? "bounds",
    validated.destination.occupant,
    validated.destination.trap ? 1 : 0,
    validated.destination.stairsDown ? 1 : 0,
  ].join("|"));
}

/** Hashes behavioral output so equal-position wall/player/combat decisions cannot alias. */
export function movementEventHash(transition: Pick<MovementTransition, "outcome" | "turnCost" | "events">): string {
  const eventCodes = transition.events.map((event) =>
    event.type === "message" ? `${event.type}:${event.code}` : event.type);
  return fnv64([transition.outcome, transition.turnCost, ...eventCodes].join("|"));
}

/** Pure movement decision shared by the origin adapter and Workers shadow replay. */
export function reduceMovement(
  input: Readonly<MovementState>,
  command: Readonly<MovementCommand>,
): MovementTransition {
  assertMovementCommand(command);
  const state = validateMovementState(input);
  const unchanged = (): MovementState => ({
    ...state,
    authority: { ...state.authority },
    destination: { ...state.destination },
  });
  if (state.phase !== "playing" || !state.alive) {
    return { state: unchanged(), outcome: "ignored", turnCost: "none", events: [] };
  }
  if (state.immobilizedTurns > 0) {
    return {
      state: unchanged(),
      outcome: "struggle",
      turnCost: "consume",
      events: [
        { type: "message", code: "struggle" },
        { type: "turn_intent" },
        { type: "visibility_intent" },
      ],
    };
  }
  if (state.destination.tile === null || state.destination.tile === "#") {
    return {
      state: unchanged(),
      outcome: "blocked_terrain",
      turnCost: "none",
      events: [{ type: "message", code: "wall" }],
    };
  }
  if (state.destination.occupant === "player") {
    return {
      state: unchanged(),
      outcome: "blocked_player",
      turnCost: "none",
      events: [{ type: "blocked_player" }],
    };
  }
  if (state.destination.occupant === "monster") {
    return {
      state: unchanged(),
      outcome: "combat_intent",
      turnCost: "consume",
      events: [
        { type: "combat_intent" },
        { type: "turn_intent" },
        { type: "visibility_intent" },
      ],
    };
  }

  const events: MovementEvent[] = [{ type: "moved" }];
  if (state.destination.tile === "+") events.push({ type: "door_crossed" });
  events.push({ type: "pickup_intent" });
  if (state.destination.trap) events.push({ type: "trap_intent" });
  events.push({ type: "room_step_intent" });
  if (state.destination.stairsDown && state.destination.tile === ">") {
    events.push({ type: "transfer_intent" });
  }
  events.push({ type: "turn_intent" }, { type: "visibility_intent" });
  const x = state.x + command.dx;
  const y = state.y + command.dy;
  if (!Number.isSafeInteger(x) || x < 0 || !Number.isSafeInteger(y) || y < 0) {
    throw new RangeError("invalid movement destination");
  }
  return {
    state: {
      ...state,
      authority: { ...state.authority },
      x,
      y,
      destination: { ...state.destination },
    },
    outcome: "moved",
    turnCost: "after_effects",
    events,
  };
}
