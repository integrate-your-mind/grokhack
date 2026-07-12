#!/usr/bin/env bash
# ACQ-PULSE — measure GrokHack human acquisition (hourly / each cycle).
# OWN: data/fleet/ACQUISITION_METRICS.jsonl, ACQUISITION_OPS.md metrics, ACQUISITION_NOW.md alerts
#
#   bash scripts/acq-pulse.sh          # one sample + rebuild table/alerts
#   bash scripts/acq-pulse.sh once     # same
#   bash scripts/acq-pulse.sh loop     # every ACQ_PULSE_INTERVAL (default 3600s)
#   bash scripts/acq-pulse.sh rebuild  # docs only from existing jsonl
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE="${ACQ_BASE_URL:-https://grokhack.mondello.dev}"
METRICS="$ROOT/data/fleet/ACQUISITION_METRICS.jsonl"
OPS="$ROOT/data/fleet/ACQUISITION_OPS.md"
ALERT="$ROOT/data/fleet/ACQUISITION_NOW.md"
STATE="$ROOT/data/fleet/.acq-pulse-state"
INTERVAL="${ACQ_PULSE_INTERVAL:-3600}"

mkdir -p "$ROOT/data/fleet"
touch "$METRICS"

pulse_once() {
  # Single Python process: curl via urllib, append metrics, rebuild ops+alerts
  ACQ_BASE="$BASE" ACQ_METRICS="$METRICS" ACQ_OPS="$OPS" ACQ_ALERT="$ALERT" ACQ_STATE="$STATE" \
  python3 - <<'PY'
import json, os, re, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

BASE = os.environ["ACQ_BASE"].rstrip("/")
METRICS = Path(os.environ["ACQ_METRICS"])
OPS = Path(os.environ["ACQ_OPS"])
ALERT = Path(os.environ["ACQ_ALERT"])
STATE = Path(os.environ["ACQ_STATE"])
at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def fetch(url, timeout=15):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "acq-pulse/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", errors="replace")
            return True, body, r.status
    except Exception as e:
        return False, str(e), 0

ok_s, body_s, code_s = fetch(f"{BASE}/api/status", 15)
ok_h, body_h, code_h = fetch(f"{BASE}/health", 10)

online = floors = turns = uptime = None
discord_ready = False
invite_null = True
irc_connected = False
fetch_ok = False
note = None
flags = None

if ok_s and body_s:
    try:
        d = json.loads(body_s)
        fetch_ok = "onlinePlayers" in d
        online = d.get("onlinePlayers")
        floors = d.get("floorsActive")
        turns = d.get("totalTurns")
        uptime = d.get("uptimeMs")
        disc = d.get("discord") or (d.get("bridges") or {}).get("discord") or {}
        irc = (d.get("bridges") or {}).get("irc") or {}
        discord_ready = bool(disc.get("ready"))
        invite_null = disc.get("serverInviteUrl") is None
        irc_connected = bool(irc.get("connected"))
    except Exception as e:
        flags = "fetch_failed"
        note = f"json parse error: {e}"
        fetch_ok = False
else:
    flags = "fetch_failed"
    note = f"status fetch failed: {body_s[:120]}"
    fetch_ok = False

health_ok = bool(ok_h and re.search(r"ok|online=", body_h or "", re.I))

# Spike vs last trusted acq-pulse sample
prev_online = None
if METRICS.exists():
    for line in METRICS.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("role") == "acq-pulse" or r.get("source") or "serverInviteUrl_null" in r or "health_ok" in r:
            if r.get("onlinePlayers") is not None and r.get("fetch_ok", True) is not False:
                prev_online = r.get("onlinePlayers")

if fetch_ok and online is not None and prev_online is not None:
    try:
        if int(online) >= int(prev_online) + 5:
            flags = ((flags + ",") if flags else "") + "spike_after_post_candidate"
            note = f"onlinePlayers +{int(online) - int(prev_online)} vs prev pulse — check founder posts / bot fleet"
    except Exception:
        pass

row = {
    "at": at,
    "onlinePlayers": online,
    "floorsActive": floors,
    "totalTurns": turns,
    "uptimeMs": uptime,
    "discord_ready": discord_ready,
    "serverInviteUrl_null": invite_null,
    "irc_connected": irc_connected,
    "health_ok": health_ok,
    "fetch_ok": fetch_ok,
    "flags": flags,
    "note": note,
    "source": BASE,
    "role": "acq-pulse",
}
with METRICS.open("a") as f:
    f.write(json.dumps(row, separators=(",", ":")) + "\n")

# invite_null_since state
if invite_null and fetch_ok:
    if not STATE.exists() or "invite_null_since=" not in STATE.read_text():
        STATE.write_text(f"invite_null_since={at}\n")
elif not invite_null and STATE.exists():
    lines = [ln for ln in STATE.read_text().splitlines() if not ln.startswith("invite_null_since=")]
    STATE.write_text("\n".join(lines) + ("\n" if lines else ""))

# --- rebuild rolling 24h table ---
cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
rows = []
for line in METRICS.read_text().splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    ts = r.get("at") or r.get("ts") or ""
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        continue
    if t >= cutoff:
        rows.append(r)
rows.sort(key=lambda r: r.get("at") or r.get("ts") or "", reverse=True)

def cell(v):
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "true" if v else "false"
    return v

table_lines = []
if not rows:
    table_lines.append("| _(no samples in last 24h)_ | | | | | | | |")
else:
    for r in rows[:48]:
        if "serverInviteUrl_null" in r:
            inv = "null" if r["serverInviteUrl_null"] else "set"
        elif "serverInviteUrl" in r:
            inv = "null" if r.get("serverInviteUrl") is None else "set"
        else:
            inv = "—"
        flags_note = r.get("flags") or r.get("note") or "—"
        if isinstance(flags_note, str) and len(flags_note) > 40:
            flags_note = flags_note[:37] + "…"
        table_lines.append(
            f"| {r.get('at') or r.get('ts') or '—'} | {cell(r.get('onlinePlayers'))} | {cell(r.get('floorsActive'))} | {cell(r.get('totalTurns'))} | {cell(r.get('discord_ready'))} | {inv} | {cell(r.get('irc_connected'))} | {flags_note} |"
        )

last_at = row["at"]
last_online = cell(row["onlinePlayers"])
now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# --- live CTA + pack audit (report only; no play.js) ---
PLAY_URL = f"{BASE}/play.html?ref=x"
FEEDBACK_URL = f"{BASE}/feedback.html"
OG_URL = f"{BASE}/og.png"
ROOT = METRICS.parent.parent.parent  # data/fleet/../.. = repo root
if not (ROOT / "scripts" / "acq-pulse.sh").exists():
    ROOT = Path(os.environ.get("PWD") or ".")

def http_code(url, timeout=10):
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "acq-pulse/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except Exception:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "acq-pulse/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status
        except Exception:
            return 0

play_code = http_code(PLAY_URL)
fb_code = http_code(FEEDBACK_URL)
og_code = http_code(OG_URL)

def cta_ok(code):
    return "✅" if code == 200 else f"❌ {code or 'fail'}"

# feedback submissions (local durable log)
fb_dir = ROOT / "data" / "feedback"
fb_count = 0
fb_humanish = 0
fb_latest = "—"
if fb_dir.is_dir():
    for p in sorted(fb_dir.glob("*.jsonl")):
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                fr = json.loads(line)
            except Exception:
                continue
            fb_count += 1
            fb_latest = fr.get("at") or fb_latest
            name = (fr.get("playerName") or "").lower()
            page = (fr.get("page") or "").lower()
            # skip known smoke/agent harness noise for "humanish" count
            if name in ("goalverify", "acq-smoke") or page in ("post-test", "acq-smoke"):
                continue
            fb_humanish += 1

# pack paste readiness
PACKS = [
    ("FEEDBACK_ACQ_PACK", ROOT / "data/fleet/content/FEEDBACK_ACQ_PACK.md", True),
    ("URGENT_HUMAN_PUSH", ROOT / "data/fleet/content/URGENT_HUMAN_PUSH.md", True),
    ("X_CREDITS_LAUNCH", ROOT / "data/fleet/content/X_CREDITS_LAUNCH.md", False),  # feedback optional on credits angle
]
pack_rows = []
for name, path, need_fb in PACKS:
    if not path.exists():
        pack_rows.append(f"| `{name}.md` | ❌ missing | — | — | — |")
        continue
    t = path.read_text()
    has_play = PLAY_URL in t or "play.html?ref=x" in t
    has_fb = FEEDBACK_URL in t or "feedback.html" in t
    has_og = "og.png" in t
    play_s = "✅" if has_play else "❌"
    fb_s = "✅" if has_fb else ("⬜ optional" if not need_fb else "❌")
    og_s = "✅" if has_og else "❌"
    ready = "✅ paste-ready" if has_play and has_og and (has_fb or not need_fb) else "⚠ fix CTAs"
    pack_rows.append(f"| `{name}.md` | {ready} | {play_s} | {fb_s} | {og_s} |")

# founder post checkboxes: report ⬜ unless ACQUISITION_FOUNDER.md marks posted
founder_file = ROOT / "data/fleet/ACQUISITION_FOUNDER.md"
founder_posted = False
if founder_file.exists():
    ft = founder_file.read_text().lower()
    founder_posted = any(k in ft for k in ("posted: yes", "posted=yes", "✅ posted", "founder posted: true"))

founder_status = "✅ marked posted" if founder_posted else "⬜ founder @0xBunny only (not marked)"

# enrich metrics row note (already written — append correction line if useful)
row["play_http"] = play_code
row["feedback_http"] = fb_code
row["og_http"] = og_code
row["feedback_submissions"] = fb_count
# rewrite last metrics line with CTA fields (still append-only: append enriched twin only if first write lacked them)
row2 = dict(row)
row2["note"] = row2.get("note") or "users+feedback pulse"
row2["ctas"] = {"play": PLAY_URL, "feedback": FEEDBACK_URL, "og": OG_URL}
# don't double-append full row; keep single line — already appended above. Skip re-append.

OPS.write_text(f"""# ACQUISITION OPS — live player metrics

**Owner:** ACQ-PULSE
**Goal (users+feedback):** drive humans to play + collect feedback — **report paste/post status only**
**Play CTA:** {PLAY_URL}
**Feedback CTA:** {FEEDBACK_URL}
**Founder media:** {OG_URL} (required on every founder X original)
**Status API:** `{BASE}/api/status` · **Health:** `{BASE}/health`
**Log:** `data/fleet/ACQUISITION_METRICS.jsonl` (append-only)
**Pulse:** `bash scripts/acq-pulse.sh` · loop: `bash scripts/acq-pulse.sh loop`
**Do not thrash:** `public/play.js` combat / death-card / server combat

## Snapshot

| Field | Latest |
|-------|--------|
| Sample time (UTC) | {last_at} |
| onlinePlayers | **{last_online}** _(bots inflate — not pure humans)_ |
| floorsActive | {cell(row.get("floorsActive"))} |
| totalTurns | {cell(row.get("totalTurns"))} |
| discord.ready | {cell(row.get("discord_ready"))} |
| serverInviteUrl | {"null" if row.get("serverInviteUrl_null") else "set"} |
| irc.connected | {cell(row.get("irc_connected"))} |
| health_ok | {cell(row.get("health_ok"))} |
| play.html?ref=x | {cta_ok(play_code)} |
| feedback.html | {cta_ok(fb_code)} |
| og.png | {cta_ok(og_code)} |
| feedback submissions (local) | **{fb_count}** total · ~{fb_humanish} non-smoke · latest {fb_latest} |
| Alerts | `data/fleet/ACQUISITION_NOW.md` |

## Paste / post status (live CTAs only)

| Item | Status | play?ref=x | feedback | og.png |
|------|--------|------------|----------|--------|
| Live play CTA | {cta_ok(play_code)} `{PLAY_URL}` | — | — | — |
| Live feedback CTA | {cta_ok(fb_code)} `{FEEDBACK_URL}` | — | — | — |
| Live og.png | {cta_ok(og_code)} `{OG_URL}` | — | — | — |
{chr(10).join(pack_rows)}
| Founder X (URGENT Wave A Compose 1 + og) | {founder_status} | required | — | **required** |
| Founder X (FEEDBACK_ACQ_PACK compose + og) | {founder_status} | required | required | **required** |
| Founder X (X_CREDITS_LAUNCH + og) | {founder_status} | required | optional | **required** |
| Feedback form human submissions | {"✅ " + str(fb_humanish) if fb_humanish else "⬜ none yet (only smoke/harness if total>0)"} | — | collect | — |

**Founder order (from packs):** URGENT Compose 1 + **og.png** → FEEDBACK compose + **og.png** → optional credits post + **og.png**.

Cannot perfectly separate bots from humans. Flag `spike_after_post_candidate` after founder paste waves.

## Metrics (rolling 24h)

| UTC | onlinePlayers | floorsActive | totalTurns | discord.ready | invite | irc | flags/note |
|-----|---------------|--------------|------------|---------------|--------|-----|------------|
{chr(10).join(table_lines)}

## How to sample

```bash
bash scripts/acq-pulse.sh          # one pulse
bash scripts/acq-pulse.sh loop     # every ${{ACQ_PULSE_INTERVAL:-3600}}s
```

## Alert rules

1. `onlinePlayers == 0` → page in ACQUISITION_NOW.md (empty dungeon)
2. `serverInviteUrl` still null for **≥ 2h** of continuous pulse observation → Discord invite blocker alert
3. `+5` online jump vs previous acq-pulse sample → flag `spike_after_post_candidate`
4. Live play/feedback/og not HTTP 200 → warn (broken CTAs)

## Coord

- content-x / poster-x / marketing: paste packs only; founder posts with og.png
- user-growth / reddit-ops / discord-raids: live CTAs only (`?ref=x` + feedback)
- error-triage: mine `data/feedback/*.jsonl`
- **Do not** thrash play.js combat from this role

---
*Last rebuilt by acq-pulse at {now_iso}*
""")

# --- alerts ---
alerts = []
severity = "ok"
invite_since = None
invite_hours = 0.0

if not fetch_ok:
    alerts.append(f"**STATUS FETCH FAILED** — could not read onlinePlayers at {at}. Re-run `bash scripts/acq-pulse.sh`. Do not assume empty dungeon.")
    severity = "warn"
elif online == 0:
    alerts.append(f"**EMPTY / ZERO ONLINE** — `onlinePlayers=0` at {at}. Founder: URGENT_HUMAN_PUSH Compose 1 + og.png · paste play `{PLAY_URL}`.")
    severity = "critical"

if play_code != 200 or fb_code != 200 or og_code != 200:
    alerts.append(f"**CTA HTTP** — play={play_code} feedback={fb_code} og={og_code} (need 200). Live CTAs only.")
    if severity == "ok":
        severity = "warn"

if invite_null:
    if STATE.exists():
        for ln in STATE.read_text().splitlines():
            if ln.startswith("invite_null_since="):
                invite_since = ln.split("=", 1)[1].strip()
    if invite_since:
        try:
            t0 = datetime.fromisoformat(invite_since.replace("Z", "+00:00"))
            invite_hours = (datetime.now(timezone.utc) - t0).total_seconds() / 3600.0
        except Exception:
            invite_hours = 0.0
        if invite_hours >= 2.0:
            alerts.append(
                f"**DISCORD INVITE STILL NULL (≥2h)** — `serverInviteUrl` null since {invite_since} (~{invite_hours:.1f}h)."
            )
            if severity != "critical":
                severity = "warn"
        else:
            alerts.append(f"**Discord invite null** (watching; alert fires at 2h). Observed since {invite_since}.")
            if severity == "ok":
                severity = "watch"
    else:
        alerts.append(f"**Discord invite null** — timer started at {at}.")
        if severity == "ok":
            severity = "watch"

if flags and "spike_after_post_candidate" in flags:
    alerts.append(f"**SPIKE** — {note}. Correlate with founder posts; bots may dominate.")
    if severity == "ok":
        severity = "info"

if not founder_posted and fetch_ok and (online or 0) > 0:
    # soft nudge only — not critical
    alerts.append(
        f"**FOUNDER POSTS PENDING** — packs ready; X still ⬜. Order: URGENT Compose 1 + og.png → FEEDBACK pack + og.png. "
        f"CTAs: play `{PLAY_URL}` · feedback `{FEEDBACK_URL}`."
    )
    if severity == "ok":
        severity = "watch"

if not alerts:
    alert_body = f"_No active alerts. onlinePlayers={online} · CTAs live · dungeon breathing._"
    severity = "ok"
else:
    alert_body = "\n".join(f"- {a}" for a in alerts)

ALERT.write_text(f"""# ACQUISITION NOW — paste/post + alerts

**Severity:** `{severity}`
**Updated:** {at}
**Live:** onlinePlayers=**{online}** · floors={floors} · turns={turns} · discord={discord_ready} · invite_null={invite_null} · irc={irc_connected}

## Drive (live CTAs only)

| Drive | URL | HTTP |
|-------|-----|------|
| **Play** | {PLAY_URL} | {cta_ok(play_code)} |
| **Feedback** | {FEEDBACK_URL} | {cta_ok(fb_code)} |
| **og.png** (every founder X) | {OG_URL} | {cta_ok(og_code)} |

## Paste / post status

| Pack / action | Status |
|---------------|--------|
| `FEEDBACK_ACQ_PACK.md` | paste-ready · play+feedback+og |
| `URGENT_HUMAN_PUSH.md` | paste-ready · Compose 1–3 · og required |
| `X_CREDITS_LAUNCH.md` | paste-ready · play `?ref=x` · og required · feedback optional |
| Founder X posted | {founder_status} |
| Feedback submissions | {fb_count} local (`data/feedback/`) · ~{fb_humanish} non-smoke |

## Active alerts

{alert_body}

## Founder 90s path (report — do not agent-post)

1. Open URGENT **Compose 1** · attach **og.png** · post
2. FEEDBACK_ACQ_PACK compose · attach **og.png**
3. Soft-DM / Discord with play `{PLAY_URL}`
4. Collect feedback at `{FEEDBACK_URL}`
5. Optional: `X_CREDITS_LAUNCH.md` + og.png

**Do not thrash** play.js combat. Agents report status only.

## Measure

```bash
bash scripts/acq-pulse.sh
```

---
*ACQ-PULSE — paste/post status only; no game-code thrash.*
""")

print(
    f"[acq-pulse] {at} online={online} floors={floors} turns={turns} "
    f"discord_ready={discord_ready} invite_null={invite_null} irc={irc_connected} "
    f"health_ok={health_ok} fetch_ok={fetch_ok} "
    f"play={play_code} feedback={fb_code} og={og_code} fb_subs={fb_count}"
    + (f" flags={flags}" if flags else "")
)
PY
}

cmd="${1:-once}"
case "$cmd" in
  once|"")
    pulse_once
    ;;
  loop)
    echo "[acq-pulse] loop every ${INTERVAL}s → $METRICS"
    while true; do
      pulse_once || echo "[acq-pulse] sample failed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
      sleep "$INTERVAL"
    done
    ;;
  rebuild)
    # force a sample (same as once — keeps state consistent)
    pulse_once
    ;;
  *)
    echo "usage: $0 [once|loop|rebuild]" >&2
    exit 2
    ;;
esac
