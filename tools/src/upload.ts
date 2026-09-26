/*
nml-upload: push the buckets built by nml-build into an EdgeKV namespace.

  node dist/tools/src/upload.js --in ./buckets --network staging

Uses the EdgeKV bulk-upload endpoint:

  POST /edgekv/v1/networks/{network}/namespaces/{namespaceId}/upload
       Content-Type: text/csv
       body: one "groupId,itemId,value" line per item

The response is 202 with a Location header; that job URL is polled until
jobStatus is COMPLETED, and a job reporting any failed write aborts the run.

Chunking is by payload bytes rather than item count, because a bucket is a few
dozen bytes on a test list and ~24 KB on the real 100M-hash list. maxItems is
sent as an assertion, not as the chunk boundary.

Resumable: chunk boundaries are a deterministic function of the input file, and
every write is a full overwrite of a fixed item id, so re-running a chunk is a
no-op. Progress is recorded in the output directory and picked up automatically.

The payload is not gzipped. akamai-edgegrid JSON-stringifies any non-string body
unless Content-Type is application/gzip, which this endpoint rejects, so sending
compressed bytes would mean hand-rolling the request signing. Hex halves under
gzip at best and a refresh runs every few weeks, so it is not worth it.
*/
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chunkBuckets, csvLine, readBuckets } from "./csv.js";
import {
  EdgeKvApi,
  Network,
  describeError,
  parseArgs,
  requireNamespace,
  requireNetwork,
  requireSection,
} from "./edgegrid.js";

/** Stay well clear of any undocumented request-size limit. */
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface UploadState {
  network: Network;
  namespace: string;
  built_at: string;
  chunks_done: number;
  items_done: number;
}

interface JobStatus {
  jobId?: string;
  jobStatus?: string;
  successesCount?: number;
  errorsCount?: number;
  errors?: { failureRecord?: number; message?: string }[];
  message?: string;
}

function usage(): never {
  console.error(
    [
      "usage: nml-upload --in <dir> --network staging|production [options]",
      "  --in           directory written by nml-build (buckets.ndjson, fingerprints.json)",
      "  --network      staging or production",
      "  --namespace    EdgeKV namespace          (default $EDGEKV_NAMESPACE)",
      "  --group        EdgeKV group              (default hashes)",
      "  --section      ~/.edgerc section         (default $AKAMAI_EDGERC_SECTION)",
      "  --switchkey    account switch key        (default $AKAMAI_ACCOUNT_SWITCH_KEY)",
      "  --chunk-bytes  CSV bytes per request     (default 8388608)",
      "  --rps          requests per second       (default 5, API cap is 18 average)",
      "  --dry-run      send dryRun=true so nothing is written",
      "  --restart      ignore recorded progress and upload every chunk again",
    ].join("\n"),
  );
  process.exit(2);
}

async function upload(
  api: EdgeKvApi,
  network: Network,
  namespace: string,
  csv: string,
  items: number,
  dryRun: boolean,
): Promise<string> {
  const query: Record<string, string> = { maxItems: String(items) };
  if (dryRun) {
    query.dryRun = "true";
  }

  const response = await api.send({
    method: "POST",
    path: `/networks/${network}/namespaces/${namespace}/upload`,
    query: query,
    contentType: "text/csv",
    body: csv,
  });

  if (response.status !== 202) {
    throw new Error(`bulk upload rejected: ${describeError(response)}`);
  }

  const location = response.headers["location"];
  if (!location) {
    throw new Error(
      "bulk upload accepted but returned no Location header to poll",
    );
  }
  // Location is absolute from the API root; strip the base the client re-adds.
  return location.replace(/^\/edgekv\/v1/, "");
}

/** Poll a job to COMPLETED and throw if any record failed. */
async function awaitJob(
  api: EdgeKvApi,
  jobPath: string,
  /** Records the chunk held, or null on a dry run, where nothing is written. */
  expectedItems: number | null,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    const response = await api.send({ method: "GET", path: jobPath });
    // The job endpoint answers 207, since a job can be partly successful.
    if (response.status !== 200 && response.status !== 207) {
      throw new Error(`job status query failed: ${describeError(response)}`);
    }

    const job = response.body as JobStatus;
    if (job.jobStatus === "COMPLETED") {
      const errors = job.errorsCount ?? 0;
      if (errors > 0) {
        const detail = (job.errors ?? [])
          .slice(0, 5)
          .map((e) => `record ${e.failureRecord}: ${e.message}`)
          .join("; ");
        throw new Error(
          `job ${job.jobId} completed with ${errors} failed writes - ${detail}`,
        );
      }
      // A short job can report fewer successes than records only if something
      // was silently dropped, which nml-verify would catch much later.
      if (
        expectedItems !== null &&
        (job.successesCount ?? 0) !== expectedItems
      ) {
        throw new Error(
          `job ${job.jobId} wrote ${job.successesCount} items but the chunk held ${expectedItems}`,
        );
      }
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `job ${job.jobId} still ${job.jobStatus} after ${POLL_TIMEOUT_MS / 1000}s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Write the _meta item last. Nothing on the login path reads it - the EdgeWorker
 * must not spend a second read per check - but it is the operator's record of
 * which build is live, and it advancing is the signal that a refresh finished.
 */
async function writeMeta(
  api: EdgeKvApi,
  network: Network,
  namespace: string,
  group: string,
  meta: {
    prefix_len: number;
    record_len: number;
    built_at: string;
    total_records: number;
  },
  dryRun: boolean,
): Promise<void> {
  const value = [
    `built=${meta.built_at}`,
    `records=${meta.total_records}`,
    `prefix_len=${meta.prefix_len}`,
    `record_len=${meta.record_len}`,
  ].join("|");

  const jobPath = await upload(
    api,
    network,
    namespace,
    csvLine(group, { item: "_meta", value }),
    1,
    dryRun,
  );
  await awaitJob(api, jobPath, dryRun ? null : 1);
  console.log(`_meta = ${value}`);
}

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  const inDir = flags["in"];
  if (!inDir || !flags["network"]) {
    usage();
  }

  const network = requireNetwork(flags["network"]);
  const namespace = requireNamespace(flags["namespace"]);
  const group = flags["group"] ?? "hashes";
  const chunkBytes = Number(flags["chunk-bytes"] ?? DEFAULT_CHUNK_BYTES);
  const dryRun = bools.has("dry-run");

  const bucketsPath = join(inDir, "buckets.ndjson");
  const meta = JSON.parse(
    readFileSync(join(inDir, "fingerprints.json"), "utf8"),
  ) as {
    prefix_len: number;
    record_len: number;
    built_at: string;
    total_records: number;
  };

  const statePath = join(inDir, `upload-state.${network}.json`);
  let state: UploadState = {
    network,
    namespace,
    built_at: meta.built_at,
    chunks_done: 0,
    items_done: 0,
  };
  if (!dryRun && !bools.has("restart") && existsSync(statePath)) {
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as UploadState;
    // Resuming against a different build would mix two lists in the namespace.
    if (saved.built_at !== meta.built_at || saved.namespace !== namespace) {
      throw new Error(
        `${statePath} records a different build (${saved.built_at} -> ${saved.namespace}); ` +
          "finish or delete it, or pass --restart",
      );
    }
    state = saved;
    console.log(`resuming after chunk ${state.chunks_done}`);
  }

  const api = new EdgeKvApi({
    section: requireSection(flags["section"]),
    switchKey: flags["switchkey"] ?? process.env["AKAMAI_ACCOUNT_SWITCH_KEY"],
    requestsPerSecond: Number(flags["rps"] ?? 5),
  });

  console.log(
    `uploading ${bucketsPath} to ${namespace}/${group} on ${network}` +
      (dryRun ? " (dry run - nothing is written)" : ""),
  );

  const started = Date.now();
  for await (const chunk of chunkBuckets(
    readBuckets(bucketsPath),
    group,
    chunkBytes,
  )) {
    if (chunk.index < state.chunks_done) {
      continue;
    }

    const jobPath = await upload(
      api,
      network,
      namespace,
      chunk.csv,
      chunk.items,
      dryRun,
    );
    await awaitJob(api, jobPath, dryRun ? null : chunk.items);

    state.chunks_done = chunk.index + 1;
    state.items_done += chunk.items;
    // Never record progress for a dry run, or the real run would skip those chunks.
    if (!dryRun) {
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    }

    const elapsed = (Date.now() - started) / 1000;
    console.log(
      `chunk ${chunk.index} ok - ${chunk.items} items, ` +
        `${state.items_done.toLocaleString()} total, ${elapsed.toFixed(0)}s elapsed`,
    );
  }

  await writeMeta(api, network, namespace, group, meta, dryRun);

  console.log(
    `\ndone: ${state.items_done.toLocaleString()} buckets on ${network} in ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
  console.log(
    dryRun
      ? "dry run only - re-run without --dry-run to write"
      : `allow ~10s for propagation, then: npm run nml-verify -- --in ${inDir} --network ${network}`,
  );
}

main().catch((error) => {
  console.error(
    `nml-upload failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
