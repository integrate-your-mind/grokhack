# GrokHack production SLO

Status: engineering target; not a current uptime claim.

## Availability objective

GrokHack targets **99.99% good eligible interactions over every rolling 30-day
window**.

`availability = good eligible interactions / all eligible interactions`

Eligible interactions are:

- WebSocket connect or resume;
- authenticated join;
- an accepted gameplay command;
- the durable acknowledgement of a state-changing command.

An interaction is good only when it:

- completes within two seconds;
- returns no application, overload, resource, binding, deployment, platform, or
  synchronous-dependency failure;
- does not lose or double-apply an acknowledged command;
- preserves a monotonic authoritative world revision.

Invalid, malicious, banned, and client-cancelled requests may be excluded.
Legitimate throttling, capacity rejection, overload, deployments, application
bugs, bad configuration, and dependency failures count against the SLO.

For an exact 30-day window, 99.99% permits **259.2 seconds (4 minutes 19.2
seconds)** of time-based unavailability and only 100 bad interactions per one
million eligible interactions.

## Guardrails

| SLI | Objective |
|---|---:|
| Good eligible interactions, rolling 30 days | >= 99.99% |
| Good external probe-location-minutes per served region | >= 99.99% |
| Minimum availability for any individual served region | >= 99.9% |
| Authoritative command acknowledgement, intended region | p99 < 500 ms |
| Usable session resume after disconnect/runtime reset | p99 < 5 s |
| Known acknowledged-command loss or double application | 0 |
| Acknowledged active-state RPO | 0 after successful durable commit |
| Operator-error/corruption restore RPO | <= 5 min |
| Operator-error/corruption restore RTO | <= 30 min |

Global aggregation must not hide one chronically unavailable region, realm, or
shard. Dashboards must expose both request-weighted availability and affected
player-minutes by region/realm/version.

## Synthetic transaction

An external probe, independent of Cloudflare, must run from multiple regions:

1. Resolve DNS and establish TLS.
2. Obtain a short-lived test-session route ticket.
3. Upgrade a WebSocket and receive `welcome`.
4. Join a dedicated probe floor.
5. Commit a harmless sequenced `slo_probe`.
6. Verify the durable acknowledgement and monotonic revision.
7. Disconnect, resume directly, replay the same sequence, and verify the exact
   cached acknowledgement without a second mutation.

The monitor and long-term SLO record cannot live only on Cloudflare. A correlated
Cloudflare failure must remain observable.

## Error-budget alerts

- Page when 14.4x burn is sustained over both 5 minutes and 1 hour.
- Page when 6x burn is sustained over both 30 minutes and 6 hours.
- Page immediately on any acknowledged-state loss, duplicate application, or
  divergent authority.
- Page when legitimate `.overloaded` responses exceed 0.01%, command p99 exceeds
  500 ms, resume p99 exceeds 5 seconds, or critical queue age exceeds 60 seconds.
- Warn/page at 60%/75%/90% of measured safe object capacity or storage budget.
- Treat any dead-letter message as actionable.
- Freeze feature releases if 25% of the monthly error budget is consumed within
  seven days.

## Degradation order

Core local gameplay must not synchronously depend on analytics, leaderboards,
chat bridges, Discord, IRC, R2, or D1 projections.

1. Sample/drop nonessential telemetry.
2. Delay leaderboard, bridge, and social projections.
3. Reduce presence/cosmetic update frequency and coalesce replaceable deltas.
4. Stop allocating new joins to a warm shard and reroute them.
5. Preserve only authoritative state commits and acknowledgements.
6. At hard capacity, fail closed; never acknowledge an uncommitted mutation.

Queue consumers are idempotent because Cloudflare Queues provide at-least-once
delivery: [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

## Platform SLA boundary

Cloudflare's Enterprise Workers objective is not GrokHack's application SLO.
The public SLA excludes classes of application errors, configuration/binding
failures, resource-limit breaches, and dependent-product failures. Those failure
modes still affect players and therefore count here:
[Workers SLA](https://www.cloudflare.com/workers-service-level-agreement/).

R2 also must not be a synchronous gameplay dependency; its published
availability is below this application target:
[R2 durability and availability](https://developers.cloudflare.com/r2/reference/durability/).

## Claim gate

Do not publicly claim “99.99% uptime” until all of the following are true:

- the complete browser and agent gameplay path is measured by external probes;
- per-object saturation and overload behavior are established under realistic
  state size, fanout, payload, and hot-shard skew;
- a Cloudflare-approved distributed test reaches the claimed peak concurrency;
- 10x expected reconnect/join storms pass;
- a 72-hour full-peak soak and seven-day half-peak diurnal soak show no unbounded
  memory, storage, replay, entity, or outbox growth;
- deploy-under-load, runtime eviction, dependency failure, queue duplication,
  and transfer-step fault injection pass without state loss;
- random PITR and independent snapshot restore drills meet RPO/RTO;
- at least 30 measured days pass before limited GA and 90 measured days before
  a public four-nines reliability claim.
