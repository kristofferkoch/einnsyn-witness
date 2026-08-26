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
// Pure functions only: the caller (witness.mjs) owns the filesystem and state.

/**
 * @param {Object} args
 * @param {Record<string, {firstSeen: string, lastSeen: string}>} args.known
 *   Cumulative id-union from state: id -> {firstSeen, lastSeen} (ISO dates).
 * @param {string[]} args.suspects  Ids flagged as suspect exits, from state.
 * @param {string[]} args.prevWindow  Ids served by the previous run's window.
 * @param {string[]} args.currWindow  Ids served by this run's window.
 * @param {string} args.runDate  ISO date (YYYY-MM-DD) of this run.
 */
export function updateKnownIds({ known, suspects, prevWindow, currWindow, runDate }) {
  const next = {};
  for (const [id, seen] of Object.entries(known)) next[id] = { ...seen };

  const prevSet = new Set(prevWindow);
  const currSet = new Set(currWindow);

  const newIds = [];
  for (const id of currWindow) {
    if (!next[id]) {
      next[id] = { firstSeen: runDate, lastSeen: runDate };
      newIds.push(id);
    } else {
      next[id].lastSeen = runDate;
    }
  }

  // Returned: known again after at least one run absent (not in prev window).
  const returnedIds = currWindow.filter((id) => known[id] && !prevSet.has(id));

  // Exits: in the previous window, gone now. Rotation if the head moved.
  const exits = prevWindow
    .filter((id) => !currSet.has(id))
    .map((id) => ({ id, rotatedOut: newIds.length > 0 }));

  const nextSuspects = new Set(suspects);
  for (const e of exits) {
    if (!e.rotatedOut) nextSuspects.add(e.id);
  }
  for (const id of returnedIds) nextSuspects.delete(id);

  return {
    known: next,
    suspects: [...nextSuspects].sort(),
    newIds: [...new Set(newIds)].sort(),
    returnedIds: [...new Set(returnedIds)].sort(),
    exits,
  };
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
