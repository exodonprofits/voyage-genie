#!/usr/bin/env python3
"""Site checks run before every deploy (and locally: python3 tools/check-site.py).

For every .html page in the repo root and every js/*.js file:
  - inline <script> blocks must parse (node --check)
  - tags must be balanced (HTML structure)
  - <style> blocks must have balanced braces
  - local href/src targets should exist (warning only; images/ is skipped
    because it lives on the server, not in the repo)

Exit code 1 if any page outside KNOWN_BROKEN fails a parse/structure check.
Missing link targets are printed as warnings and never block a deploy. Pages in KNOWN_BROKEN
are reported as warnings so one old bug doesn't block every deploy;
remove a page from the list once it's fixed.
"""
import glob
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from html.parser import HTMLParser

KNOWN_BROKEN = {
    'contact.html': 'file is truncated mid-script; needs the full copy from the server',
}

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'source', 'track', 'wbr', 'param'}
OPTIONAL_CLOSE = {'p', 'li', 'option', 'tr', 'td', 'th', 'thead', 'tbody',
                  'tfoot', 'dt', 'dd', 'optgroup', 'colgroup', 'rt', 'rp'}


class TagChecker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if tag not in [t for t, _ in self.stack]:
            self.errors.append(f'stray </{tag}> on line {self.getpos()[0]}')
            return
        while self.stack:
            open_tag, line = self.stack.pop()
            if open_tag == tag:
                break
            if open_tag not in OPTIONAL_CLOSE:
                self.errors.append(f'<{open_tag}> on line {line} never closed')


def first_error_line(stderr):
    return next((l for l in stderr.splitlines() if 'Error' in l), stderr.strip()[:200])


def check_page(path, tmpdir):
    src = open(path, encoding='utf-8', errors='replace').read()
    problems = []
    missing = set()

    checker = TagChecker()
    checker.feed(src)
    checker.close()
    problems += checker.errors
    problems += [f'<{t}> on line {l} never closed' for t, l in checker.stack
                 if t not in OPTIONAL_CLOSE]

    for i, m in enumerate(re.finditer(r'<script([^>]*)>(.*?)</script>', src, re.S)):
        attrs, body = m.group(1), m.group(2)
        if 'src=' in attrs or not body.strip():
            continue
        if re.search(r'type=["\'](?!module|text/javascript)', attrs):
            continue  # JSON-LD, templates, etc.
        ext = '.mjs' if 'module' in attrs else '.js'
        f = os.path.join(tmpdir, f'script{i}{ext}')
        with open(f, 'w', encoding='utf-8') as fh:
            fh.write(body)
        r = subprocess.run(['node', '--check', f], capture_output=True, text=True)
        if r.returncode:
            line = src[:m.start()].count('\n') + 1
            problems.append(f'script starting line {line}: {first_error_line(r.stderr)}')

    for m in re.finditer(r'<style[^>]*>(.*?)</style>', src, re.S):
        css = re.sub(r'/\*.*?\*/', '', m.group(1), flags=re.S)
        css = re.sub(r'"[^"\n]*"|\'[^\'\n]*\'', '""', css)
        if css.count('{') != css.count('}'):
            problems.append(f'CSS braces unbalanced ({css.count("{")} open, {css.count("}")} close)')

    for m in re.finditer(r'''(?:href|src)\s*=\s*["']([^"'#?]+)''', src):
        url = m.group(1).strip()
        if re.match(r'^(https?:|mailto:|tel:|data:|javascript:|//)', url) or '${' in url:
            continue
        target = urllib.parse.unquote(url).lstrip('/')
        if not target or target == 'URL' or target.startswith(('images/', 'cdn-cgi/')):
            continue  # 'URL' is placeholder text inside AI prompt strings
        if not os.path.exists(target):
            missing.add(target)

    return problems, sorted(missing)


def main():
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    tmpdir = tempfile.mkdtemp()
    failed = False

    for path in sorted(glob.glob('js/*.js')):
        r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
        if r.returncode:
            print(f'FAIL {path}: {first_error_line(r.stderr)}')
            failed = True

    missing_by_target = {}
    for path in sorted(glob.glob('*.html')):
        problems, missing = check_page(path, tmpdir)
        for target in missing:
            missing_by_target.setdefault(target, []).append(path)
        if not problems:
            continue
        if path in KNOWN_BROKEN:
            print(f'WARN {path} (known: {KNOWN_BROKEN[path]})')
            for p in problems:
                print(f'       {p}')
            continue
        failed = True
        print(f'FAIL {path}')
        for p in problems:
            print(f'       {p}')

    for target, pages in sorted(missing_by_target.items()):
        print(f'WARN missing {target} <- {", ".join(pages)}')

    print('Site checks failed.' if failed else 'Site checks passed.')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
