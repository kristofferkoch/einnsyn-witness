#!/usr/bin/env node
// einnsyn-witness — a tamper-evident witness for Norway's offentlig journal.
//
// Snapshots the latest journal posts from a Norwegian public agency published
// via eInnsyn (einnsyn.no), hashes them, and records the state so that silent
// edits or removals are detectable on the next run.
//
// The git history of this repository IS the tamper-evident chain; the GitHub
// hosting IS the off-machine witness. Each daily commit is a sealed snapshot.
//
// See README.md for the completeness-scope, the robots-tension disclosure,
// and how to verify.

import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SNAPSHOTS_DIR = join(ROOT, "snapshots");
const STATE_FILE = join(ROOT, "state.json");
const CHANGELOG_FILE = join(ROOT, "CHANGELOG.md");

// --- Configuration ---
const TARGET_NAME = process.env.WITNESS_TARGET_NAME || "Datatilsynet";
const TARGET_IRI =
  process.env.WITNESS_TARGET_IRI ||
  "http://data.einnsyn.no/virksomhet/oepeksport_content_provider_100";
const SNAPSHOT_SIZE = parseInt(process.env.WITNESS_SIZE || "500", 10);
const API_URL = "https://einnsyn.no/api/result";
const USER_AGENT =
  "einnsyn-witness/1.0 (+https://github.com/kristofferkoch/einnsyn-witness; daily integrity snapshot of Norwegian public journal; contact via GitHub)";

// --- eInnsyn API client ---
const API_PAGE_SIZE = 50; // eInnsyn caps page size at 50; offset-based pagination is unreliable

async function fetchJournalPosts() {
  const body = {
    size: API_PAGE_SIZE,
    aggregations: { contentTypes: "type", virksomheter: "arkivskaperTransitive" },
    appliedFilters: [
      {
        fieldName: "type",
        fieldValue: ["JournalpostForMøte"],
        type: "notQueryFilter",
      },
      {
        fieldName: "arkivskaperTransitive",
        fieldValue: [TARGET_IRI],
        type: "termQueryFilter",
      },
    ],
    sort: { fieldName: "moetedato", order: "DESC" },
  };

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`eInnsyn API returned HTTP ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  return data;
}

// --- Extract a stable, minimal field set from each hit ---
function extractPost(hit) {
  const s = hit.source || {};
  const parent = s.parent || {};
  return {
    id: s.id || hit.id,
    title: parent.offentligTittel || s.offentligTittel || null,
    saksnummer: parent.saksnummer || s.saksnummer || null,
    type: s.type || parent.type || null,
    journalposttype: s.journalposttype || null,
    publisertDato: s.publisertDato || parent.publisertDato || null,
    oppdatertDato: s.oppdatertDato || parent.oppdatertDato || null,
    journaldato: s.journaldato || null,
    skjerming: s.skjerming || null,
  };
}

// --- Hashing (unspent's id-set-hash convention + content hash) ---
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function idSetHash(posts) {
  const ids = posts.map((p) => p.id).sort();
  return sha256(ids.join("\n"));
}

function contentHash(posts) {
  const canonical = posts
    .map((p) => JSON.stringify(p, Object.keys(p).sort()))
    .sort()
    .join("\n");
  return sha256(canonical);
}

// --- State management ---
function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { firstRun: null, lastRun: null, lastIdSetHash: null, lastContentHash: null, totalSnapshots: 0 };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function loadPreviousSnapshot() {
  if (!existsSync(STATE_FILE)) return null;
  const state = loadState();
  if (!state.lastSnapshotDate) return null;
  const path = join(SNAPSHOTS_DIR, `${state.lastSnapshotDate}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// --- Diff ---
function diffSnapshots(prev, curr) {
  const prevMap = new Map(prev.posts.map((p) => [p.id, p]));
  const currMap = new Map(curr.posts.map((p) => [p.id, p]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, p] of currMap) {
    if (!prevMap.has(id)) {
      added.push(p);
    } else {
      const old = prevMap.get(id);
      if (JSON.stringify(old) !== JSON.stringify(p)) {
        changed.push({ id, old, curr: p });
      }
    }
  }
  for (const [id, p] of prevMap) {
    if (!currMap.has(id)) removed.push(p);
  }

  return { added, removed, changed };
}

// --- Changelog ---
function appendChangelog(date, summary, diff) {
  const header = existsSync(CHANGELOG_FILE)
    ? readFileSync(CHANGELOG_FILE, "utf-8")
    : "# Changelog — einnsyn-witness\n\nHuman-readable diff log. Each entry is one daily snapshot run.\n\n";

  let entry = `\n## ${date}\n\n`;
  entry += `**Target:** ${summary.target}  \n`;
  entry += `**Total hits (agency):** ${summary.hitCount}  \n`;
  entry += `**Snapshot size:** ${summary.snapshotSize}  \n`;
  entry += `**id-set-hash:** \`${summary.idSetHash}\`  \n`;
  entry += `**content-hash:** \`${summary.contentHash}\`\n\n`;

  if (!diff) {
    entry += `_First snapshot — baseline established. No diff._\n`;
  } else {
    entry += `### Diff from previous snapshot (${summary.previousDate})\n\n`;
    entry += `- **Added:** ${diff.added.length} post(s)\n`;
    entry += `- **Removed:** ${diff.removed.length} post(s)\n`;
    entry += `- **Changed:** ${diff.changed.length} post(s)\n\n`;

    if (diff.removed.length > 0) {
      entry += `#### Removed (⚠️ potential silent removals)\n\n`;
      for (const p of diff.removed.slice(0, 20)) {
        entry += `- \`${p.id}\` — ${p.title || "(no title)"} [${p.saksnummer || "?"}]\n`;
      }
      if (diff.removed.length > 20) entry += `\n_...and ${diff.removed.length - 20} more._\n`;
      entry += "\n";
    }

    if (diff.changed.length > 0) {
      entry += `#### Changed (⚠️ potential silent edits)\n\n`;
      for (const c of diff.changed.slice(0, 20)) {
        const fields = Object.keys(c.curr).filter(
          (k) => JSON.stringify(c.old[k]) !== JSON.stringify(c.curr[k]),
        );
        entry += `- \`${c.id}\` — ${c.curr.title || "(no title)"} — changed: ${fields.join(", ")}\n`;
      }
      if (diff.changed.length > 20) entry += `\n_...and ${diff.changed.length - 20} more._\n`;
      entry += "\n";
    }

    if (diff.added.length > 0) {
      entry += `#### Added (new posts — normal)\n\n`;
      for (const p of diff.added.slice(0, 10)) {
        entry += `- \`${p.id}\` — ${p.title || "(no title)"} [${p.saksnummer || "?"}]\n`;
      }
      if (diff.added.length > 10) entry += `\n_...and ${diff.added.length - 10} more._\n`;
      entry += "\n";
    }

    if (diff.removed.length === 0 && diff.changed.length === 0) {
      entry += `_No removals or edits detected. Only normal additions._\n`;
    }
  }

  writeFileSync(CHANGELOG_FILE, header + entry);
}

// --- Main ---
async function main() {
  console.log(`[einnsyn-witness] Fetching latest ${SNAPSHOT_SIZE} posts for ${TARGET_NAME}...`);

  const data = await fetchJournalPosts();
  const rawPosts = (data.searchHits || []).map(extractPost);
  // Deduplicate by ID (the API can return duplicate entries within a page)
  const seen = new Set();
  const posts = rawPosts.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const timestamp = now.toISOString();

  const iHash = idSetHash(posts);
  const cHash = contentHash(posts);

  const snapshot = {
    date,
    timestamp,
    target: TARGET_NAME,
    targetIri: TARGET_IRI,
    hitCount: data.hitCount,
    snapshotSize: posts.length,
    idSetHash: iHash,
    contentHash: cHash,
    note: `${posts.length} of ${data.hitCount} total posts. id-set-hash is sha256 of sorted ids; content-hash is sha256 of canonical JSON per post, sorted. See CHANGELOG.md for diffs.`,
    posts,
  };

  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  writeFileSync(join(SNAPSHOTS_DIR, `${date}.json`), JSON.stringify(snapshot, null, 2) + "\n");

  const state = loadState();
  const prev = loadPreviousSnapshot();
  const diff = prev ? diffSnapshots(prev, snapshot) : null;

  const summary = {
    target: TARGET_NAME,
    hitCount: data.hitCount,
    snapshotSize: posts.length,
    idSetHash: iHash,
    contentHash: cHash,
    previousDate: prev?.date,
  };

  appendChangelog(date, summary, diff);

  const newState = {
    firstRun: state.firstRun || timestamp,
    lastRun: timestamp,
    lastSnapshotDate: date,
    lastIdSetHash: iHash,
    lastContentHash: cHash,
    totalSnapshots: (state.totalSnapshots || 0) + 1,
  };
  saveState(newState);

  console.log(`[einnsyn-witness] Snapshot saved: snapshots/${date}.json`);
  console.log(`[einnsyn-witness] hitCount=${data.hitCount} snapshotSize=${posts.length}`);
  console.log(`[einnsyn-witness] id-set-hash=${iHash.slice(0, 16)}`);
  console.log(`[einnsyn-witness] content-hash=${cHash.slice(0, 16)}`);
  if (diff) {
    console.log(
      `[einnsyn-witness] Diff: +${diff.added.length} added, -${diff.removed.length} removed, ~${diff.changed.length} changed`,
    );
  } else {
    console.log("[einnsyn-witness] First run — baseline established.");
  }
}

main().catch((err) => {
  console.error("[einnsyn-witness] FATAL:", err.message);
  process.exit(1);
});
