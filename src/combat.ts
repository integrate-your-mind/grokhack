import type {
  BucStatus,
  Entity,
  HungerState,
  PlayerState,
  PotionEffect,
  RingEffect,
  ScrollEffect,
  StatusEffect,
  WandEffect,
} from "./types";
import {
  corpseIsUnsafe,
  fullyIdentify,
  isCorpseItem,
  itemDisplayName,
  POTION_TRUE_NAMES,
  RING_TRUE_NAMES,
  SCROLL_TRUE_NAMES,
  WAND_TRUE_NAMES,
  weaponVerb,
} from "./entities";
import { reducePlayerMeleeV1, type CombatantSnapshotV1, type CombatRollTranscriptV1 } from "./combat-reducer";

export interface CombatResult {
  hit: boolean;
  damage: number;
  killed: boolean;
  critical: boolean;
  message: string;
  /** Extra flavor from on-hit effects (poison, etc.). */
  sideEffect?: string;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Hunger degrades offense/defense — starving is a combat death spiral. */
export function hungerCombatMod(state: HungerState): {
  attack: number;
  defense: number;
  hitPenalty: number;
} {
  switch (state) {
    case "hungry":
      return { attack: 0, defense: 0, hitPenalty: 0.03 };
    case "weak":
      return { attack: -1, defense: 0, hitPenalty: 0.08 };
    case "fainting":
      return { attack: -2, defense: -1, hitPenalty: 0.15 };
    case "starving":
      return { attack: -3, defense: -2, hitPenalty: 0.22 };
    default:
      return { attack: 0, defense: 0, hitPenalty: 0 };
  }
}

function rollAttack(attacker: Entity, defender: Entity, crit: boolean): number {
  const base = attacker.attack - defender.defense;
  const variance = Math.floor(Math.random() * 4) - 1; // -1..2
  let dmg = Math.max(1, base + variance);
  // Swift monsters: more variance, occasional spikes
  if (attacker.traits?.includes("swift") && Math.random() < 0.2) {
    dmg += 1;
  }
  if (crit) dmg = Math.max(2, Math.floor(dmg * 1.85));
  return dmg;
}

function severityVerb(damage: number, maxHp: number): string {
  const ratio = damage / Math.max(1, maxHp);
  if (ratio >= 0.45) return pick(["devastate", "maul", "brutalize"]);
  if (ratio >= 0.25) return pick(["wound", "strike hard", "smash"]);
  if (ratio >= 0.12) return pick(["hit", "cut", "bash"]);
  return pick(["nick", "graze", "glance"]);
}

/** Third-person present: "strike hard" → "strikes hard", "smash" → "smashes". */
export function conjugateVerb(verb: string): string {
  const parts = verb.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return verb;
  const first = parts[0]!;
  const conjugated = /(?:s|x|z|ch|sh)$/i.test(first) ? `${first}es` : `${first}s`;
  parts[0] = conjugated;
  return parts.join(" ");
}

export interface MeleeOptions {
  /** Player weapon name for flavor (optional). */
  weaponName?: string | null;
  /** Extra hit-chance penalty (hunger, etc.). */
  hitPenalty?: number;
  /** Crit chance override (default 0.10). */
  critChance?: number;
}

function combatSnapshot(entity: Entity): CombatantSnapshotV1 {
  return {
    id: entity.id,
    name: entity.name,
    hp: entity.hp,
    maxHp: entity.maxHp,
    attack: entity.attack,
    defense: entity.defense,
    isPlayer: entity.isPlayer,
    traits: entity.traits ?? [],
    enraged: entity.enraged === true,
  };
}

function playerHitChance(attacker: Entity, defender: Entity, options: MeleeOptions): number {
  let chance = 0.62 + (attacker.attack - defender.defense) * 0.04;
  if (attacker.traits?.includes("pack")) chance += 0.04;
  if (attacker.traits?.includes("swift")) chance += 0.06;
  if (attacker.enraged) chance += 0.08;
  return Math.min(0.92, Math.max(0.15, chance - (options.hitPenalty ?? 0)));
}

function legacyPlayerTranscript(attacker: Entity, defender: Entity, options: MeleeOptions): CombatRollTranscriptV1 {
  const transcript: CombatRollTranscriptV1 = { hit: Math.random() };
  if (transcript.hit > playerHitChance(attacker, defender, options)) {
    transcript.missFlavor = Math.random();
    return transcript;
  }
  transcript.crit = Math.random();
  transcript.variance = Math.random();
  if (attacker.traits?.includes("swift")) transcript.swiftSpike = Math.random();
  transcript.severityFlavor = Math.random();
  const crit = transcript.crit < (options.critChance ?? (attacker.enraged ? 0.16 : 0.1));
  let damage = Math.max(1, attacker.attack - defender.defense + Math.floor(transcript.variance * 4) - 1);
  if (attacker.traits?.includes("swift") && transcript.swiftSpike! < 0.2) damage++;
  if (crit) damage = Math.max(2, Math.floor(damage * 1.85));
  if (!crit && defender.hp - damage <= 0) transcript.killFlavor = Math.random();
  return transcript;
}

/**
 * Core melee resolution — shared by client game and multiplayer world.
 * Hit formula is NetHack-adjacent: attack vs defense moves a 15–92% band.
 */
export function meleeAttack(
  attacker: Entity,
  defender: Entity,
  options: MeleeOptions = {}
): CombatResult {
  // Player attacks now resolve through the pure, transcript-bound reducer. The
  // adapter samples only rolls consumed by the old branch, then applies HP once.
  // Monster-initiated combat remains origin-only in this P0 slice.
  if (attacker.isPlayer && !defender.isPlayer) {
    const transcript = legacyPlayerTranscript(attacker, defender, options);
    const transition = reducePlayerMeleeV1(
      combatSnapshot(attacker),
      combatSnapshot(defender),
      { weaponName: options.weaponName ?? null, hitPenalty: options.hitPenalty ?? 0, critChance: options.critChance ?? null },
      transcript,
    );
    defender.hp = transition.defender.hp;
    return transition;
  }
  const atkEdge = attacker.attack - defender.defense;
  let hitChance = 0.62 + atkEdge * 0.04;
  // Pack fighters: slightly better accuracy when kind is pack-tagged
  if (attacker.traits?.includes("pack")) hitChance += 0.04;
  if (attacker.traits?.includes("swift")) hitChance += 0.06;
  if (attacker.enraged) hitChance += 0.08;
  hitChance -= options.hitPenalty ?? 0;
  hitChance = Math.min(0.92, Math.max(0.15, hitChance));

  if (Math.random() > hitChance) {
    const miss = attacker.isPlayer
      ? pick([
          `You miss the ${defender.name}.`,
          `Your attack whistles past the ${defender.name}.`,
          `The ${defender.name} dodges your swing.`,
          `You swing wide of the ${defender.name}.`,
        ])
      : pick([
          `The ${attacker.name} misses you.`,
          `You duck under the ${attacker.name}'s attack.`,
          `The ${attacker.name} claws the air beside you.`,
          `A clumsy swipe from the ${attacker.name} misses.`,
        ]);
    return { hit: false, damage: 0, killed: false, critical: false, message: miss };
  }

  const critChance = options.critChance ?? (attacker.enraged ? 0.16 : 0.1);
  const crit = Math.random() < critChance;
  let damage = rollAttack(attacker, defender, crit);
  // cycle1 analytics: mean lethal hit 6.6 one-shotting Lv1 — soft-cap non-crits on players
  // so orcs/goblins hurt hard without always deleting starting HP in one swing.
  // Crits and bosses remain fully cruel.
  if (!attacker.isPlayer && defender.isPlayer && !crit && !attacker.traits?.includes("boss")) {
    const cap = Math.max(5, Math.floor(defender.maxHp * 0.4));
    if (damage > cap) damage = cap;
  }
  defender.hp -= damage;
  const killed = defender.hp <= 0;
  const verb = severityVerb(damage, defender.maxHp);
  const wVerb = weaponVerb(options.weaponName);

  let message: string;
  if (attacker.isPlayer) {
    if (crit) {
      message = killed
        ? `CRITICAL! You ${wVerb} the ${defender.name} for ${damage} — it dies!`
        : `CRITICAL! You ${wVerb} the ${defender.name} for ${damage} damage!`;
    } else if (killed) {
      message = pick([
        `You ${verb} the ${defender.name} for ${damage} — it dies!`,
        `You fell the ${defender.name} (${damage} dmg)!`,
        `The ${defender.name} collapses under your ${wVerb} (${damage})!`,
      ]);
    } else {
      message = `You ${verb} the ${defender.name} for ${damage} damage.`;
    }
  } else {
    const verb3 = conjugateVerb(verb);
    if (crit) {
      message = killed
        ? `The ${attacker.name} CRITICAL hits you for ${damage} — you die!`
        : `The ${attacker.name} CRITICAL hits you for ${damage} damage!`;
    } else if (killed) {
      message = `The ${attacker.name} ${verb3} you for ${damage} — you die!`;
    } else {
      message = `The ${attacker.name} ${verb3} you for ${damage} damage.`;
    }
  }

  return { hit: true, damage, killed, critical: crit, message };
}

/**
 * Shared XP / level-up (SP + MMO). cycle1: bots reached d5 still Lv1 —
 * XP path existed but threshold + kill rate never paid; also keep one codepath.
 * Returns level-up messages (may be empty).
 */
export function applyXpGain(player: PlayerState, amount: number): string[] {
  if (amount <= 0) return [];
  const msgs: string[] = [];
  player.xp += amount;
  while (player.xp >= player.xpToLevel) {
    player.xp -= player.xpToLevel;
    player.level += 1;
    // Softer growth than ×1.5 so L2→L3 still reachable mid-early game
    player.xpToLevel = Math.max(12, Math.floor(player.xpToLevel * 1.4));
    player.entity.maxHp += 5;
    player.entity.hp = player.entity.maxHp;
    player.entity.attack += 1;
    player.entity.defense += 1;
    msgs.push(`You ascend to level ${player.level}!`);
  }
  return msgs;
}

export function playerAttackBonus(player: PlayerState): number {
  const w = player.equippedWeapon;
  let bonus = 0;
  if (w) {
    // Cursed weapons fight you — still usable but weaker
    bonus += w.cursed || w.buc === "cursed" ? Math.max(0, w.power - 2) : w.power;
  }
  const ring = player.equippedRing;
  if (ring?.ringEffect === "adornment" && ring.identified) {
    bonus += ring.cursed || ring.buc === "cursed" ? 0 : 1;
  }
  return bonus;
}

export function playerDefenseBonus(player: PlayerState): number {
  let bonus = 0;
  const a = player.equippedArmor;
  if (a) {
    bonus += a.cursed || a.buc === "cursed" ? Math.max(0, a.power - 2) : a.power;
  }
  const ring = player.equippedRing;
  if (ring?.ringEffect === "protection") {
    const p = ring.power || 1;
    bonus += ring.cursed || ring.buc === "cursed" ? Math.max(0, p - 1) : p;
  }
  if (ring?.ringEffect === "stealth" && !(ring.cursed || ring.buc === "cursed")) {
    bonus += 1;
  }
  return bonus;
}

/** Extra hunger drain from a worn ring of hunger (call from end-of-turn). */
export function ringHungerDrain(player: PlayerState): number {
  const ring = player.equippedRing;
  if (!ring || ring.ringEffect !== "hunger") return 0;
  return ring.cursed || ring.buc === "cursed" ? 4 : 2;
}

/** Silent regen from ring of regeneration. */
export function tickRingRegen(player: PlayerState): boolean {
  const ring = player.equippedRing;
  if (!ring || ring.ringEffect !== "regeneration") return false;
  if (ring.cursed || ring.buc === "cursed") return false;
  if (player.entity.hp >= player.entity.maxHp) return false;
  player.entity.hp = Math.min(player.entity.maxHp, player.entity.hp + 1);
  return true;
}

export function effectivePlayerEntity(player: PlayerState): Entity {
  const e = { ...player.entity };
  e.attack += playerAttackBonus(player);
  e.defense += playerDefenseBonus(player);
  const mod = hungerCombatMod(player.hungerState);
  e.attack = Math.max(1, e.attack + mod.attack);
  e.defense = Math.max(0, e.defense + mod.defense);
  // Poison saps offense slightly
  if (player.statuses?.some((s) => s.kind === "poison")) {
    e.attack = Math.max(1, e.attack - 1);
  }
  return e;
}

/** Hit penalty for the player's next swing (hunger / status). */
export function playerHitPenalty(player: PlayerState): number {
  return hungerCombatMod(player.hungerState).hitPenalty;
}

export function hungerDamage(state: string): number {
  switch (state) {
    case "weak":
      return 1;
    case "fainting":
      return 2;
    case "starving":
      return 3;
    default:
      return 0;
  }
}

export function updateHungerState(player: PlayerState): string | null {
  const ratio = player.hunger / player.maxHunger;
  const prev = player.hungerState;

  if (ratio > 0.8) player.hungerState = "satiated";
  else if (ratio > 0.5) player.hungerState = "normal";
  else if (ratio > 0.3) player.hungerState = "hungry";
  else if (ratio > 0.15) player.hungerState = "weak";
  else if (ratio > 0.05) player.hungerState = "fainting";
  else player.hungerState = "starving";

  if (
    prev !== player.hungerState &&
    player.hungerState !== "normal" &&
    player.hungerState !== "satiated"
  ) {
    return `You are ${player.hungerState}.`;
  }
  return null;
}

/** Once you know a red potion is healing, all red potions in pack identify. */
export function autoIdentifyMatchingPotions(
  player: PlayerState,
  appearance: string | undefined,
  effect: PotionEffect
): number {
  if (!appearance) return 0;
  let n = 0;
  for (const it of player.inventory) {
    if (it.type !== "potion" || it.identified) continue;
    if (it.appearance !== appearance) continue;
    it.identified = true;
    it.effect = effect;
    it.name = POTION_TRUE_NAMES[effect];
    n++;
  }
  return n;
}

/** Matching scroll labels auto-identify after one is read. */
export function autoIdentifyMatchingScrolls(
  player: PlayerState,
  appearance: string | undefined,
  scrollEffect: ScrollEffect
): number {
  if (!appearance) return 0;
  let n = 0;
  for (const it of player.inventory) {
    if (it.type !== "scroll" || it.identified) continue;
    if (it.appearance !== appearance) continue;
    it.identified = true;
    it.scrollEffect = scrollEffect;
    it.name = SCROLL_TRUE_NAMES[scrollEffect];
    n++;
  }
  return n;
}

/** Matching ring materials auto-identify after one is worn/identified. */
export function autoIdentifyMatchingRings(
  player: PlayerState,
  appearance: string | undefined,
  ringEffect: RingEffect
): number {
  if (!appearance) return 0;
  let n = 0;
  const consider = [...player.inventory];
  if (player.equippedRing) consider.push(player.equippedRing);
  for (const it of consider) {
    if (it.type !== "ring" || it.identified) continue;
    if (it.appearance !== appearance) continue;
    it.identified = true;
    it.ringEffect = ringEffect;
    it.name = RING_TRUE_NAMES[ringEffect];
    n++;
  }
  return n;
}

/** Matching wand materials auto-identify after one is zapped/identified. */
export function autoIdentifyMatchingWands(
  player: PlayerState,
  appearance: string | undefined,
  wandEffect: WandEffect
): number {
  if (!appearance) return 0;
  let n = 0;
  for (const it of player.inventory) {
    if (it.type !== "wand" || it.identified) continue;
    if (it.appearance !== appearance) continue;
    it.identified = true;
    it.wandEffect = wandEffect;
    it.name = WAND_TRUE_NAMES[wandEffect];
    n++;
  }
  return n;
}

function itemIsCursed(item: { cursed?: boolean; buc?: BucStatus }): boolean {
  return item.cursed === true || item.buc === "cursed";
}

function itemIsBlessed(item: { buc?: BucStatus }): boolean {
  return item.buc === "blessed";
}

// ─── Monster specials (shared client + server) ───────────────────────────────

/** Troll / dragon / lich regen — silent heal; return true if healed. */
export function tickMonsterRegen(monster: Entity): boolean {
  if (monster.hp <= 0) return false;
  if (!monster.traits?.includes("regenerate")) return false;
  if (monster.hp >= monster.maxHp) return false;
  const amount =
    monster.kind === "dragon" ? 2 : monster.kind === "troll" || monster.kind === "lich" ? 2 : 1;
  // Enraged bosses regenerate faster
  const bonus = monster.enraged ? 1 : 0;
  monster.hp = Math.min(monster.maxHp, monster.hp + amount + bonus);
  return true;
}

/**
 * Dragon (and similar) breath at range 2–6.
 * Ignores half of target defense — armor helps less vs fire.
 */
export function tryBreathAttack(
  monster: Entity,
  player: PlayerState,
  dist: number
): CombatResult | null {
  if (monster.hp <= 0) return null;
  if (!monster.traits?.includes("breath")) return null;
  if (dist < 2 || dist > 6) return null;

  const cd = monster.specialCooldown ?? 0;
  if (cd > 0) {
    monster.specialCooldown = cd - 1;
    return null;
  }

  // ~45% chance when eligible; enraged always tries
  if (!monster.enraged && Math.random() > 0.45) return null;

  monster.specialCooldown = monster.enraged ? 2 : 3;

  const eff = effectivePlayerEntity(player);
  const halfDef = Math.floor(eff.defense / 2);
  const base = Math.max(3, monster.attack - halfDef);
  const variance = Math.floor(Math.random() * 4); // 0..3
  let damage = base + variance;
  if (monster.enraged) damage = Math.floor(damage * 1.25);

  player.entity.hp -= damage;
  const killed = player.entity.hp <= 0;
  if (killed) player.entity.hp = 0;

  const message = killed
    ? `The ${monster.name} bathes you in fire for ${damage} — you die!`
    : `The ${monster.name} breathes fire! You take ${damage} damage!`;

  return {
    hit: true,
    damage,
    killed,
    critical: false,
    message,
  };
}

/**
 * Mind flayer-class psychic blast at range 2–5.
 * Ignores half defense; brief stun (immobilize) on non-lethal hits.
 * Shares specialCooldown with breath — one special channel per monster.
 */
export function tryMindBlast(
  monster: Entity,
  player: PlayerState,
  dist: number,
  rng: () => number = Math.random
): CombatResult | null {
  if (monster.hp <= 0) return null;
  if (!monster.traits?.includes("mind_blast")) return null;
  if (dist < 2 || dist > 5) return null;

  const cd = monster.specialCooldown ?? 0;
  if (cd > 0) {
    monster.specialCooldown = cd - 1;
    return null;
  }

  // ~40% when eligible; enraged / unique always tries
  if (!monster.enraged && !monster.traits.includes("unique") && rng() > 0.4) return null;

  monster.specialCooldown = monster.enraged || monster.traits.includes("unique") ? 2 : 3;

  const eff = effectivePlayerEntity(player);
  const halfDef = Math.floor(eff.defense / 2);
  const base = Math.max(2, monster.attack - halfDef - 1);
  const variance = Math.floor(rng() * 3); // 0..2
  let damage = base + variance;
  if (monster.enraged) damage = Math.floor(damage * 1.2);

  player.entity.hp -= damage;
  const killed = player.entity.hp <= 0;
  if (killed) {
    player.entity.hp = 0;
    player.alive = false;
    player.deathCause = `Mind blasted by a ${monster.name}`;
  } else {
    // Brief psychic stun — reuses trap immobilize channel
    const stun = monster.traits.includes("unique") ? 2 : 1;
    player.immobilizedTurns = Math.max(player.immobilizedTurns ?? 0, stun);
  }

  const message = killed
    ? `The ${monster.name} invades your mind for ${damage} — you die!`
    : `The ${monster.name} blasts your mind! You take ${damage} damage and reel!`;

  return {
    hit: true,
    damage,
    killed,
    critical: false,
    message,
  };
}

/**
 * Unified ranged special: breath OR mind blast (mutually exclusive per turn via cooldown).
 * Prefer breath when both present (dragons); mind flayers/liches use mind_blast.
 */
export function tryRangedSpecial(
  monster: Entity,
  player: PlayerState,
  dist: number
): CombatResult | null {
  if (monster.traits?.includes("breath")) {
    return tryBreathAttack(monster, player, dist);
  }
  if (monster.traits?.includes("mind_blast")) {
    return tryMindBlast(monster, player, dist);
  }
  return null;
}

/**
 * Nymph-class theft — inventory item preferred, else gold.
 * Returns flavor message or null if nothing stolen this hit.
 */
export function tryStealFromPlayer(
  monster: Entity,
  player: PlayerState,
  rng: () => number = Math.random
): string | null {
  if (monster.hp <= 0) return null;
  if (!monster.traits?.includes("steal")) return null;
  // ~42% per hit — frequent enough to force inventory discipline
  if (rng() > 0.42) return null;

  // Leprechaun (nymph-class): prefer gold first
  const goldFirst = monster.kind === "leprechaun";
  if (goldFirst && player.gold > 0) {
    const take = Math.min(player.gold, 8 + Math.floor(rng() * 25));
    player.gold -= take;
    return `The ${monster.name} filches ${take} gold!`;
  }

  if (player.inventory.length > 0) {
    const idx = Math.floor(rng() * player.inventory.length);
    const stolen = player.inventory.splice(idx, 1)[0];
    const label = itemDisplayName(stolen);
    return `The ${monster.name} steals your ${label}!`;
  }

  if (player.gold > 0) {
    const take = Math.min(player.gold, 5 + Math.floor(rng() * 20));
    player.gold -= take;
    return `The ${monster.name} filches ${take} gold!`;
  }

  return `The ${monster.name} gropes for loot but finds nothing.`;
}

/**
 * Floating-eye gaze — immobilize briefly on hit (mobility tax, low DPS).
 */
export function tryGazeStun(
  monster: Entity,
  player: PlayerState,
  rng: () => number = Math.random
): string | null {
  if (monster.hp <= 0) return null;
  if (!monster.traits?.includes("gaze")) return null;
  // ~45% — frequent enough to teach "don't facetank eyes"
  if (rng() > 0.45) return null;
  const stun = monster.kind === "floating_eye" ? 2 : 1;
  player.immobilizedTurns = Math.max(player.immobilizedTurns ?? 0, stun);
  return `The ${monster.name}'s gaze freezes you!`;
}

/**
 * Reveal a disguised mimic — restores true glyph and clears hiddenAs.
 * Safe to call repeatedly (no-op if already revealed).
 */
export function revealMimic(monster: Entity): string | null {
  if (!monster.hiddenAs && monster.trueChar == null) return null;
  const fake = monster.hiddenAs?.name ?? "object";
  monster.char = monster.trueChar ?? (monster.kind === "mimic" ? "m" : monster.char);
  if (monster.kind === "mimic") {
    monster.char = "m";
    monster.color = "#8a7a5a";
  }
  monster.hiddenAs = undefined;
  monster.trueChar = undefined;
  monster.ai = "hunt";
  return `The ${fake} was a mimic!`;
}

/**
 * Mimic-class ambush — one-shot surprise damage on first successful engagement.
 * Also reveals disguise. Ambush flag via specialCooldown === 0 then set to 99.
 */
export function tryAmbushBonus(
  monster: Entity,
  player: PlayerState,
  rng: () => number = Math.random
): string | null {
  if (monster.hp <= 0) return null;
  const isAmbush =
    monster.traits?.includes("ambush") || monster.traits?.includes("mimic");
  if (!isAmbush) return null;

  const parts: string[] = [];
  const reveal = revealMimic(monster);
  if (reveal) parts.push(reveal);

  // One-shot ambush damage only when ambush trait and not yet spent
  if (monster.traits?.includes("ambush") && (monster.specialCooldown ?? 0) === 0) {
    const bonus = 2 + Math.floor(rng() * 4); // 2–5
    monster.specialCooldown = 99; // spent for the rest of the fight
    monster.ai = "hunt";
    player.entity.hp -= bonus;
    if (player.entity.hp <= 0) {
      player.entity.hp = 0;
      player.alive = false;
      player.deathCause = `Ambushed by a ${monster.name}`;
    }
    parts.push(`Surprise attack (−${bonus} HP)!`);
  } else if (reveal) {
    monster.ai = "hunt";
  } else if ((monster.specialCooldown ?? 0) > 0) {
    // Already spent, nothing left to do
    return null;
  }

  return parts.length ? parts.join(" ") : null;
}

/**
 * Ooze-class acid — 25% chance to degrade equipped armor power by 1.
 * Gear fear without one-shotting the player.
 */
export function tryAcidArmor(
  monster: Entity,
  player: PlayerState,
  rng: () => number = Math.random
): string | null {
  if (monster.hp <= 0) return null;
  if (!monster.traits?.includes("acid")) return null;
  if (rng() > 0.25) return null;

  const armor = player.equippedArmor;
  if (!armor) {
    return `The ${monster.name}'s acid hisses harmlessly on your bare skin.`;
  }
  const before = armor.power;
  armor.power = Math.max(0, armor.power - 1);
  if (armor.power < before) {
    return `The ${monster.name}'s acid eats your ${armor.name}! (armor −1)`;
  }
  return `The ${monster.name}'s acid spatters your ruined ${armor.name}.`;
}

/**
 * Lich-class summon — spawn a skeleton minion on cooldown.
 * Returns the minion entity (caller must place on floor map) or null.
 * Shares specialCooldown with other specials (mind_blast takes priority if both fire).
 */
export function trySummonMinion(
  monster: Entity,
  depth: number,
  openTile: { x: number; y: number } | null,
  createMinion: (kind: "skeleton", x: number, y: number, depth: number) => Entity,
  rng: () => number = Math.random
): { minion: Entity; message: string } | null {
  if (monster.hp <= 0) return null;
  if (!monster.traits?.includes("summon")) return null;
  if (!openTile) return null;

  const cd = monster.specialCooldown ?? 0;
  if (cd > 0) {
    // Do not steal cooldown ticks from breath/mind_blast here — only gate.
    return null;
  }

  // ~30% when ready; enraged/unique more eager
  const chance = monster.enraged || monster.traits.includes("unique") ? 0.45 : 0.3;
  if (rng() > chance) return null;

  monster.specialCooldown = monster.enraged ? 4 : 6;
  const minion = createMinion("skeleton", openTile.x, openTile.y, depth);
  minion.name = "summoned skeleton";
  // Weaker thrall
  minion.hp = Math.max(1, Math.floor(minion.hp * 0.7));
  minion.maxHp = minion.hp;
  minion.ai = "hunt";
  return {
    minion,
    message: `The ${monster.name} gestures — a skeleton rises!`,
  };
}

/** Low-HP boss phase — permanent until death. Uniques also enrage. */
export function checkBossEnrage(monster: Entity): string | null {
  if (monster.hp <= 0) return null;
  const canEnrage =
    monster.traits?.includes("boss") || monster.traits?.includes("unique");
  if (!canEnrage) return null;
  if (monster.enraged) return null;
  if (monster.hp > monster.maxHp * 0.4) return null;
  monster.enraged = true;
  monster.attack = Math.max(monster.attack + 2, Math.floor(monster.attack * 1.3));
  monster.ai = "hunt";
  const verb = monster.traits?.includes("unique") ? "shrieks" : "roars";
  return `The ${monster.name} ${verb} in fury — it is enraged!`;
}

/**
 * NetHack-grade level drain — wraiths (and any level_drain trait) can steal a level.
 * Call after a successful melee hit against the player (independent of poison).
 */
export function tryLevelDrain(
  monster: Entity,
  player: PlayerState,
  rng: () => number = Math.random
): string | null {
  const drains =
    monster.traits?.includes("level_drain") || monster.kind === "wraith";
  if (!drains || monster.hp <= 0) return null;
  // ~28% per hit — frequent enough to force engagement discipline
  if (rng() > 0.28) return null;

  if (player.level > 1) {
    player.level -= 1;
    player.entity.maxHp = Math.max(8, player.entity.maxHp - 4);
    player.entity.hp = Math.min(player.entity.hp, player.entity.maxHp);
    player.entity.attack = Math.max(1, player.entity.attack - 1);
    player.entity.defense = Math.max(0, player.entity.defense - 1);
    player.xp = Math.floor(player.xp * 0.4);
    // Soften next level-up requirement so recovery is possible but costly
    player.xpToLevel = Math.max(20, Math.floor(player.xpToLevel / 1.45));
    return `The ${monster.name} drains your life force! You fall to level ${player.level}!`;
  }

  // Level 1: permanent essence drain (cannot go below level 1)
  const lost = Math.min(3, Math.max(1, Math.floor(player.entity.maxHp * 0.12)));
  player.entity.maxHp = Math.max(4, player.entity.maxHp - lost);
  player.entity.hp = Math.min(player.entity.hp, player.entity.maxHp);
  if (player.entity.hp <= 0) {
    player.entity.hp = 0;
    player.alive = false;
    player.deathCause = `Drained dry by a ${monster.name}`;
  }
  return `The ${monster.name} saps your essence (−${lost} max HP)!`;
}

/**
 * On-hit monster → player effects (poison, level drain, ambush, steal).
 * Call after a successful melee hit against the player.
 */
export function tryApplyMonsterOnHit(monster: Entity, player: PlayerState): string | null {
  const parts: string[] = [];

  // Mimic ambush fires first (one-shot bonus damage)
  const ambush = tryAmbushBonus(monster, player);
  if (ambush) parts.push(ambush);
  if (!player.alive) return parts.length ? parts.join(" ") : null;

  if (monster.traits?.includes("poisonous")) {
    // 40% chance; wraiths more reliable; swarm insects a bit stickier
    const chance =
      monster.kind === "wraith" ? 0.55 : monster.traits.includes("swarm") ? 0.45 : 0.38;
    if (Math.random() <= chance) {
      if (!player.statuses) player.statuses = [];
      const power = monster.kind === "wraith" ? 2 : monster.traits.includes("swarm") ? 1 : 1;
      const existing = player.statuses.find((s) => s.kind === "poison");
      if (existing) {
        existing.turnsLeft = Math.max(existing.turnsLeft, 4 + Math.floor(Math.random() * 3));
        existing.power = Math.max(existing.power, power);
      } else {
        player.statuses.push({
          kind: "poison",
          turnsLeft: 4 + Math.floor(Math.random() * 3),
          power,
        });
      }
      parts.push(
        monster.kind === "wraith"
          ? "Chill venom seeps into your veins!"
          : monster.kind === "killer_bee" || monster.kind === "insect"
            ? "The stinger burns — venom in your blood!"
            : "You feel poison coursing through you!"
      );
    }
  }

  const steal = tryStealFromPlayer(monster, player);
  if (steal) parts.push(steal);

  const gaze = tryGazeStun(monster, player);
  if (gaze) parts.push(gaze);

  const acid = tryAcidArmor(monster, player);
  if (acid) parts.push(acid);

  const drain = tryLevelDrain(monster, player);
  if (drain) parts.push(drain);

  return parts.length ? parts.join(" ") : null;
}

/**
 * Pack / swarm hunters aim for open flanks of the prey instead of dogpiling one approach tile.
 * Returns chase aim point (x,y) — a free cardinally-adjacent flank or the prey itself.
 */
export function packChaseTarget(
  mx: number,
  my: number,
  tx: number,
  ty: number,
  isBlocked: (x: number, y: number) => boolean
): { x: number; y: number } {
  const flanks = [
    { x: tx + 1, y: ty },
    { x: tx - 1, y: ty },
    { x: tx, y: ty + 1 },
    { x: tx, y: ty - 1 },
  ];
  // Already on a flank — close for the kill
  if (flanks.some((f) => f.x === mx && f.y === my)) {
    return { x: tx, y: ty };
  }
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (const f of flanks) {
    if (isBlocked(f.x, f.y)) continue;
    const d = Math.abs(f.x - mx) + Math.abs(f.y - my);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best ?? { x: tx, y: ty };
}

/**
 * Prefer the longer axis first (better corridor pathing), then alternate.
 * tryStep returns true if the step was taken.
 */
export function chooseStepToward(
  mx: number,
  my: number,
  tx: number,
  ty: number,
  tryStep: (dx: number, dy: number) => boolean
): boolean {
  const dx = Math.sign(tx - mx);
  const dy = Math.sign(ty - my);
  const adx = Math.abs(tx - mx);
  const ady = Math.abs(ty - my);
  if (adx >= ady) {
    if (dx && tryStep(dx, 0)) return true;
    if (dy && tryStep(0, dy)) return true;
  } else {
    if (dy && tryStep(0, dy)) return true;
    if (dx && tryStep(dx, 0)) return true;
  }
  // Sidestep when blocked head-on (pack mobility / corridor juke)
  if (dx) {
    if (tryStep(dx, 0)) return true;
  }
  if (dy) {
    if (tryStep(0, dy)) return true;
  }
  if (dx && tryStep(0, 1)) return true;
  if (dx && tryStep(0, -1)) return true;
  if (dy && tryStep(1, 0)) return true;
  if (dy && tryStep(-1, 0)) return true;
  return false;
}

/** End-of-turn status damage (poison). */
export function tickPlayerStatuses(player: PlayerState): string | null {
  if (!player.statuses || player.statuses.length === 0) return null;
  const msgs: string[] = [];
  const remain: StatusEffect[] = [];

  for (const s of player.statuses) {
    if (s.kind === "poison") {
      const dmg = s.power;
      player.entity.hp -= dmg;
      msgs.push(`Poison burns you (−${dmg} HP).`);
      s.turnsLeft -= 1;
      if (s.turnsLeft > 0) remain.push(s);
      else msgs.push("The poison fades.");
      if (player.entity.hp <= 0) {
        player.entity.hp = 0;
        player.alive = false;
        player.deathCause = "Succumbed to poison";
      }
    } else if (s.turnsLeft > 1) {
      s.turnsLeft -= 1;
      remain.push(s);
    }
  }
  player.statuses = remain;
  return msgs.length ? msgs.join(" ") : null;
}

// ─── Items / potions / scrolls / rings / identify ────────────────────────────

function applyPotionEffect(
  player: PlayerState,
  effect: PotionEffect,
  power: number,
  buc?: BucStatus
): string {
  const blessed = buc === "blessed";
  const cursed = buc === "cursed";
  const scale = blessed ? 1.4 : cursed ? 0.65 : 1;

  switch (effect) {
    case "healing": {
      const heal = Math.max(6, Math.floor(power * scale));
      const before = player.entity.hp;
      const underPressure = before <= player.entity.maxHp * 0.4;
      player.entity.hp = Math.min(player.entity.maxHp, player.entity.hp + heal);
      if (player.statuses) {
        player.statuses = player.statuses.filter((s) => s.kind !== "poison");
      }
      const gained = player.entity.hp - before;
      if (underPressure && gained > 0) {
        return blessed
          ? `Desperate, you quaff — and live! Wonderfully better (+${gained} HP).`
          : `Desperate, you quaff — healing! You feel better (+${gained} HP).`;
      }
      return blessed
        ? `You feel wonderfully better (+${gained} HP).`
        : `You feel better (+${gained} HP).`;
    }
    case "extra_healing": {
      const heal = Math.max(14, Math.floor(power * 2 * scale));
      const before = player.entity.hp;
      player.entity.hp = Math.min(player.entity.maxHp, player.entity.hp + heal);
      if (player.statuses) {
        player.statuses = player.statuses.filter((s) => s.kind !== "poison");
      }
      if (player.entity.hp === player.entity.maxHp && Math.random() < (blessed ? 0.55 : 0.35)) {
        player.entity.maxHp += blessed ? 2 : 1;
        player.entity.hp = player.entity.maxHp;
        return `You feel thoroughly restored! Max HP +${blessed ? 2 : 1}.`;
      }
      const gained = player.entity.hp - before;
      return `You feel much better (+${gained} HP)!`;
    }
    case "poison": {
      // Deadly mistake: BUC and power scale the pain
      const mult = cursed ? 1.5 : blessed ? 0.5 : 1;
      const dmg = Math.max(4, Math.floor(power * 0.65 * mult));
      player.entity.hp -= dmg;
      if (!player.statuses) player.statuses = [];
      player.statuses.push({
        kind: "poison",
        turnsLeft: cursed ? 7 : blessed ? 2 : 5,
        power: cursed ? 3 : 2,
      });
      if (player.entity.hp <= 0) {
        player.entity.hp = 0;
        player.alive = false;
        player.deathCause = "Drank a potion of poison";
        return `The potion was poison! You take ${dmg} damage and collapse...`;
      }
      return `Ugh! Poison burns your throat (−${dmg} HP). You are poisoned!`;
    }
    case "strength": {
      const gain = blessed ? 2 : cursed ? 0 : 1;
      if (gain === 0) return "You feel momentarily strong, then nothing. (Cursed.)";
      player.entity.attack += gain;
      return `Power courses through your muscles! Attack +${gain}.`;
    }
    case "nutrition": {
      const food = Math.floor((350 + power * 10) * scale);
      player.hunger = Math.min(player.maxHunger, player.hunger + food);
      updateHungerState(player);
      return cursed
        ? "The liquid is greasy and unsatisfying."
        : "The liquid is thick and filling. Hunger restored.";
    }
    case "speed": {
      if (cursed) {
        player.entity.defense = Math.max(0, player.entity.defense - 1);
        return "You feel sluggish! Defense −1.";
      }
      player.entity.defense += 1;
      player.hunger = Math.min(player.maxHunger, player.hunger + 40);
      return "Time seems to slow. You feel quick! Defense +1.";
    }
    case "invisibility": {
      if (cursed) {
        // "aggravating" shimmer
        player.entity.defense = Math.max(0, player.entity.defense - 1);
        return "You glow brightly — monsters will notice! Defense −1.";
      }
      player.entity.defense += 1;
      return "You shimmer and fade. Harder to hit! Defense +1.";
    }
    default:
      return "You feel strange.";
  }
}

function resolveScrollEffect(item: { name: string; scrollEffect?: ScrollEffect }): ScrollEffect {
  if (item.scrollEffect) return item.scrollEffect;
  const n = item.name.toLowerCase();
  if (n.includes("identify")) return "identify";
  if (n.includes("remove curse")) return "remove_curse";
  if (n.includes("enchant")) return "enchant_weapon";
  if (n.includes("teleport")) return "teleport";
  if (n.includes("mapping")) return "magic_mapping";
  if (n.includes("fire")) return "fire";
  if (n.includes("amnesia")) return "amnesia";
  if (n.includes("create monster")) return "create_monster";
  return "identify";
}

function applyScrollEffect(
  player: PlayerState,
  effect: ScrollEffect,
  itemIndex: number,
  buc?: BucStatus
): string {
  const blessed = buc === "blessed";
  const cursed = buc === "cursed";

  switch (effect) {
    case "identify": {
      const unidentified = player.inventory.filter((i, idx) => idx !== itemIndex && !i.identified);
      const equippedUnknown = [
        player.equippedWeapon,
        player.equippedArmor,
        player.equippedRing,
      ].filter((i): i is NonNullable<typeof i> => !!i && !i.identified);
      const pool = [...unidentified, ...equippedUnknown];
      player.inventory.splice(itemIndex, 1);
      if (pool.length === 0) {
        return "You read the scroll of identify. Nothing left to reveal.";
      }
      const count = blessed ? Math.min(3, pool.length) : 1;
      const revealed: string[] = [];
      for (let k = 0; k < count; k++) {
        const idx = Math.floor(Math.random() * pool.length);
        const target = pool.splice(idx, 1)[0];
        fullyIdentify(target);
        if (target.type === "potion" && target.effect) {
          autoIdentifyMatchingPotions(player, target.appearance, target.effect);
        } else if (target.type === "scroll" && target.scrollEffect) {
          autoIdentifyMatchingScrolls(player, target.appearance, target.scrollEffect);
        } else if (target.type === "ring" && target.ringEffect) {
          autoIdentifyMatchingRings(player, target.appearance, target.ringEffect);
        } else if (target.type === "wand" && target.wandEffect) {
          autoIdentifyMatchingWands(player, target.appearance, target.wandEffect);
        }
        revealed.push(itemDisplayName(target));
      }
      return `You read the scroll of identify. It reveals: ${revealed.join("; ")}.`;
    }
    case "remove_curse": {
      let fixed = 0;
      const cleanse = (it: { cursed?: boolean; buc?: BucStatus; bucKnown?: boolean; identified?: boolean } | null) => {
        if (!it) return;
        if (itemIsCursed(it)) {
          it.cursed = false;
          it.buc = "uncursed";
          it.bucKnown = true;
          fixed++;
        }
      };
      cleanse(player.equippedWeapon);
      cleanse(player.equippedArmor);
      cleanse(player.equippedRing);
      for (const it of player.inventory) cleanse(it);
      player.inventory.splice(itemIndex, 1);
      if (fixed === 0) return "You read the scroll of remove curse. Nothing was cursed.";
      return `You read the scroll of remove curse. ${fixed} item${fixed > 1 ? "s" : ""} cleansed!`;
    }
    case "enchant_weapon": {
      player.inventory.splice(itemIndex, 1);
      if (!player.equippedWeapon) {
        return "You read the scroll of enchant weapon. You have nothing to enchant.";
      }
      if (itemIsCursed(player.equippedWeapon) && !blessed) {
        return "Your cursed weapon rejects the enchantment.";
      }
      const gain = blessed ? 3 : cursed ? 1 : 2;
      if (itemIsCursed(player.equippedWeapon) && blessed) {
        player.equippedWeapon.cursed = false;
        player.equippedWeapon.buc = "uncursed";
        player.equippedWeapon.bucKnown = true;
      }
      player.equippedWeapon.power += gain;
      player.equippedWeapon.identified = true;
      return `Your ${player.equippedWeapon.name} glows with power! (+${gain})`;
    }
    case "teleport": {
      player.inventory.splice(itemIndex, 1);
      if (cursed) {
        // Hostile "teleport" — damage as reality tears
        const dmg = 2 + Math.floor(Math.random() * 4);
        player.entity.hp -= dmg;
        if (player.entity.hp <= 0) {
          player.entity.hp = 0;
          player.alive = false;
          player.deathCause = "Cursed teleportation mishap";
          return `The cursed scroll tears space around you (−${dmg})! You die!`;
        }
        return `The cursed scroll lurches you through space (−${dmg} HP)!`;
      }
      return "You read the scroll of teleportation. The world blurs... (stand still — you feel displaced).";
    }
    case "magic_mapping": {
      player.inventory.splice(itemIndex, 1);
      if (cursed) {
        // Partial / painful map
        const dmg = 1 + Math.floor(Math.random() * 3);
        player.entity.hp = Math.max(1, player.entity.hp - dmg);
        return "SCROLL_MAGIC_MAPPING"; // still maps, but message handled by caller + pain
      }
      return "SCROLL_MAGIC_MAPPING";
    }
    case "fire": {
      player.inventory.splice(itemIndex, 1);
      const dmg = blessed ? 2 : cursed ? 8 + Math.floor(Math.random() * 6) : 4 + Math.floor(Math.random() * 5);
      player.entity.hp -= dmg;
      // Destroy a random non-equipped inventory item (scroll of fire classic)
      let destroyed = "";
      if (player.inventory.length > 0 && Math.random() < (cursed ? 0.7 : 0.4)) {
        const di = Math.floor(Math.random() * player.inventory.length);
        destroyed = itemDisplayName(player.inventory[di]);
        player.inventory.splice(di, 1);
      }
      if (player.entity.hp <= 0) {
        player.entity.hp = 0;
        player.alive = false;
        player.deathCause = "Burned by a scroll of fire";
        return `The scroll erupts in flames (−${dmg})! You burn to death.`;
      }
      const lose = destroyed ? ` Your ${destroyed} is incinerated!` : "";
      return `The scroll erupts in flames! You take ${dmg} damage.${lose}`;
    }
    case "amnesia": {
      player.inventory.splice(itemIndex, 1);
      // Un-identify random known items — knowledge loss is the risk
      const known = player.inventory.filter((i) => i.identified);
      let wiped = 0;
      const wipeCount = cursed ? 3 : blessed ? 1 : 2;
      for (let k = 0; k < wipeCount && known.length > 0; k++) {
        const idx = Math.floor(Math.random() * known.length);
        const t = known.splice(idx, 1)[0];
        t.identified = false;
        t.bucKnown = false;
        if (t.type === "potion" && t.appearance) t.name = `${t.appearance} potion`;
        else if (t.type === "scroll" && t.appearance) t.name = `scroll labeled ${t.appearance}`;
        else if (t.type === "ring" && t.appearance) t.name = `${t.appearance} ring`;
        else if (t.type === "wand" && t.appearance) t.name = `${t.appearance} wand`;
        wiped++;
      }
      if (wiped === 0) {
        return "You read the scroll of amnesia. Your mind feels foggy, but nothing slips away.";
      }
      return `You read the scroll of amnesia. You forget the nature of ${wiped} item${wiped > 1 ? "s" : ""}!`;
    }
    case "create_monster": {
      player.inventory.splice(itemIndex, 1);
      // Caller may spawn; we apply stress + signal
      if (cursed) {
        const dmg = 3 + Math.floor(Math.random() * 4);
        player.entity.hp -= dmg;
        if (player.entity.hp <= 0) {
          player.entity.hp = 0;
          player.alive = false;
          player.deathCause = "Torn apart by summoned monsters";
          return `Hideous shapes erupt from the scroll (−${dmg})! You are overwhelmed!`;
        }
        return `SCROLL_CREATE_MONSTER:Hideous shapes pour from the parchment (−${dmg} HP)!`;
      }
      return "SCROLL_CREATE_MONSTER:The scroll summons something nearby!";
    }
    default:
      player.inventory.splice(itemIndex, 1);
      return "You read the scroll. Nothing happens.";
  }
}

function wearRingMessage(effect: RingEffect, cursed: boolean): string {
  switch (effect) {
    case "protection":
      return cursed
        ? "The ring feels brittle. Protection, but flawed."
        : "A ward settles over you. Defense up!";
    case "regeneration":
      return cursed
        ? "The ring is cold and dead — no healing for you."
        : "Warmth pulses in your veins. You will regenerate.";
    case "sustain_ability":
      return "Your body feels steadier.";
    case "searching":
      return "Your eyes sharpen. Secrets feel nearer.";
    case "stealth":
      return cursed
        ? "The ring jingles loudly. Stealth ruined!"
        : "Your footsteps grow soft.";
    case "hunger":
      return "Your stomach growls. This ring will eat at you.";
    case "aggravate":
      return "You feel... noticeable. Monsters will hunt you harder.";
    case "adornment":
      return cursed ? "A gaudy trinket. Useless." : "A fine ring. You look capable (+1 atk).";
    default:
      return "You put on the ring.";
  }
}

/**
 * Apply wand zap effect to the player (self-zap / ray flavor).
 * Digging returns a message token for dungeon handlers; combat stays pure.
 */
function applyWandEffect(
  player: PlayerState,
  effect: WandEffect,
  power: number,
  buc?: BucStatus
): string {
  const blessed = buc === "blessed";
  const cursed = buc === "cursed";
  const scale = blessed ? 1.35 : cursed ? 0.7 : 1;

  switch (effect) {
    case "light":
      return "The wand flashes brilliantly! Light floods the area.";
    case "digging":
      // Token for game/dungeon layer; flavor for the player message log.
      return "WAND_DIGGING:You carve a tunnel of force into the rock!";
    case "striking": {
      // Self-zap damage (no adjacent monster API here) — risky ID game reward when aimed later.
      const dmg = Math.max(3, Math.floor((power + 2) * scale));
      player.entity.hp -= dmg;
      if (player.entity.hp <= 0) {
        player.entity.hp = 0;
        player.alive = false;
        player.deathCause = "Zapped self with a wand of striking";
        return `A bolt of force slams into you (−${dmg})! You die!`;
      }
      return `A bolt of force erupts from the wand (−${dmg} HP)!`;
    }
    case "cold": {
      const dmg = Math.max(2, Math.floor(power * 0.75 * scale));
      player.entity.hp -= dmg;
      if (player.entity.hp <= 0) {
        player.entity.hp = 0;
        player.alive = false;
        player.deathCause = "Frozen by a wand of cold";
        return `A cone of frost engulfs you (−${dmg})! You freeze solid!`;
      }
      return `A cone of frost sprays from the wand (−${dmg} HP)!`;
    }
    case "sleep": {
      // Temporary defense dip as you drowse; blessed is milder
      if (cursed) {
        player.entity.defense = Math.max(0, player.entity.defense - 2);
        return "You collapse into unnatural sleep! Defense −2.";
      }
      if (blessed) {
        player.entity.hp = Math.min(player.entity.maxHp, player.entity.hp + 2);
        return "A gentle drowsiness washes over you. You rest briefly (+2 HP).";
      }
      player.entity.defense = Math.max(0, player.entity.defense - 1);
      return "You feel very sleepy. Defense −1.";
    }
    case "nothing":
      return "Nothing happens. The wand fizzles quietly.";
    case "polymorph": {
      // Lite polymorph: random small stat shuffle, risk of harm
      if (cursed) {
        const dmg = 3 + Math.floor(Math.random() * 4);
        player.entity.hp -= dmg;
        player.entity.attack = Math.max(1, player.entity.attack - 1);
        if (player.entity.hp <= 0) {
          player.entity.hp = 0;
          player.alive = false;
          player.deathCause = "Polymorphed into a corpse";
          return `Your form warps violently (−${dmg})! You die mid-change!`;
        }
        return `Your body warps painfully (−${dmg} HP, Attack −1)!`;
      }
      if (blessed || Math.random() < 0.55) {
        player.entity.attack += 1;
        return "You shimmer and reshape. Muscles denser — Attack +1!";
      }
      player.entity.defense = Math.max(0, player.entity.defense - 1);
      return "You shimmer awkwardly. The change is imperfect (Defense −1).";
    }
    case "secret_door_detection":
      return "WAND_SECRET_DOORS:The wand tingles — secret doors nearby feel obvious.";
    default:
      return "The wand crackles, then falls silent.";
  }
}

/** Cursed wand backfire: explode in hand (NetHack risk). */
function explodeCursedWand(player: PlayerState, power: number): string {
  const dmg = Math.max(5, Math.floor(power * 1.2) + Math.floor(Math.random() * 5));
  player.entity.hp -= dmg;
  if (player.entity.hp <= 0) {
    player.entity.hp = 0;
    player.alive = false;
    player.deathCause = "Killed by a cursed wand exploding";
    return `The cursed wand explodes in your face (−${dmg})! You die!`;
  }
  return `The cursed wand explodes in your hand (−${dmg} HP)!`;
}

/**
 * Eat food/corpse — undead corpses always poison (TICKET-DP-01).
 * Safe-table corpses still risk rot; cruelty preserved.
 */
export function eatFood(player: PlayerState, itemIndex: number): string {
  const item = player.inventory[itemIndex];
  if (!item || item.type !== "food") return "Nothing edible there.";

  const name = itemDisplayName(item);
  const nutrition = item.power;
  player.hunger = Math.min(player.maxHunger, player.hunger + nutrition);
  player.inventory.splice(itemIndex, 1);
  updateHungerState(player);

  if (isCorpseItem(item) && corpseIsUnsafe(item)) {
    // Undead: guaranteed harm — high damage + poison status
    const dmg = 4 + Math.floor(Math.random() * 5); // 4–8
    player.entity.hp -= dmg;
    if (!player.statuses) player.statuses = [];
    const existing = player.statuses.find((s) => s.kind === "poison");
    if (existing) {
      existing.turnsLeft = Math.max(existing.turnsLeft, 5);
      existing.power = Math.max(existing.power, 2);
    } else {
      player.statuses.push({ kind: "poison", turnsLeft: 5, power: 2 });
    }
    if (player.entity.hp <= 0) {
      player.entity.hp = 0;
      player.alive = false;
      player.deathCause = "Ate an undead corpse";
      return `You eat the ${name}. Necrotic flesh tears you apart (−${dmg})! You die!`;
    }
    return `You eat the ${name}. Foul undead flesh burns you (−${dmg} HP)! You are poisoned!`;
  }

  if (isCorpseItem(item)) {
    const risk =
      player.hungerState === "starving" || player.hungerState === "fainting"
        ? 0.28
        : 0.18;
    if (Math.random() < risk) {
      const dmg = 2 + Math.floor(Math.random() * 4);
      player.entity.hp -= dmg;
      if (player.entity.hp <= 0) {
        player.entity.hp = 0;
        player.alive = false;
        player.deathCause = "Food poisoning";
        return `You eat the ${name}. It was rotten! You die of food poisoning.`;
      }
      if (Math.random() < 0.4) {
        if (!player.statuses) player.statuses = [];
        player.statuses.push({ kind: "poison", turnsLeft: 3, power: 1 });
        return `You eat the ${name}. It was half-rotten (−${dmg} HP). You feel ill.`;
      }
      return `You eat the ${name}. It was half-rotten (−${dmg} HP).`;
    }
  }
  return `You eat the ${name}.`;
}

/**
 * Shrine sacrifice lite (TICKET-DP-01):
 * Consume one corpse from inventory → 40% heal / 30% bless weapon / 30% nothing.
 * Roll is optional for tests (0..1).
 */
export function sacrificeCorpse(
  player: PlayerState,
  corpseIndex: number,
  roll = Math.random()
): string {
  const item = player.inventory[corpseIndex];
  if (!item || !isCorpseItem(item)) {
    return "You have no corpse to sacrifice.";
  }

  const offered = itemDisplayName(item);
  player.inventory.splice(corpseIndex, 1);

  if (roll < 0.4) {
    const heal = Math.max(8, Math.floor(player.entity.maxHp * 0.25));
    const before = player.entity.hp;
    player.entity.hp = Math.min(player.entity.maxHp, player.entity.hp + heal);
    // Mild poison cleanse on divine favor
    if (player.statuses) {
      player.statuses = player.statuses.filter((s) => s.kind !== "poison");
    }
    return `You sacrifice the ${offered} on the shrine. Divine warmth restores you (+${player.entity.hp - before} HP).`;
  }

  if (roll < 0.7) {
    if (player.equippedWeapon) {
      player.equippedWeapon.buc = "blessed";
      player.equippedWeapon.bucKnown = true;
      player.equippedWeapon.cursed = false;
      player.equippedWeapon.identified = true;
      // Slight power bump so blessing matters mechanically
      player.equippedWeapon.power += 1;
      return `You sacrifice the ${offered}. Your ${player.equippedWeapon.name} gleams — it is blessed (+1)!`;
    }
    // No weapon: minor permanent attack instead (still a real outcome)
    player.entity.attack += 1;
    return `You sacrifice the ${offered}. Power settles into your bare hands (Attack +1).`;
  }

  // 30% nothing — cruel, corpse gone
  if (corpseIsUnsafe(item)) {
    return `You sacrifice the ${offered}. The shrine recoils at the undead offering. Nothing happens.`;
  }
  return `You sacrifice the ${offered}. The shrine accepts the offering in silence. Nothing happens.`;
}

export type ThroneSitResult = {
  message: string;
  /** Caller should spawn a hostile near the player. */
  summon?: { kind: "orc" | "ogre" | "goblin" };
};

/**
 * Throne sit table (TICKET-DP-01 / §3.2):
 * 40% gold, 25% buff, 20% summon, 15% nothing.
 * Caller enforces 1 sit / player / floor via throneSatDepth.
 */
export function resolveThroneSit(
  player: PlayerState,
  roll = Math.random()
): ThroneSitResult {
  if (roll < 0.4) {
    const gold = 20 + player.depth * 5 + Math.floor(Math.random() * 15);
    player.gold += gold;
    return {
      message: `You sit upon the throne. Coins spill from the fittings (+${gold} gold)!`,
    };
  }
  if (roll < 0.65) {
    // Permanent cruel-game buff (small)
    if (Math.random() < 0.5) {
      player.entity.attack += 1;
      return {
        message: "You sit upon the throne. Royal arrogance strengthens your arm (Attack +1)!",
      };
    }
    player.entity.defense += 1;
    return {
      message: "You sit upon the throne. A crown of force steadies your stance (Defense +1)!",
    };
  }
  if (roll < 0.85) {
    const kind: "orc" | "ogre" | "goblin" =
      player.depth >= 6 ? "ogre" : player.depth >= 3 ? "orc" : "goblin";
    return {
      message: `You sit upon the throne. A ${kind} guardian erupts from the shadows!`,
      summon: { kind },
    };
  }
  return {
    message: "You sit upon the throne. Dust motes drift. Nothing happens.",
  };
}

/** Find first corpse inventory index, or -1. */
export function findCorpseIndex(player: PlayerState): number {
  return player.inventory.findIndex((i) => isCorpseItem(i));
}

export function useItem(player: PlayerState, itemIndex: number): string | null {
  const item = player.inventory[itemIndex];
  if (!item) return "Nothing there.";

  switch (item.type) {
    case "food": {
      return eatFood(player, itemIndex);
    }
    case "potion": {
      const effect: PotionEffect = item.effect ?? "healing";
      const appearance = item.appearance;
      const buc = item.buc;
      item.identified = true;
      // Drinking reveals BUC when harmful or blessed flourish
      if (effect === "poison" || itemIsBlessed(item) || itemIsCursed(item)) {
        item.bucKnown = true;
      }
      item.name = POTION_TRUE_NAMES[effect] ?? item.name;
      player.inventory.splice(itemIndex, 1);
      const matched = autoIdentifyMatchingPotions(player, appearance, effect);
      const result = applyPotionEffect(player, effect, item.power, buc);
      const idNote =
        matched > 0
          ? ` You recognize ${matched} other ${appearance} potion${matched > 1 ? "s" : ""} in your pack.`
          : "";
      return `You quaff the ${itemDisplayName({ ...item, identified: true, effect })}. ${result}${idNote}`;
    }
    case "weapon": {
      if (player.equippedWeapon && itemIsCursed(player.equippedWeapon)) {
        return "Your weapon is cursed and stuck to your hands!";
      }
      if (player.equippedWeapon) {
        player.inventory.push(player.equippedWeapon);
      }
      player.equippedWeapon = item;
      item.identified = true;
      if (itemIsCursed(item)) item.bucKnown = true;
      player.inventory.splice(itemIndex, 1);
      if (itemIsCursed(item)) {
        return `You wield the ${item.name} (+${item.power} atk). It is cursed and welds to your grip!`;
      }
      return `You wield the ${item.name} (+${item.power} atk).`;
    }
    case "armor": {
      if (player.equippedArmor && itemIsCursed(player.equippedArmor)) {
        return "Your armor is cursed and won't come off!";
      }
      if (player.equippedArmor) {
        player.inventory.push(player.equippedArmor);
      }
      player.equippedArmor = item;
      item.identified = true;
      if (itemIsCursed(item)) item.bucKnown = true;
      player.inventory.splice(itemIndex, 1);
      if (itemIsCursed(item)) {
        return `You wear the ${item.name} (+${item.power} def). It is cursed and cinches tight!`;
      }
      return `You wear the ${item.name} (+${item.power} def).`;
    }
    case "ring": {
      if (player.equippedRing && itemIsCursed(player.equippedRing)) {
        return "Your ring is cursed and won't come off!";
      }
      if (player.equippedRing) {
        player.inventory.push(player.equippedRing);
      }
      const effect: RingEffect = item.ringEffect ?? "adornment";
      const appearance = item.appearance;
      player.equippedRing = item;
      item.identified = true;
      item.ringEffect = effect;
      item.name = RING_TRUE_NAMES[effect];
      if (itemIsCursed(item) || effect === "hunger" || effect === "aggravate") {
        item.bucKnown = true;
      }
      player.inventory.splice(itemIndex, 1);
      const matched = autoIdentifyMatchingRings(player, appearance, effect);
      const base = wearRingMessage(effect, itemIsCursed(item));
      const weld = itemIsCursed(item) ? " It welds to your finger!" : "";
      const idNote =
        matched > 0
          ? ` You recognize ${matched} other ${appearance} ring${matched > 1 ? "s" : ""}.`
          : "";
      return `You put on the ${itemDisplayName(item)}. ${base}${weld}${idNote}`;
    }
    case "scroll": {
      const effect = resolveScrollEffect(item);
      const appearance = item.appearance;
      const buc = item.buc;
      // Identify the scroll type as you read it (NetHack: use-ID)
      item.identified = true;
      item.scrollEffect = effect;
      item.name = SCROLL_TRUE_NAMES[effect];
      if (itemIsCursed(item) || itemIsBlessed(item) || effect === "fire" || effect === "amnesia") {
        item.bucKnown = true;
      }
      const matched = autoIdentifyMatchingScrolls(player, appearance, effect);
      const result = applyScrollEffect(player, effect, itemIndex, buc);
      const idNote =
        matched > 0
          ? ` You recognize ${matched} other scroll${matched > 1 ? "s" : ""} labeled ${appearance}.`
          : "";
      // Preserve special tokens for game.ts handlers
      if (result.startsWith("SCROLL_")) {
        return result.includes(":") ? result : result; // mapping / create_monster
      }
      if (result.includes("Nothing left") || result.includes("Nothing was cursed") || result.includes("nothing to enchant")) {
        return result + idNote;
      }
      // Avoid double-consuming: applyScrollEffect already spliced
      return result + idNote;
    }
    case "wand": {
      const charges = item.charges ?? 0;
      if (charges <= 0) {
        // Empty wands stay in pack; still reveal type if somehow known
        if (item.identified && item.wandEffect) {
          return `The ${itemDisplayName(item)} is empty. Nothing happens.`;
        }
        return "The wand is empty. Nothing happens.";
      }

      const effect: WandEffect = item.wandEffect ?? "nothing";
      const appearance = item.appearance;
      const buc = item.buc;
      const power = item.power;

      // Spend a charge before effect / explosion
      item.charges = charges - 1;

      // Cursed wands explode on zap (NetHack risk/reward)
      if (itemIsCursed(item)) {
        item.identified = true;
        item.wandEffect = effect;
        item.name = WAND_TRUE_NAMES[effect];
        item.bucKnown = true;
        const matched = autoIdentifyMatchingWands(player, appearance, effect);
        const boom = explodeCursedWand(player, power);
        // Destroy the wand in the explosion
        player.inventory.splice(itemIndex, 1);
        const idNote =
          matched > 0
            ? ` You recognize ${matched} other ${appearance} wand${matched > 1 ? "s" : ""} in your pack.`
            : "";
        return `${boom} It was a ${WAND_TRUE_NAMES[effect]}.${idNote}`;
      }

      // Use-ID on successful zap
      item.identified = true;
      item.wandEffect = effect;
      item.name = WAND_TRUE_NAMES[effect];
      if (itemIsBlessed(item) || effect === "striking" || effect === "cold" || effect === "polymorph") {
        item.bucKnown = true;
      }
      const matched = autoIdentifyMatchingWands(player, appearance, effect);
      const result = applyWandEffect(player, effect, power, buc);
      const chargeNote =
        item.charges === 0
          ? " The wand is now empty."
          : ` (${item.charges} charge${item.charges === 1 ? "" : "s"} left)`;
      const idNote =
        matched > 0
          ? ` You recognize ${matched} other ${appearance} wand${matched > 1 ? "s" : ""} in your pack.`
          : "";

      // Preserve special tokens for game.ts handlers (digging / secret doors)
      if (result.startsWith("WAND_")) {
        const flavor = result.includes(":") ? result.split(":").slice(1).join(":") : result;
        return `${result.split(":")[0]}:${flavor}${chargeNote}${idNote}`;
      }
      return `You zap the ${itemDisplayName(item)}. ${result}${chargeNote}${idNote}`;
    }
    default:
      return "You can't use that.";
  }
}
