export interface CombatantSnapshotV1 {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  isPlayer: boolean;
  traits: readonly string[];
  enraged: boolean;
}

export interface PlayerMeleeOptionsV1 {
  weaponName: string | null;
  hitPenalty: number;
  critChance: number | null;
}

/** Every value is supplied by the origin and authenticated before replay. */
export interface CombatRollTranscriptV1 {
  hit: number;
  missFlavor?: number;
  crit?: number;
  variance?: number;
  swiftSpike?: number;
  severityFlavor?: number;
  killFlavor?: number;
}

export interface PlayerMeleeTransitionV1 {
  defender: CombatantSnapshotV1;
  hit: boolean;
  damage: number;
  killed: boolean;
  critical: boolean;
  message: string;
}

const transcriptKeys = new Set([
  "hit", "missFlavor", "crit", "variance", "swiftSpike", "severityFlavor", "killFlavor",
]);

function fnv64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** JSON array framing keeps attacker/player-provided strings unambiguous. */
function hashParts(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

export function playerMeleeStateHashV1(attacker: Readonly<CombatantSnapshotV1>, defender: Readonly<CombatantSnapshotV1>): string {
  return fnv64(hashParts([combatantStateHashV1(attacker), combatantStateHashV1(defender)]));
}

const playerMisses = [
  "You miss the {target}.",
  "Your attack whistles past the {target}.",
  "The {target} dodges your swing.",
  "You swing wide of the {target}.",
] as const;
const killMessages = [
  "You {verb} the {target} for {damage} — it dies!",
  "You fell the {target} ({damage} dmg)!",
  "The {target} collapses under your {weapon} ({damage})!",
] as const;

function unit(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`invalid_combat_transcript_${name}`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`invalid_combat_${name}`);
  return Number(value);
}

function combatant(value: Readonly<CombatantSnapshotV1>, name: string): CombatantSnapshotV1 {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id ||
      typeof value.name !== "string" || !value.name || typeof value.isPlayer !== "boolean" ||
      !Array.isArray(value.traits) || value.traits.some((trait) => typeof trait !== "string") ||
      typeof value.enraged !== "boolean") {
    throw new Error(`invalid_combat_${name}`);
  }
  return {
    id: value.id, name: value.name,
    hp: integer(value.hp, `${name}_hp`), maxHp: integer(value.maxHp, `${name}_max_hp`, 1),
    attack: integer(value.attack, `${name}_attack`), defense: integer(value.defense, `${name}_defense`),
    isPlayer: value.isPlayer, traits: [...value.traits], enraged: value.enraged,
  };
}

export function combatantStateHashV1(value: Readonly<CombatantSnapshotV1>): string {
  const entity = combatant(value, "combatant");
  return fnv64(hashParts([
    entity.id, entity.name, entity.hp, entity.maxHp, entity.attack, entity.defense,
    entity.isPlayer ? 1 : 0, entity.traits, entity.enraged ? 1 : 0,
  ]));
}

export function playerMeleeTransitionHashV1(result: Readonly<PlayerMeleeTransitionV1>): string {
  return fnv64(hashParts([
    result.hit ? 1 : 0, result.damage, result.killed ? 1 : 0, result.critical ? 1 : 0,
    result.message, combatantStateHashV1(result.defender),
  ]));
}

function choose<T>(values: readonly T[], roll: number): T {
  return values[Math.floor(unit(roll, "choice") * values.length)]!;
}

function severityVerb(damage: number, maxHp: number, roll: number): string {
  const ratio = damage / Math.max(1, maxHp);
  if (ratio >= 0.45) return choose(["devastate", "maul", "brutalize"], roll);
  if (ratio >= 0.25) return choose(["wound", "strike hard", "smash"], roll);
  if (ratio >= 0.12) return choose(["hit", "cut", "bash"], roll);
  return choose(["nick", "graze", "glance"], roll);
}

function weaponVerb(weaponName: string | null): string {
  if (!weaponName) return "strike";
  const name = weaponName.toLowerCase();
  if (name.includes("dagger") || name.includes("sword")) return "slash";
  if (name.includes("mace") || name.includes("hammer")) return "crush";
  if (name.includes("axe")) return "cleave";
  return "strike";
}

/**
 * Pure player-to-monster melee resolution. The origin supplies a finite random
 * transcript; replay validates it and never generates a combat outcome.
 */
export function reducePlayerMeleeV1(
  attackerInput: Readonly<CombatantSnapshotV1>,
  defenderInput: Readonly<CombatantSnapshotV1>,
  options: Readonly<PlayerMeleeOptionsV1>,
  transcript: Readonly<CombatRollTranscriptV1>,
): PlayerMeleeTransitionV1 {
  const attacker = combatant(attackerInput, "attacker");
  const defender = combatant(defenderInput, "defender");
  if (!attacker.isPlayer || defender.isPlayer || defender.hp < 1) throw new Error("invalid_player_melee_participants");
  if (typeof options.weaponName !== "string" && options.weaponName !== null ||
      !Number.isFinite(options.hitPenalty) || options.hitPenalty < 0 ||
      (options.critChance !== null && (!Number.isFinite(options.critChance) || options.critChance < 0 || options.critChance > 1))) {
    throw new Error("invalid_player_melee_options");
  }
  if (!transcript || typeof transcript !== "object" || Array.isArray(transcript) ||
      Object.keys(transcript).some((key) => !transcriptKeys.has(key))) {
    throw new Error("invalid_combat_transcript_keys");
  }
  const hitRoll = unit(transcript.hit, "hit");
  const atkEdge = attacker.attack - defender.defense;
  let hitChance = 0.62 + atkEdge * 0.04;
  if (attacker.traits.includes("pack")) hitChance += 0.04;
  if (attacker.traits.includes("swift")) hitChance += 0.06;
  if (attacker.enraged) hitChance += 0.08;
  hitChance = Math.min(0.92, Math.max(0.15, hitChance - options.hitPenalty));
  if (hitRoll > hitChance) {
    if (transcript.missFlavor === undefined || transcript.crit !== undefined || transcript.variance !== undefined ||
        transcript.swiftSpike !== undefined || transcript.severityFlavor !== undefined || transcript.killFlavor !== undefined) {
      throw new Error("invalid_combat_transcript_miss");
    }
    return { defender, hit: false, damage: 0, killed: false, critical: false,
      message: choose(playerMisses, transcript.missFlavor).replaceAll("{target}", defender.name) };
  }
  if (transcript.crit === undefined || transcript.variance === undefined || transcript.severityFlavor === undefined || transcript.missFlavor !== undefined) {
    throw new Error("invalid_combat_transcript_hit");
  }
  const critical = unit(transcript.crit, "crit") < (options.critChance ?? (attacker.enraged ? 0.16 : 0.1));
  let damage = Math.max(1, attacker.attack - defender.defense + Math.floor(unit(transcript.variance, "variance") * 4) - 1);
  if (attacker.traits.includes("swift")) {
    if (transcript.swiftSpike === undefined) throw new Error("invalid_combat_transcript_swift");
    if (unit(transcript.swiftSpike, "swift_spike") < 0.2) damage++;
  } else if (transcript.swiftSpike !== undefined) throw new Error("invalid_combat_transcript_swift");
  if (critical) damage = Math.max(2, Math.floor(damage * 1.85));
  const nextHp = Math.max(0, defender.hp - damage);
  const killed = nextHp === 0;
  const verb = severityVerb(damage, defender.maxHp, transcript.severityFlavor);
  if (critical) {
    if (transcript.killFlavor !== undefined) throw new Error("invalid_combat_transcript_critical");
    return { defender: { ...defender, hp: nextHp }, hit: true, damage, killed, critical, message: killed
      ? `CRITICAL! You ${weaponVerb(options.weaponName)} the ${defender.name} for ${damage} — it dies!`
      : `CRITICAL! You ${weaponVerb(options.weaponName)} the ${defender.name} for ${damage} damage!` };
  }
  if (!killed) {
    if (transcript.killFlavor !== undefined) throw new Error("invalid_combat_transcript_nonlethal");
    return { defender: { ...defender, hp: nextHp }, hit: true, damage, killed, critical, message: `You ${verb} the ${defender.name} for ${damage} damage.` };
  }
  if (transcript.killFlavor === undefined) throw new Error("invalid_combat_transcript_kill");
  const message = choose(killMessages, transcript.killFlavor)
    .replaceAll("{target}", defender.name).replaceAll("{verb}", verb)
    .replaceAll("{damage}", String(damage)).replaceAll("{weapon}", weaponVerb(options.weaponName));
  return { defender: { ...defender, hp: nextHp }, hit: true, damage, killed, critical, message };
}
