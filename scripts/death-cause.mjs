/**
 * Shared death-cause extraction for agent bots and tests.
 * Prefer server deathCause; never inventory / stairs / ambient / miss as cause.
 */

/** Lines that look like a real death epitaph. */
export const DEATH_CAUSE_RE =
  /you die|slain by|starved|incinerated|killed by|drained dry|succumbed to|burned by|torn apart|food poisoning|cursed teleport|cursed item|polymorphed|zapped self|frozen by|crushed by|ambushed by|mind blasted|fell into|pit trap|dart trap|quit|the dungeon claims/i;

/** Pure miss / dodge combat fluff (not lethal). */
export const MISS_LINE_RE =
  /\bmiss(?:es)?(?:\s+you)?\.?$|\bmisses you\b|dodges your|whistles past|swing wide|claws the air|duck under|clumsy swipe.*miss|you duck under/i;

/** Inventory UI / pack dump. */
export const INVENTORY_LINE_RE =
  /inventory|wearing:|carrying:|^\s*\d+\.\s|unidentified |\bslots?\b|press [a-z] to|use item|scroll labeled|pack\.|close your pack/i;

/** Stairs / ambient / reconnect / rest / wall bump — never a death cause. */
export const AMBIENT_LINE_RE =
  /stairs|leading up|leading down|you notice|you hear|growl|howl|welcome back|bump into a wall|you wait\.?$|you rest|footsteps|scent of|the air grows|something stirs|you feel watched|agent\b/i;

/** Combat hit lines without death language (e.g. "The orc mauls you for 8 damage."). */
export const DAMAGE_ONLY_RE = /for \d+ damage/i;

/**
 * True if this string must never be used as a bot-run / share death cause.
 * @param {string|null|undefined} m
 */
export function isPollutedDeathCause(m) {
  if (m == null) return true;
  const s = String(m).trim();
  if (!s) return true;
  if (s === "permadeath") return false; // explicit fallback, not pollution
  if (INVENTORY_LINE_RE.test(s)) return true;
  if (AMBIENT_LINE_RE.test(s)) return true;
  if (MISS_LINE_RE.test(s) && !DEATH_CAUSE_RE.test(s)) return true;
  if (DAMAGE_ONLY_RE.test(s) && !DEATH_CAUSE_RE.test(s)) return true;
  if (s.startsWith("[chat]") || s.startsWith("Agent")) return true;
  return false;
}

/**
 * Raw server deathCause field (unfiltered). Prefer for bot-runs.deathCause.
 * @param {object|null|undefined} you
 * @param {object|null|undefined} state
 * @returns {string|null}
 */
export function rawDeathCause(you, state) {
  const field =
    you?.deathCause ||
    state?.you?.deathCause ||
    state?.player?.deathCause ||
    state?.deathCause ||
    null;
  if (field == null) return null;
  const s = String(field).trim();
  return s || null;
}

/**
 * Infer "Slain by a X" from last melee damage line when deathCause missing.
 * Damage-only lines are not used as the raw epitaph (analytics noise) — only
 * to recover a killer name when the server field is empty.
 * @param {string[]} msgs
 * @returns {string|null}
 */
export function inferSlainFromDamage(msgs = []) {
  const list = Array.isArray(msgs) ? msgs : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = String(list[i] || "").trim();
    if (!m || m.startsWith("[chat]")) continue;
    if (INVENTORY_LINE_RE.test(m) || AMBIENT_LINE_RE.test(m)) continue;
    if (MISS_LINE_RE.test(m) && !DAMAGE_ONLY_RE.test(m)) continue;
    // "The orc mauls you for 8 damage." / "The skeleton CRITICAL hits you for 3 damage!"
    const hit = m.match(
      /^The (.+?) (?:CRITICAL hits|mauls|hits|wounds|cuts|smashes|smashs|bashes|bashs|strike hards|strikes|nicks|grazes|glances|claws|bites|stings|drains) you/i
    );
    if (hit?.[1]) {
      const mon = hit[1].replace(/\s+/g, " ").trim().slice(0, 40);
      if (mon && !/you|air|swing/i.test(mon)) return `Slain by a ${mon}`;
    }
  }
  return null;
}

/**
 * Prefer server deathCause; else last log line that looks like a death message;
 * else infer slain-from last damage; never inventory/miss/ambient as cause.
 *
 * @param {object|null|undefined} you
 * @param {object|null|undefined} state
 * @param {string[]} msgs
 * @returns {string}
 */
export function extractRunCause(you, state, msgs = []) {
  const field = rawDeathCause(you, state);
  if (field && !isPollutedDeathCause(field)) {
    return field;
  }

  const list = Array.isArray(msgs) ? msgs : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = String(list[i] || "").trim();
    if (!m) continue;
    if (isPollutedDeathCause(m)) continue;
    if (DEATH_CAUSE_RE.test(m)) return m;
  }

  const inferred = inferSlainFromDamage(list);
  if (inferred) return inferred;

  return "permadeath";
}

/**
 * Best-effort killer slug for analytics ("orc" from "Slain by a orc").
 * @param {string|null|undefined} cause
 * @returns {string|null}
 */
export function killerFromCause(cause) {
  if (!cause) return null;
  const s = String(cause);
  const m =
    s.match(/slain by an?\s+(.+)$/i) ||
    s.match(/killed by an?\s+(.+)$/i) ||
    s.match(/ambushed by an?\s+(.+)$/i) ||
    s.match(/mind blasted by an?\s+(.+)$/i) ||
    s.match(/drained dry by an?\s+(.+)$/i) ||
    s.match(/burned by an?\s+(.+)$/i);
  if (!m) return null;
  return m[1].replace(/\.$/, "").trim().slice(0, 40) || null;
}
