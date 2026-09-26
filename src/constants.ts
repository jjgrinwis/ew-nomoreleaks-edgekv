/*
Configuration constants for the NoMoreLeaks EdgeWorker.
This is the only file that should be modified for deployment.

JSON path examples:
- Simple field: "username"
- Nested field: "user.email"
- Array element: "credentials[0].username"

Test with httpie: http POST https://<your-hostname>/login user:='{"name":"test@test.nl","password":"test"}'
*/

export const UNAME = "username";
export const PASSWD = "password";

export const NO_MORE_LEAKS_HEADER = "x-nomoreleaks";

/*
EdgeKV lookup configuration.

The leaked-credential list is stored as prefix buckets: the first PREFIX_LEN hex
chars of the sha256 select the item, and the item value is the concatenation of
the next RECORD_LEN hex chars of every hash sharing that prefix, sorted ascending.
See tools/README.md for how the buckets are built and uploaded.

PREFIX_LEN and RECORD_LEN must match what the builder used, or every lookup misses.
*/
// Replaced in built/constants.js by the namespace from local-config.sh.
export const EDGEKV_NAMESPACE = "__EDGEKV_NAMESPACE__";
export const EDGEKV_GROUP = "hashes";
export const PREFIX_LEN = 4;
export const RECORD_LEN = 16;

// Milliseconds. Must be 1-4000; the helper library throws outside that range.
export const EDGEKV_TIMEOUT_MS = 1000;
