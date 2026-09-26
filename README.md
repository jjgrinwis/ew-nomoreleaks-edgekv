# NoMoreLeaks EdgeWorker

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A defensive security EdgeWorker that checks the username/password pair in a login
request against a list of known leaked credentials held in **EdgeKV**, and tells
the origin the verdict so it can act on it.

## Overview

The EdgeWorker intercepts login POSTs in `responseProvider`, extracts the
username and password from the body, computes a SHA-256 hash of the normalized
pair, looks that hash up in EdgeKV, and forwards the request to origin with
`x-nomoreleaks: true|false`. It does not block anything itself.

```
Client POST /login
  → extract credentials      (JSON or form-urlencoded)
  → sha256(username+password)
  → EdgeKV bucket lookup     (one read, binary search in the handler)
  → origin, with x-nomoreleaks: true|false
```

Reading EdgeKV directly means there is no subworker hop, no network round trip
to a single credential-store origin, no Basic-auth secret in Property Manager,
and no single point of failure on the login path.

## How the list is stored

100M hashes cannot be one EdgeKV item each — a namespace caps at 10,000,000
items — so the list is bucketed by hash prefix:

```
namespace  $EDGEKV_NAMESPACE  group  hashes
item id    first 4 hex chars of the sha256              "1a3f"       → 65,536 items
value      the next 16 hex chars of every hash sharing that prefix,
           concatenated with no separator, sorted ascending
```

At 100M hashes that is 65,536 items of ~23.8 KB, or ~1.6 GB in one namespace,
and the item count does not grow with the list. Lowercase hex is
order-preserving in ASCII, so `bucket.ts` binary-searches the returned value as a
plain string with `substring()` — no parsing and no array allocation in the
handler.

The full SHA-256 is used to select and search a bucket, but only the first 20
hex characters are stored. For example:

```text
full hash:  5083dc51f4334d395f8ef0365fdbeb214320c562290d3e16945a707fe0525b68
item id:    5083
record:     dc51f4334d395f8e
```

If two hashes share an item prefix, their fixed-width 16-character records are
concatenated. For example, an item value may be:

```text
dc51f4334d395f8ee426cbfdcc40289f
```

This is two records, `dc51f4334d395f8e` and `e426cbfdcc40289f`, not one long
record. The lookup takes 16-character slices at offsets 0, 16, 32, and so on,
and binary-searches those slices. No separator is needed.

To inspect a bucket directly with the Akamai CLI, use the environment, namespace,
group, and four-character item id in this order:

```bash
akamai edgekv read item staging "$EDGEKV_NAMESPACE" hashes 5083
```

The returned value is the concatenated bucket value. A bucket read is a storage
inspection only; the EdgeWorker performs the same prefix and record extraction
automatically for each login.

To list all bucket item ids in the `hashes` group, use:

```bash
akamai edgekv list items staging "$EDGEKV_NAMESPACE" hashes
```

The output contains the four-character bucket ids, such as `5083`. Each id can
then be passed to `read item` to inspect that bucket's concatenated records.

The 20 stored hex characters provide 80 bits of discrimination. A random lookup
matching a non-listed record is therefore about $2^{-80}$, or `8.3e-25`.
Two independent hashes colliding in those 20 characters is also extremely
unlikely; the approximate chance across a list of $n$ hashes is
$n(n-1)/(2 \cdot 2^{80})$. Full 256-bit hash duplicates are vastly less likely.

`src/bucket.ts` and `src/constants.ts` are shared source between the EdgeWorker and the
offline tooling in [`tools/`](tools/README.md), so the builder and the reader
cannot disagree about the layout. See that README for the arithmetic, the
builder, the uploader and the verifier.

## Fail-open behaviour

If EdgeKV is unavailable, times out, or returns something malformed, the lookup
returns `known: false` **with status `"unavailable"`** and the login proceeds.
The status is what distinguishes "we checked, the password is clean" from "we
could not check" — without it a total EdgeKV outage would look exactly like
nobody's password having leaked.

## Logging and DataStream

The worker emits EdgeWorker logs for the structured check event and for
fail-open lookup or origin errors. When an Akamai DataStream is configured to
collect EdgeWorker logs, Akamai can forward these logs to the DataStream's
configured destination. DataStream setup, filtering, retention and delivery
are Akamai configuration outside this repository; this code only emits the
logs.

The structured check event contains only `ev`, `known`, `st` and `ms`. It never
logs the username, password, full digest, digest prefix, client IP or bucket
item id.

To attach these logs to an Akamai DataStream 2 stream, create and activate an
EdgeWorkers stream in Akamai Control Center, then set its stream id before
building:

```bash
export EDGEWORKER_DS2_ID="12345"
export EDGEWORKER_LOG_LEVEL="info"
source ./local-config.sh
npm run build
```

The build then writes this `bundle.json` configuration:

```json
{
  "config": {
    "logging": {
      "level": "info",
      "schema": "v1",
      "ds2id": 12345,
      "log-uncaught-exceptions": true
    }
  }
}
```

The stream must be active and accessible to the EdgeWorker before activation.
DataStream delivery is asynchronous; logs typically appear at the configured
destination after about two minutes. Leave `EDGEWORKER_DS2_ID` empty when no
DataStream stream is configured.

## Key files

- **`src/main.ts`** — the `responseProvider` handler: body parsing, hashing, origin
  sub-request, header sanitization.
- **`src/knownKey.ts`** — the EdgeKV lookup. Never throws; the login path must not
  break on a storage problem.
- **`src/bucket.ts`** — pure layout helpers (prefix, record, binary search). Shared
  with `tools/`, imports nothing but `constants.ts`.
- **`src/constants.ts`** — **the only file to edit for deployment**: field paths,
  namespace, group, `PREFIX_LEN`, `RECORD_LEN`, timeout.
- **`src/generateDigest.ts`**, **`src/utils.ts`** — SHA-256 and JSON path helpers.
- **`vendor/edgekv.js`** — the Akamai EdgeKV helper library (v0.6.3), vendored;
  it is not on npm. **`vendor/edgekv_tokens.js`** is the access token and is
  gitignored.
- **`tools/`** — offline builder / uploader / verifier. Excluded from the bundle.

## Configuration

`constants.ts`:

```typescript
export const UNAME = "username"; // JSON path, e.g. "user.email"
export const PASSWD = "password";
export const NO_MORE_LEAKS_HEADER = "x-nomoreleaks";

export const EDGEKV_NAMESPACE =
  "<value from EDGEKV_NAMESPACE in local-config.sh>";
export const EDGEKV_GROUP = "hashes";
export const PREFIX_LEN = 4; // must match the builder
export const RECORD_LEN = 16; // must match the builder
export const EDGEKV_TIMEOUT_MS = 250; // 1-4000; never retried
```

Dotted paths (`user.email`) work. The bracket-index form (`users[0].email`) is
documented in `constants.ts` but **not** supported by the dot-split reducer in
`utils.ts` — a pre-existing limitation.

No Property Manager variables are needed. If the delivery configuration still
defines `PMUSER_AUTH_HEADER`, it is left over from the predecessor EdgeWorker
and can be removed.

## Build and deploy

```bash
npm install
npm run typecheck                 # tsc --noEmit
npm run build-ts                  # tsc + copy vendor/*.js into built/
npm run build                     # NOTE: also uploads AND activates on staging
npm run activate-edgeworker-prod  # production
npm run verify-bundle             # list the tarball contents
```

`build-ts` fails fast if `vendor/edgekv_tokens.js` is missing, since a bundle
without it returns _MISSING ACCESS TOKEN_ at runtime. The vendored files must sit
at the **top level** of the tarball — the bundle is flat, which is why the import
is `./edgekv.js` and not `./vendor/edgekv.js`.

### One-time EdgeKV setup

```bash
npm run create-edgekv-ns                        # staging
npm run create-edgekv-ns-prod                   # production
EXPIRY=2027-09-01 npm run generate-edgekv-token
```

> There is a limit of 20 namespaces per account. If you get an error, skip this step and select and existing namespace which can be retrieved via: npm run list-edgekv-ns

The token is created **read-only** (`namespace-$EDGEKV_NAMESPACE+r`): the EdgeWorker
never writes. The key in the token file must be `namespace-jgrinwiskv`, with the
`namespace-` prefix — the helper library prepends it when looking up credentials.

> **`vendor/edgekv_tokens.js` is a live credential.** Never commit it, paste it
> into a ticket, or put it in documentation. Use
> `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` placeholders; see
> `vendor/edgekv_tokens.js.template`.

## Refreshing the list

A new list arrives every few weeks. A refresh **replaces every bucket value
wholesale**, so hashes absent from the new list cease to exist — there are no
deletes and no per-hash TTL.

```bash
cd tools
npm run nml-build  -- leaks.txt --out ./buckets
npm run nml-upload -- --in ./buckets --network staging --dry-run
npm run nml-upload -- --in ./buckets --network staging --restart
npm run nml-verify -- --in ./buckets --network staging
```

Use `--restart` on the real upload whenever `leaks.txt` has been rebuilt after a
previous upload. It ignores the older `buckets/upload-state.staging.json` and
uploads the new build from the first chunk. It is not needed for the dry run,
which does not record progress.

See [`tools/README.md`](tools/README.md).

## Testing

```bash
http POST https://$EW_HOSTNAME/login \
  Content-Type:application/json username=test@example.com password=testpassword

http --form POST https://$EW_HOSTNAME/login \
  username=test@example.com password=testpassword
```

Debug logging:

```
Pragma: akamai-x-ew-debug-rp
```

`akamai-x-ew-subworkers` and `akamai-x-ew-debug-subs` are no longer relevant —
there is no subworker.

Unit tests for the bucket layout and the CSV chunking live in `tools/` (`npm test`
there, no credentials required). The EdgeWorker itself has no host-side test
harness; the logic worth testing is in `bucket.ts`, which those tests cover as
the exact function the handler calls.

## Privacy

The list is credential-derived and therefore pseudonymous personal data under
GDPR.

**Never stored or logged: client IP, username, password, the full hash, or any
prefix of it.** The EdgeWorker emits exactly one structured line per check:

```json
{ "ev": "check", "known": false, "st": "ok", "ms": 12 }
```

`st` is `ok`, `unavailable` or `nocreds`. That line is the **only** source of hit
statistics — aggregate it via DataStream 2. There are no EdgeKV hit counters: an
approximate counter under eventual consistency with last-writer-wins converges
toward one region's increments, a multiplicative error that sharding cannot fix.

Akamai's EdgeKV documentation states the store _"should not be used to store
Sensitive Data."_ Whether credential hashes fall under that needs sign-off from
Akamai and from privacy review before production. It is a policy question, not a
technical one.

## Troubleshooting

| Symptom                           | Cause                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| _MISSING ACCESS TOKEN_            | `vendor/edgekv_tokens.js` absent from the bundle, or its key lacks the `namespace-` prefix |
| Every lookup misses               | `PREFIX_LEN`/`RECORD_LEN` disagree with the build — check `_meta` via `nml-verify`         |
| `st: "unavailable"` in the logs   | EdgeKV timeout, 4xx/5xx, or a bucket value whose length is not a multiple of `RECORD_LEN`  |
| Credentials not found in the body | `UNAME`/`PASSWD` paths wrong, or a bracket-index path (unsupported)                        |
| A just-uploaded hash still misses | EdgeKV is eventually consistent; allow ~10s                                                |

## License

Copyright 2024 Akamai Technologies, Inc. Licensed under the Apache License,
Version 2.0.
