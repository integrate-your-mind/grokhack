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
- opaque, ticket-bound resume-proof grants, canonical UUID identities, durable
  source/target transfer capabilities, 256-command handoff, and bounded saga artifacts;
- strict runtime readiness/configuration validation and required-secret typegen;
- real Workers-runtime tests covering global route binding, cross-floor transfer,
  same-floor takeover, response-loss retry, phase eviction, abort recovery,
  live hibernating sockets, ticket replay, supersession, capacity, alarm, rate,
  frame boundaries, exact control-body authentication, concurrent allocation,
  historical shard layouts, automatic retirement, adjacent schemas, and storage bounds.

It runs the shared deterministic `wait`/vitals reducer and intentionally rejects
the remaining gameplay commands with `edge_gameplay_not_migrated`. Movement,
combat, monsters, traps, items, the external resume-proof issuer/control plane,
social services, queues, projections, and migration tooling must still be added
and proven before any player traffic is routed here.

The global route binding rejects an uncommitted different route or higher login
epoch as `transfer_required`/`takeover_required`. A committed saga now moves the
shared gameplay state plus the full dedupe window without granting the target
command authority early, and alarm recovery finishes abort/source cleanup after
eviction. This is an undeployed substrate, not full avatar/inventory parity.
Issuer-side rotation/proof issuance and adoption of the allocator response,
account-level admission/WAF controls, structured SLI export, and measured
capacity remain open gates. Location hints are best-effort first-placement
preferences, not residency guarantees.

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
