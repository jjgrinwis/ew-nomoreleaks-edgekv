/*
(c) Copyright 2024 Akamai Technologies, Inc. Licensed under Apache 2 license.
Purpose: Pure bucket-layout helpers for the leaked-credential list.

This file is shared verbatim by the EdgeWorker (knownKey.ts) and by the offline
builder in tools/. It deliberately imports nothing except constants.ts, so it
runs unchanged on the EdgeWorkers platform and under plain Node, and so the
builder and the reader can never disagree about the layout. A PREFIX_LEN or
RECORD_LEN mismatch between them would cause every lookup to miss silently,
which is the worst failure this system can have.
*/
import { PREFIX_LEN, RECORD_LEN } from "./constants.js";

/** A sha256 digest as lowercase hex. */
export const HASH_LEN = 64;

/** Distinct buckets, i.e. EdgeKV items holding records. 16^PREFIX_LEN. */
export const BUCKET_COUNT = Math.pow(16, PREFIX_LEN);

/**
 * Refuse to build a bucket value longer than this. The EdgeKV item cap is about
 * 1 MB; at 100M hashes and PREFIX_LEN 4 a bucket is ~24 KB, so hitting this
 * means the input file is corrupt, not that the data grew.
 */
export const MAX_VALUE_BYTES = 900_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Exactly 64 lowercase hex chars. Uppercase is rejected: records are compared as strings. */
export function isValidHash(hash: string): boolean {
  return SHA256_HEX.test(hash);
}

/** The EdgeKV item id a hash belongs to. */
export function prefixOf(hash: string): string {
  return hash.substring(0, PREFIX_LEN);
}

/** The discriminating record stored inside that item. */
export function recordOf(hash: string): string {
  return hash.substring(PREFIX_LEN, PREFIX_LEN + RECORD_LEN);
}

/**
 * Binary search a bucket value for a fixed-width record.
 *
 * Lowercase hex is order-preserving in ASCII, so the stored records can be
 * compared as plain strings - no decoding and no array allocation. The caller
 * must have checked that value.length is a multiple of RECORD_LEN.
 */
export function bucketContains(value: string, record: string): boolean {
  let lo = 0;
  let hi = value.length / RECORD_LEN - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const offset = mid * RECORD_LEN;
    const candidate = value.substring(offset, offset + RECORD_LEN);

    if (candidate === record) {
      return true;
    }
    if (candidate < record) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return false;
}

/**
 * Turn a bucket's records into its stored value: sorted ascending, deduplicated,
 * concatenated with no separator. Mutates `records` by sorting it in place.
 *
 * @throws if the resulting value would exceed MAX_VALUE_BYTES
 */
export function buildBucketValue(records: string[]): string {
  records.sort();

  const unique: string[] = [];
  let previous = "";
  for (const record of records) {
    if (record !== previous) {
      unique.push(record);
      previous = record;
    }
  }

  const value = unique.join("");
  if (value.length > MAX_VALUE_BYTES) {
    throw new Error(
      `bucket value ${value.length} chars exceeds MAX_VALUE_BYTES ${MAX_VALUE_BYTES}; input file is probably corrupt`
    );
  }

  return value;
}
