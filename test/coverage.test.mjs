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
