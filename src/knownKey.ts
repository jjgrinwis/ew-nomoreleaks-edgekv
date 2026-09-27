/*
(c) Copyright 2024 Akamai Technologies, Inc. Licensed under Apache 2 license.
Purpose: Look up a credential hash in the bucketed EdgeKV leaked-credential list.

Storage layout (see tools/README.md for the builder):
  item id  = first PREFIX_LEN hex chars of the sha256              e.g. "1a3f"
  value    = the next RECORD_LEN hex chars of every hash sharing that prefix,
             concatenated with no separator and sorted ascending

Lowercase hex is order-preserving in ASCII, so the value can be binary-searched
as a string with substring comparisons - no parsing and no array allocation.
*/
import { logger } from "log";
import { EdgeKV } from "./edgekv.js";
import {
  EDGEKV_NAMESPACE,
  EDGEKV_GROUP,
  RECORD_LEN,
  EDGEKV_TIMEOUT_MS,
} from "./constants.js";
import { isValidHash, prefixOf, recordOf, bucketContains } from "./bucket.js";

/**
 * "ok"          - the answer is authoritative, `known` can be trusted
 * "unavailable" - the lookup could not be performed; `known` is false only
 *                 because we fail open, not because the credential is clean
 */
export type LookupStatus = "ok" | "unavailable";

export interface LookupResult {
  known: boolean;
  status: LookupStatus;
}

// Client is created once at global scope and reused across requests.
// Never construct this inside an event handler.
const edgeKv = new EdgeKV({
  namespace: EDGEKV_NAMESPACE,
  group: EDGEKV_GROUP,
  num_retries_on_timeout: 0,
});

/**
 * Is this credential hash in the leaked-credential list?
 * Never throws and never rejects - the login path must not break on a storage problem.
 */
export async function isKnownLeaked(hash: string): Promise<LookupResult> {
  // generateDigest always produces 64 lowercase hex chars. If it did not, string
  // comparison against the stored records would silently miss every time, so treat
  // it as a lookup failure rather than as a clean password.
  if (!isValidHash(hash)) {
    logger.error("nml: malformed digest, not a 64-char lowercase hex string");
    return { known: false, status: "unavailable" };
  }

  const item = prefixOf(hash);
  const record = recordOf(hash);

  try {
    logger.log("nml: edgekv subrequest start");
    const value = await edgeKv.getText({
      item: item,
      default_value: null,
      timeout: EDGEKV_TIMEOUT_MS,
      num_retries_on_timeout: 0,
    });
    logger.log(
      `nml: edgekv subrequest complete, result ${value === null ? "miss" : "value"}`,
    );

    // 404 on the bucket means no hash carries this prefix - a clean miss, not an error.
    if (value === null) {
      return { known: false, status: "ok" };
    }

    if (value.length % RECORD_LEN !== 0) {
      logger.error(
        `nml: bucket length ${value.length} is not a multiple of ${RECORD_LEN}`,
      );
      return { known: false, status: "unavailable" };
    }

    return { known: bucketContains(value, record), status: "ok" };
  } catch (error) {
    // Deliberately logs only the status - never the item id, which is a hash prefix.
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? error.status
        : 0;
    logger.error(`nml: edgekv lookup failed, status ${status}`);
    return { known: false, status: "unavailable" };
  }
}
