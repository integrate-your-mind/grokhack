import { OriginGameplayJournal } from "../server/origin-journal.js";
import { catchUpOriginJournal } from "../server/shadow-catchup.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positive(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const endpoint = required("SHADOW_EDGE_ENDPOINT");
const url = new URL(endpoint);
if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
  throw new Error("SHADOW_EDGE_ENDPOINT must use HTTPS outside loopback");
}

const result = await catchUpOriginJournal({
  journal: new OriginGameplayJournal(),
  streamId: required("SHADOW_STREAM_ID"),
  route: {
    realmId: required("SHADOW_REALM_ID"),
    floorInstanceId: required("SHADOW_FLOOR_INSTANCE_ID"),
    depth: positive("SHADOW_DEPTH"),
    floorEpoch: positive("SHADOW_FLOOR_EPOCH"),
  },
  endpoint,
  secret: required("SHADOW_INGEST_SECRET"),
  cursor: process.env.SHADOW_CURSOR ? Number(process.env.SHADOW_CURSOR) : 0,
  maxBatches: process.env.SHADOW_MAX_BATCHES ? Number(process.env.SHADOW_MAX_BATCHES) : 4,
});

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.caughtUp) process.exitCode = 75;
