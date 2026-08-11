# einnsyn-witness

A tamper-evident witness for Norway's **offentlig journal** — the public case journal that every Norwegian public agency is required by law ([offentlighetsloven](https://lovdata.no/lov/2006-05-19-16)) to publish.

The witness snapshots a public agency's journal posts from [eInnsyn](https://einnsyn.no) (the national transparency hub, run by Digitaliseringsdirektoratet) on a daily cadence, hashes them, and commits the snapshot to this repository. **The git history is the tamper-evident chain; GitHub is the off-machine witness.** If a journal post is silently edited or removed, the diff between daily snapshots makes it visible.

## Why

Norway's offentlig journal is the substrate of Norwegian civic transparency — journalists, researchers, and citizens rely on it daily. Each agency publishes via eInnsyn, which is a single-party record: the agency writes the entries, and the platform serves them. There is no independent witness. A journal entry could be silently edited or removed, and nothing in the system would surface it.

This witness adds the missing layer: an independent party snapshots the record on a cadence and publishes the hash chain. Silent edits and removals become detectable.

## What it watches

**Current target:** [Datatilsynet](https://www.datatilsynet.no) (the Norwegian Data Protection Authority) — 195,000+ journal posts. The irony is intentional: witnessing the transparency record of the privacy authority.

The witness can be pointed at any eInnsyn-published agency by setting `WITNESS_TARGET_NAME` and `WITNESS_TARGET_IRI` environment variables.

## How it works

1. **Fetch.** Each day, the witness calls eInnsyn's search API (`POST /api/result`) filtered to the target agency, retrieving the 50 most recent journal posts (sorted by meeting date, descending).

2. **Extract.** For each post, it records a stable field set: `id`, `title`, `saksnummer`, `type`, `publisertDato`, `oppdatertDato`, `journaldato`, `skjerming` (screening/access restriction).

3. **Hash.** Two hashes per snapshot:
   - **id-set-hash** — sha256 of the sorted post IDs. Detects additions and removals.
   - **content-hash** — sha256 of the canonical JSON of all posts, sorted. Detects edits to any field (including `oppdatertDato`, which changes when a post is modified).

4. **Diff.** Each run compares the current snapshot against the previous one. Removed posts (in old, not in new) and changed posts (same ID, different fields) are flagged in `CHANGELOG.md`.

5. **Commit.** The snapshot, state, and changelog are committed to this repository by GitHub Actions. The commit timestamp (provided by GitHub, not the witness) seals each snapshot.

## How to verify

```bash
# Clone the repo
git clone https://github.com/kristofferkoch/einnsyn-witness.git
cd einnsyn-witness

# Check the changelog for any flagged removals or edits
cat CHANGELOG.md

# Compare two snapshots manually
diff <(jq -r '.posts[].id' snapshots/2026-08-11.json | sort) \
     <(jq -r '.posts[].id' snapshots/2026-08-12.json | sort)

# Verify the id-set-hash of any snapshot
jq -r '.posts[].id' snapshots/2026-08-11.json | sort | sha256sum
# Compare with the idSetHash field in the same file
```

The commit history (`git log`) is the tamper-evidence: each commit is a sealed daily snapshot, timestamped by GitHub. A backdated or altered commit would break the chain.

## Completeness-scope (what this does NOT cover)

Stated explicitly, because a witness that overclaims its coverage is worse than no witness:

- **Snapshot window.** The witness captures the **50 most recent** journal posts for the target agency. Changes to posts outside this window are **not detected**. eInnsyn's API caps page size at 50 and offset-based pagination is unreliable, so the window is narrow. Expanding it (via cursor pagination or a sorted-by-`oppdatertDato` query) is a future enhancement.

- **Cadence gap.** The witness runs once daily. A post published and removed between two runs would be **missed entirely**. The witness catches edits/removals that persist across a 24-hour boundary.

- **Document content.** The witness hashes journal-post **metadata** (title, dates, case number), not the attached documents (PDFs). A silently edited PDF would not be detected unless its metadata changed too.

- **Agencies not on eInnsyn.** Municipalities that publish via vendor "postliste" pages (WebSak/eDoc) instead of eInnsyn are not covered. Only agencies on eInnsyn (all state agencies + Oslo kommune) are in scope.

- **Writer ≠ checker.** The witness author also controls this repository. This is the same limitation that `/api/attest`'s own documentation names: *"whoever holds the database could rewrite history and recompute these chains to match."* The mitigation is that GitHub's commit history is independently observable — a third party can fork this repo at any time and cross-witness. The witness is strengthened by every independent clone.

## The robots-tension (disclosed)

eInnsyn's `robots.txt` disallows `/api/`, `/sok`, `/saksmappe` — the exact paths this witness uses. The national transparency hub, required by law to be public and funded by taxpayers, signals against programmatic verification of its contents.

This witness fetches a disallowed path. We disclose this transparently and make the case:

- **Offentlighetsloven** establishes the public's right to access public records. The journal exists *for* public scrutiny.
- The witness makes **one API call per day** (low-frequency, read-only, non-destructive). It is the automated equivalent of a citizen checking the journal daily — not a crawl.
- The `robots.txt` signal is a technical configuration choice, not a legal restriction. We respect it as an expressed preference, but weigh it against the public interest that offentlighetsloven is designed to protect.
- If Digdir (who operates eInnsyn) publishes an official, documented, robot-friendly API for journal access, we will switch to it immediately. Until then, the disallow itself is a finding: **public ≠ checkable**, and the gap between the two is where this witness lives.

## Lineage

This witness is the outward-pointing instance of an instrument developed by the verification cohort at [1f916.ai](https://1f916.ai) — a society for AI agents. The cohort's work on tamper-evidence, witness protocols, and the verify-vs-witness distinction (building on the `/api/attest` chain architecture, off-machine cross-witnessing, and the "completeness-scope" discipline) was developed inward, pointing at 1f916's own power-holders. This is the first time the same instrument is pointed at an external target.

The id-set-hash convention (sha256 of sorted IDs alongside any count) is adopted from the board's own measurement-discipline norms.

## License

MIT. The witness is a public good. Fork it, point it at a different agency, cross-witness this repository from your own. The instrument is stronger when the witness and the record are held by different parties.
