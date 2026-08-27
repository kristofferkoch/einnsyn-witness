// lib/attest.mjs — ow.attest.v1 attestation of the einnsyn id-union root,
// plus the coverage limits note the report carries.
//
// Contract source: https://openwitness.net/skills/witness/attest.mjs (fetched
// 2026-08-27). The signed string is
//   ow.attest.v1|handle|hashing_version|hashing_fingerprint|takenAt|root|count|commentCount
// with `\` and `|` escaped in every field, so legitimate values (hex roots,
// ISO dates, integers, pipe-free handles) sign byte-identical to their raw
// form. Signature: ed25519 over the UTF-8 canon string, base64url.
//
// This witness attests a DIFFERENT record than a board witness — the einnsyn
// id-union, not ow-hash-1 post content — so hashing_version is deliberately
// NOT ow-hash-1 and the roots are not comparable across witnesses; the
// attestation's value is external, dated publication of the root, not
// cross-witness comparison.

import { createHash, createPrivateKey, createPublicKey, sign, verify as cryptoVerify } from "node:crypto";

export const UNION_HASHING_VERSION = "einnsyn-union-1";

// Fingerprint = sha256 of the one-line contract text below, computed at import
// so the contract and the fingerprint can never drift apart silently.
const CONTRACT =
  "union root = sha256 over the union's sorted `id|firstSeen|lastSeen` lines, " +
  "LF-joined, UTF-8, no trailing newline; union = every id seen in snapshots/, " +
  "firstSeen/lastSeen = first/last capture date";
export const UNION_HASHING_FINGERPRINT = createHash("sha256")
  .update(CONTRACT, "utf8")
  .digest("hex");

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

export function canonAttest(a) {
  return `ow.attest.v1|${esc(a.handle)}|${esc(a.hashing_version)}|${esc(
    a.hashing_fingerprint,
  )}|${esc(a.takenAt)}|${esc(a.root)}|${esc(a.count)}|${esc(a.commentCount)}`;
}

// The honesty line every report carries (OpenWitness, c26073): what a clean
// run does NOT claim. lastSeen bounds disappearance to the daily cadence, and
// an edit/removal restored inside one interval is invisible to the union.
export function limitsNote() {
  return (
    "- **Limits:** no change found means none in what it watched. `lastSeen` " +
    "bounds disappearance to the capture cadence (daily), not below it — " +
    "removed-and-restored inside one interval leaves no trace in the union"
  );
}

// Build a signed attestation for the union root persisted in state.
// keyPem: a PEM ed25519 private key (node KeyObject or PEM string) — passed in,
// never stored here. commentCount is 0 by design: the einnsyn record has no
// comments; the scope field says what the root actually covers.
export function buildUnionAttestation({ state, keyPem, handle }) {
  if (!state || !state.unionRoot) throw new Error("state has no unionRoot to attest");
  const key =
    typeof keyPem === "string" ? createPrivateKey(keyPem) : keyPem;
  const a = {
    v: "ow.attest.v1",
    handle,
    pubkey: publicKeyBase64Url(key),
    scope:
      "einnsyn.no Datatilsynet journal id-union (firstSeen|lastSeen), daily snapshots; not board content, not ow-hash-1",
    takenAt: state.lastRun,
    root: state.unionRoot,
    count: Object.keys(state.knownIds || {}).length,
    commentCount: 0,
    hashing_version: UNION_HASHING_VERSION,
    hashing_fingerprint: UNION_HASHING_FINGERPRINT,
  };
  a.signature = sign(null, Buffer.from(canonAttest(a), "utf8"), key).toString("base64url");
  return a;
}

// Verify an attestation object against its own published public key — the same
// check an external verifier runs, so we never publish what fails it.
export function verifyAttestation(a) {
  try {
    const pub = createPublicKeyFromBase64Url(a.pubkey);
    return cryptoVerify(
      null,
      Buffer.from(canonAttest(a), "utf8"),
      pub,
      Buffer.from(a.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

// --- key helpers ---

function publicKeyBase64Url(privKey) {
  const spki = createPublicKey(privKey).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
}

function createPublicKeyFromBase64Url(b64u) {
  const raw = Buffer.from(b64u, "base64url");
  if (raw.length !== 32) throw new Error("pubkey must be 32 raw ed25519 bytes");
  // SPKI prefix for ed25519 (RFC 8410) is fixed; prepend it to the raw key.
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}
