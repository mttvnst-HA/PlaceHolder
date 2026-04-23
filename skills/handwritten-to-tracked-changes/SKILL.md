---
name: handwritten-to-tracked-changes
description: Convert a hand-marked printout of a .docx back into the source .docx with the handwritten edits applied as Word tracked changes (w:ins / w:del). Use when the user provides an original .docx plus photos/scans of marked-up pages and asks for the edits encoded as revisions. Supports per-author attribution by ink color.
---

# Handwritten edits → Word tracked changes

Given an original `.docx` and images of its hand-marked printout, produce a new
`.docx` where each handwritten edit is a real Word revision (visible in
Review → All Markup, accept/reject-ready).

## When to trigger

User provides:
- an original `.docx` (or a path to one), and
- one or more images/PDFs of the printout with handwritten marks,

and asks for the edits applied as tracked changes / revisions / redlines.

## Two-stage workflow

**Stage 1 — Interpret the handwriting (you, with vision).**
For each page image, read the handwritten marks using standard proofreader
conventions:

- `^` caret with text above/in margin → **insert** at the caret position.
- Single strike-through → **delete** the struck text.
- Struck text with replacement above/in margin → **replace**.
- Circled text + margin note → treat note content as the op (e.g. "stet",
  "move", "bold") — if unambiguous, encode it; otherwise list as a question.
- Arrows, transposition loops (`⌒`), `¶` / `no ¶` — handle the common cases;
  flag the rest.

For each edit emit one entry in the JSON edit list (schema below). The
`anchor` field MUST be a verbatim substring of the printed page text long
enough to be unique in the document (roughly 6–12 words, including
punctuation). This is how Stage 2 locates the edit in the source `.docx`
without OCR drift.

If a mark is illegible, ambiguous, or its scope is unclear, do NOT guess —
add it under `"questions"` and ask the user before running Stage 2.

**Stage 2 — Apply the edits (deterministic, `scripts/apply_edits.py`).**

```
python scripts/apply_edits.py \
  --docx  original.docx \
  --edits edits.json \
  --out   original.tracked.docx
```

The script never calls an LLM. It:
1. Opens the `.docx` as a zip, parses `word/document.xml` with `lxml`.
2. For each edit, locates `anchor` in the concatenated run text of each
   paragraph (respecting `anchor_occurrence` if given).
3. Splits runs at the edit boundary so insertions/deletions align on clean
   run boundaries, preserving surrounding formatting.
4. Wraps the affected runs in `<w:ins>` / `<w:del>` with `w:id`, `w:author`,
   `w:date` — converting `<w:t>` to `<w:delText>` inside deletions.
5. Rezips to the output path.

Any edit whose anchor can't be found (or matches ambiguously when
`anchor_occurrence` isn't set) is reported and skipped — the script exits
non-zero so nothing silently drops.

## Edit-list JSON schema

```json
{
  "default_author": "Reviewer",
  "date": "2026-04-23T12:00:00Z",
  "authors_by_color": {
    "red":   "Alice Ng",
    "blue":  "Bob Ortiz",
    "green": "Carla Pym"
  },
  "edits": [
    {
      "id": "e1",
      "op": "insert" | "delete" | "replace",
      "anchor": "verbatim text from the document",
      "anchor_occurrence": 1,
      "position": "before" | "after" | null,
      "new_text": "text to insert (for insert/replace)",
      "color": "red",
      "author": null,
      "page": 3,
      "note": "optional human-readable note"
    }
  ],
  "questions": [
    {"page": 4, "note": "arrow from margin, target unclear"}
  ]
}
```

Field semantics:

- `op: "insert"` — inserts `new_text` relative to `anchor` per `position`
  (`before` = immediately before anchor, `after` = immediately after).
  `anchor` itself is not modified.
- `op: "delete"` — deletes the anchor text.
- `op: "replace"` — deletes anchor, inserts `new_text` in its place.
- `color` selects an author via `authors_by_color`. `author` (if set)
  overrides the color lookup. Falls back to `default_author`.
- `anchor_occurrence` is 1-based; omit when the anchor is already unique.
- `date` applies to every edit unless you add a per-edit `date`.

## Defaults & conventions

- If the user doesn't name the author(s), ask once. Do not silently use
  "Claude" or "AI".
- Default `date` is the conversation's current date at 12:00:00Z.
- Preserve the original `.docx` — always write to a new file, never overwrite.
- Leave `<w:trackRevisions/>` in `word/settings.xml` untouched; the revisions
  are valid regardless of whether Track Changes is "on" in the settings.

## Out of scope for v1

Flag these back to the user rather than attempting them:

- Edits spanning paragraph boundaries (splitting/merging paragraphs).
- Formatting-only changes (bold/italic/style) — would need `<w:rPrChange>`.
- Comments vs. revisions — this skill emits revisions, not `<w:comment>`
  balloons. If the user wants margin notes preserved as comments, say so
  and we'll extend the schema with an `op: "comment"`.
- Moves (cut+paste with arrows) — currently express as delete + insert.

## Files

- `SKILL.md` — this file.
- `scripts/apply_edits.py` — the Stage 2 patcher. Pure `stdlib` + `lxml`.
- `scripts/example_edits.json` — a minimal example.
- `README.md` — quick start for sharing the skill.
