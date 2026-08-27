// lib/coverage.mjs — cumulative id-union coverage over a volatile window.
//
// The daily snapshot is a 50-post window sliding (by moetedato DESC) over the
// agency's ~196k posts. A day-over-day "removed" is ambiguous: rotation (new
// posts push old ones out of the window) and silent deletion look identical.
// This module keeps the cumulative union of every id ever served, so:
//
//   - an exit WITH concurrent new arrivals at the head is probable rotation;
//   - an exit with NOTHING new is suspect (nothing pushed it out);
//   - a suspect id that later returns clears the flag;
//   - drift, per the pre-registered rule, is a known id that never returns.
//
// 2026-08-27 amendment (oscillation): the 08-26→08-27 pair of runs proved the
// window is not a stable head — two DISJOINT 50-post eras alternate, union
// pinned at 100, hitCount flat. Under that regime rotation-by-oscillation
// reads identical to a no-arrival exit, so ONE return anywhere suspends
// suspect classification permanently (oscillationObserved). Exits and
// absentRuns stay recorded; hitCount remains the only global deletion check.
//
// Pure functions only: the caller (witness.mjs) owns the filesystem and state.

import { createHash } from "node:crypto";

/**
 * @param {Object} args
 * @param {Record<string, {firstSeen: string, lastSeen: string, absentRuns?: number}>} args.known
 *   Cumulative id-union from state: id -> {firstSeen, lastSeen, absentRuns}.
 * @param {string[]} args.suspects  Ids flagged as suspect exits, from state.
 * @param {boolean} [args.oscillationObserved]  Sticky, from state; once true,
 *   exits are recorded but never flagged (window proven not a stable head).
 * @param {string[]} args.prevWindow  Ids served by the previous run's window.
 * @param {string[]} args.currWindow  Ids served by this run's window.
 * @param {string} args.runDate  ISO date (YYYY-MM-DD) of this run.
 */
export function updateKnownIds({ known, suspects, oscillationObserved = false, prevWindow, currWindow, runDate }) {
  const next = {};
  for (const [id, seen] of Object.entries(known)) {
    next[id] = { absentRuns: 0, ...seen };
  }

  const prevSet = new Set(prevWindow);
  const currSet = new Set(currWindow);

  const newIds = [];
  for (const id of currWindow) {
    if (!next[id]) {
      next[id] = { firstSeen: runDate, lastSeen: runDate, absentRuns: 0 };
      newIds.push(id);
    } else {
      next[id].lastSeen = runDate;
      next[id].absentRuns = 0;
    }
  }
  for (const id of Object.keys(next)) {
    if (!currSet.has(id)) next[id].absentRuns = (next[id].absentRuns || 0) + 1;
  }

  // Returned: known again after at least one run absent (not in prev window).
  const returnedIds = currWindow.filter((id) => known[id] && !prevSet.has(id));

  // Exits: in the previous window, gone now. Rotation if the head moved.
  const exits = prevWindow
    .filter((id) => !currSet.has(id))
    .map((id) => ({ id, rotatedOut: newIds.length > 0 }));

  // One return anywhere proves the window oscillates; classification of any
  // exit as "nothing pushed it out" is vacuous from then on.
  if (returnedIds.length > 0) oscillationObserved = true;

  let nextSuspects = new Set(suspects);
  if (oscillationObserved) {
    nextSuspects = new Set();
  } else {
    for (const e of exits) {
      if (!e.rotatedOut) nextSuspects.add(e.id);
    }
    for (const id of returnedIds) nextSuspects.delete(id);
  }

  return {
    known: next,
    suspects: [...nextSuspects].sort(),
    oscillationObserved,
    newIds: [...new Set(newIds)].sort(),
    returnedIds: [...new Set(returnedIds)].sort(),
    exits,
  };
}

/**
 * Bind the covered set into a digest a reader can recompute. sha256 over the
 * sorted `id|firstSeen|lastSeen` lines of the union. Replaying the snapshots
 * (bootstrapKnownIds, then folds) must reproduce this exactly — so a union
 * published beside the snapshots carries a root that makes it checkable
 * against them, and any edit to either side moves the digest.
 * absentRuns is deliberately NOT in the preimage: it is advisory streak
 * state, not coverage.
 *
 * @param {Record<string, {firstSeen: string, lastSeen: string}>} known
 */
export function unionRoot(known) {
  const lines = Object.keys(known)
    .sort()
    .map((id) => `${id}|${known[id].firstSeen}|${known[id].lastSeen}`);
  return createHash("sha256").update(lines.join("\n") + "\n").digest("hex");
}

/**
 * hitCount is the agency-wide total the API serves alongside every window.
 * A journal is append-mostly, so the total must never decrease; a drop is
 * evidence of a deletion ANYWHERE in the ~196k posts, including far outside
 * the window — the one global check a 50-post window cannot provide itself.
 *
 * @param {{date: string, hitCount: number}[]} history  From state.
 * @param {number} current
 * @returns {{ok: boolean, drops: {from: number, to: number, date: string}[]}}
 */
export function checkHitCounts(history, current) {
  if (history.length === 0) return { ok: true, drops: [] };
  const max = history.reduce((m, h) => (h.hitCount >= m.hitCount ? h : m));
  const drops =
    current < max.hitCount
      ? [{ from: max.hitCount, to: current, date: max.date }]
      : [];
  return { ok: drops.length === 0, drops };
}

/**
 * Replay parsed snapshot files (in date order) to build the id-union for a
 * host whose state predates cumulative coverage. firstSeen = first file that
 * serves the id; lastSeen = last file that serves it.
 *
 * @param {{date: string, posts: {id: string}[]}[]} files
 */
export function bootstrapKnownIds(files) {
  const known = {};
  for (const f of files) {
    for (const p of f.posts || []) {
      if (!known[p.id]) known[p.id] = { firstSeen: f.date, lastSeen: f.date };
      else known[p.id].lastSeen = f.date;
    }
  }
  return known;
}
