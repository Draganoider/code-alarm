"""Check that every relative link in a tracked Markdown file resolves.

Resolved against what git tracks: a link to an ignored or untracked file is broken on GitHub
even if it opens on your machine. External URLs and #anchors are not followed. Links inside
fenced code blocks and inline code are examples, not links, and are skipped.

Run from the repository root:  python .github/scripts/check_links.py
CI runs the same script (.github/workflows/repo-hygiene.yml).
"""

import posixpath
import re
import subprocess
import sys
from urllib.parse import unquote


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True, check=True).stdout
    return [f for f in out.split("\0") if f]


def link_targets(text):
    text = re.sub(r"^(```|~~~).*?^\1", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S | re.M)
    text = re.sub(r"`[^`\n]*`", "", text)
    for m in re.finditer(r"\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)", text):
        yield text.count("\n", 0, m.start()) + 1, m.group(1)
    for m in re.finditer(r"^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)", text, re.M):
        yield text.count("\n", 0, m.start()) + 1, m.group(1)
    for m in re.finditer(r"<(?:img|a|source)\b[^>]*?\b(?:src|href|srcset)\s*=\s*([\"'])(.*?)\1", text, re.I):
        yield text.count("\n", 0, m.start()) + 1, m.group(2)


def main():
    tracked = tracked_files()
    files = set(tracked)
    folders = set()
    for f in tracked:
        d = posixpath.dirname(f)
        while d and d not in folders:
            folders.add(d)
            d = posixpath.dirname(d)

    errors, checked = [], 0
    for f in tracked:
        if not f.endswith(".md"):
            continue
        with open(f, encoding="utf-8") as fh:
            text = fh.read()
        for line, raw in link_targets(text):
            target = raw.strip()
            if not target or target.startswith(("#", "mailto:", "data:", "javascript:")):
                continue
            if re.match(r"^[a-z][a-z0-9+.-]*://", target, re.I):
                continue
            path = unquote(target.split("#", 1)[0].split("?", 1)[0])
            if not path:
                continue
            if path.startswith("/"):
                resolved = posixpath.normpath(path.lstrip("/"))
            else:
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(f), path))
            checked += 1
            if resolved.rstrip("/") not in files and resolved.rstrip("/") not in folders:
                errors.append(
                    f"::error file={f},line={line}::Broken link: {raw} (resolves to {resolved}, "
                    f"which is not a tracked file or folder)."
                )

    print("\n".join(errors) if errors else f"OK: {checked} relative links resolve")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
