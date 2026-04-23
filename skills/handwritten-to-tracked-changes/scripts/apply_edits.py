#!/usr/bin/env python3
"""Apply a JSON edit list to a .docx as Word tracked changes.

Stage 2 of the handwritten-to-tracked-changes skill. Pure-deterministic; no
LLM calls. See ../SKILL.md for the edit-list schema.

Usage:
    python apply_edits.py --docx in.docx --edits edits.json --out out.docx
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NSMAP = {"w": W_NS}


def qn(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


@dataclass
class Edit:
    id: str
    op: str              # insert | delete | replace
    anchor: str
    new_text: str
    position: str        # before | after  (insert only)
    occurrence: int      # 1-based
    author: str
    date: str
    note: str


def load_edits(path: Path, today_iso: str) -> tuple[list[Edit], dict]:
    data = json.loads(path.read_text())
    default_author = data.get("default_author", "Reviewer")
    default_date = data.get("date") or today_iso
    color_map = data.get("authors_by_color") or {}

    out: list[Edit] = []
    for i, raw in enumerate(data.get("edits", [])):
        op = raw["op"]
        if op not in ("insert", "delete", "replace"):
            raise ValueError(f"edit {raw.get('id', i)}: bad op {op!r}")
        anchor = raw["anchor"]
        if not anchor:
            raise ValueError(f"edit {raw.get('id', i)}: empty anchor")
        new_text = raw.get("new_text", "") or ""
        if op == "delete" and new_text:
            raise ValueError(f"edit {raw.get('id', i)}: delete must not have new_text")
        if op in ("insert", "replace") and not new_text:
            raise ValueError(f"edit {raw.get('id', i)}: {op} needs new_text")
        position = raw.get("position") or ("after" if op == "insert" else "")
        if op == "insert" and position not in ("before", "after"):
            raise ValueError(f"edit {raw.get('id', i)}: insert position must be before|after")

        author = raw.get("author")
        if not author:
            color = raw.get("color")
            author = color_map.get(color, default_author) if color else default_author

        out.append(Edit(
            id=str(raw.get("id", f"e{i + 1}")),
            op=op,
            anchor=anchor,
            new_text=new_text,
            position=position,
            occurrence=int(raw.get("anchor_occurrence") or 1),
            author=author,
            date=raw.get("date") or default_date,
            note=raw.get("note", ""),
        ))
    return out, data


def paragraph_text(p: etree._Element) -> tuple[str, list[tuple[etree._Element, int, int]]]:
    """Concatenate run text for a paragraph. Return (text, [(run, start, end), ...]).

    Only plain-text `w:t` runs contribute; `w:tab` becomes '\\t', `w:br` becomes '\\n'.
    Other elements (fields, drawings) are ignored for matching purposes — edits
    that land on them will fail the anchor search and get reported.
    """
    parts: list[str] = []
    spans: list[tuple[etree._Element, int, int]] = []
    cursor = 0
    for r in p.findall(qn("r")):
        for child in r:
            if child.tag == qn("t"):
                s = child.text or ""
            elif child.tag == qn("tab"):
                s = "\t"
            elif child.tag == qn("br"):
                s = "\n"
            else:
                continue
            if s:
                spans.append((r, cursor, cursor + len(s)))
                parts.append(s)
                cursor += len(s)
            break  # only first text-bearing child per run contributes; good enough for typical docs
    return "".join(parts), spans


def find_anchor(paragraphs: list[etree._Element], anchor: str, occurrence: int):
    """Return (paragraph_index, start_offset) for the Nth occurrence, or None."""
    seen = 0
    for i, p in enumerate(paragraphs):
        text, _ = paragraph_text(p)
        start = 0
        while True:
            idx = text.find(anchor, start)
            if idx < 0:
                break
            seen += 1
            if seen == occurrence:
                return i, idx
            start = idx + 1
    return None


def split_run_at(run: etree._Element, char_offset: int) -> etree._Element:
    """Split a single-`w:t` run at char_offset. Return the right-hand run.

    The left run keeps the first `char_offset` chars of its text; a new run
    (copy of run properties) is inserted after it with the remainder.
    """
    t = run.find(qn("t"))
    if t is None:
        raise RuntimeError("split_run_at called on a run without w:t")
    text = t.text or ""
    if char_offset <= 0 or char_offset >= len(text):
        raise RuntimeError(f"split offset {char_offset} out of bounds for run len {len(text)}")

    left = text[:char_offset]
    right = text[char_offset:]
    t.text = left
    # preserve leading/trailing whitespace on the right half
    if left != left.strip() or left.endswith(" ") or left.startswith(" "):
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    new_run = etree.fromstring(etree.tostring(run))
    new_t = new_run.find(qn("t"))
    new_t.text = right
    if right != right.strip() or right.endswith(" ") or right.startswith(" "):
        new_t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    run.addnext(new_run)
    return new_run


def runs_covering(p: etree._Element, start: int, end: int) -> list[etree._Element]:
    """Split runs so that the half-open [start, end) range aligns on run boundaries.

    Returns the (possibly new) runs whose concatenated text is exactly the
    slice [start, end) of the paragraph text.
    """
    if start == end:
        return []
    # Re-compute spans after each split, because indices shift.
    covered: list[etree._Element] = []
    consumed = 0
    # Work left-to-right by walking runs fresh each iteration.
    while consumed < (end - start):
        text, spans = paragraph_text(p)
        # Find the run containing position (start + consumed).
        target = start + consumed
        for run, s, e in spans:
            if s <= target < e:
                # Trim left edge of this run if needed.
                if target > s:
                    run = split_run_at(run, target - s)
                    # After split, `run` is the right half; its new span is [target, e).
                    s = target
                # Trim right edge if the edit ends inside this run.
                if end < e:
                    split_run_at(run, end - s)
                    # Left half keeps [s, end); right half is separate. We want left.
                covered.append(run)
                consumed += min(e, end) - target
                break
        else:
            raise RuntimeError("ran off the end of paragraph while covering range")
    return covered


def wrap_with_ins(runs: list[etree._Element], rev_id: int, author: str, date: str) -> None:
    if not runs:
        return
    ins = etree.SubElement(runs[0].getparent(), qn("ins"))
    ins.set(qn("id"), str(rev_id))
    ins.set(qn("author"), author)
    ins.set(qn("date"), date)
    parent = runs[0].getparent()
    idx = list(parent).index(runs[0])
    parent.remove(ins)
    parent.insert(idx, ins)
    for r in runs:
        parent.remove(r)
        ins.append(r)


def wrap_with_del(runs: list[etree._Element], rev_id: int, author: str, date: str) -> None:
    if not runs:
        return
    parent = runs[0].getparent()
    idx = list(parent).index(runs[0])
    # Convert w:t -> w:delText inside each run.
    for r in runs:
        for t in r.findall(qn("t")):
            t.tag = qn("delText")
    del_el = etree.Element(qn("del"))
    del_el.set(qn("id"), str(rev_id))
    del_el.set(qn("author"), author)
    del_el.set(qn("date"), date)
    for r in runs:
        parent.remove(r)
        del_el.append(r)
    parent.insert(idx, del_el)


def build_ins_run(template_run: etree._Element, text: str) -> etree._Element:
    """Clone run properties from template_run, carry new text."""
    new_run = etree.Element(qn("r"))
    rpr = template_run.find(qn("rPr")) if template_run is not None else None
    if rpr is not None:
        new_run.append(etree.fromstring(etree.tostring(rpr)))
    t = etree.SubElement(new_run, qn("t"))
    t.text = text
    if text != text.strip() or text.startswith(" ") or text.endswith(" "):
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return new_run


def insert_ins_at(p: etree._Element, offset: int, text: str, rev_id: int,
                  author: str, date: str) -> None:
    """Insert a new <w:ins> containing `text` at the given paragraph offset."""
    pg_text, spans = paragraph_text(p)
    template = None
    insert_after: etree._Element | None = None
    parent = p

    if offset == 0:
        # Insert as first child (after pPr if present).
        ppr = p.find(qn("pPr"))
        template = spans[0][0] if spans else None
        ins = etree.Element(qn("ins"))
        ins.set(qn("id"), str(rev_id))
        ins.set(qn("author"), author)
        ins.set(qn("date"), date)
        ins.append(build_ins_run(template, text))
        if ppr is not None:
            ppr.addnext(ins)
        else:
            p.insert(0, ins)
        return

    if offset >= len(pg_text):
        # Append at end.
        template = spans[-1][0] if spans else None
        ins = etree.Element(qn("ins"))
        ins.set(qn("id"), str(rev_id))
        ins.set(qn("author"), author)
        ins.set(qn("date"), date)
        ins.append(build_ins_run(template, text))
        p.append(ins)
        return

    # Mid-paragraph: split the run at `offset`, then insert between the halves.
    for run, s, e in spans:
        if s <= offset < e:
            if offset > s:
                split_run_at(run, offset - s)
                # `run` is now the left half; insert after it.
                insert_after = run
            else:
                # offset lands on a run boundary; insert before this run.
                prev = run.getprevious()
                insert_after = prev
            template = run
            break

    ins = etree.Element(qn("ins"))
    ins.set(qn("id"), str(rev_id))
    ins.set(qn("author"), author)
    ins.set(qn("date"), date)
    ins.append(build_ins_run(template, text))

    if insert_after is not None:
        insert_after.addnext(ins)
    else:
        # Insert as first child after pPr.
        ppr = p.find(qn("pPr"))
        if ppr is not None:
            ppr.addnext(ins)
        else:
            p.insert(0, ins)


def apply_edit(paragraphs: list[etree._Element], edit: Edit, rev_id_start: int) -> tuple[int, str | None]:
    """Apply one edit. Return (next_rev_id, error_or_None)."""
    located = find_anchor(paragraphs, edit.anchor, edit.occurrence)
    if located is None:
        return rev_id_start, f"anchor not found (occurrence={edit.occurrence}): {edit.anchor!r}"
    p_idx, start = located
    p = paragraphs[p_idx]
    end = start + len(edit.anchor)

    rev_id = rev_id_start

    if edit.op == "delete":
        runs = runs_covering(p, start, end)
        wrap_with_del(runs, rev_id, edit.author, edit.date)
        return rev_id + 1, None

    if edit.op == "replace":
        runs = runs_covering(p, start, end)
        template = runs[0] if runs else None
        wrap_with_del(runs, rev_id, edit.author, edit.date)
        rev_id += 1
        # Insert the replacement immediately after the <w:del>.
        del_el = runs[0].getparent() if runs else None
        ins = etree.Element(qn("ins"))
        ins.set(qn("id"), str(rev_id))
        ins.set(qn("author"), edit.author)
        ins.set(qn("date"), edit.date)
        ins.append(build_ins_run(template, edit.new_text))
        if del_el is not None:
            del_el.addnext(ins)
        else:
            p.append(ins)
        return rev_id + 1, None

    # insert
    offset = start if edit.position == "before" else end
    insert_ins_at(p, offset, edit.new_text, rev_id, edit.author, edit.date)
    return rev_id + 1, None


def next_rev_id(tree: etree._ElementTree) -> int:
    """Pick a starting w:id above anything already present in the doc."""
    existing = tree.getroot().xpath("//@w:id", namespaces=NSMAP)
    nums = [int(v) for v in existing if str(v).isdigit()]
    return (max(nums) + 1) if nums else 1000


def run_patch(docx_in: Path, edits: list[Edit], docx_out: Path) -> list[str]:
    if docx_in.resolve() == docx_out.resolve():
        raise SystemExit("refusing to overwrite input .docx; pick a different --out path")
    shutil.copyfile(docx_in, docx_out)

    errors: list[str] = []
    with zipfile.ZipFile(docx_out, "r") as zf:
        doc_xml = zf.read("word/document.xml")
        other = {n: zf.read(n) for n in zf.namelist() if n != "word/document.xml"}

    tree = etree.ElementTree(etree.fromstring(doc_xml))
    paragraphs = tree.getroot().xpath("//w:body//w:p", namespaces=NSMAP)
    rev_id = next_rev_id(tree)

    for edit in edits:
        rev_id, err = apply_edit(paragraphs, edit, rev_id)
        if err:
            errors.append(f"[{edit.id}] {err}")

    new_xml = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)

    with zipfile.ZipFile(docx_out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in other.items():
            zf.writestr(name, data)
        zf.writestr("word/document.xml", new_xml)

    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--docx", required=True, type=Path, help="source .docx")
    ap.add_argument("--edits", required=True, type=Path, help="edit-list JSON")
    ap.add_argument("--out", required=True, type=Path, help="destination .docx")
    args = ap.parse_args(argv)

    today_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    edits, _ = load_edits(args.edits, today_iso)
    errors = run_patch(args.docx, edits, args.out)

    if errors:
        print(f"applied {len(edits) - len(errors)} / {len(edits)} edits; {len(errors)} failed:",
              file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 2
    print(f"applied {len(edits)} edits -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
