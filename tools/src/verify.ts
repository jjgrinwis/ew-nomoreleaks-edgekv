/*
nml-verify: read a sample of buckets back out of EdgeKV and check them against
what nml-build produced.

  node dist/tools/src/verify.js --in ./buckets --network staging

A COMPLETED upload job with zero errors says the API accepted every record. It
does not say the stored value is byte-for-byte what was built, so this samples
items through the read-item endpoint and compares record count and fingerprint.

Reads are paced: the Administrative API allows a burst of 24 hits/sec and an
average of 18 over two minutes, and exceeding it blocks the client for ten
minutes. 200 samples at the default rate take about 40 seconds.

A miss right after an upload is not necessarily a failure - EdgeKV is eventually
consistent and a write can take ten seconds or more to be readable.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECORD_LEN } from "../../src/constants.js";
import { fingerprint } from "./fingerprint.js";
import {
  EdgeKvApi,
  Network,
  describeError,
  parseArgs,
  requireNetwork,
  requireSection,
} from "./edgegrid.js";

const DEFAULT_SAMPLES = 200;

interface Fingerprints {
  prefix_len: number;
  record_len: number;
  built_at: string;
  total_records: number;
  buckets: Record<string, { n: number; fp: string }>;
}

function usage(): never {
  console.error(
    [
      "usage: nml-verify --in <dir> --network staging|production [options]",
      "  --in         directory written by nml-build",
      "  --network    staging or production",
      "  --samples    buckets to check            (default 200)",
      "  --seed       sample seed, for a repeatable run",
      "  --namespace  EdgeKV namespace            (default nomoreleaks)",
      "  --group      EdgeKV group                (default hashes)",
      "  --section    ~/.edgerc section           (default $AKAMAI_EDGERC_SECTION)",
      "  --switchkey  account switch key          (default $AKAMAI_ACCOUNT_SWITCH_KEY)",
      "  --rps        requests per second         (default 5)",
    ].join("\n")
  );
  process.exit(2);
}

/** Deterministic generator so a reported failure can be reproduced with --seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** `count` distinct items from `items`, chosen by partial Fisher-Yates. */
function sample(items: string[], count: number, seed: number): string[] {
  const rand = lcg(seed);
  const pool = [...items];
  const take = Math.min(count, pool.length);

  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  return pool.slice(0, take);
}

async function readItem(
  api: EdgeKvApi,
  network: Network,
  namespace: string,
  group: string,
  item: string
): Promise<string | null> {
  const response = await api.send({
    method: "GET",
    path: `/networks/${network}/namespaces/${namespace}/groups/${group}/items/${item}`,
    // Bucket values are hex, so a value of nothing but digits would be parsed
    // into a number and lose precision if axios were allowed to touch it.
    raw: true,
  });

  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new Error(`read of item ${item} failed: ${describeError(response)}`);
  }
  if (typeof response.body !== "string") {
    throw new Error(`read of item ${item} returned ${typeof response.body}, not text`);
  }
  return response.body;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  if (!flags["in"] || !flags["network"]) {
    usage();
  }

  const inDir = flags["in"]!;
  const network = requireNetwork(flags["network"]);
  const namespace = flags["namespace"] ?? "nomoreleaks";
  const group = flags["group"] ?? "hashes";
  const samples = Number(flags["samples"] ?? DEFAULT_SAMPLES);
  const seed = Number(flags["seed"] ?? Date.now() % 0x7fffffff);

  const expected = JSON.parse(
    readFileSync(join(inDir, "fingerprints.json"), "utf8")
  ) as Fingerprints;

  if (expected.record_len !== RECORD_LEN) {
    throw new Error(
      `fingerprints.json was built with record_len ${expected.record_len} but this ` +
        `checkout uses ${RECORD_LEN}; the EdgeWorker would miss every lookup`
    );
  }

  const api = new EdgeKvApi({
    section: requireSection(flags["section"]),
    switchKey: flags["switchkey"] ?? process.env["AKAMAI_ACCOUNT_SWITCH_KEY"],
    requestsPerSecond: Number(flags["rps"] ?? 5),
  });

  const items = sample(Object.keys(expected.buckets), samples, seed);
  console.log(
    `checking ${items.length} of ${Object.keys(expected.buckets).length.toLocaleString()} ` +
      `buckets in ${namespace}/${group} on ${network} (seed ${seed})`
  );

  const problems: string[] = [];
  for (const item of items) {
    const want = expected.buckets[item]!;
    const value = await readItem(api, network, namespace, group, item);

    if (value === null) {
      problems.push(`${item}: missing (404)`);
      continue;
    }
    const got = { n: value.length / RECORD_LEN, fp: fingerprint(value) };
    if (value.length % RECORD_LEN !== 0) {
      problems.push(`${item}: length ${value.length} is not a multiple of ${RECORD_LEN}`);
    } else if (got.n !== want.n) {
      problems.push(`${item}: ${got.n} records, expected ${want.n}`);
    } else if (got.fp !== want.fp) {
      problems.push(`${item}: fingerprint ${got.fp}, expected ${want.fp}`);
    }
  }

  const meta = await readItem(api, network, namespace, group, "_meta");
  console.log(`_meta: ${meta ?? "missing"}`);
  if (meta !== null && !meta.includes(`built=${expected.built_at}`)) {
    problems.push(
      `_meta reports a different build than this fingerprints.json (${expected.built_at})`
    );
  }

  if (problems.length === 0) {
    console.log(`\nok: ${items.length} buckets and _meta match the build`);
    return;
  }

  console.error(`\n${problems.length} of ${items.length} sampled buckets did not match:`);
  for (const problem of problems.slice(0, 40)) {
    console.error(`  ${problem}`);
  }
  console.error(
    "\nIf the upload just finished, wait ~10s for propagation and re-run: EdgeKV is\n" +
      "eventually consistent. Persistent mismatches mean the upload did not land."
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(`nml-verify failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
