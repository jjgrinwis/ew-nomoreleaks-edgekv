# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An Akamai EdgeWorker ("NoMoreLeaks", resource tier 200; the EW id and all other
account values live in the gitignored `local-config.sh`) that checks
the username/password pair in a login request against a list of known leaked
credential hashes held in **EdgeKV**, and forwards the verdict to origin as
`x-nomoreleaks: true|false`. It does not block anything itself.

There is no subworker, no outbound HTTP to a credential store, and no Property
Manager variable in the lookup path: EdgeKV is read directly.

### Request flow

1. `responseProvider` intercepts the login POST; the body is read as JSON or
   form-urlencoded depending on Content-Type.
2. `UNAME`/`PASSWD` paths from `constants.ts` pull the credentials out.
3. `sha256(username.toLowerCase().normalize("NFC") + password.normalize("NFC"))`,
   lowercase hex, no separator. **This contract is shared with the offline
   builder, which consumes an already-hashed list — do not re-derive it there.**
4. `isKnownLeaked(hash)` reads one EdgeKV item and binary-searches its value.
5. The request goes to origin with `x-nomoreleaks`.
6. One structured log line per check.

## Storage layout (the thing to understand first)

100M hashes cannot be one item each — a namespace caps at 10,000,000 items — so
the list is bucketed by prefix:

- **item id** = first `PREFIX_LEN` (4) hex chars of the sha256 → 65,536 items
- **value** = the next `RECORD_LEN` (16) hex chars of every hash sharing that
  prefix, concatenated with no separator, sorted ascending

At 100M: ~1,526 records and ~23.8 KB per item, ~1.6 GB total, item count
independent of dataset size, false-positive rate ~8.3e-17. Lowercase hex is
order-preserving in ASCII, so the value is binary-searched as a plain string
with `substring()` — never decode it, never split it into an array.

`src/bucket.ts` and `src/constants.ts` are compiled into **both** the EdgeWorker
and `tools/` on purpose (`tools/tsconfig.json` includes them via `../src/`).
A `PREFIX_LEN`/`RECORD_LEN` disagreement between builder and reader would make
every lookup miss silently — the worst failure this system can have. **Do not
fork these two files, and do not change the constants without rebuilding and
re-uploading the whole list.**

## Key files

All EdgeWorker sources live in `src/` and are emitted flat into `built/`
(`rootDir: "src"`), so the bundle layout stays flat and imports stay `./x.js`.

- **`src/main.ts`** — the `responseProvider` handler.
- **`src/knownKey.ts`** — the EdgeKV lookup. Must never throw or reject.
- **`src/bucket.ts`** — pure layout helpers. Imports nothing but `constants.ts`,
  so it runs on both EdgeWorkers and Node.
- **`src/constants.ts`** — the only file to edit for deployment.
- **`src/generateDigest.ts`**, **`src/utils.ts`** — SHA-256 and JSON path
  helpers.
- **`src/edgekv.d.ts`** — hand-written types for the vendored helper. Must use
  top-level `export` statements; a `declare module "./edgekv.js"` form is
  rejected with TS2436.
- **`vendor/edgekv.js`** — EdgeKV helper library v0.6.3, vendored (not on npm).
- **`tools/`** — offline builder / uploader / verifier, Node + TypeScript. See
  `tools/README.md`. Excluded from `tsconfig.json` so it never reaches the bundle.

## Commands

Every script that talks to Akamai reads its account values from the
environment, so source `local-config.sh` first:

```bash
source ./local-config.sh

npm run typecheck                 # tsc --noEmit
npm run lint                      # eslint
npm run build                     # tsc + vendor copy + bundle.json. Local only.
npm run package                   # build + tarball into dist/
npm run verify-bundle             # tar tzf the built tarball

npm run deploy:staging            # lint + package + upload + activate on staging
npm run activate-edgeworker-prod  # promote the already-uploaded version to prod
npm run status                    # activation status of this package.json version

cd tools && npm test              # 22 unit tests, no credentials needed
```

`build` and `package` never touch the network. Only `deploy:staging`,
`upload-edgeworker` and the two `activate-*` scripts do.

`package.json`'s `config.*` block holds `REPLACE_WITH_*` placeholders on
purpose — real ids live in the gitignored `local-config.sh` (see
`local-config.sh.example`) and override the placeholders via
`AKAMAI_EDGERC_SECTION`, `AKAMAI_ACCOUNT_SWITCH_KEY`, `EW_GROUP_ID`, `EWID`,
`EW_HOSTNAME`. Never write real values back into `package.json`.

## Constraints to respect

- **Tier 200: 4 sub-requests, 2.5 MB handler memory.** The EdgeKV read plus the
  origin request is 2. A 23.8 KB ASCII value is ~47.6 KB as a UTF-16 JS string;
  `PREFIX_LEN` 3 would make that ~762 KB, which is why it is 4.
- **The EdgeKV client is constructed at global scope**, never inside the handler.
- **`timeout` must be set explicitly** (1–4000 ms) and `num_retries_on_timeout`
  is 0: never retry on the login path.
- **`default_value: null`** so a missing bucket (404) is distinguishable from an
  error.
- **Fail open.** Any lookup problem returns `known: false` with status
  `"unavailable"`, and the login proceeds. Keep `unavailable` distinct from a
  clean miss — conflating them makes an EdgeKV outage look like "nothing has
  leaked", a silent security failure. `originRequest` is wrapped in try/catch for
  the same reason.
- **EdgeKV is eventually consistent** (~10 s) and the token in the bundle is
  **read-only**. The EdgeWorker never writes.

## Privacy (non-negotiable)

The list is credential-derived, i.e. pseudonymous personal data under GDPR.

**Never log or store: client IP, username, password, the full hash, or any prefix
of it** — a 5-char hash prefix is a stable correlatable identifier, and the item
id _is_ a hash prefix, so it must not appear in an error message either.

There is exactly one log line per check:

```typescript
logger.log(
  JSON.stringify({ ev: "check", known: known, st: status, ms: lookupMs }),
);
```

This is the **only** source of hit statistics. Do not add EdgeKV hit counters: an
approximate counter under eventual consistency with last-writer-wins converges
toward one region's increments, a multiplicative error sharding cannot fix.

**`vendor/edgekv_tokens.js` is a live credential.** Gitignored under several
patterns; never commit it or put it in documentation. Use
`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` placeholders.

## Open issues

- Akamai's EdgeKV docs say the store _"should not be used to store Sensitive
  Data."_ Whether credential hashes fall under that needs Akamai and privacy
  sign-off before production. Policy question, unresolved.
- **Unrelated repo, real credential exposure.** `snippets-logs.log` is committed
  in commit `7d939af` of the separate repo
  `github.com/jjgrinwis/ew-nomoreleaks-harperdb` and contains plaintext Akamai
  API client tokens and signing keys. Those credentials need rotating and the
  file purging from that repo's history. Nothing to do in _this_ repo — it is
  recorded here only so the task is not lost.
- The predecessor EdgeWorker (id 90754) becomes dead once this ships: deactivate
  it and drop `PMUSER_AUTH_HEADER` from the delivery configuration.
- `getNestedValue` in `src/utils.ts` does not support the bracket-index path
  form (`credentials[0].username`) that `src/constants.ts` documents.
  Pre-existing.

## TypeScript

- EdgeWorker: target/module ES2022, `rootDir: "src"`, `outDir: "built"`,
  `include: ["src/**/*"]`, `types: ["akamai-edgeworkers"]` (no Node APIs exist
  on the platform), `exclude: ["node_modules", "built", "dist", "vendor", "tools"]`.
- `strict` is **not** set, so `strictNullChecks` is off. VS Code's implicit
  project config turns it _on_, so a file the TS server does not associate with
  this tsconfig shows phantom "null is not assignable" errors that
  `npm run typecheck` does not. `.vscode/settings.json` pins
  `typescript.tsdk`; reload the window if the two ever disagree.
- `tools/`: `module: "ESNext"` + `moduleResolution: "Bundler"` so the shared
  `src/` files emit as ESM. Under `NodeNext` they would compile to CommonJS (the
  repo root has no `"type": "module"`) while `tools/src` emitted ESM, and the
  mixed output would not load.
- Imports use the `.js` extension even from TypeScript, and reference the flat
  bundle layout (`./edgekv.js`, not `./vendor/edgekv.js`).
