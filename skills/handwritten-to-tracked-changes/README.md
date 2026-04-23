# handwritten-to-tracked-changes (Claude skill)

Turn photos of a hand-marked `.docx` printout into the same `.docx` with the
edits encoded as Word tracked changes (`w:ins` / `w:del`), ready for Review →
Accept / Reject. Supports per-reviewer attribution by ink color.

## Install

### Claude.ai (web/desktop)

1. `zip -r handwritten-to-tracked-changes.zip handwritten-to-tracked-changes/`
2. In Claude.ai: **Settings → Capabilities → Skills → Upload skill** and pick
   the zip.

### Claude Code

Copy or symlink the folder into one of:

```
~/.claude/skills/handwritten-to-tracked-changes/       # personal, all projects
<repo>/.claude/skills/handwritten-to-tracked-changes/  # shared via the repo
```

### Agent SDK

Mount the folder as a skill directory when you construct the agent.

## Requirements

The `apply_edits.py` script needs Python ≥ 3.9 and `lxml`:

```
pip install lxml
```

On Claude.ai the bundled code-execution sandbox already has `lxml`.

## Use

Attach the original `.docx` and the marked-up page images, then say something
like:

> Apply these handwritten edits as tracked changes. Red = Alice, blue = Bob.

Claude will read the marks, emit an edit list, show it to you for
confirmation (especially any ambiguous marks), then run
`apply_edits.py` to produce `yourdoc.tracked.docx`.

## Manual Stage-2-only run

If you already have an edit-list JSON (see `scripts/example_edits.json`):

```
python scripts/apply_edits.py \
  --docx  original.docx \
  --edits edits.json \
  --out   original.tracked.docx
```

The script exits non-zero and prints a report if any anchor fails to match;
no edits are silently dropped.

## See also

- `SKILL.md` — full trigger / workflow / schema spec.
- `scripts/apply_edits.py` — deterministic patcher (no LLM calls).
- `scripts/example_edits.json` — minimal edit-list example.
