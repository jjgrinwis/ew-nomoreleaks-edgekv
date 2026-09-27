# NoMoreLeaks offline tooling

Turns a flat list of leaked-credential sha256 hashes into EdgeKV bucket items,
uploads them, and verifies what landed. Run every few weeks when a new list
arrives. Nothing here is deployed — it never ends up in the EdgeWorker bundle
(`tsconfig.json` at the repo root excludes `tools/`).

```bash
cd tools
npm install
npm test                                                     # 22 unit tests, no credentials needed

npm run nml-build  -- leaks.txt --out ./buckets
npm run nml-upload -- --in ./buckets --network staging
npm run nml-verify -- --in ./buckets --network staging
```

After rebuilding `leaks.txt`, use `--restart` for the real upload if the output
directory contains an upload state from an older build:

```bash
npm run nml-upload -- --in ./buckets --network staging --restart
```

This ignores `upload-state.staging.json` and uploads the new build from the
first chunk. A dry run does not record progress, so `--restart` is only needed
on the real upload.

## Storage layout

The EdgeWorker cannot hold 100M items — a namespace caps at 10,000,000 — so the
hashes are bucketed by prefix:

```
namespace  $EDGEKV_NAMESPACE
group      hashes
item id    first 4 hex chars of the sha256              "1a3f"
value      the next 16 hex chars of every hash sharing that prefix,
           concatenated with no separator, sorted ascending
```

|                     | at 100,000,000 hashes                                               |
| ------------------- | ------------------------------------------------------------------- |
| items               | 65,536 (16⁴) — **0.66%** of the 10M namespace cap, in one namespace |
| records per bucket  | mean 1,526, σ ≈ 39; largest of 65,536 at 5σ ≈ 1,720                 |
| value size          | **~23.8 KB** mean, ~26.9 KB at 5σ — the cap is 999,999 bytes        |
| total storage       | ~1.6 GB                                                             |
| false positive rate | about 1 in 12 quadrillion per random lookup across 100M records     |

**Item count is independent of dataset size.** Growing to 200M changes value
size, not item count. Three hex chars would mean 4,096 items of ~381 KB, which
lands in EdgeKV's slowest write tier and costs ~760 KB of the EdgeWorker's
2.5 MB handler memory as a UTF-16 string; five would mean 1,048,576 items and a
pure long-tail read pattern. Four is the middle.

`PREFIX_LEN` and `RECORD_LEN` live in `../src/constants.ts` and the layout functions
in `../src/bucket.ts`. Both files are compiled into **both** the EdgeWorker and this
tooling on purpose (see `tsconfig.json`): if the builder and the reader ever
disagreed about the layout, every lookup would miss silently, which is the worst
failure this system can have. Do not fork them.

Lowercase hex is order-preserving in ASCII, which is why the value is a plain
concatenated string: the EdgeWorker binary-searches it with `substring()` and
never parses or allocates. Base64 would halve the bytes but its standard
alphabet is not order-preserving.

A refresh **replaces every bucket value wholesale**, so hashes absent from the
new list simply cease to exist. There are no deletes and no per-hash TTL.

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
record. The reader takes 16-character slices at offsets 0, 16, 32, and so on,
and binary-searches those slices. No separator is needed.

To inspect a bucket directly with the Akamai CLI, use the environment, namespace,
group, and four-character item id in this order:

```bash
akamai edgekv read item staging "$EDGEKV_NAMESPACE" hashes 5083
```

The returned value is the concatenated bucket value. The builder and reader use
the same `PREFIX_LEN` and `RECORD_LEN`, so a direct read should be interpreted
in fixed-width chunks rather than as one hash.

To list all bucket item ids in the `hashes` group, use:

```bash
akamai edgekv list items staging "$EDGEKV_NAMESPACE" hashes
```

The output contains the four-character bucket ids, such as `5083`. Each id can
then be passed to `read item` to inspect that bucket's concatenated records.

Only 20 hex characters of each hash are stored, giving 80 bits of discrimination.
With 100 million stored records, the chance of any accidental collision in
those stored values is about 1 in 240 million. A random lookup matching any
stored record by accident is still only about 1 in 12 quadrillion. A collision
in the full 256-bit SHA-256 value is vastly less likely.

## `nml-build`

```
nml-build <hashes.txt> --out <dir> [--keep-spills]
```

Input is one 64-char **lowercase** hex sha256 per line. The builder does not
hash anything — the EdgeWorker's digest contract is
`sha256(username.toLowerCase().normalize("NFC") + password.normalize("NFC"))`
and re-deriving it here would create a second place for it to drift.

Sorting 100M records in memory would need well over a gigabyte, so it does an
external sort: pass 1 spills each record into one of 256 files keyed on the
hash's first two hex chars; pass 2 sorts one spill file at a time. Because
`PREFIX_LEN` (4) is greater than 2, each spill file maps to a contiguous,
disjoint run of buckets, so walking them in order emits buckets in ascending
order with peak memory of one spill file. It runs on a laptop.

Outputs into `--out`:

- **`buckets.ndjson`** — one `{"item","value"}` per line, ascending by item.
- **`fingerprints.json`** — `prefix_len`, `record_len`, `built_at`,
  `total_records`, and per bucket a record count and an FNV-1a fingerprint of
  the value. `nml-verify` reads this.

Lines that are not 64-char lowercase hex are counted, reported and skipped; the
line's **contents are never printed**, since an invalid line may still be
credential-derived. A bucket whose value would exceed 900,000 chars aborts the
build — at 100M that is 37× the expected size, so it means a corrupt input, not
growth.

## `nml-upload`

```
nml-upload --in <dir> --network staging|production [--dry-run] [--restart]
           [--namespace "$EDGEKV_NAMESPACE"] [--group hashes] [--section gss]
           [--switchkey <key>] [--chunk-bytes 8388608] [--rps 5]
```

Authenticates with EdgeGrid from `~/.edgerc` (section from
`$AKAMAI_EDGERC_SECTION`, or `--section`) and POSTs `text/csv` of
`groupId,itemId,value` lines to

```
POST /edgekv/v1/networks/{network}/namespaces/{namespaceId}/upload
```

which answers `202` with a `Location` header. That job is polled until
`jobStatus` is `COMPLETED`; a job reporting any failed write, or fewer
successful writes than the chunk held, aborts the run.

Account-specific values are never hardcoded in this repo. Source the gitignored
`local-config.sh` at the repo root before running any of these commands — it
exports `AKAMAI_EDGERC_SECTION` and, if the account needs one,
`AKAMAI_ACCOUNT_SWITCH_KEY`:

```bash
source ../local-config.sh
npm run nml-upload -- --in out --network staging --dry-run
```

Both can be overridden per run with `--section` / `--switchkey`. `--section` has
no default: an unset section aborts rather than guessing, since the wrong one
would authenticate against the wrong account.

**Always run `--network staging` first, and `--dry-run` before that.** A dry run
sends `dryRun=true`, writes nothing, and deliberately does not record progress.

Notes on the mechanics, in case they look surprising:

- **Chunking is by payload bytes**, default 8 MB, not by item count. A bucket is
  a few dozen bytes on a test list and ~24 KB on the real one. `maxItems` is
  sent as an assertion (the API caps it at 5,000,000), not as the boundary. The
  API does not document a request-size limit, hence the conservative default; at
  100M this is ~200 requests.
- **Resumable.** Chunk boundaries are a deterministic function of the input file
  and every write is a full overwrite of a fixed item id, so re-running a chunk
  is a no-op. Progress goes to `<dir>/upload-state.<network>.json` and is picked
  up automatically; it refuses to resume against a different `built_at`, which
  would mix two lists in one namespace. `--restart` ignores it.
- **Paced to 5 requests/sec** by default. The EdgeKV Administrative API allows a
  burst of 24 hits/sec and an average of 18 over two minutes; exceeding it
  returns 403 and **blocks the client for ten minutes**. There is nothing to
  gain from running near that limit every few weeks.
- **The payload is not gzipped**, though the API accepts `Content-Encoding:
gzip`. `akamai-edgegrid` JSON-stringifies any non-string request body unless
  the Content-Type is `application/gzip` — which this endpoint rejects — so
  sending compressed bytes would mean hand-rolling the request signing. Hex
  halves under gzip at best, and a refresh runs every few weeks.
- **`_meta` is written last**, as `built=…|records=…|prefix_len=…|record_len=…`.
  Nothing on the login path reads it: the EdgeWorker must not spend a second
  EdgeKV read per check. It is the operator's record of which build is live, and
  it advancing is the signal that a refresh completed.

## `nml-verify`

```
nml-verify --in <dir> --network staging|production [--samples 200] [--seed <n>]
```

A `COMPLETED` job with zero errors says the API accepted every record. It does
not say the stored value is byte-for-byte what was built. This reads a sample of
buckets back through the read-item endpoint and compares record count and
fingerprint, then checks `_meta` matches this build. Any mismatch exits 1.

EdgeKV is **eventually consistent** — a write can take ten seconds or longer to
become readable — so wait a moment after an upload before reading too much into
a 404. `--seed` makes a reported failure reproducible.

## One-time EdgeKV setup

From the repo root, where the namespace, group, EdgeWorker id and switch key are
already in `package.json`:

```bash
npm run create-edgekv-ns          # staging
npm run create-edgekv-ns-prod     # production
EXPIRY=2027-09-01 npm run generate-edgekv-token
```

The token is created **read-only** (`namespace-$EDGEKV_NAMESPACE+r`): the EdgeWorker
never writes, so the token embedded in the bundle must not be able to. Writes go
through this tooling, authenticated separately.

Retention is `0`, meaning data is retained indefinitely. That is required here —
a refresh replaces values wholesale every few weeks, and a finite retention
would silently expire buckets between refreshes.

> **`vendor/edgekv_tokens.js` is a live credential.** It is gitignored under
> several patterns; never commit it, paste it into a ticket, or put it in
> documentation. Use `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` placeholders. See
> `vendor/edgekv_tokens.js.template`.

## Privacy

The list is credential-derived and therefore pseudonymous personal data under
GDPR. **Nothing here logs a hash, a hash prefix, a username, a password or a
client IP**, and the EdgeWorker emits exactly one structured line per check
(`{"ev":"check","known":…,"st":…}`) which carries none of those either.
That log line is the only source of hit statistics; there are no counters.

Akamai's EdgeKV documentation states the store _"should not be used to store
Sensitive Data."_ Whether credential hashes fall under that needs sign-off from
Akamai and from privacy review before production. It is a policy question, not
a technical one.
