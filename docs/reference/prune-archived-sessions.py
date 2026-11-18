#!/usr/bin/env python3
"""Move archived DSH sessions and all their descendants into a trash folder.

DSH 0.2.2 has no session delete. Archiving only adds the id to
`archivedSessionIds` in ~/.dsh/storages/workspace.json; the session folders stay
under ~/.dsh/sessions/<workspace>/<id>/. This tool finds every archived session
plus its subagent descendants (the `parentSession` link in each log's first
line), and moves the folders (never deletes) into ~/.dsh/archive-trash/<stamp>/.

  prune-archived-sessions.py                   dry run: print what would move
  prune-archived-sessions.py --apply-folders   move the folders (host may run)
  prune-archived-sessions.py --apply-registry  fix workspace.json + projection
                                               cache (dsh-web must be STOPPED)
  prune-archived-sessions.py --restore DIR     move everything back from DIR

Safety: refuses to move a session that the running host has open, or whose log
changed in the last 30 minutes (override with --force). Nothing is deleted;
remove the trash folder yourself when you are satisfied.
"""
import argparse, collections, datetime, json, os, shutil, subprocess, sys, time

HOME = os.environ.get('PRUNE_HOME') or os.path.expanduser('~')  # PRUNE_HOME: sandbox testing only
SESSIONS = os.path.join(HOME, '.dsh', 'sessions')
WORKSPACE = os.path.join(HOME, '.dsh', 'storages', 'workspace.json')
PROJCACHE = os.path.join(HOME, '.dsh', 'storages', 'session_projcache')
TRASH_ROOT = os.path.join(HOME, '.dsh', 'archive-trash')
PIDFILE = os.path.join(HOME, '.dsh', 'dsh-web.pid')
LOG = 'session.v4.jsonl.zstd'


def host_pid():
    try:
        pid = int(open(PIDFILE).read().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def parent_of(path):
    """parentSession from the first log line, or None."""
    try:
        head = subprocess.run(
            f"zstdcat '{path}' 2>/dev/null | head -c 4000 | head -1",
            shell=True, capture_output=True, text=True).stdout
        event = json.loads(head)
    except (ValueError, OSError):
        return None
    data = event.get('data', event)
    return data.get('parentSession') or event.get('parentSession')


def scan():
    info, parent = {}, {}
    for ws in sorted(os.listdir(SESSIONS)):
        wdir = os.path.join(SESSIONS, ws)
        if not os.path.isdir(wdir):
            continue
        for sid in os.listdir(wdir):
            log = os.path.join(wdir, sid, LOG)
            if not os.path.exists(log):
                continue
            info[sid] = (ws, os.path.join(wdir, sid), os.path.getsize(log), os.path.getmtime(log))
            p = parent_of(log)
            if p:
                parent[sid] = p
    return info, parent


def cascade(archived, info, parent):
    kids = collections.defaultdict(list)
    for child, par in parent.items():
        kids[par].append(child)
    seen, stack = set(), list(archived)
    while stack:
        sid = stack.pop()
        if sid in seen:
            continue
        seen.add(sid)
        stack.extend(kids.get(sid, []))
    return seen & set(info)


def open_session_dirs(pid, folders):
    """Folders (from `folders`) that the host process currently has files open in."""
    if pid is None:
        return set()
    out = subprocess.run(['lsof', '-nP', '-p', str(pid), '-Fn'], capture_output=True, text=True).stdout
    paths = [line[1:] for line in out.splitlines() if line.startswith('n/')]
    return {f for f in folders if any(p.startswith(f + os.sep) for p in paths)}


def mb(n):
    return f'{n / 1048576:,.0f} MB'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apply-folders', action='store_true')
    ap.add_argument('--apply-registry', action='store_true')
    ap.add_argument('--restore', metavar='DIR')
    ap.add_argument('--trash', metavar='DIR', help='trash folder for --apply-registry (default: newest)')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--dry-run', action='store_true', help='with --apply-registry: print the changes, write nothing')
    args = ap.parse_args()

    if args.restore:
        return restore(args.restore)
    if args.apply_registry:
        return apply_registry(args)

    registry = json.load(open(WORKSPACE))
    archived = set(registry['global'].get('archivedSessionIds', []))
    info, parent = scan()
    todo = cascade(archived, info, parent)
    extra = todo - archived
    size = sum(info[s][2] for s in todo)
    by_ws = collections.Counter(info[s][0] for s in todo)
    print(f'archived ids: {len(archived)} | descendants: {len(extra)} | folders to move: {len(todo)} | on disk: {mb(size)}')
    for ws, n in by_ws.most_common():
        print(f'  {n:4d}  {ws}')

    pid = host_pid()
    busy = open_session_dirs(pid, [info[s][1] for s in todo])
    recent = [s for s in todo if time.time() - info[s][3] < 1800]
    if busy:
        print(f'REFUSED: the running host has {len(busy)} of these sessions open:')
        for f in sorted(busy)[:10]:
            print('   ', f)
    if recent:
        print(f'REFUSED: {len(recent)} of these sessions changed in the last 30 minutes')
    if not args.apply_folders:
        print('dry run only: nothing moved. Re-run with --apply-folders.')
        return 0
    if (busy or recent) and not args.force:
        return 2

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    trash = os.path.join(TRASH_ROOT, stamp)
    os.makedirs(os.path.join(trash, 'sessions'), exist_ok=True)
    shutil.copy2(WORKSPACE, os.path.join(trash, 'workspace.json.before'))
    moved = []
    for sid in sorted(todo):
        ws, src, _size, _mtime = info[sid]
        dest = os.path.join(trash, 'sessions', ws, sid)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        os.rename(src, dest)
        moved.append({'id': sid, 'workspace': ws, 'archived': sid in archived, 'parent': parent.get(sid)})
    json.dump({'stamp': stamp, 'moved': moved, 'registryApplied': False}, open(os.path.join(trash, 'manifest.json'), 'w'), indent=1)
    print(f'moved {len(moved)} folders to {trash}')
    print('NEXT: stop dsh-web, run --apply-registry, then start dsh-web.')
    return 0


def newest_trash(arg):
    if arg:
        return arg
    stamps = sorted(d for d in os.listdir(TRASH_ROOT) if os.path.exists(os.path.join(TRASH_ROOT, d, 'manifest.json')))
    if not stamps:
        sys.exit('no trash folder with a manifest found')
    return os.path.join(TRASH_ROOT, stamps[-1])


def apply_registry(args):
    if host_pid() is not None and not args.force and not args.dry_run:
        print('REFUSED: dsh-web is running (pid %s). Stop it first; the host rewrites workspace.json.' % host_pid())
        return 2
    trash = newest_trash(args.trash)
    manifest = json.load(open(os.path.join(trash, 'manifest.json')))
    ids = {m['id'] for m in manifest['moved']}
    registry = json.load(open(WORKSPACE))
    g = registry['global']
    before = (len(g.get('archivedSessionIds', [])), len(g.get('pinnedSessionIds', [])),
              sum(len(w.get('sessionIds', [])) for w in registry['tables']['workspaces'].values()))
    if not args.dry_run:
        shutil.copy2(WORKSPACE, os.path.join(trash, 'workspace.json.before-registry'))
    for key in ('archivedSessionIds', 'pinnedSessionIds'):
        if key in g:
            g[key] = [i for i in g[key] if i not in ids]
    for w in registry['tables']['workspaces'].values():
        if 'sessionIds' in w:
            w['sessionIds'] = [i for i in w['sessionIds'] if i not in ids]
    after = (len(g.get('archivedSessionIds', [])), len(g.get('pinnedSessionIds', [])),
             sum(len(w.get('sessionIds', [])) for w in registry['tables']['workspaces'].values()))
    print(f'workspace.json: archived {before[0]}->{after[0]}, pinned {before[1]}->{after[1]}, workspace sessionIds {before[2]}->{after[2]}')
    if args.dry_run:
        print('dry run: workspace.json and session_projcache NOT changed.')
        if os.path.isdir(PROJCACHE):
            print('would move session_projcache aside:', PROJCACHE)
        return 0
    tmp = WORKSPACE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.chmod(tmp, 0o600)
    os.replace(tmp, WORKSPACE)
    if os.path.isdir(PROJCACHE):
        os.rename(PROJCACHE, os.path.join(trash, 'session_projcache'))
        print('moved session_projcache aside (it rebuilds on start)')
    manifest['registryApplied'] = True
    json.dump(manifest, open(os.path.join(trash, 'manifest.json'), 'w'), indent=1)
    print('done. Start dsh-web and check the sidebar.')
    return 0


def restore(trash):
    if host_pid() is not None:
        print('REFUSED: stop dsh-web before restoring.')
        return 2
    manifest = json.load(open(os.path.join(trash, 'manifest.json')))
    for m in manifest['moved']:
        src = os.path.join(trash, 'sessions', m['workspace'], m['id'])
        dest = os.path.join(SESSIONS, m['workspace'], m['id'])
        if os.path.isdir(src) and not os.path.exists(dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            os.rename(src, dest)
    for name in ('workspace.json.before-registry', 'workspace.json.before'):
        saved = os.path.join(trash, name)
        if os.path.exists(saved):
            shutil.copy2(saved, WORKSPACE)
            break
    cache = os.path.join(trash, 'session_projcache')
    if os.path.isdir(cache) and not os.path.exists(PROJCACHE):
        os.rename(cache, PROJCACHE)
    print('restored folders and workspace.json from', trash)
    return 0


if __name__ == '__main__':
    sys.exit(main())
