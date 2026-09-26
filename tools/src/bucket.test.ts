/*
Unit tests for the bucket layout shared by the EdgeWorker and the builder.

  npm test        (in tools/)

These run under plain Node because bucket.ts imports nothing but constants.ts.
The binary search tested here is the exact function the EdgeWorker calls.
*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PREFIX_LEN, RECORD_LEN } from "../../src/constants.js";
import {
  BUCKET_COUNT,
  HASH_LEN,
  MAX_VALUE_BYTES,
  bucketContains,
  buildBucketValue,
  isValidHash,
  prefixOf,
  recordOf,
} from "../../src/bucket.js";
import { fingerprint } from "./fingerprint.js";

const sha256 = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

/** Deterministic pseudo-random generator so failures are reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomRecord(rand: () => number): string {
  let out = "";
  for (let i = 0; i < RECORD_LEN; i++) {
    out += "0123456789abcdef"[Math.floor(rand() * 16)];
  }
  return out;
}

/** The obvious, slow implementation the binary search must agree with. */
function linearContains(value: string, record: string): boolean {
  for (let i = 0; i + RECORD_LEN <= value.length; i += RECORD_LEN) {
    if (value.substring(i, i + RECORD_LEN) === record) {
      return true;
    }
  }
  return false;
}

test("layout constants are self-consistent", () => {
  assert.equal(BUCKET_COUNT, 16 ** PREFIX_LEN);
  assert.ok(PREFIX_LEN + RECORD_LEN <= HASH_LEN);
  // The prefix plus the record is what actually discriminates; anything less
  // than 64 bits would make false positives plausible at 100M entries.
  assert.ok((PREFIX_LEN + RECORD_LEN) * 4 >= 64);
});

test("isValidHash accepts only 64 lowercase hex chars", () => {
  const good = sha256("hello");
  assert.equal(good.length, 64);
  assert.ok(isValidHash(good));

  assert.ok(!isValidHash(good.toUpperCase()), "uppercase must be rejected");
  assert.ok(!isValidHash(good.slice(0, 63)), "63 chars");
  assert.ok(!isValidHash(good + "0"), "65 chars");
  assert.ok(!isValidHash(""), "empty");
  assert.ok(!isValidHash("0x" + good.slice(2)), "0x prefix");
  assert.ok(!isValidHash("g".repeat(64)), "non-hex");
  assert.ok(!isValidHash(good.slice(0, 63) + " "), "trailing space");
  assert.ok(!isValidHash(" " + good.slice(1)), "leading space");
});

test("prefixOf and recordOf slice the hash without overlap", () => {
  const hash = sha256("slice me");
  assert.equal(prefixOf(hash), hash.substring(0, PREFIX_LEN));
  assert.equal(recordOf(hash), hash.substring(PREFIX_LEN, PREFIX_LEN + RECORD_LEN));
  assert.equal(prefixOf(hash).length, PREFIX_LEN);
  assert.equal(recordOf(hash).length, RECORD_LEN);
});

test("every hash's record lands in the bucket its prefix selects", () => {
  // The failure this guards against - prefix and record disagreeing - would make
  // every lookup miss silently, so check it over a large sample.
  const byBucket = new Map<string, string[]>();
  for (let i = 0; i < 100_000; i++) {
    const hash = sha256(`user${i}`);
    const prefix = prefixOf(hash);
    const list = byBucket.get(prefix);
    if (list === undefined) {
      byBucket.set(prefix, [recordOf(hash)]);
    } else {
      list.push(recordOf(hash));
    }
  }

  for (let i = 0; i < 100_000; i++) {
    const hash = sha256(`user${i}`);
    const value = buildBucketValue([...byBucket.get(prefixOf(hash))!]);
    assert.ok(
      bucketContains(value, recordOf(hash)),
      `hash ${i} not found in its own bucket`
    );
  }
});

test("bucketContains handles the empty bucket", () => {
  assert.equal(bucketContains("", "0123456789abcdef".slice(0, RECORD_LEN)), false);
});

test("bucketContains handles a single record", () => {
  const record = "a".repeat(RECORD_LEN);
  assert.equal(bucketContains(record, record), true);
  assert.equal(bucketContains(record, "b".repeat(RECORD_LEN)), false);
});

test("bucketContains finds the first and last record", () => {
  const records = ["1", "3", "5", "7", "9", "b", "d", "f"].map((c) =>
    c.repeat(RECORD_LEN)
  );
  const value = buildBucketValue([...records]);

  assert.equal(bucketContains(value, records[0]!), true, "first");
  assert.equal(bucketContains(value, records[records.length - 1]!), true, "last");
  // Just outside the range at each end, where an off-by-one would show up.
  assert.equal(bucketContains(value, "0".repeat(RECORD_LEN)), false, "below first");
  assert.equal(bucketContains(value, "f".repeat(RECORD_LEN - 1) + "e"), false, "inside gap");
});

test("bucketContains matches a linear scan over random buckets", () => {
  const rand = lcg(20260926);

  for (let iteration = 0; iteration < 2_000; iteration++) {
    const size = Math.floor(rand() * 40);
    const records: string[] = [];
    for (let i = 0; i < size; i++) {
      records.push(randomRecord(rand));
    }
    const value = buildBucketValue(records);

    // Probe every stored record, plus random records that are usually absent.
    for (let i = 0; i + RECORD_LEN <= value.length; i += RECORD_LEN) {
      const present = value.substring(i, i + RECORD_LEN);
      assert.equal(bucketContains(value, present), true);
    }
    for (let probe = 0; probe < 5; probe++) {
      const candidate = randomRecord(rand);
      assert.equal(
        bucketContains(value, candidate),
        linearContains(value, candidate),
        `disagreement on ${candidate} in a ${value.length / RECORD_LEN}-record bucket`
      );
    }
  }
});

test("buildBucketValue sorts ascending and deduplicates", () => {
  const a = "0".repeat(RECORD_LEN);
  const b = "5".repeat(RECORD_LEN);
  const c = "f".repeat(RECORD_LEN);

  const value = buildBucketValue([c, a, b, a, c]);
  assert.equal(value, a + b + c);
  assert.equal(value.length % RECORD_LEN, 0);

  // Ascending order is what makes the binary search valid; assert it directly.
  for (let i = RECORD_LEN; i + RECORD_LEN <= value.length; i += RECORD_LEN) {
    const previous = value.substring(i - RECORD_LEN, i);
    const current = value.substring(i, i + RECORD_LEN);
    assert.ok(previous < current, `not strictly ascending at offset ${i}`);
  }
});

test("buildBucketValue rejects an oversized bucket", () => {
  const count = Math.ceil(MAX_VALUE_BYTES / RECORD_LEN) + 1;
  const records: string[] = [];
  for (let i = 0; i < count; i++) {
    records.push(i.toString(16).padStart(RECORD_LEN, "0"));
  }
  assert.throws(() => buildBucketValue(records), /MAX_VALUE_BYTES/);
});

test("fingerprint is stable and sensitive to a single-character change", () => {
  const value = buildBucketValue(["a".repeat(RECORD_LEN), "b".repeat(RECORD_LEN)]);
  assert.equal(fingerprint(value), fingerprint(value));
  assert.notEqual(
    fingerprint(value),
    fingerprint(buildBucketValue(["a".repeat(RECORD_LEN), "c".repeat(RECORD_LEN)]))
  );
  assert.match(fingerprint(value), /^[0-9a-f]{8}$/);
});
