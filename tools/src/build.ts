/*
nml-build: turn a flat list of sha256 hashes into EdgeKV bucket items.

  node dist/tools/src/build.js leaks.txt --out ./buckets

Sorting 100M records in memory would need well over a gigabyte, so this does an
external sort: pass 1 spills each record to one of 256 files chosen by the first
two hex chars of the hash, pass 2 sorts one spill file at a time.

Because PREFIX_LEN (4) is greater than 2, every spill file maps to a contiguous,
disjoint run of buckets, so walking the spill files in order emits buckets in
strictly ascending order and peak memory is one spill file.

Output is NDJSON, one {"item","value"} per line, which upload.ts chunks into
bulk-upload requests. Also writes fingerprints.json for verify.ts.
*/
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PREFIX_LEN, RECORD_LEN } from "../../src/constants.js";
import {
  BUCKET_COUNT,
  buildBucketValue,
  isValidHash,
  prefixOf,
  recordOf,
} from "../../src/bucket.js";
import { fingerprint } from "./fingerprint.js";

const SPILL_PREFIX_LEN = 2;
const SPILL_COUNT = 16 ** SPILL_PREFIX_LEN;

interface BuildStats {
  linesRead: number;
  valid: number;
  invalid: number;
  duplicatesDropped: number;
  bucketsWritten: number;
  largestBucketChars: number;
}

function usage(): never {
  console.error(
    "usage: nml-build <hashes.txt> --out <dir> [--keep-spills]\n" +
      "  <hashes.txt>  one 64-char lowercase hex sha256 per line\n" +
      "  --out         directory for buckets.ndjson and fingerprints.json"
  );
  process.exit(2);
}

/** Pass 1: stream the input and spill 16-char records to 256 files by hash[0..2). */
async function spill(
  inputPath: string,
  spillDir: string,
  stats: BuildStats
): Promise<void> {
  const streams = new Array(SPILL_COUNT);
  for (let i = 0; i < SPILL_COUNT; i++) {
    const name = i.toString(16).padStart(SPILL_PREFIX_LEN, "0");
    streams[i] = createWriteStream(join(spillDir, `${name}.txt`));
  }

  const reader = createInterface({
    input: createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const backpressure: Promise<void>[] = [];

  for await (const rawLine of reader) {
    stats.linesRead++;
    const hash = rawLine.trim();
    if (hash.length === 0) {
      continue;
    }
    if (!isValidHash(hash)) {
      stats.invalid++;
      if (stats.invalid <= 10) {
        // Never log the line itself: an invalid line may still be credential-derived.
        console.warn(`  skipping invalid line ${stats.linesRead} (length ${hash.length})`);
      }
      continue;
    }
    stats.valid++;

    // Store prefix chars 2..4 with the record so pass 2 can recover the full bucket
    // id without re-reading the source. The spill file name supplies chars 0..2.
    const index = parseInt(hash.substring(0, SPILL_PREFIX_LEN), 16);
    const line = hash.substring(SPILL_PREFIX_LEN, PREFIX_LEN) + recordOf(hash) + "\n";
    if (!streams[index].write(line)) {
      backpressure.push(
        new Promise<void>((resolve) => streams[index].once("drain", () => resolve()))
      );
      if (backpressure.length >= 16) {
        await Promise.all(backpressure.splice(0));
      }
    }
  }

  await Promise.all(backpressure);
  await Promise.all(
    streams.map(
      (s: import("node:fs").WriteStream) =>
        new Promise<void>((resolve, reject) => s.end((err?: Error) => (err ? reject(err) : resolve())))
    )
  );
}

/** Pass 2: sort each spill file and emit its buckets in ascending order. */
async function emit(
  spillDir: string,
  outDir: string,
  stats: BuildStats
): Promise<void> {
  const bucketsOut = createWriteStream(join(outDir, "buckets.ndjson"));
  const fingerprints: Record<string, { n: number; fp: string }> = {};
  // Chars of the prefix that live in the spill line rather than the file name.
  const tailLen = PREFIX_LEN - SPILL_PREFIX_LEN;

  for (let i = 0; i < SPILL_COUNT; i++) {
    const head = i.toString(16).padStart(SPILL_PREFIX_LEN, "0");
    const raw = await readFile(join(spillDir, `${head}.txt`), "utf8");
    if (raw.length === 0) {
      continue;
    }

    // Group this spill file's lines by their remaining prefix chars.
    const groups = new Map<string, string[]>();
    for (const line of raw.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const tail = line.substring(0, tailLen);
      const record = line.substring(tailLen);
      const group = groups.get(tail);
      if (group === undefined) {
        groups.set(tail, [record]);
      } else {
        group.push(record);
      }
    }

    // Ascending bucket order within the spill file.
    for (const tail of [...groups.keys()].sort()) {
      const records = groups.get(tail)!;
      const value = buildBucketValue(records);
      stats.duplicatesDropped += records.length - value.length / RECORD_LEN;

      const item = head + tail;
      bucketsOut.write(JSON.stringify({ item, value }) + "\n");
      fingerprints[item] = { n: value.length / RECORD_LEN, fp: fingerprint(value) };
      stats.bucketsWritten++;
      if (value.length > stats.largestBucketChars) {
        stats.largestBucketChars = value.length;
      }
    }
  }

  await new Promise<void>((resolve, reject) =>
    bucketsOut.end((err?: Error) => (err ? reject(err) : resolve()))
  );

  writeFileSync(
    join(outDir, "fingerprints.json"),
    JSON.stringify(
      {
        prefix_len: PREFIX_LEN,
        record_len: RECORD_LEN,
        // Identifies which build is live once upload.ts writes it into the _meta item.
        built_at: new Date().toISOString(),
        total_records: stats.valid - stats.duplicatesDropped,
        buckets: fingerprints,
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const outIndex = args.indexOf("--out");
  if (!inputPath || inputPath.startsWith("--") || outIndex === -1 || !args[outIndex + 1]) {
    usage();
  }
  const outDir = args[outIndex + 1]!;
  const keepSpills = args.includes("--keep-spills");

  mkdirSync(outDir, { recursive: true });
  const spillDir = join(tmpdir(), `nml-spill-${process.pid}`);
  mkdirSync(spillDir, { recursive: true });

  const stats: BuildStats = {
    linesRead: 0,
    valid: 0,
    invalid: 0,
    duplicatesDropped: 0,
    bucketsWritten: 0,
    largestBucketChars: 0,
  };

  const started = Date.now();
  console.log(`pass 1: spilling ${inputPath} to ${SPILL_COUNT} files`);
  await spill(inputPath, spillDir, stats);
  console.log(`  ${stats.valid.toLocaleString()} valid, ${stats.invalid.toLocaleString()} invalid`);

  console.log("pass 2: sorting and emitting buckets");
  await emit(spillDir, outDir, stats);

  if (!keepSpills) {
    await rm(spillDir, { recursive: true, force: true });
  }

  const unique = stats.valid - stats.duplicatesDropped;
  console.log(
    [
      "",
      `records in        ${stats.valid.toLocaleString()}`,
      `duplicates dropped${stats.duplicatesDropped.toLocaleString().padStart(12)}`,
      `records stored    ${unique.toLocaleString()}`,
      `buckets written   ${stats.bucketsWritten.toLocaleString()} of ${BUCKET_COUNT.toLocaleString()} possible`,
      `largest bucket    ${(stats.largestBucketChars / 1024).toFixed(1)} KB` +
        ` (${(stats.largestBucketChars / RECORD_LEN).toLocaleString()} records)`,
      `elapsed           ${((Date.now() - started) / 1000).toFixed(1)}s`,
      "",
      `wrote ${join(outDir, "buckets.ndjson")} and ${join(outDir, "fingerprints.json")}`,
    ].join("\n")
  );

  if (stats.invalid > 0) {
    console.warn(
      `\nWARNING: ${stats.invalid.toLocaleString()} lines were not 64-char lowercase hex and were skipped.`
    );
  }
}

main().catch((error) => {
  console.error(`nml-build failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
