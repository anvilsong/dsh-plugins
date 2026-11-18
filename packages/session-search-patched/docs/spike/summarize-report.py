#!/usr/bin/env python3
"""S1 spike: print a compact timeline of a scratch report.jsonl, split at marker lines.

usage: summarize-report.py <report.jsonl> [label-substring]
"""
import json
import sys

KEEP_ROWS = ('session-query-sqlite', 'optional-session-query-sqlite', 'optional-session-search', 'optional-tool-session-query', 'session-query-sqlite-patched')


def provider(p):
    if not p:
        return 'none'
    return f"{p.get('ctor')}@{p.get('row')}[{p.get('fiberState')}]"


def line(r):
    e = r.get('event')
    t = r.get('time', '')[11:23]
    if e == 'marker':
        return f"\n=== {r.get('label')} ({r.get('time')})"
    if e == 'js-scope':
        return None
    if e in ('sessionQuery-up', 'sessionQuery-down'):
        return f"{t} {e:18} where={r.get('where')} provider={provider(r.get('provider'))}"
    if e in ('search-ok', 'search-error'):
        extra = f"items={r.get('items')}" if e == 'search-ok' else f"code={r.get('code')} {r.get('message')}"
        return f"{t} {e:18} where={r.get('where')} provider={provider(r.get('provider'))} {extra}"
    if e == 'probe-apply':
        return f"{t} {e:18} row={r.get('rowId')} mode={r.get('mode')} scope={r['facts']['isolate']['sessionQuery']}"
    if e in ('probe-engine-settled', 'probe-engine-failed', 'probe-fallback', 'probe-dispose'):
        return f"{t} {e:18} row={r.get('rowId')} {json.dumps({k: v for k, v in r.items() if k not in ('time', 'pid', 'event', 'rowId')})}"
    if e == 'snapshot':
        rows = [row for row in r.get('rows', []) if row['id'].split(':', 1)[-1] in KEEP_ROWS]
        out = [f"{t} snapshot{' ' + r['auto'] if r.get('auto') else ''} root-provider={provider(r.get('provider'))}"]
        for row in rows:
            err = f" error={row['error']}" if row.get('error') else ''
            out.append(f"      {row['id']:45} disabled={str(row['disabled']):5} state={row['state']}{err}")
        return '\n'.join(out)
    if e in ('reporter-apply', 'reporter-dispose'):
        return f"{t} {e:18} where={r.get('where')}"
    return f"{t} {e} {json.dumps(r)[:200]}"


def main():
    path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else None
    records = [json.loads(text) for text in open(path, encoding='utf8') if text.strip()]
    active = label is None
    for r in records:
        if r.get('event') == 'marker' and label is not None:
            active = label in r.get('label', '')
        if not active:
            continue
        text = line(r)
        if text:
            print(text)


if __name__ == '__main__':
    main()
