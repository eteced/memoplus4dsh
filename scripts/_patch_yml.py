#!/usr/bin/env python3
"""Marker-delimited block surgery on a dsh profile cordis.patch.yml.

A profile patch file is a top-level YAML array of loader patch entries. This
helper adds or removes a managed block delimited by marker comments:

    # >>> <marker> (managed; do not edit between markers)
    ...block lines...
    # <<< <marker>

`add` replaces any existing block with the same marker (idempotent) and strips
the empty-array placeholder line (`[]`) from the shipped template, which would
otherwise make the file invalid once real entries follow. `remove` deletes the
block and restores `[]` when no top-level entries remain, so a file derived
from the template returns to a valid empty patch list.

Usage: _patch_yml.py <file> <marker> add <block-file>
       _patch_yml.py <file> <marker> remove
"""

import sys


def marker_lines(marker: str) -> tuple[str, str]:
    return f"# >>> {marker} (managed; do not edit between markers)", f"# <<< {marker}"


def strip_block(lines: list[str], marker: str) -> list[str]:
    begin, end = marker_lines(marker)
    out: list[str] = []
    skipping = False
    for line in lines:
        if line.rstrip() == begin:
            skipping = True
            continue
        if skipping:
            if line.rstrip() == end:
                skipping = False
            continue
        out.append(line)
    if skipping:
        raise SystemExit(f"error: unterminated marker block {marker!r}; fix the file by hand")
    return out


def has_top_level_entry(lines: list[str]) -> bool:
    return any(line.startswith("- ") and not line.startswith("#") for line in lines)


def cmd_add(path: str, marker: str, block_path: str) -> None:
    with open(path, encoding="utf-8") as handle:
        lines = strip_block(handle.read().splitlines(), marker)
    with open(block_path, encoding="utf-8") as handle:
        block = handle.read().splitlines()
    if not block:
        raise SystemExit("error: block file is empty")
    # The shipped template ends in a bare `[]` placeholder; a real entry list
    # cannot follow it, so drop it (trailing blank lines first).
    while lines and lines[-1].strip() == "":
        lines.pop()
    if lines and lines[-1].strip() == "[]":
        lines.pop()
        while lines and lines[-1].strip() == "":
            lines.pop()
    begin, end = marker_lines(marker)
    lines += ["", begin, *block, end, ""]
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))


def cmd_remove(path: str, marker: str) -> None:
    with open(path, encoding="utf-8") as handle:
        lines = strip_block(handle.read().splitlines(), marker)
    while lines and lines[-1].strip() == "":
        lines.pop()
    if not has_top_level_entry(lines) and not any(line.strip() == "[]" for line in lines):
        lines += ["", "[]"]
    lines.append("")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))


def main(argv: list[str]) -> None:
    if len(argv) < 4:
        raise SystemExit(__doc__)
    path, marker, command = argv[1], argv[2], argv[3]
    if command == "add" and len(argv) == 5:
        cmd_add(path, marker, argv[4])
    elif command == "remove" and len(argv) == 4:
        cmd_remove(path, marker)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
