#!/usr/bin/env python3
"""S8: compact timeline of a scratch report.jsonl written by test/scratch/observer.

usage: summarize.py <report.jsonl> [marker-label-substring]

Without a label every record is printed; with one, the records from the first
marker whose label contains it up to the next marker. The report holds only
hashed ids, counts, provider facts, redacted error facts and the package's own
log lines, so the output carries no session content.
"""
import json
import sys

ROWS = ('optional-session-search', 'optional-session-query-sqlite', 'optional-tool-session-query',
        'session-query-sqlite-patched', 'session-query-sqlite', 'ssp-observer-group', 'ssp-observer-root')


def provider(p):
    if not p:
        return 'none'
    if 'error' in p:
        return f"error {p['error']}"
    cls = 'shipped-class' if p.get('sameClassAsRootShipped') else f"other-class(patch-methods={p.get('patchMethods')})"
    return f"{p.get('ctor')}@{p.get('row')}[{p.get('fiberState')}] {cls} bases-identical={p.get('basesIdenticalToShipped')} prc={p.get('persistedReadConcurrency')}"


def line(r):
    e = r.get('event')
    t = r.get('time', '')[11:23]
    if e == 'marker':
        return f"\n=== {r.get('label')} ({r.get('time')})"
    if e in ('sessionQuery-up', 'sessionQuery-down'):
        return f"{t} {e:17} {provider(r.get('provider'))}"
    if e == 'facts':
        s = r.get('store', {})
        pk = r.get('packages', {})
        entry = pk.get('entry', {}) if isinstance(pk, dict) else {}
        peers = ', '.join(f"{k.split('/')[-1]}={'asar' if (v or {}).get('inAsar') else ('none' if v is None else 'NOT-asar')}@{(v or {}).get('version')}" for k, v in entry.items())
        src = pk.get('sources', {}) if isinstance(pk, dict) else {}
        srcs = ', '.join(f"{k}={'pin-ok' if v.get('equalsGuardPin') else 'MISMATCH'}" for k, v in src.items() if isinstance(v, dict) and 'sha256' in v) or str(src)
        return (f"{t} facts             store root starts with scratch DSH_HOME={s.get('rootStartsWithScratchHome')} listed={s.get('listed')} "
                f"{('listError=' + str(s.get('listError'))) if s.get('listError') else ''}\n"
                f"      packageOf(entry): {peers}\n      sources vs guard pins: {srcs}")
    if e == 'query-start':
        return f"{t} query-start       label={r.get('label')} provider={provider(r.get('provider'))}"
    if e == 'query-done':
        return (f"{t} query-done        label={r.get('label')} sha256={r.get('sha256')} hits={r.get('hits')} "
                f"errors={r.get('errors')} totalMs={r.get('totalMs')}")
    if e == 'query-error':
        return f"{t} query-error       label={r.get('label')} {r.get('id')} code={r.get('code')} {r.get('name')}: {r.get('message')}"
    if e == 'snapshot':
        out = [f"{t} snapshot {r.get('label')} root-provider={provider(r.get('rootProvider'))}"]
        for row in r.get('rows', []):
            if row['id'].split(':', 1)[-1] in ROWS:
                err = f" error={row['error']}" if row.get('error') else ''
                out.append(f"      {row['id']:45} disabled={str(row['disabled']):5} state={row['state']}{err}")
        for log in (r.get('logs') or {}).get('lines', []):
            out.append(f"      log {log['ts']} {log['type']:5} [{log['name']}] {log['text']}")
        return '\n'.join(out)
    if e in ('observer-apply', 'observer-dispose'):
        return f"{t} {e:17} where={r.get('where')} scope={r.get('scope')}"
    return f"{t} {e} {json.dumps(r)[:300]}"


def main():
    path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else None
    active = label is None
    for text in open(path, encoding='utf8'):
        if not text.strip():
            continue
        r = json.loads(text)
        if r.get('event') == 'marker' and label is not None:
            active = label in r.get('label', '')
        if active:
            print(line(r))


if __name__ == '__main__':
    main()
