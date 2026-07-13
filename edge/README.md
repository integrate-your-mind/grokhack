# GrokHack edge game runtime

This directory is the undeployed Cloudflare-native data-plane foundation. It is
not a proxy to the current Node process.

The first vertical slice proves final-architecture primitives:

- a stateless gateway that verifies short-lived, environment/audience/key-bound
  HMAC route tickets and rejects unapproved browser origins;
- deterministic routing to one named/placed SQLite-backed `FloorInstance`
  Durable Object, including an allocator-chosen instance ID;
- a sharded SQLite-backed `RealmDirectory` used only for authenticated new
  allocations and floor lifecycle work, with party-first deterministic buckets,
  a four-probe ceiling, capacity reservations, and no directory hop in the
  gameplay/WebSocket command path;
- one named SQLite-backed `PlayerSession` per environment/player that
  idempotently binds the signed `(sessionEpoch, authorityEpoch, leaseId, route)`
  tuple before local activation and coordinates source-bound
  freeze/prepare/commit/activate/cleanup or abort;
- direct hibernating WebSockets with an 8 KiB application frame limit;
- a bounded player/socket cap, per-socket and floor-wide token buckets, and an
  explicit request for a fresh signed assignment when capacity is exhausted;
- one-time ticket consumption, higher-epoch recovery of orphaned pending
  attempts, directly tested alarm cleanup, and fencing only after a successful join;
- active/previous verification-key overlap and an enforced session-tombstone
  ceiling that requires allocation of a fresh floor epoch;
- exact raw-byte HMAC authentication for the internal allocation/retirement API,
  expiring idempotency receipts that are never evicted while live, and explicit
  overload/fresh-assignment responses;
- allocator-layout/location/bucket-count-qualified floor identities, an explicit
  supported historical bucket-count window, and monotonic
  `active -> draining -> retired` Floor fencing;
- bounded alarm-driven retirement recovery that waits for reservations, live or
  pending sockets, frozen exports, and prepared imports before incrementing an
  epoch, including eviction and response-loss recovery;
- optional protocol-v4 allocation reservation IDs that let Floor capacity
  snapshots reconcile joined/pending players without double-counting their
  still-live allocation reservations;
- monotonic client sequences, atomic durable acknowledgements, and bounded
  replay/deduplication for the application SLO probe and shared `wait` reducer;
- a mixed-version isolated shadow-replay namespace that preserves frozen V1
  wait/vitals hashes while independently replaying V2 movement decisions,
  including collision, door, trap-check, transfer, turn-cost, and visibility
  intents plus separate observation, carried-state, and behavioral-event hashes,
  authority-derived stream/floor fencing, classified durable divergences,
  one-way domain upgrade, and version/domain-qualified checkpoints;
- an additive movement-turn ingestion path that atomically commits one
  hash-chained envelope containing a V2 movement decision and its optional V1
  turn/vitals follow-up, with exact-operation response-loss idempotency;
- opaque, ticket-bound resume-proof grants, canonical UUID identities, durable
  source/target transfer capabilities, 256-command handoff, and bounded saga artifacts;
- strict runtime readiness/configuration validation and required-secret typegen;
- real Workers-runtime tests covering global route binding, cross-floor transfer,
  same-floor takeover, response-loss retry, phase eviction, abort recovery,
  live hibernating sockets, ticket replay, supersession, capacity, alarm, rate,
  frame boundaries, exact control-body authentication, concurrent allocation,
  historical shard layouts, automatic retirement, adjacent schemas, and storage bounds.

`FloorInstance` runs the shared deterministic `wait`/vitals reducer and still
rejects movement authority with `edge_gameplay_not_migrated`. The isolated
`ShadowReplay` object now runs the shared movement-decision reducer, but it
discards the result and cannot serve player state. Authoritative position tables,
combat resolution, item/trap/room-effect reducers, movement-safe transfer state,
the external resume-proof issuer/control plane, social services, queues,
projections, and migration tooling must still be added and proven before any
player traffic is routed here.

The global route binding rejects an uncommitted different route or higher login
epoch as `transfer_required`/`takeover_required`. A committed saga now moves the
shared gameplay state plus the full dedupe window without granting the target
command authority early, and alarm recovery finishes abort/source cleanup after
eviction. This is an undeployed substrate, not full avatar/inventory parity.
Issuer-side rotation/proof issuance and adoption of the allocator response,
account-level admission/WAF controls, structured SLI export, and measured
capacity remain open gates. Location hints are best-effort first-placement
preferences, not residency guarantees.

## Movement-turn shadow envelope

The current migration branch adds an undeployed, additive publication unit for
the specific crash gap between a durable V2 movement decision and its V1
turn/vitals follow-up. The owner-only origin journal writes one complete JSONL
envelope and fsyncs it, then appends and fsyncs one byte in the segment commit
sidecar. A reader exposes only the sidecar-committed prefix. Each envelope nests
the unchanged V2 movement entry plus either the unchanged V1 entry required by a
turn-consuming decision or an explicit null for a no-turn decision; the frozen
standalone V1/V2 formats and hashes do not change.

The internal catch-up route sends whole envelopes to one routed `ShadowReplay`
Durable Object. Validation and replay of both nested records, their receipt,
checkpoint, resulting states, and divergence evidence occur in one SQL
transaction. Retrying the exact operation after a lost response returns the
durable result without applying it again. Conflicting operation reuse, partial
or corrupt envelopes, gaps, reordering, chain breaks, stale/impossible
checkpoints, and terminal mismatches fail closed.

The success acknowledgement binds its checkpoint to the last durable envelope
hash and both nested state heads. A copier restarting behind an already-ahead
Worker may skip the duplicated prefix only when its local immutable journal
reconstructs the exact acknowledged envelope, terminal bit, and state hashes;
otherwise catch-up fails closed instead of trusting the remote cursor alone.

A no-turn append failure occurs before origin mutation. Before a turn-consuming
movement mutates origin state, the writer durably publishes one fixed,
mode-0600 preparation marker through one fixed temporary file. It binds the
stream, operation, expected cursor, prior envelope hash, and provisional
movement-entry hash. The origin applies the V1 reducer fields before the envelope
commit, finishes all remaining synchronous turn effects, then durably advances
the marker to `origin_applied` and immediately submits the player and affected
floor snapshots to DuckDB's ordered queue. Only acknowledgements for both
snapshots plus an exactly matching committed envelope may clear the marker with
unlink and directory fsync. The one global preparation slot rejects overlapping
movement while those acknowledgements are pending. A prepared-only marker
remains poison after restart even when its envelope exists; a different later
operation cannot overwrite or clear it.

Cold startup conservatively retains `prepared` and `origin_applied`: the exact
envelope alone does not prove that the player and every affected floor commit
acknowledged before process loss. After all of those writes settle successfully,
the handler durably advances the marker to `persistence_committed`. A cold
process may reconcile only that exact phase against the matching immutable
envelope and finish cleanup; earlier phases remain poison. The running handler
also retries ambiguous marker rename/unlink/directory-fsync acknowledgements.
Fixed-temp recovery
uses a direct path probe on every operation; the legacy random-temp compatibility
scan runs once per shared journal state, cleans at most 64 candidates, and
otherwise fails closed without unlink amplification.

If combined append or marker cleanup fails, the origin completes and charges the
turn so a retry cannot grant a free action, emits the evidence error, and keeps
`shadowEvidenceDegraded` latched. Marker presence reconstructs the latch after
restart. A latched origin continues legacy gameplay but emits no later movement
shadow envelopes and is ineligible for parity promotion even if catch-up would
otherwise appear clean. The fence remains until the player and every persistable
source/destination floor snapshot acknowledge; it does not replay or roll back a
partial persistence failure. Graceful shutdown joins the in-flight durability
chain and fails its durability barrier if the marker remains unresolved.

This envelope is atomic at the shadow-evidence publication and edge-ingest
boundaries. Player and every affected source/destination floor snapshot are
committed before cleanup, and all queued writes must settle before the phase can
advance. These separate DuckDB autocommits are not one database transaction; a
partial failure therefore stays fenced. Floor persistence currently serializes
the dungeon, monsters, and items, not transient trap/event runtime state. The
boundary is not one transaction with score/chat,
world metadata, the authority sidecar, or every legacy side effect, and it does
not make edge movement authoritative. Combat, item, trap, room, monster, and
transfer effects still need complete shared reducers and a state transaction
with a transactional outbox. The route and schema are undeployed; omitting a
namespace migration is safe only after exact account/environment evidence proves
that no earlier V2 or envelope-capable namespace was deployed.

Origin retention has separate 4,096-entry V1 and V2 counters. Standalone entries
are capped at 8 KiB and envelopes at 20 KiB, so the hard worst-case retained
record payload is 112 MiB (4,096 maximum-size no-turn envelopes plus 4,096
maximum-size standalone V1 entries). Paired-only traffic is bounded to 80 MiB;
commit bytes, one 512-byte preparation marker plus one transient 512-byte fixed
temp, and fixed metadata add small bounded overhead.

Adoption requires exact-head origin/edge parity and failure-injection results,
restart and response-loss recovery, a non-degraded origin, bounded catch-up,
restore proof, and a fenced shadow-only canary. Rollback before authority
transfer stops the copier and new shadow admission while leaving Node/DuckDB as
sole authority; it preserves origin envelopes and does not rewrite Durable
Object storage in place. If any prior edge state exists, use an
expand/contract-compatible schema or a new class/namespace rather than assuming
an empty namespace. This evidence does not establish four-nines availability or
million-user capacity.

Protocol-v4 route tickets are carried in WebSocket subprotocols so credentials are not put
in query strings. The optional signed allocation reservation ID is opaque and
short-lived. A control-plane/session issuer will consume the assignment and issue
the ticket; this package implements the authenticated assignment API, verifier,
and data plane but does not expose a public browser ticket issuer.

The allocator configuration is explicit: `REALM_DIRECTORY_BUCKETS` selects the
active power-of-two layout, `REALM_DIRECTORY_SUPPORTED_BUCKET_COUNTS` retains a
bounded migration window for retirement of prior layouts, and floor, reservation,
and receipt limits bound each directory object. Changing the active count creates
a versioned layout instead of silently remapping an existing one.

Local proof:

```sh
npm ci
npm run types
npm run check
npm test
npm run test:shuffle
npm run build:all
# or from the repository root: npm run edge:verify
```

The checked-in lockfile is clean-install verified with the CI toolchain
(Node 22/npm 10) and with npm 11. A populated workspace is not accepted as
dependency reproducibility proof.

Wrangler declares active and previous route-ticket secrets as required in every environment. Tests
inject an isolated fixture secret; a real remote secret is intentionally absent
from this repository. All build commands are Wrangler dry runs. Nothing in this
package deploys, creates paid resources, uploads secrets, changes DNS, or touches
production data.
