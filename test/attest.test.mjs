// Tests for lib/attest.mjs — ow.attest.v1 attestation of the einnsyn id-union root.
//
// Why this module exists: OpenWitness (c26073, #2379) — a root your own
// --verify-union replays proves only self-consistency, exactly /api/attest's
// position. Publishing an ed25519-signed ow.attest.v1 object as a board comment
// lands the root on infrastructure the witness does not control, where their
// harvester verifies the signature and lists it. The signed string and field
// escaping follow openwitness.net/skills/witness/attest.mjs byte-for-byte so a
// verifier built against their contract accepts ours unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  canonAttest,
  limitsNote,
  UNION_HASHING_VERSION,
  UNION_HASHING_FINGERPRINT,
  buildUnionAttestation,
  verifyAttestation,
} from "../lib/attest.mjs";

const fixtureState = {
  unionRoot: "e625d3ec9fabe320e053695a85688b12cf51551b16b5c5e2836f21a50d053efc",
  lastRun: "2026-08-27T04:17:02.941Z",
  knownIds: { a: {}, b: {} }, // count derives from keys
};

function fixtureKey() {
  // Throwaway key for tests; the real attestation key never enters this repo.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    priv: privateKey,
    pub: Buffer.from(spki.subarray(spki.length - 32)).toString("base64url"),
  };
}

test("canonAttest matches the OpenWitness field order and escaping", () => {
  assert.equal(
    canonAttest({
      handle: "no-brief", hashing_version: "v", hashing_fingerprint: "f",
      takenAt: "t", root: "r", count: 1, commentCount: 0,
    }),
    "ow.attest.v1|no-brief|v|f|t|r|1|0",
  );
});

test("a handle containing the delimiter cannot reframe the signed message", () => {
  const c1 = canonAttest({
      handle: "a|b", hashing_version: "v", hashing_fingerprint: "f",
      takenAt: "t", root: "r", count: 1, commentCount: 0,
  });
  const c2 = canonAttest({
      handle: "a", hashing_version: "b|v", hashing_fingerprint: "f",
      takenAt: "t", root: "r", count: 1, commentCount: 0,
  });
  assert.notEqual(c1, c2); // escaped, so the split is unambiguous
  assert.ok(c1.includes("a\\|b"));
});

test("backslash in a field is escaped too", () => {
  assert.ok(canonAttest({
    handle: "a\\b", hashing_version: "v", hashing_fingerprint: "f",
    takenAt: "t", root: "r", count: 1, commentCount: 0,
  }).includes("a\\\\b"));
});

test("limitsNote states the cadence bound and the in-gap blind spot", () => {
  const n = limitsNote();
  assert.match(n, /no change found means none in what it watched/);
  assert.match(n, /bounds disappearance to the capture cadence/);
  assert.match(n, /inside one interval leaves no trace/);
});

test("buildUnionAttestation signs the union root and verifyAttestation accepts it", () => {
  const key = fixtureKey();
  const a = buildUnionAttestation({
    state: fixtureState, keyPem: key.priv, handle: "no-brief",
  });
  assert.equal(a.v, "ow.attest.v1");
  assert.equal(a.root, fixtureState.unionRoot);
  assert.equal(a.count, 2); // union size
  assert.equal(a.hashing_version, UNION_HASHING_VERSION);
  assert.equal(a.hashing_fingerprint, UNION_HASHING_FINGERPRINT);
  assert.equal(a.pubkey, key.pub);
  assert.ok(verifyAttestation(a));
});

test("a tampered root fails verification", () => {
  const key = fixtureKey();
  const a = buildUnionAttestation({
    state: fixtureState, keyPem: key.priv, handle: "no-brief",
  });
  const tampered = { ...a, root: "0".repeat(64) };
  assert.equal(verifyAttestation(tampered), false);
});

test("a forged signature fails verification", () => {
  const other = fixtureKey();
  const a = buildUnionAttestation({
    state: fixtureState, keyPem: other.priv, handle: "no-brief",
  });
  a.pubkey = fixtureKey().pub; // mismatched key
  assert.equal(verifyAttestation(a), false);
});
