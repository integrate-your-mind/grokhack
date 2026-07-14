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
Each record is appended with a complete short-write loop and file fsync, then a
one-byte per-segment commit sidecar is appended and fsynced. The write cost is
therefore proportional to the new bounded record rather than the accumulated
segment, and a separate online catch-up process reads only the committed prefix
without taking writer ownership or repairing files. The odd writer sequence is
fsynced (and its first directory entry committed) before evidence mutation; an
even token is published only after commit durability or successful recovery.
This fence keeps pre-fsync commit bytes and failed durability recovery invisible;
readers rebuild their bounded head inside one stable sequence snapshot and retry
transient cross-process writer contention for up to one second. New segment, sidecar, and
movement-evidence directory entries are committed with directory fsyncs. A
trailing or newline-complete record whose commit did not finish is truncated and
fsynced before retry; a complete commit acknowledgement-loss record is re-synced
and deduplicated, while committed corruption still fails closed.
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
are frozen. An additive movement-turn envelope leaves both nested formats and
their hashes unchanged: it carries exactly one V2 movement decision and, when
that decision consumes a turn, its V1 turn/vitals follow-up. A no-turn decision
has an explicit null V1 member.

The origin publishes that pair as one owner-only JSONL envelope in the dedicated
`movement-turn-v1` journal. The complete envelope line is appended and fsynced,
then one byte is appended and fsynced in the segment's commit sidecar. Readers
expose only the sidecar-committed prefix, so a crash before the commit byte makes
neither nested record visible and acknowledgement loss after the committed byte
is recovered as an idempotent duplicate. Envelope, movement, and V1 chains are
validated independently without changing the frozen standalone V1 or V2 wire
formats.

The isolated edge copier submits whole envelopes. `ShadowReplay` validates both
nested transitions and commits the envelope receipt, V2 movement state, optional
V1 vitals state, checkpoint, and any resulting divergence in one Durable Object
SQL transaction. Re-sending the exact operation after response loss is
idempotent; conflicting operation reuse, gap, reorder, stale checkpoint, chain
break, or partial/corrupt envelope fails closed without advancing the
checkpoint. A successful response includes the durable checkpoint's envelope
hash as well as both nested state heads. If the Worker is already ahead of the
copier's first page after a restart, the copier advances only after the local
immutable journal proves that exact envelope hash, terminal bit, and nested
state hashes; an unprovable ahead checkpoint fails closed.

For message-only/no-turn decisions, a failed envelope append still stops before
origin mutation. Before any turn-consuming movement mutates origin state, the
single writer durably replaces one mode-0600, at-most-512-byte preparation file
through one fixed temporary file, write, file fsync, rename, and directory fsync.
Cold recovery removes only validated fixed or legacy pre-rename temporary files;
ambiguous, insecure, oversized, or symlinked temp state stays fail-closed. The
fixed path is probed directly on the hot path. Legacy random names are scanned
once per shared journal state, with at most 64 candidates eligible for cleanup;
an excessive legacy inventory is preserved and fences parity instead of causing
unbounded unlink work. The
preparation binds the stream, operation, expected cursor, prior envelope hash,
and exact provisional movement-entry hash. An unresolved preparation is never
overwritten or cleared by a different operation.

A turn-consuming movement cannot construct its V1 member until the origin's
post-effect vitals are known. The origin therefore mutates, applies the narrow V1
turn/vitals reducer fields, appends the combined envelope, and finishes the
remaining synchronous origin turn effects. Only then does it durably rewrite the
marker to `origin_applied` and immediately enqueue snapshots of the player and
every affected source/destination floor through DuckDB's ordered persistence
queue. The player, one/two floor snapshots, and a bounded operation receipt are
written in one transaction. Each serialized writer transaction prunes any stale
prior receipt before inserting its own, bounding application-managed receipts to
one row even when post-marker cleanup repeatedly fails. Schema v2 retains its
original composite-key table shape. Startup also detects the unpublished
single-slot v2 variant and selects its required insert shape without rewriting
or dropping either database form. Original-v2 databases therefore remain
compatible with the earlier writer, while temporary single-slot QA databases
remain readable by this writer. The receipt
binds the journal identity to a SHA-256
of the exact stored player/floor rows; an exact retry is idempotent, while a
conflicting or subsequently overwritten snapshot fails closed. After COMMIT,
the handler durably advances the filesystem marker to `persistence_committed`;
unlink plus directory fsync completes marker cleanup, and only then may the
receipt be deleted. A cold process that finds `origin_applied` may advance it
only when the matching receipt still hashes to the stored rows and the matching
immutable envelope exists. A crash after marker cleanup can leave only a stale
receipt, which startup prunes when no preparation exists. `prepared` and an
`origin_applied` marker without that exact receipt remain poison. While
persistence is pending, the one global
preparation slot rejects another movement without mutating origin state. A failed
persistence acknowledgement retains the marker and keeps
`shadowEvidenceDegraded` latched. Marker presence reconstructs that latch on
restart; malformed, oversized, permissive, or symlinked marker/temp state fails
closed. The handler retries ambiguous phase/cleanup acknowledgements. Graceful
shutdown joins the in-flight chain and fails its durability barrier if poison
remains. A failed transaction rollback poisons and closes the shared DuckDB
connection rather than admitting later work on unknown transaction state. While
latched, legacy origin gameplay
remains available but later movement commands publish no new shadow envelopes,
so they cannot hide or clear the older gap. A real two-process WorldServer/DuckDB
regression terminates inside the persistence callback before acknowledgement and
proves that stale persisted player state remains fenced rather than being
mislabeled clean. This is bounded state-durability fencing and same-handler
acknowledgement recovery, not automatic gameplay replay or rollback.

This publication unit closes the V2-movement/V1-vitals shadow-evidence split and
does not clear its durable fence until the movement's player and affected-floor
snapshots commit. A transfer may therefore wait for the player, source floor,
and destination floor rows. `saveMovementTurnNow` writes those rows in one
queued DuckDB transaction: every pre-commit crash/failure rolls back the whole
snapshot, while a crash after COMMIT but before the filesystem phase advance is
recovered from the in-transaction operation receipt. Schema v2 adds only the
receipt table; older rows need no rewrite and the table is safe to leave in
place during code rollback after any in-flight preparation is resolved. Before
performing any DDL, startup reads the migration ceiling and rejects a database
whose maximum version is newer than the binary's `SCHEMA_VERSION`; a downgrade
therefore cannot silently write through an unknown future schema. The
floor serializer covers the dungeon,
monsters, items, traps, timed event state, and mechanical event book. The unit
is not atomic with score/chat effects, world
metadata, the authority sidecar, or every other origin persistence side effect.
Combat, monsters, item mutation, traps, room effects, and floor transfers are
not yet complete shared-authority reducers. Recovery drills and shared reducers
for those effects remain required before authority transfer.
Free wall/player rejections are evidence-sampled with a permanent 64-fingerprint
budget per retained player and a hard global retained-player ceiling for the
origin process lifetime. Repeats, new fingerprints beyond either cap, and new
players after the global cap do not perform another synchronous fsync, so cycling
players or inputs cannot turn the sample cache into unbounded writes or memory.
Turn-consuming commands remain unsampled. This is bounded migration evidence,
not an unbiased population sample: once the global cohort is full, later players
produce no new no-turn samples until the origin process is replaced.
V1 vitals and V2 movement each have a separate origin-wide ceiling of 4,096
entries. Standalone entries are limited to 8 KiB and an atomic movement-turn
envelope is limited to 20 KiB. The enforced worst case is therefore at most
112 MiB of retained record payload: 4,096 no-turn envelopes at the 20 KiB
envelope ceiling plus 4,096 standalone V1 entries at 8 KiB. A workload made
entirely of paired envelopes is capped at 80 MiB because each envelope consumes
both counters. Commit sidecars add at most 8 KiB across both counters, and the
single preparation file adds at most 512 bytes; fixed metadata and segment names
add small bounded overhead. Canonical committed segments are the only capacity ledger: the single
origin writer inventories and structurally validates their filenames, cursors,
hash chains, terminal boundaries, and domain continuity before its first
mutation, then reconciles them after an ambiguous append failure. No separately
rewritten counter can drift from retained evidence or add growing writes to the
public movement path. A mode-0600 hard-link owner record rejects a second live
origin writer. Dead-process ownership is reclaimed through a hard-link recovery
claim that admits one contender, survives reclaimer crashes, and can itself be
reclaimed only after its recorded process exits. Linux process start ticks (or
the platform process-start identity where available) prevent PID reuse from
pinning a dead owner; platforms that cannot prove start identity fail closed.
Public movement stream discovery performs at most 64 fixed segment probes
instead of rescanning unrelated journal filenames for each rotated run.
At saturation the journal preserves one contiguous immutable prefix, emits one
capacity audit signal per domain and process, and returns before stream discovery
or filesystem work. Authoritative origin gameplay continues even when either
shadow domain is full; catch-up completeness intentionally ends at that visible
capacity boundary. Other I/O, corruption, and continuity failures remain
fail-closed.
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

The envelope route and its `ShadowReplay` schema are undeployed. No namespace or
persisted-object migration is needed only if exact account/environment evidence
confirms that no prior envelope-capable Worker or V2 shadow namespace was ever
deployed. If that cannot be proved, adoption must use an expand/contract schema
or a new Durable Object class/namespace and validate every existing object
before traffic. Adoption additionally requires clean exact-head origin/edge
parity and failure-injection proof, restart and response-loss recovery, a
non-degraded origin, bounded catch-up, restore proof, and a fenced canary with no
player reads served from shadow state. Rollback stops the copier and new shadow
admission while leaving the Node/DuckDB authority unchanged; it must not delete
origin envelopes or roll back Durable Object storage in place. Once edge state
ever becomes authoritative, rollback must instead follow the version-affine
drain-forward rules in Phase 5.

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
