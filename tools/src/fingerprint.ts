/**
 * Cheap non-cryptographic fingerprint (FNV-1a, 32-bit) of a bucket value.
 *
 * Used only to compare a bucket read back from EdgeKV against what the builder
 * produced, so collision resistance is not a requirement - detecting truncation
 * or substitution in a sampled bucket is.
 */
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
