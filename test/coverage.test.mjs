// Tests for lib/coverage.mjs — cumulative id-union coverage over a volatile window.
//
// Why this module exists: the day-over-day diff compares two 50-post windows
// sliding over ~196k posts. A "removed" id is ambiguous — rotation (new posts
// pushed it out of the head of the window) and silent deletion look identical.
// The cumulative union separates them: an exit with concurrent new arrivals at
// the head is probable rotation; an exit with NOTHING new is suspect. Drift,
// per the pre-registered rule, is a known id that never returns — so a return
// clears the suspicion and the suspect list persists in state.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  updateKnownIds,
  checkHitCounts,
  bootstrapKnownIds,
  unionRoot,
} from "../lib/coverage.mjs";

const day = (n) => `2026-08-${String(n).padStart(2, "0")}`;

test("new ids accumulate into the union with firstSeen/lastSeen", () => {
  const r1 = updateKnownIds({
    known: {},
    suspects: [],
    prevWindow: [],
    currWindow: ["a", "b"],
    runDate: day(1),
  });
  assert.deepEqual(r1.newIds, ["a", "b"]);
  assert.equal(r1.known.a.firstSeen, day(1));
  assert.equal(r1.known.a.lastSeen, day(1));

  const r2 = updateKnownIds({
    known: r1.known,
    suspects: r1.suspects,
    prevWindow: ["a", "b"],
    currWindow: ["a", "b", "c"],
    runDate: day(2),
  });
  assert.deepEqual(r2.newIds, ["c"]);
  assert.equal(r2.known.a.lastSeen, day(2)); // still seen
  assert.equal(r2.known.a.firstSeen, day(1)); // firstSeen never moves
  assert.equal(Object.keys(r2.known).length, 3);
});

test("an exit with concurrent new arrivals is rotation, not suspicion", () => {
  const r = updateKnownIds({
    known: { a: { firstSeen: day(1), lastSeen: day(1) }, b: { firstSeen: day(1), lastSeen: day(1) } },
    suspects: [],
    prevWindow: ["a", "b"],
    currWindow: ["b", "c"], // a left, c arrived — window slid
    runDate: day(2),
  });
  assert.deepEqual(r.exits, [{ id: "a", rotatedOut: true }]);
  assert.deepEqual(r.suspects, []);
});

test("an exit with zero new arrivals is suspect", () => {
  const r = updateKnownIds({
    known: { a: { firstSeen: day(1), lastSeen: day(1) }, b: { firstSeen: day(1), lastSeen: day(1) } },
    suspects: [],
    prevWindow: ["a", "b"],
    currWindow: ["b"], // a left and NOTHING arrived to push it out
    runDate: day(2),
  });
  assert.deepEqual(r.exits, [{ id: "a", rotatedOut: false }]);
  assert.deepEqual(r.suspects, ["a"]);
});

test("a suspect id that returns is cleared and recorded", () => {
  const r = updateKnownIds({
    known: { a: { firstSeen: day(1), lastSeen: day(1) }, b: { firstSeen: day(1), lastSeen: day(2) } },
    suspects: ["a"],
    prevWindow: ["b"],
    currWindow: ["a", "b"], // a came back
    runDate: day(3),
  });
  assert.ok(r.returnedIds.includes("a"));
  assert.deepEqual(r.suspects, []);
  assert.equal(r.known.a.lastSeen, day(3));
});

test("suspects persist across runs while absent", () => {
  const r = updateKnownIds({
    known: { a: { firstSeen: day(1), lastSeen: day(2) }, b: { firstSeen: day(1), lastSeen: day(3) } },
    suspects: ["a"],
    prevWindow: ["b"],
    currWindow: ["b"],
    runDate: day(4),
  });
  assert.deepEqual(r.suspects, ["a"]); // still gone, still suspect
});

// --- Oscillation (2026-08-27 specimen: two disjoint 50-post eras alternate) ---
//
// The 08-26→08-27 pair proved the window is not a stable head: the old era
// RETURNED in full while the new era left, union pinned, hitCount flat. Under
// that regime a per-id "suspect exit" is unclassifiable from the window alone
// (rotation-by-oscillation reads identical to a no-arrival exit), so one return
// anywhere suspends suspect classification permanently; exits stay recorded.

test("a return anywhere clears all standing suspects and flags oscillation", () => {
  // era-A ids: a (returns this run), z (stays absent). Era-B: b (exits now).
  const r = updateKnownIds({
    known: {
      a: { firstSeen: day(1), lastSeen: day(1), absentRuns: 1 },
      z: { firstSeen: day(1), lastSeen: day(1), absentRuns: 1 },
      b: { firstSeen: day(2), lastSeen: day(2), absentRuns: 0 },
    },
    suspects: ["z", "a"],
    prevWindow: ["b"],
    currWindow: ["a"], // old-era id returns; b exits with zero NEW arrivals
    runDate: day(3),
  });
  assert.ok(r.returnedIds.includes("a"));
  assert.equal(r.oscillationObserved, true);
  assert.deepEqual(r.suspects, []); // z's suspicion is vacuous now, cleared
  assert.ok(r.exits.some((e) => e.id === "b" && e.rotatedOut === false));
});

test("once oscillation is observed, exits are recorded but never flagged", () => {
  const r = updateKnownIds({
    known: { b: { firstSeen: day(2), lastSeen: day(2), absentRuns: 0 } },
    suspects: [],
    oscillationObserved: true,
    prevWindow: ["b"],
    currWindow: [], // everything leaves, nothing arrives
    runDate: day(3),
  });
  assert.equal(r.oscillationObserved, true);
  assert.deepEqual(r.suspects, []);
  assert.equal(r.known.b.absentRuns, 1);
});

test("absentRuns counts consecutive absences and resets on presence", () => {
  const r1 = updateKnownIds({
    known: { a: { firstSeen: day(1), lastSeen: day(1), absentRuns: 0 } },
    suspects: [],
    prevWindow: ["a"],
    currWindow: [],
    runDate: day(2),
  });
  assert.equal(r1.known.a.absentRuns, 1);
  const r2 = updateKnownIds({
    known: r1.known,
    suspects: r1.suspects,
    prevWindow: [],
    currWindow: [],
    runDate: day(3),
  });
  assert.equal(r2.known.a.absentRuns, 2); // streak accrues
  const r3 = updateKnownIds({
    known: r2.known,
    suspects: r2.suspects,
    prevWindow: [],
    currWindow: ["a"],
    runDate: day(4),
  });
  assert.equal(r3.known.a.absentRuns, 0); // reset on return
  assert.equal(r3.known.a.lastSeen, day(4));
});

test("legacy known entries without absentRuns migrate as 0", () => {
  const r = updateKnownIds({
    known: { a: { firstSeen: day(1), lastSeen: day(2) } }, // pre-migration shape
    suspects: [],
    prevWindow: ["a"],
    currWindow: [],
    runDate: day(3),
  });
  assert.equal(r.known.a.absentRuns, 1); // 0 assumed, then incremented
});

// --- unionRoot (bind the covered set into a recomputable digest) ---
//
// A union published BESIDE the snapshots must still be trusted; a union whose
// digest a reader can recompute from the snapshots does not. unionRoot is
// sha256 over sorted `id|firstSeen|lastSeen` lines — replaying the snapshots
// (bootstrapKnownIds + folds) must reproduce it exactly.

test("unionRoot is deterministic and binds every field of every entry", () => {
  const known = {
    b: { firstSeen: day(2), lastSeen: day(3), absentRuns: 0 },
    a: { firstSeen: day(1), lastSeen: day(1), absentRuns: 4 },
  };
  const r1 = unionRoot(known);
  const r2 = unionRoot({ ...known });
  assert.equal(r1, r2); // order-independent
  const tampered = { ...known, a: { ...known.a, lastSeen: day(9) } };
  assert.notEqual(unionRoot(tampered), r1); // date change moves the root
  const grown = { ...known, c: { firstSeen: day(3), lastSeen: day(3), absentRuns: 0 } };
  assert.notEqual(unionRoot(grown), r1); // set change moves the root
  // absentRuns deliberately NOT in the preimage: it is advisory streak state,
  // not coverage; it must not be able to move the digest a reader checks.
});

test("bootstrap replay reproduces unionRoot of the folded union", () => {
  const files = [
    { date: day(1), posts: [{ id: "a" }, { id: "b" }] },
    { date: day(2), posts: [{ id: "b" }, { id: "c" }] },
  ];
  const k = bootstrapKnownIds(files);
  const root1 = unionRoot(k);
  // a "published" root must equal what any reader replaying the same files gets
  const k2 = bootstrapKnownIds(JSON.parse(JSON.stringify(files)));
  assert.equal(unionRoot(k2), root1);
  const forged = JSON.parse(JSON.stringify(files));
  forged[1].posts.push({ id: "x" }); // one fabricated snapshot entry
  assert.notEqual(unionRoot(bootstrapKnownIds(forged)), root1);
});

test("hitCount: flat and increasing are ok, any decrease is flagged", () => {
  const hist = [
    { date: day(1), hitCount: 100 },
    { date: day(2), hitCount: 100 },
  ];
  assert.equal(checkHitCounts(hist, 101).ok, true);
  assert.equal(checkHitCounts(hist, 100).ok, true);
  const drop = checkHitCounts(hist, 99);
  assert.equal(drop.ok, false);
  assert.deepEqual(drop.drops, [{ from: 100, to: 99, date: day(2) }]);
});

test("bootstrapKnownIds replays snapshot files in date order", () => {
  const files = [
    {
      date: day(1),
      posts: [{ id: "a" }, { id: "b" }],
    },
    {
      date: day(2),
      posts: [{ id: "b" }, { id: "c" }],
    },
  ];
  const k = bootstrapKnownIds(files);
  assert.deepEqual(
    Object.keys(k).sort(),
    ["a", "b", "c"],
  );
  assert.equal(k.a.firstSeen, day(1));
  assert.equal(k.a.lastSeen, day(1));
  assert.equal(k.b.lastSeen, day(2));
  assert.equal(k.c.firstSeen, day(2));
});
