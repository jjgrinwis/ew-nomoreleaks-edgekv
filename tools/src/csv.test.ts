/*
Unit tests for the CSV chunking the uploader feeds to the bulk-upload endpoint.

A chunk that silently drops or reorders items would still produce a COMPLETED
job, so the properties asserted here - every bucket appears exactly once, in
order, and no chunk exceeds the byte budget - are the only thing that catches it.
*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bucket, Chunk, chunkBuckets, csvLine } from "./csv.js";

const GROUP = "hashes";

function buckets(count: number, valueChars: number): Bucket[] {
  const out: Bucket[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      item: i.toString(16).padStart(4, "0"),
      value: "a".repeat(valueChars),
    });
  }
  return out;
}

async function collect(
  input: Bucket[],
  chunkBytes: number
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of chunkBuckets(input, GROUP, chunkBytes)) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Every CSV line across every chunk, in order. */
function lines(chunks: Chunk[]): string[] {
  return chunks.flatMap((chunk) => chunk.csv.split("\n").filter((l) => l.length > 0));
}

test("csvLine writes groupId,itemId,value with a trailing newline", () => {
  assert.equal(csvLine(GROUP, { item: "1a3f", value: "9c4e0b71a5d2f083" }),
    "hashes,1a3f,9c4e0b71a5d2f083\n");
});

test("csvLine rejects fields that would need RFC 4180 quoting", () => {
  // The value is written unescaped, so a comma would shift every later field.
  assert.throws(() => csvLine(GROUP, { item: "1a3f", value: "ab,cd" }), /quoting/);
  assert.throws(() => csvLine(GROUP, { item: "1a3f", value: 'ab"cd' }), /quoting/);
  assert.throws(() => csvLine(GROUP, { item: "1a3f", value: "ab\ncd" }), /quoting/);
  assert.throws(() => csvLine(GROUP, { item: "1a,3f", value: "abcd" }), /quoting/);
});

test("csvLine accepts the pipe-delimited _meta value", () => {
  const value = "built=2026-09-26T10:00:00.000Z|records=100000000|prefix_len=4|record_len=16";
  assert.equal(csvLine(GROUP, { item: "_meta", value }), `hashes,_meta,${value}\n`);
});

test("an empty input produces no chunks", async () => {
  assert.deepEqual(await collect([], 1000), []);
});

test("every bucket appears exactly once, in input order", async () => {
  const input = buckets(500, 40);
  const chunks = await collect(input, 1024);
  const emitted = lines(chunks);

  assert.equal(emitted.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assert.equal(emitted[i], csvLine(GROUP, input[i]!).trimEnd());
  }
});

test("no chunk exceeds the byte budget, and item counts add up", async () => {
  const input = buckets(500, 40);
  const chunkBytes = 1024;
  const chunks = await collect(input, chunkBytes);

  assert.ok(chunks.length > 1, "the input should have been split");
  let total = 0;
  for (const chunk of chunks) {
    assert.ok(
      chunk.csv.length <= chunkBytes,
      `chunk ${chunk.index} is ${chunk.csv.length} bytes, budget ${chunkBytes}`
    );
    assert.equal(chunk.items, chunk.csv.split("\n").filter((l) => l.length > 0).length);
    total += chunk.items;
  }
  assert.equal(total, input.length);
});

test("chunk indexes are contiguous from zero", async () => {
  const chunks = await collect(buckets(100, 40), 512);
  assert.deepEqual(
    chunks.map((c) => c.index),
    chunks.map((_, i) => i)
  );
});

test("a bucket larger than the budget gets a chunk of its own", async () => {
  // Would only happen on a corrupt input, but it must not be dropped or merged.
  const input: Bucket[] = [
    { item: "0000", value: "a".repeat(10) },
    { item: "0001", value: "b".repeat(5000) },
    { item: "0002", value: "c".repeat(10) },
  ];
  const chunks = await collect(input, 100);

  assert.equal(lines(chunks).length, 3);
  const big = chunks.find((c) => c.csv.includes("0001"))!;
  assert.equal(big.items, 1, "the oversized bucket must be alone in its chunk");
});

test("chunking is deterministic, which is what makes a resume line up", async () => {
  const input = buckets(300, 64);
  const first = await collect(input, 2048);
  const second = await collect(input, 2048);
  assert.deepEqual(first, second);
});

test("chunk boundaries are stable when a later prefix of the input is re-run", async () => {
  // A resumed upload skips whole chunks by index, so the first N chunks of a
  // re-run must be byte-identical to the first N of the original run.
  const input = buckets(300, 64);
  const full = await collect(input, 2048);
  const partial = await collect(input.slice(0, input.length - 1), 2048);

  for (let i = 0; i < partial.length - 1; i++) {
    assert.deepEqual(partial[i], full[i]);
  }
});

test("chunkBuckets accepts an async iterable", async () => {
  async function* source(): AsyncGenerator<Bucket> {
    for (const bucket of buckets(10, 40)) {
      yield bucket;
    }
  }

  const chunks: Chunk[] = [];
  for await (const chunk of chunkBuckets(source(), GROUP, 1024)) {
    chunks.push(chunk);
  }
  assert.equal(lines(chunks).length, 10);
});
