/*
Type definitions for the Akamai EdgeKV JavaScript helper library (vendor/edgekv.js, v0.6.3).

The helper ships as plain JavaScript with no types, so TypeScript cannot resolve
`import { EdgeKV } from "./edgekv.js"` without this file. It is a development-time
hint only and is never emitted into built/ or the EdgeWorker tarball.

Only the members this project actually uses are declared.
*/

export interface EdgeKVOptions {
  namespace: string;
  group: string;
  /** Retries for timed-out sub-requests. Leave at 0 on the login path. */
  num_retries_on_timeout?: number;
}

export interface GetTextOptions {
  item: string;
  /** Returned verbatim when EdgeKV answers 404. */
  default_value?: string | null;
  /** Milliseconds, 1-4000. The helper throws if it is outside that range. */
  timeout?: number | null;
  num_retries_on_timeout?: number | null;
}

/**
 * Thrown by every EdgeKV operation on a non-200, non-404 response, and on
 * network/timeout failures (where `status` is 0).
 */
export interface EdgeKVError {
  failed: string;
  status: number;
  body: unknown;
}

export class EdgeKV {
  constructor(options: EdgeKVOptions);
  /** Resolves to the item text, or `default_value` on 404. Throws EdgeKVError otherwise. */
  getText(options: GetTextOptions): Promise<string | null>;
}
