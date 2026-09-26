/*
Turning buckets.ndjson into bulk-upload CSV chunks.

Split out of upload.ts so it can be unit tested without running the uploader:
a bug here silently uploads the wrong items, which no job status would reveal.
*/
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Hard cap the API enforces on a single upload request. */
export const MAX_ITEMS_PER_UPLOAD = 5_000_000;

/**
 * CSV fields are written unescaped. The layout only ever produces lowercase hex
 * item ids and values, and _meta is pipe-delimited, so anything that would need
 * RFC 4180 quoting means the input is not what this tool expects.
 */
const SAFE_CSV_FIELD = /^[A-Za-z0-9_|=:.+-]+$/;

export interface Bucket {
  item: string;
  value: string;
}

export interface Chunk {
  index: number;
  items: number;
  csv: string;
}

export function csvLine(group: string, bucket: Bucket): string {
  for (const field of [group, bucket.item, bucket.value]) {
    if (!SAFE_CSV_FIELD.test(field)) {
      throw new Error(
        `refusing to upload item ${bucket.item}: a CSV field contains characters that would need quoting`
      );
    }
  }
  return `${group},${bucket.item},${bucket.value}\n`;
}

/**
 * Group buckets into CSV payloads of at most `chunkBytes`.
 *
 * Chunking is by bytes rather than item count because a bucket is a few dozen
 * bytes on a test list and ~24 KB on the real 100M-hash list. Boundaries are a
 * deterministic function of the input, which is what makes a resumed upload
 * line up with the chunks already written.
 *
 * Accepts a sync iterable so tests can pass an array, and an async one so the
 * uploader can stream: 1.6 GB of buckets must not be held in memory.
 */
export async function* chunkBuckets(
  buckets: Iterable<Bucket> | AsyncIterable<Bucket>,
  group: string,
  chunkBytes: number
): AsyncGenerator<Chunk> {
  let parts: string[] = [];
  let bytes = 0;
  let items = 0;
  let index = 0;

  for await (const bucket of buckets) {
    const csv = csvLine(group, bucket);

    // Close the current chunk before adding, so a single oversized line still
    // gets a chunk of its own rather than being merged past the limit.
    if (items > 0 && (bytes + csv.length > chunkBytes || items >= MAX_ITEMS_PER_UPLOAD)) {
      yield { index: index++, items, csv: parts.join("") };
      parts = [];
      bytes = 0;
      items = 0;
    }

    parts.push(csv);
    bytes += csv.length;
    items++;
  }

  if (items > 0) {
    yield { index: index++, items, csv: parts.join("") };
  }
}

/** Stream the NDJSON written by nml-build. */
export async function* readBuckets(path: string): AsyncGenerator<Bucket> {
  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (line.length > 0) {
      yield JSON.parse(line) as Bucket;
    }
  }
}
