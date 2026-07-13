# Cloudflare edge migration plan

This is an additive migration. The current Node/DuckDB world remains the sole
authority until a fenced cohort handoff is proven. There is no dual-authority
phase and no direct production-data write from the edge scaffold.

## Phase 0: stabilize the origin

Required before migration load is added:

- bound live entity growth and remove defeated entities;
- enforce WebSocket frame size at the server boundary;
- serialize joins/resumes so one identity cannot be created twice;
- preserve owner/public serialization and DM privacy;
- isolate tests from repository and production data;
- make the server compiler, root build, tests, and CI authoritative;
- remove per-command full-file social writes from the gameplay path;
- prove backup and restore for the existing database.

The entity-growth, malformed-profile, observer-privacy, test-isolation, atomic
admission, connection/deadline, payment/credit authorization, owner-only secret,
single-flight metadata persistence, read-only social profile, and
outbound-backpressure fixes exist locally.
Coverage floors, correctness lint, locked installs, builds, and an exact server
type-debt baseline now have a CI definition. The live process has not been
restarted onto these changes, the server type baseline is still not clean, and
backup/restore plus hosted CI proof remain open.

## Phase 1: extract one deterministic engine

Create a pure package with this boundary:

`applyCommand(state, command, rngState) -> { state, rngState, events }`

The legacy `WorldServer` and future `FloorInstanceDO` must call the same reducer.
Remove wall-clock time, process-global IDs, and ambient I/O from decisions.
Capture production-shaped golden command traces and compare state hashes across
Node and Workers runtimes. A compile-clean edge rewrite without parity is not a
migration proof.

Exit gate:

- normal, failure, duplicate, reordered, stale-session, and odd command paths
  produce identical state/event hashes in both runtimes;
- public/owner DTO contract tests remain green;
- deterministic replay after process/object reconstruction is byte-stable.

The shared layer now covers turn/vitals and the authoritative movement-decision
seam: eight-direction validation, terrain/player/monster collision precedence,
immobilized struggle, door crossing, pickup/trap/room/transfer intents, turn
cost, and visibility intent. The movement adapter deliberately does not claim
edge authority yet: combat, pickup mutation, trap/room effects, floor transfer,
and persistent position still require shared normalized state and reducers.

## Phase 2: complete the edge substrate

The current [`edge`](../edge/README.md) package is the start of this phase.

The package now includes a protocol-v4 `PlayerSessionDO` that binds one exact
authority tuple and rejects uncommitted route/takeover changes. It also includes
opaque proof-bound grants and a source-bound, idempotent
freeze/prepare/commit/activate/cleanup-or-abort saga with a full dedupe-window
handoff, alarm recovery, adjacent-schema proof, and bounded receipts. The same
package now also includes sharded, capacity-aware allocation with exact
reservation reconciliation and alarm-driven floor epoch retirement. Add next:

- normalized floor/player/entity/item/trap tables and explicit schema versions;
- bounded command replay plus critical transactional outbox;
- versioned snapshot/delta protocol while keeping legacy message discriminators;
- partitioned Queues with DLQs, D1 projections, and R2 archives;
- service-level telemetry dimensions and external synthetic-probe credentials.

Do not add D1, R2, bridges, analytics, or network RPC to the command transaction.

Exit gate:

- real Workers-runtime tests cover hibernation, eviction, malformed/oversized
  input, duplicate/reordered sequences, stale closes, token theft, privacy,
  capacity rejection, storage growth, and queue duplication;
- every environment dry-run bundles with generated binding types;
- schema expand/contract compatibility is proven across adjacent versions.

The transfer/allocation slices now satisfy that exit-gate portion locally for
`PlayerSession`, `FloorInstance`, and `RealmDirectory`; other future stateful
objects must prove the same compatibility before adoption.

## Phase 3: shadow replay, never dual write

Add an append-only versioned command journal to the legacy authority. Copy its
events asynchronously into isolated edge objects and compare state hashes. The
edge result is discarded; it must not serve player state or mutate legacy data.

The first production-shaped slices now journal the shared turn/vitals reducer
and movement decisions into fsynced, mode-0600, hash-chained 64-entry segments.
Each bounded segment is written completely (including short-write retries)
through a mode-0600 temporary file, file
fsync, atomic rename, and directory fsync. First-use directory creation is also
committed by fsyncing each existing parent boundary before an append can be
acknowledged. A pre-rename fsync failure leaves the
canonical segment unchanged; a lost post-rename acknowledgement is reconciled
from the canonical file on retry.
Frozen V1 vitals entries remain byte-compatible; V2 movement entries add
position/cell input, full-observation and carried-state hashes, and a separate
behavioral-event hash so wall, player, and monster blocks cannot alias merely
because position did not change. The Worker carries position, phase, liveness,
immobilization, and authority continuity across no-turn decisions. A
turn-consuming decision deliberately opens a visible continuity boundary because
combat, traps, room events, vitals, and monster AI are still origin-only effects;
those boundaries cannot become strict until their reducers are shared.
V2 remains undeployed and is establishing its initial merge contract in this
branch; predecessor feature-branch V2 artifacts without continuity fields are
not compatible. V1 is the only historical production-shaped format whose bytes
are frozen.
The movement decision is recorded before origin mutation so a failed first
append cannot partially move or pick up an item. Turn-consuming paths retain the
existing V1 vitals follow-up. These two fsynced records are not yet one atomic
transaction; the transactional outbox remains required before authority transfer.
Free wall/player rejections are evidence-sampled with a permanent 64-fingerprint
budget per retained player and a hard global retained-player ceiling for the
origin process lifetime. Repeats, new fingerprints beyond either cap, and new
players after the global cap do not perform another synchronous fsync, so cycling
players or inputs cannot turn the sample cache into unbounded writes or memory.
Turn-consuming commands remain unsampled. This is bounded migration evidence,
not an unbiased population sample: once the global cohort is full, later players
produce no new no-turn samples until the origin process is replaced.
The bounded copier sends
at most 64 entries per page through an authenticated internal Worker route to a
dedicated `ShadowReplay` SQLite Durable Object namespace. Checkpoint, immutable
entry receipts, terminal state, and version/domain/kind-classified divergence
evidence are committed transactionally. Batches must be strictly increasing;
an ordered duplicate prefix remains idempotent, while conflict, gap, reorder,
chain break, corrupt input, domain downgrade, post-terminal input, continuity
drift, and parity divergence fail visibly without silently advancing past the
failing cursor. The copier's duration budget aborts both the request and response
body read instead of merely checking time between pages.

This proves the ingestion/catch-up mechanism for vitals and movement decisions.
It does not claim full-floor gameplay parity or edge movement authority: combat,
monsters, item mutation, trap/room effects, durable position, and transfers must
enter shared normalized reducers before their journals can satisfy the
zero-divergence authority-transfer gate.

Movement evidence is partitioned into an opaque character-run and
authority-derived origin stream. A one-way digest of the 256-bit resume
credential prevents a recycled process-local player ID from reusing an old
character's stream without putting the credential itself in journal paths.
Realm, floor instance, depth, floor epoch, and ruleset version also rotate the
stream and are bound into state hashes. A mode-0600, synchronously fsynced
authority sidecar reuses the same instance across benign origin restarts and
advances the epoch before a missing floor is regenerated, even when its
deterministic seed is unchanged. Rotation retries reconcile a committed rename
by a request-bound mutating operation ID instead of allocating a second epoch
after response loss; reusing a persisted mutation ID for another seed or
rotation mode fails closed. Read-only benign-restart lookups are not recorded as
idempotency operations.
Atomic retry of a command that crossed the journal/mutation boundary still
remains part of the transactional-outbox requirement. The DuckDB floor rows and
authority sidecar are also one restore set; restoring only one can orphan shadow
streams and is not accepted as a restore drill. The Worker rejects an entry whose complete authority tuple
differs from the routed shadow object, rejects unsupported ruleset versions, and
allows only the explicit one-way V1-vitals to V2-movement upgrade. Checkpoints
expose entry version and state domain so a movement fingerprint cannot be
mistaken for a vitals fingerprint.

Exit gate:

- zero unexplained divergence over representative long-running floors;
- replay catches up from a snapshot watermark within the RTO;
- duplicate, missing, reordered, and corrupt journal segments fail visibly and
  do not silently advance the watermark.

## Phase 4: backfill and ownership fencing

1. Take a read-only DuckDB snapshot and immutable checksum manifest.
2. Validate/compact dead, duplicate, malformed, and oversized entities.
3. Import a new `legacy-1` realm into a non-production namespace.
4. Import identity/session material separately from floor state.
5. Replay journal entries from snapshot watermark to cutover watermark.
6. Compare row counts, content hashes, invariants, and sampled full replays.

No live player is owned by both systems. A transfer advances an authoritative
lease/session epoch exactly once. If target import fails, source ownership
remains valid.

## Phase 5: cohort canary

Admission order:

1. internal synthetic users and bots;
2. new internal runs;
3. one regional canary;
4. 1%, 5%, 25%, 50%, then 100% of new runs;
5. existing runs only at a safe reconnect/floor boundary;
6. drain legacy after zero legacy-owned active runs and verified checksums.

Rollback stops new admission. Already-authoritative edge runs stay on their
compatible object version or drain forward; they are not copied backward into
the live DuckDB world. Stateful schema changes use expand/contract or a new
class/namespace because code rollback does not roll back persisted data.

Automatic rollback/freeze triggers:

- any acknowledged state loss, duplicate application, or split authority;
- availability burn above policy;
- overload above 0.01% of legitimate commands;
- p99 command acknowledgement above 500 ms or resume above 5 seconds;
- unexpected storage/outbox/entity growth;
- state-hash divergence or restore-checksum mismatch.

## Phase 6: capacity and reliability proof

Before million-user or four-nines claims:

- measure saturation curves by players, commands/sec, fanout, state size, and
  payload size; keep production admission below 40% of the observed knee;
- test the actual claimed distributed peak, not an extrapolation from one object;
- inject hot/celebrity shard skew and a 10x reconnect storm;
- run 72 hours at peak and seven days at half-peak with diurnal changes;
- deploy under load and verify version-affine reconnect/resume;
- inject Worker/DO eviction, CPU/memory/storage limits, D1/R2/Queue failure,
  queue duplicate/reorder/retry exhaustion, and network partitions;
- restore random objects using SQLite PITR and independent R2 artifacts;
- obtain Cloudflare confirmation for Enterprise support, WebSocket establishment
  rate, active object count, queue/D1 limits, observability export, DDoS and
  denial-of-wallet controls, load-test windows, and spend alerts.

SQLite-backed Durable Objects provide a 30-day PITR facility, but operational
recovery and account-compromise protection still require independent artifacts
and drills: [SQLite/PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Explicitly outside the initial core SLO

Telnet, Discord, IRC, MCP administration, voluntary compute, analytics,
leaderboards, and third-party bridges remain outside the first gameplay SLO
unless each path is independently hardened and measured. Their failure must not
take down local gameplay.

## Authorization boundaries

Local code, tests, dry runs, docs, and isolated load harnesses are reversible and
in scope. Stop for explicit approval before:

- creating paid Cloudflare resources or changing an account plan;
- setting/uploading secrets;
- changing DNS, routes, Tunnel, or production traffic;
- importing or mutating production data;
- applying irreversible Durable Object migrations;
- running a high-volume external load test.
