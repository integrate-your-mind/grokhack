import type { Entity, PlayerState } from "./types";
import { itemDisplayName } from "./entities";

export interface CombatResult {
  hit: boolean;
  damage: number;
  killed: boolean;
  message: string;
}

function rollAttack(attacker: Entity, defender: Entity): number {
  const base = attacker.attack - defender.defense;
  const variance = Math.floor(Math.random() * 4) - 1;
  return Math.max(1, base + variance);
}

export function meleeAttack(attacker: Entity, defender: Entity): CombatResult {
  const hitChance = 0.75 + (attacker.attack - defender.defense) * 0.03;
  if (Math.random() > Math.min(0.95, Math.max(0.3, hitChance))) {
    return {
      hit: false,
      damage: 0,
      killed: false,
      message: `${attacker.name} misses ${defender.name}.`,
    };
  }

  const damage = rollAttack(attacker, defender);
  defender.hp -= damage;
  const killed = defender.hp <= 0;

  const verb = attacker.isPlayer ? "You hit" : `The ${attacker.name} hits`;
  const target = defender.isPlayer ? "you" : `the ${defender.name}`;
  const msg = killed
    ? `${verb} ${target} for ${damage} damage${defender.isPlayer ? "" : " — it dies"}!`
    : `${verb} ${target} for ${damage} damage.`;

  return { hit: true, damage, killed, message: msg };
}

export function playerAttackBonus(player: PlayerState): number {
  return player.equippedWeapon?.power ?? 0;
}

export function playerDefenseBonus(player: PlayerState): number {
  return player.equippedArmor?.power ?? 0;
}

export function effectivePlayerEntity(player: PlayerState): Entity {
  const e = { ...player.entity };
  e.attack += playerAttackBonus(player);
  e.defense += playerDefenseBonus(player);
  return e;
}

export function hungerDamage(state: string): number {
  switch (state) {
    case "weak": return 1;
    case "fainting": return 2;
    case "starving": return 3;
    default: return 0;
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

  if (prev !== player.hungerState && player.hungerState !== "normal" && player.hungerState !== "satiated") {
    return `You are ${player.hungerState}.`;
  }
  return null;
}

export function useItem(player: PlayerState, itemIndex: number): string | null {
  const item = player.inventory[itemIndex];
  if (!item) return "Nothing there.";

  switch (item.type) {
    case "food": {
      player.hunger = Math.min(player.maxHunger, player.hunger + item.power);
      player.inventory.splice(itemIndex, 1);
      updateHungerState(player);
      return `You eat the ${itemDisplayName(item)}.`;
    }
    case "potion": {
      const heal = item.power;
      player.entity.hp = Math.min(player.entity.maxHp, player.entity.hp + heal);
      item.identified = true;
      player.inventory.splice(itemIndex, 1);
      return `You quaff the ${item.name}. You feel better (+${heal} HP).`;
    }
    case "weapon": {
      if (item.cursed && player.equippedWeapon) {
        return "The weapon is stuck to your hands!";
      }
      player.equippedWeapon = item;
      item.identified = true;
      return `You wield the ${item.name}.`;
    }
    case "armor": {
      if (item.cursed && player.equippedArmor) {
        return "The armor won't come off!";
      }
      player.equippedArmor = item;
      item.identified = true;
      return `You wear the ${item.name}.`;
    }
    case "scroll": {
      if (item.name.includes("identify")) {
        const unidentified = player.inventory.filter((i) => !i.identified);
        if (unidentified.length === 0) return "Nothing to identify.";
        const target = unidentified[Math.floor(Math.random() * unidentified.length)];
        target.identified = true;
        player.inventory.splice(itemIndex, 1);
        return `You read the scroll. It reveals: ${target.name}.`;
      }
      if (item.name.includes("enchant")) {
        if (player.equippedWeapon) {
          player.equippedWeapon.power += 2;
          player.inventory.splice(itemIndex, 1);
          return `Your ${player.equippedWeapon.name} glows with power!`;
        }
        return "You have nothing to enchant.";
      }
      player.inventory.splice(itemIndex, 1);
      return "You read the scroll. Nothing happens.";
    }
    default:
      return "You can't use that.";
  }
}