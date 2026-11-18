// dsh-plugin-sessions, browser half: the Sessions page.
//
// A plain script (no build step). It registers one lazy factory with the
// module loader; React comes from the browser module table and nothing else is
// required. Placement follows docs/placement.md: a global `main` panel plus the
// `sidebar.panellist` row that opens it, both with the id `sessions-manager`.
//
// The shell owns: the single Remote mount, the locale tables, the stylesheet,
// the header, the tabs and the Overview tab. The Archived tab (ArchivedTab)
// lists archived roots; the Trash tab (TrashTab) lists prune batches; the
// prune flow (PrunePanel) is an in-page dialog over the page, opened from the
// Archived tab or the Reclaimable card. Every tab body and the panel receive
// `shell`. Mutations (apply, unarchive, restore, purge) run only through
// shell.mutate(), only from click handlers, one at a time (shell.busy).
//
// Safety: a throw during apply fails web boot for the whole GUI, so apply
// guards every step, the Remote mount never throws out of its effect, and
// every Remote outcome is checked before it is rendered.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-sessions',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PACKAGE = 'dsh-plugin-sessions'
    /** Remote and locale namespace (design.md D1); never `sessions`, the host's live-session service. */
    const NS = 'sessionsManager'
    /** The sidebar.panellist id, equal to the main key. */
    const PANEL_ID = 'sessions-manager'
    const STYLE_ID = 'dsh-plugin-sessions-styles'
    const ERROR_PREFIX = 'sessions-manager/'

    // Mirrors of src/contract.js (a plain script cannot import it); the client
    // test compares them with the contract.
    const METHOD_NAMES = ['overview', 'archived', 'plan', 'apply', 'unarchive', 'trash', 'restore', 'purge']
    const MUTATING = ['apply', 'unarchive', 'restore', 'purge']
    const REFUSAL_CODES = [
      'live', 'locked', 'recent', 'kept-descendant', 'parent-kept', 'cycle', 'path-unsafe', 'no-location', 'changed',
      'not-archived', 'cross-device', 'workspace-missing', 'conflict', 'legacy-format',
    ]
    const ARCHIVED_SORTS = ['bytes', 'lastActivityAt', 'title']
    const MAX_IDS_PER_REQUEST = 1000
    const PLAN_SCOPES = ['all', 'olderThan', 'selection']
    const WARNING_CODES = ['stale-backend-entry', 'registry-step-failed', 'audit-failed', 'restart-recommended', 'recovery-needed']
    const APPLY_STATES = ['complete', 'partial', 'needs-recovery', 'conflict']
    const BATCH_STATES = ['complete', 'needs-recovery', 'conflict']
    const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
    const ERROR_CODES = [
      'forbidden', 'busy', 'plan-expired', 'confirmation-mismatch', 'purge-disabled', 'unsupported-backend',
      'unsupported-platform', 'trash-unusable', 'batch-not-found', 'invalid-request', 'store-unreadable',
    ].map((name) => ERROR_PREFIX + name)

    const TABS = ['overview', 'archived', 'trash']
    const MAX_LARGEST = 10
    const MIN_REFRESH_MS = 1000
    const DAY_MS = 86_400_000
    const MB = 1024 * 1024
    /** The order the Host applies per sort key (store index): largest first, newest first, A to Z. */
    const SORT_ORDER = { bytes: 'descending', lastActivityAt: 'descending', title: 'ascending' }
    /** The Host accepts at most this many characters of filter text. */
    const MAX_TEXT = 200
    /** Pause after the last keystroke in a filter field before the request goes out. */
    const FILTER_DEBOUNCE_MS = 300

    // ---------- locale tables ----------
    // Placeholders are {name}; the page fills them itself, so a translate
    // function that ignores parameters still works.

    const en = {
      panel: 'Sessions',
      'page.title': 'Sessions',
      'page.store': 'Store',
      'page.storeUnknown': 'unknown',
      'page.refresh': 'Refresh',
      'page.refreshing': 'Refreshing…',
      'page.updated': 'Updated {time}',
      'page.pruneOn': 'Prune available',
      'page.pruneOff': 'Read-only',
      'tabs.label': 'Sessions views',
      'tab.overview': 'Overview',
      'tab.archived': 'Archived',
      'tab.archivedCount': 'Archived ({n})',
      'tab.trash': 'Trash',
      'tab.trashCount': 'Trash ({n})',
      'state.connecting': 'Connecting to the Host…',
      'state.mountFailed': 'Could not connect the Sessions service. Refresh the page after the Host restarts.',
      'state.unavailable': 'The Sessions service is not available. Check that the plugin is enabled, then restart the Host.',
      'state.loading': 'Reading the session store…',
      'state.error': 'Could not read the session store.',
      'state.stale': 'The last refresh failed. The figures below are from the previous read.',
      'state.malformed': 'The Host sent an overview that this page cannot read.',
      'state.detail': 'Host message: {message}',
      'state.retry': 'Try again',
      'state.empty': 'The session store holds no sessions.',
      'readOnly.notice': 'Read-only: pruning is off. {reason}',
      'overview.sizes': 'All sizes are on-disk (compressed) bytes.',
      'card.total': 'Total',
      'card.total.live': 'Live',
      'card.total.archived': 'Archived',
      'card.total.children': 'Subagent children',
      'card.total.unreadable': 'Unreadable',
      'card.disk': 'On disk',
      'card.archived': 'Archived',
      'card.archived.roots': 'Archived roots',
      'card.archived.children': 'Children included',
      'card.archived.missing': 'The registry also lists {n} archived ids whose log is gone. They are harmless and are not counted here.',
      'card.archived.missingOne': 'The registry also lists 1 archived id whose log is gone. It is harmless and is not counted here.',
      'card.reclaim': 'Reclaimable',
      'card.reclaim.ready': 'Ready units',
      'card.reclaim.blocked': 'Blocked units',
      'card.reclaim.review': 'Review prune…',
      'card.largest': 'Largest',
      'card.largest.none': 'No sessions',
      'index.label': 'Search index load',
      'index.normal': 'Normal',
      'index.high': 'High',
      'index.hintNormal': 'The warning tier starts at {limit} on disk.',
      'index.hintHigh': 'Session search loads every stored session into memory. At {limit} on disk or more it can run out of memory.',
      'ws.title': 'Workspaces',
      'ws.col.name': 'Workspace',
      'ws.col.sessions': 'Sessions',
      'ws.col.archived': 'Archived',
      'ws.col.size': 'Size on disk',
      'ws.col.activity': 'Last activity',
      'ws.unassigned': 'Unassigned',
      'ws.folder': 'Store folder {folder}',
      'ws.open': 'Show archived sessions of {name}',
      'ws.empty': 'No workspace holds a stored session.',
      'top.title': 'Largest sessions (top 10)',
      'top.col.session': 'Session',
      'top.col.workspace': 'Workspace',
      'top.col.size': 'Size',
      'top.col.events': 'Events',
      'top.col.activity': 'Last activity',
      'top.col.state': 'State',
      'top.empty': 'No stored sessions.',
      'top.eventsUnknown': 'Event count unknown',
      'badge.live': 'live',
      'badge.archived': 'archived',
      'badge.child': 'child',
      'size.b': '{n} B',
      'size.kb': '{n} KB',
      'size.mb': '{n} MB',
      'size.gb': '{n} GB',
      'size.tb': '{n} TB',
      'time.today': 'today',
      'time.yesterday': 'yesterday',
      'time.daysAgo': '{n} days ago',
      'archived.filters': 'Filter archived sessions',
      'archived.filter.workspace': 'Workspace',
      'archived.filter.allWorkspaces': 'All workspaces',
      'archived.filter.olderThan': 'Older than (days)',
      'archived.filter.largerThan': 'Larger than (MB)',
      'archived.filter.text': 'Search',
      'archived.filter.textHint': 'Id, title or workspace',
      'archived.filter.invalid': 'Enter a number of 0 or more. This filter is not applied.',
      'archived.chip.workspace': 'Workspace: {name}',
      'archived.chip.remove': 'Remove the filter {label}',
      'archived.clearFilters': 'Clear filters',
      'archived.loading': 'Reading archived sessions…',
      'archived.updating': 'Updating…',
      'archived.error': 'Could not read the archived sessions.',
      'archived.stale': 'The last refresh failed. The list below is from the previous read.',
      'archived.malformed': 'The Host sent a list that this page cannot read.',
      'archived.empty': 'No archived sessions. Sessions you archive in the sidebar appear here.',
      'archived.noMatch': 'No archived session matches the filters.',
      'archived.readOnly': 'Read-only: pruning is off. Unarchive still works. {reason}',
      'archived.count': '{n} archived sessions',
      'archived.countOne': '1 archived session',
      'archived.showing': 'Showing {shown} of {total} archived sessions. Narrow the filters to see the rest.',
      'archived.sizes': 'Sizes are on-disk bytes and include all children.',
      'archived.table': 'Archived sessions',
      'archived.selectAll': 'Select all listed sessions',
      'archived.selectRow': 'Select {name}',
      'archived.col.session': 'Session',
      'archived.col.size': 'Size with children',
      'archived.col.children': 'Children',
      'archived.col.activity': 'Last activity',
      'archived.col.age': 'Age',
      'archived.col.status': 'Status',
      'archived.col.actions': 'Actions',
      'archived.sort.bytes': 'Sort by size, largest first',
      'archived.sort.lastActivityAt': 'Sort by last activity, newest first',
      'archived.sort.title': 'Sort by title, A to Z',
      'archived.groupSummary': '{n} sessions · {size}',
      'archived.groupSummaryOne': '1 session · {size}',
      'archived.age': '{n} days',
      'archived.ageOne': '1 day',
      'archived.ageNew': 'under a day',
      'archived.blocked': 'blocked',
      'archived.reasonItem': '{reason} ({ids})',
      'archived.orphan': 'orphan',
      'archived.orphanHint': 'Its archived parent has no stored log, so this session is not archived itself and cannot be unarchived. It can be pruned as its own unit.',
      'archived.unarchive': 'Unarchive',
      'archived.unarchiveRow': 'Unarchive {name}',
      'archived.prune': 'Prune…',
      'archived.pruneRow': 'Prune {name}…',
      'archived.selection': 'Selection',
      'archived.selected': '{n} selected · {size}',
      'archived.selectionCap': 'At most {max} sessions can be selected at once.',
      'archived.selectionOrphans': 'Orphans in the selection ({n}) are not unarchived.',
      'archived.unarchiveSelected': 'Unarchive selected',
      'archived.pruneSelected': 'Prune selected…',
      'archived.clearSelection': 'Clear selection',
      'archived.confirm.question': 'Unarchive {n} sessions?',
      'archived.confirm.detail': 'They return to the normal session list of their workspaces.',
      'archived.confirm.cancel': 'Cancel',
      'archived.confirm.ok': 'Unarchive {n}',
      'unarchive.running': 'Unarchiving {n} sessions…',
      'unarchive.runningOne': 'Unarchiving 1 session…',
      'unarchive.done': 'Unarchived {n} sessions. They are back in the session list.',
      'unarchive.doneOne': 'Unarchived 1 session. It is back in the session list.',
      'unarchive.skipped': 'Not unarchived ({n}):',
      'unarchive.skippedItem': '{name}: {reason}',
      'unarchive.failed': 'Unarchive failed.',
      'unarchive.malformed': 'The Host sent an answer that this page cannot read. The list was read again.',
      'unarchive.dismiss': 'Dismiss',
      'prune.title': 'Prune archived sessions',
      'prune.close': 'Close',
      'prune.cancel': 'Cancel',
      'prune.back': 'Back',
      'prune.preview': 'Preview',
      'prune.previewAgain': 'Preview again',
      'prune.continue': 'Continue',
      'prune.move': 'Move to trash',
      'prune.done': 'Done',
      'prune.undo': 'Undo',
      'prune.undoHint': 'Undo moves this batch back to its original folders.',
      'prune.step': 'Step {n} of 3: {name}',
      'prune.step.scope': 'Scope',
      'prune.step.preview': 'Preview',
      'prune.step.confirm': 'Confirm',
      'prune.nothingMoved': 'Nothing was moved yet. Sessions move to the trash only after the last step.',
      'prune.readOnly': 'Read-only: pruning is off. {reason}',
      'prune.scope.legend': 'What to prune',
      'prune.scope.all': 'All archived sessions',
      'prune.scope.allHint': '{n} archived roots with their children',
      'prune.scope.allHintOne': '1 archived root with its children',
      'prune.scope.olderThan': 'Archived sessions older than',
      'prune.scope.days': 'Age in days',
      'prune.scope.daysUnit': 'days',
      'prune.scope.daysInvalid': 'Enter a whole number of days, 0 or more.',
      'prune.scope.selection': 'The current selection',
      'prune.scope.selected': '{n} archived sessions selected',
      'prune.scope.selectedOne': '1 archived session selected',
      'prune.scope.selectionNone': 'Select sessions in the Archived tab first.',
      'prune.planning': 'Making a plan… Nothing moves.',
      'prune.discarded': 'The scope or the selection changed, so the plan was discarded. Preview again.',
      'prune.planFailed': 'Could not make a plan.',
      'prune.malformed': 'The Host sent a plan that this page cannot read. Nothing was moved.',
      'prune.summary': 'What moves to the trash',
      'prune.fact.roots': 'Roots',
      'prune.fact.descendants': 'Descendants',
      'prune.fact.sessions': 'Sessions',
      'prune.fact.size': 'Total size',
      'prune.excludedLine': 'Excluded as blocked: {units} with {sessions} ({size}).',
      'prune.emptyPlan': 'No archived session is in this scope.',
      'prune.allBlocked': 'Every unit in this scope is blocked. Nothing can be moved.',
      'prune.byWorkspace': 'By workspace',
      'prune.ws.workspace': 'Workspace',
      'prune.ws.units': 'Units',
      'prune.ws.sessions': 'Sessions',
      'prune.ws.size': 'Size',
      'prune.checks': 'Safety checks',
      'prune.checksPassed': 'Every unit in this scope passed the safety checks.',
      'prune.excluded': 'Excluded ({n})',
      'prune.units': '{n} units',
      'prune.unitsOne': '1 unit',
      'prune.sessions': '{n} sessions',
      'prune.sessionsOne': '1 session',
      'prune.roots': '{n} roots',
      'prune.rootsOne': '1 root',
      'prune.descendants': '{n} descendants',
      'prune.descendantsOne': '1 descendant',
      'prune.confirm.summary': '{sessions} ({size}) move to the trash: {roots} and {descendants}. You can restore them from the Trash tab.',
      'prune.confirm.check': 'I understand that these sessions leave the session list and move to the trash.',
      'prune.confirm.type': 'Type the number of sessions, {n}, to confirm',
      'prune.confirm.typeHint': 'The number must be {n}.',
      'prune.moving': 'Moving {sessions} to the trash…',
      'prune.applyFailed': 'Move to trash failed.',
      'prune.stalePlan': 'The plan can no longer be used. Make a new plan, then confirm again.',
      'prune.applyMalformed': 'The Host sent an answer that this page cannot read. Some sessions may have moved: check the Trash tab.',
      'prune.result.complete': 'Moved to the trash',
      'prune.result.partial': 'Moved to the trash, with skipped units',
      'prune.result.needs-recovery': 'The move was interrupted and needs recovery',
      'prune.result.conflict': 'The move stopped at a conflict',
      'prune.result.nothing': 'Nothing was moved',
      'prune.result.unknown': 'Outcome unknown',
      'prune.result.moved': 'Moved',
      'prune.result.skipped': 'Skipped',
      'prune.result.batch': 'Batch',
      'prune.result.location': 'Trash folder',
      'prune.result.recoveryHint': 'Nothing is deleted. The Host finishes or undoes the interrupted step at its next change; the Trash tab shows the batch state.',
      'prune.result.skippedList': 'Skipped units',
      'prune.result.warnings': 'Warnings',
      'prune.warningItem': '{warning} ({id})',
      'prune.undoing': 'Restoring the batch…',
      'prune.undone': 'Restored {sessions} to their folders.',
      'prune.undoSkipped': 'Not restored ({n}):',
      'prune.undoFailed': 'Undo failed.',
      'prune.undoMalformed': 'The Host sent an answer that this page cannot read. Check the Trash tab.',
      'warning.stale-backend-entry': 'The session store still listed a moved session after the move. Restart the Host to be sure it is gone.',
      'warning.registry-step-failed': 'A workspace, pin or archive update did not complete.',
      'warning.audit-failed': 'The audit log could not be written.',
      'warning.restart-recommended': 'Restart the Host so that it stops serving the moved sessions.',
      'warning.recovery-needed': 'A unit is split between the store and the trash. Nothing is deleted; the Host recovers it at its next change.',
      'batchState.complete': 'complete',
      'batchState.needs-recovery': 'needs recovery',
      'batchState.conflict': 'conflict',
      'trash.loading': 'Reading the trash…',
      'trash.error': 'Could not read the trash.',
      'trash.stale': 'The last refresh failed. The list below is from the previous read.',
      'trash.malformed': 'The Host sent a trash list that this page cannot read.',
      'trash.empty': 'The trash is empty. Sessions you prune appear here until you restore them or delete them for good.',
      'trash.location': 'Trash folder',
      'trash.batches': '{n} batches',
      'trash.batchesOne': '1 batch',
      'trash.table': 'Trash batches',
      'trash.col.batch': 'Batch',
      'trash.col.sessions': 'Sessions',
      'trash.col.size': 'Size',
      'trash.col.state': 'State',
      'trash.col.actions': 'Actions',
      'trash.needsRecoveryHint': 'A move or a restore of this batch was interrupted. Nothing is deleted; the Host finishes or undoes the step at its next change.',
      'trash.conflictHint': 'A session of this batch could not go back: its folder exists again or is missing. Nothing was overwritten.',
      'trash.restore': 'Restore batch',
      'trash.restoreRow': 'Restore batch {id}',
      'trash.delete': 'Delete permanently…',
      'trash.deleteRow': 'Delete batch {id} permanently…',
      'trash.deleteOff': 'Permanent delete is turned off: allowPermanentDelete is false in the plugin settings. Batches stay in the trash until you restore them.',
      'trash.deleteUnknown': 'Permanent delete waits for the plugin settings. Refresh to read them.',
      'trash.readOnly': 'Read-only: pruning is off, so the trash cannot be changed. {reason}',
      'trash.restoring': 'Restoring batch {id}…',
      'trash.restored': 'Restored {sessions} from batch {id}.',
      'trash.restoreSkipped': 'Not restored ({n}):',
      'trash.restoreFailed': 'Restore failed.',
      'trash.malformedAnswer': 'The Host sent an answer that this page cannot read. The list was read again.',
      'trash.deleted': 'Deleted batch {id} for good: {sessions}, {size}.',
      'trash.deleteFailed': 'Permanent delete failed.',
      'trash.dismiss': 'Dismiss',
      'purge.title': 'Delete batch permanently',
      'purge.detail': 'Batch {id} holds {sessions} ({size}). Deleting it removes their folders for good. This cannot be undone.',
      'purge.type': 'Type the batch id to confirm',
      'purge.typeHint': 'The text must match the batch id exactly.',
      'purge.cancel': 'Cancel',
      'purge.back': 'Back',
      'purge.continue': 'Delete permanently',
      'purge.finalTitle': 'Last confirmation',
      'purge.finalDetail': 'Delete {sessions} ({size}) of batch {id} for good? They cannot be restored.',
      'purge.confirm': 'Yes, delete for good',
      'purge.running': 'Deleting batch {id} for good…',
      'refusal.live': 'A session in this tree is open in a live session.',
      'refusal.locked': 'A session folder holds the lock of a running process.',
      'refusal.recent': 'A session in this tree was active recently.',
      'refusal.kept-descendant': 'A descendant is a kept top-level session (a fork).',
      'refusal.parent-kept': 'The parent of the root is kept.',
      'refusal.cycle': 'The parent links form a loop.',
      'refusal.path-unsafe': 'A path is a link, leaves the store, or fails the folder checks.',
      'refusal.no-location': 'The session has no folder on disk.',
      'refusal.changed': 'The session changed after the plan was made.',
      'refusal.not-archived': 'The session is no longer archived.',
      'refusal.cross-device': 'The folder and the trash are on different drives.',
      'refusal.workspace-missing': 'The workspace of the session no longer exists.',
      'refusal.conflict': 'The destination already exists. Nothing was overwritten.',
      'refusal.legacy-format': 'A session log is in an old format that this version does not prune.',
      'error.forbidden': 'Only the owner can do this, from the Sessions page.',
      'error.busy': 'Another change is in progress. Try again in a moment.',
      'error.plan-expired': 'The plan expired or the store changed. Make a new plan.',
      'error.confirmation-mismatch': 'The typed confirmation does not match.',
      'error.purge-disabled': 'Permanent delete is turned off in the plugin settings.',
      'error.unsupported-backend': 'The session store backend does not support pruning.',
      'error.unsupported-platform': 'Pruning needs the session lock check, which this operating system does not offer.',
      'error.trash-unusable': 'The trash folder cannot be used.',
      'error.batch-not-found': 'The trash batch no longer exists.',
      'error.invalid-request': 'The Host rejected the request as invalid.',
      'error.store-unreadable': 'The session store cannot be read right now. Nothing was changed. Try again.',
      'error.unavailable': 'The Sessions service is not connected.',
      'error.unknown': 'The Host call failed.',
    }

    const zh = {
      panel: '会话管理',
      'page.title': '会话管理',
      'page.store': '存储位置',
      'page.storeUnknown': '未知',
      'page.refresh': '刷新',
      'page.refreshing': '正在刷新…',
      'page.updated': '更新于 {time}',
      'page.pruneOn': '可清理',
      'page.pruneOff': '只读',
      'tabs.label': '会话管理视图',
      'tab.overview': '概览',
      'tab.archived': '已归档',
      'tab.archivedCount': '已归档（{n}）',
      'tab.trash': '回收站',
      'tab.trashCount': '回收站（{n}）',
      'state.connecting': '正在连接 Host…',
      'state.mountFailed': '无法连接会话管理服务。请在 Host 重启后刷新页面。',
      'state.unavailable': '会话管理服务不可用。请确认插件已启用，然后重启 Host。',
      'state.loading': '正在读取会话存储…',
      'state.error': '无法读取会话存储。',
      'state.stale': '最近一次刷新失败。下方数据来自上一次读取。',
      'state.malformed': 'Host 返回的概览数据无法识别。',
      'state.detail': 'Host 消息：{message}',
      'state.retry': '重试',
      'state.empty': '会话存储中没有会话。',
      'readOnly.notice': '只读：清理已关闭。{reason}',
      'overview.sizes': '所有大小均为磁盘占用（压缩后）字节数。',
      'card.total': '总数',
      'card.total.live': '运行中',
      'card.total.archived': '已归档',
      'card.total.children': '子代理会话',
      'card.total.unreadable': '无法读取',
      'card.disk': '磁盘占用',
      'card.archived': '已归档',
      'card.archived.roots': '归档根会话',
      'card.archived.children': '随附子会话',
      'card.archived.missing': '注册表还列出 {n} 个已归档 ID，其会话日志已不存在。它们无害，不计入此处。',
      'card.archived.missingOne': '注册表还列出 1 个已归档 ID，其会话日志已不存在。它无害，不计入此处。',
      'card.reclaim': '可回收',
      'card.reclaim.ready': '可清理单元',
      'card.reclaim.blocked': '受阻单元',
      'card.reclaim.review': '查看清理方案…',
      'card.largest': '最大会话',
      'card.largest.none': '没有会话',
      'index.label': '搜索索引负载',
      'index.normal': '正常',
      'index.high': '偏高',
      'index.hintNormal': '磁盘占用达到 {limit} 时进入警告级别。',
      'index.hintHigh': '会话搜索会把所有已存储会话载入内存。磁盘占用达到 {limit} 或以上时可能耗尽内存。',
      'ws.title': '工作区',
      'ws.col.name': '工作区',
      'ws.col.sessions': '会话',
      'ws.col.archived': '已归档',
      'ws.col.size': '磁盘占用',
      'ws.col.activity': '最近活动',
      'ws.unassigned': '未分配',
      'ws.folder': '存储文件夹 {folder}',
      'ws.open': '查看 {name} 中的已归档会话',
      'ws.empty': '没有工作区包含已存储的会话。',
      'top.title': '最大的会话（前 10 个）',
      'top.col.session': '会话',
      'top.col.workspace': '工作区',
      'top.col.size': '大小',
      'top.col.events': '事件数',
      'top.col.activity': '最近活动',
      'top.col.state': '状态',
      'top.empty': '没有已存储的会话。',
      'top.eventsUnknown': '事件数未知',
      'badge.live': '运行中',
      'badge.archived': '已归档',
      'badge.child': '子会话',
      'size.b': '{n} B',
      'size.kb': '{n} KB',
      'size.mb': '{n} MB',
      'size.gb': '{n} GB',
      'size.tb': '{n} TB',
      'time.today': '今天',
      'time.yesterday': '昨天',
      'time.daysAgo': '{n} 天前',
      'archived.filters': '筛选已归档会话',
      'archived.filter.workspace': '工作区',
      'archived.filter.allWorkspaces': '全部工作区',
      'archived.filter.olderThan': '早于（天）',
      'archived.filter.largerThan': '大于（MB）',
      'archived.filter.text': '搜索',
      'archived.filter.textHint': 'ID、标题或工作区',
      'archived.filter.invalid': '请输入 0 或更大的数字。此筛选条件未生效。',
      'archived.chip.workspace': '工作区：{name}',
      'archived.chip.remove': '移除筛选条件 {label}',
      'archived.clearFilters': '清除筛选',
      'archived.loading': '正在读取已归档会话…',
      'archived.updating': '正在更新…',
      'archived.error': '无法读取已归档会话。',
      'archived.stale': '最近一次刷新失败。下方列表来自上一次读取。',
      'archived.malformed': 'Host 返回的列表无法识别。',
      'archived.empty': '没有已归档会话。在侧边栏中归档的会话会显示在这里。',
      'archived.noMatch': '没有符合筛选条件的已归档会话。',
      'archived.readOnly': '只读：清理已关闭，仍可取消归档。{reason}',
      'archived.count': '{n} 个已归档会话',
      'archived.countOne': '1 个已归档会话',
      'archived.showing': '显示 {total} 个已归档会话中的 {shown} 个。缩小筛选范围可查看其余会话。',
      'archived.sizes': '大小均为磁盘占用字节数，并包含所有子会话。',
      'archived.table': '已归档会话',
      'archived.selectAll': '选择所有列出的会话',
      'archived.selectRow': '选择 {name}',
      'archived.col.session': '会话',
      'archived.col.size': '大小（含子会话）',
      'archived.col.children': '子会话',
      'archived.col.activity': '最近活动',
      'archived.col.age': '距今',
      'archived.col.status': '状态',
      'archived.col.actions': '操作',
      'archived.sort.bytes': '按大小排序，从大到小',
      'archived.sort.lastActivityAt': '按最近活动排序，从新到旧',
      'archived.sort.title': '按标题排序，A 到 Z',
      'archived.groupSummary': '{n} 个会话 · {size}',
      'archived.groupSummaryOne': '1 个会话 · {size}',
      'archived.age': '{n} 天',
      'archived.ageOne': '1 天',
      'archived.ageNew': '不到 1 天',
      'archived.blocked': '受阻',
      'archived.reasonItem': '{reason}（{ids}）',
      'archived.orphan': '孤立',
      'archived.orphanHint': '其已归档的父会话没有存储的日志，因此此会话本身未归档，无法取消归档。它可以作为独立单元被清理。',
      'archived.unarchive': '取消归档',
      'archived.unarchiveRow': '取消归档 {name}',
      'archived.prune': '清理…',
      'archived.pruneRow': '清理 {name}…',
      'archived.selection': '已选内容',
      'archived.selected': '已选 {n} 个 · {size}',
      'archived.selectionCap': '一次最多可选择 {max} 个会话。',
      'archived.selectionOrphans': '选中的孤立会话（{n} 个）不会被取消归档。',
      'archived.unarchiveSelected': '取消归档所选',
      'archived.pruneSelected': '清理所选…',
      'archived.clearSelection': '清除选择',
      'archived.confirm.question': '取消归档 {n} 个会话？',
      'archived.confirm.detail': '它们会回到所属工作区的普通会话列表。',
      'archived.confirm.cancel': '取消',
      'archived.confirm.ok': '取消归档 {n} 个',
      'unarchive.running': '正在取消归档 {n} 个会话…',
      'unarchive.runningOne': '正在取消归档 1 个会话…',
      'unarchive.done': '已取消归档 {n} 个会话，它们已回到会话列表。',
      'unarchive.doneOne': '已取消归档 1 个会话，它已回到会话列表。',
      'unarchive.skipped': '未取消归档（{n} 个）：',
      'unarchive.skippedItem': '{name}：{reason}',
      'unarchive.failed': '取消归档失败。',
      'unarchive.malformed': 'Host 返回的结果无法识别。已重新读取列表。',
      'unarchive.dismiss': '关闭',
      'prune.title': '清理已归档会话',
      'prune.close': '关闭',
      'prune.cancel': '取消',
      'prune.back': '上一步',
      'prune.preview': '预览',
      'prune.previewAgain': '重新预览',
      'prune.continue': '继续',
      'prune.move': '移到回收站',
      'prune.done': '完成',
      'prune.undo': '撤销',
      'prune.undoHint': '撤销会把此批次移回原来的文件夹。',
      'prune.step': '第 {n} 步，共 3 步：{name}',
      'prune.step.scope': '范围',
      'prune.step.preview': '预览',
      'prune.step.confirm': '确认',
      'prune.nothingMoved': '尚未移动任何内容。只有完成最后一步后，会话才会移到回收站。',
      'prune.readOnly': '只读：清理已关闭。{reason}',
      'prune.scope.legend': '清理范围',
      'prune.scope.all': '全部已归档会话',
      'prune.scope.allHint': '{n} 个归档根会话及其子会话',
      'prune.scope.allHintOne': '1 个归档根会话及其子会话',
      'prune.scope.olderThan': '已归档且早于',
      'prune.scope.days': '天数',
      'prune.scope.daysUnit': '天',
      'prune.scope.daysInvalid': '请输入 0 或更大的整数天数。',
      'prune.scope.selection': '当前所选',
      'prune.scope.selected': '已选 {n} 个已归档会话',
      'prune.scope.selectedOne': '已选 1 个已归档会话',
      'prune.scope.selectionNone': '请先在“已归档”标签页中选择会话。',
      'prune.planning': '正在生成方案…不会移动任何内容。',
      'prune.discarded': '范围或所选内容已变化，方案已作废。请重新预览。',
      'prune.planFailed': '无法生成方案。',
      'prune.malformed': 'Host 返回的方案无法识别。没有移动任何内容。',
      'prune.summary': '将移到回收站的内容',
      'prune.fact.roots': '根会话',
      'prune.fact.descendants': '后代会话',
      'prune.fact.sessions': '会话总数',
      'prune.fact.size': '总大小',
      'prune.excludedLine': '因受阻而排除：{units}，含 {sessions}（{size}）。',
      'prune.emptyPlan': '此范围内没有已归档会话。',
      'prune.allBlocked': '此范围内的所有单元均受阻，无法移动任何内容。',
      'prune.byWorkspace': '按工作区',
      'prune.ws.workspace': '工作区',
      'prune.ws.units': '单元',
      'prune.ws.sessions': '会话',
      'prune.ws.size': '大小',
      'prune.checks': '安全检查',
      'prune.checksPassed': '此范围内的所有单元都通过了安全检查。',
      'prune.excluded': '已排除（{n}）',
      'prune.units': '{n} 个单元',
      'prune.unitsOne': '1 个单元',
      'prune.sessions': '{n} 个会话',
      'prune.sessionsOne': '1 个会话',
      'prune.roots': '{n} 个根会话',
      'prune.rootsOne': '1 个根会话',
      'prune.descendants': '{n} 个后代会话',
      'prune.descendantsOne': '1 个后代会话',
      'prune.confirm.summary': '{sessions}（{size}）将移到回收站：{roots}和{descendants}。可以在“回收站”标签页中恢复它们。',
      'prune.confirm.check': '我了解这些会话将离开会话列表并移到回收站。',
      'prune.confirm.type': '输入会话数量 {n} 以确认',
      'prune.confirm.typeHint': '数字必须是 {n}。',
      'prune.moving': '正在将 {sessions}移到回收站…',
      'prune.applyFailed': '移到回收站失败。',
      'prune.stalePlan': '此方案已不能使用。请重新生成方案后再次确认。',
      'prune.applyMalformed': 'Host 返回的结果无法识别。部分会话可能已被移动，请查看“回收站”标签页。',
      'prune.result.complete': '已移到回收站',
      'prune.result.partial': '已移到回收站，部分单元被跳过',
      'prune.result.needs-recovery': '移动被中断，需要恢复',
      'prune.result.conflict': '移动因冲突而停止',
      'prune.result.nothing': '没有移动任何内容',
      'prune.result.unknown': '结果未知',
      'prune.result.moved': '已移动',
      'prune.result.skipped': '已跳过',
      'prune.result.batch': '批次',
      'prune.result.location': '回收站文件夹',
      'prune.result.recoveryHint': '不会删除任何内容。Host 会在下一次更改时完成或撤销被中断的步骤；“回收站”标签页会显示批次状态。',
      'prune.result.skippedList': '被跳过的单元',
      'prune.result.warnings': '警告',
      'prune.warningItem': '{warning}（{id}）',
      'prune.undoing': '正在恢复批次…',
      'prune.undone': '已将 {sessions}恢复到原文件夹。',
      'prune.undoSkipped': '未恢复（{n} 个）：',
      'prune.undoFailed': '撤销失败。',
      'prune.undoMalformed': 'Host 返回的结果无法识别。请查看“回收站”标签页。',
      'warning.stale-backend-entry': '移动后会话存储仍列出了一个已移动的会话。请重启 Host 以确保它已消失。',
      'warning.registry-step-failed': '工作区、置顶或归档的更新未能完成。',
      'warning.audit-failed': '无法写入审计日志。',
      'warning.restart-recommended': '请重启 Host，使其不再提供已移动的会话。',
      'warning.recovery-needed': '某个单元分散在存储和回收站之间。不会删除任何内容；Host 会在下一次更改时恢复它。',
      'batchState.complete': '完整',
      'batchState.needs-recovery': '需要恢复',
      'batchState.conflict': '冲突',
      'trash.loading': '正在读取回收站…',
      'trash.error': '无法读取回收站。',
      'trash.stale': '最近一次刷新失败。下方批次列表来自上一次读取。',
      'trash.malformed': 'Host 返回的回收站列表无法识别。',
      'trash.empty': '回收站为空。清理的会话会显示在这里，直到你恢复或永久删除它们。',
      'trash.location': '回收站文件夹',
      'trash.batches': '{n} 个批次',
      'trash.batchesOne': '1 个批次',
      'trash.table': '回收站批次',
      'trash.col.batch': '批次',
      'trash.col.sessions': '会话',
      'trash.col.size': '大小',
      'trash.col.state': '状态',
      'trash.col.actions': '操作',
      'trash.needsRecoveryHint': '此批次的移动或恢复被中断。不会删除任何内容；Host 会在下一次更改时完成或撤销该步骤。',
      'trash.conflictHint': '此批次中有会话无法移回：其文件夹已再次存在或已丢失。没有覆盖任何内容。',
      'trash.restore': '恢复批次',
      'trash.restoreRow': '恢复批次 {id}',
      'trash.delete': '永久删除…',
      'trash.deleteRow': '永久删除批次 {id}…',
      'trash.deleteOff': '永久删除已关闭：插件设置中的 allowPermanentDelete 为 false。批次会一直留在回收站，直到你恢复它们。',
      'trash.deleteUnknown': '永久删除需要先读取插件设置。请刷新以读取。',
      'trash.readOnly': '只读：清理已关闭，因此无法更改回收站。{reason}',
      'trash.restoring': '正在恢复批次 {id}…',
      'trash.restored': '已从批次 {id} 恢复 {sessions}。',
      'trash.restoreSkipped': '未恢复（{n} 个）：',
      'trash.restoreFailed': '恢复失败。',
      'trash.malformedAnswer': 'Host 返回的结果无法识别。已重新读取列表。',
      'trash.deleted': '已永久删除批次 {id}：{sessions}，{size}。',
      'trash.deleteFailed': '永久删除失败。',
      'trash.dismiss': '关闭',
      'purge.title': '永久删除批次',
      'purge.detail': '批次 {id} 包含 {sessions}（{size}）。删除后它们的文件夹将被永久移除，且无法撤销。',
      'purge.type': '输入批次 ID 以确认',
      'purge.typeHint': '输入内容必须与批次 ID 完全一致。',
      'purge.cancel': '取消',
      'purge.back': '上一步',
      'purge.continue': '永久删除',
      'purge.finalTitle': '最后确认',
      'purge.finalDetail': '要永久删除批次 {id} 中的 {sessions}（{size}）吗？它们将无法恢复。',
      'purge.confirm': '是，永久删除',
      'purge.running': '正在永久删除批次 {id}…',
      'refusal.live': '此树中有会话正在运行。',
      'refusal.locked': '会话文件夹被一个运行中的进程锁定。',
      'refusal.recent': '此树中有会话最近仍有活动。',
      'refusal.kept-descendant': '某个后代是被保留的顶层会话（分叉）。',
      'refusal.parent-kept': '根会话的父会话被保留。',
      'refusal.cycle': '父会话链接形成了循环。',
      'refusal.path-unsafe': '某个路径是链接、位于存储之外，或未通过文件夹检查。',
      'refusal.no-location': '该会话在磁盘上没有文件夹。',
      'refusal.changed': '生成方案后该会话发生了变化。',
      'refusal.not-archived': '该会话已不再处于归档状态。',
      'refusal.cross-device': '会话文件夹与回收站位于不同磁盘。',
      'refusal.workspace-missing': '该会话所属的工作区已不存在。',
      'refusal.conflict': '目标位置已存在。没有覆盖任何内容。',
      'refusal.legacy-format': '某个会话日志为旧格式，此版本不清理此类会话。',
      'error.forbidden': '只有所有者可以在会话管理页面执行此操作。',
      'error.busy': '另一项更改正在进行。请稍后重试。',
      'error.plan-expired': '方案已过期或存储已变化。请重新生成方案。',
      'error.confirmation-mismatch': '输入的确认内容不匹配。',
      'error.purge-disabled': '插件设置已关闭永久删除。',
      'error.unsupported-backend': '当前会话存储后端不支持清理。',
      'error.unsupported-platform': '清理需要会话锁检查，而当前操作系统不支持。',
      'error.trash-unusable': '回收站文件夹不可用。',
      'error.batch-not-found': '该回收站批次已不存在。',
      'error.invalid-request': 'Host 认为请求无效并拒绝了它。',
      'error.store-unreadable': '目前无法读取会话存储，未做任何更改。请重试。',
      'error.unavailable': '会话管理服务未连接。',
      'error.unknown': 'Host 调用失败。',
    }

    // ---------- stylesheet ----------
    // Host theme tokens only (--dsw-*); own custom properties carry a token or
    // a length. Row, card and tab rules copy the Plugin Manager page and the
    // host primitives (docs/placement.md, Tokens and Row pattern). Hover lives
    // under @media (hover:hover): a tap latches :hover.

    const CSS = `
.sm-page{--sm-inset:clamp(24px,4vw,48px);--sm-top-inset:28px;container:sm-page / inline-size;position:relative;display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:20px}
@media (max-width:767px){.sm-page{--sm-inset:20px}}
.sm-body{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;gap:20px;box-sizing:border-box;padding:0 var(--sm-inset) 48px;overflow-x:hidden;overflow-y:auto}
.sm-body>*{flex:none;width:100%;max-width:960px;box-sizing:border-box}
.sm-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px 16px;padding-top:var(--sm-top-inset)}
[data-platform='darwin'] .sm-head{padding-top:calc(var(--sm-top-inset) + var(--dsh-frame-top-clearance, 0px))}
.sm-heading{min-width:0;max-width:100%}
.sm-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.sm-intro{display:flex;align-items:baseline;gap:6px;min-width:0;margin:4px 0 0;color:var(--dsw-alias-label-secondary)}
.sm-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.sm-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px 12px;min-width:0}
.sm-updated{font-size:12px;line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.sm-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.sm-button-outline{box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l3)}
.sm-button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.sm-button:disabled{cursor:not-allowed;opacity:.4}
.sm-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
.sm-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));max-width:420px;padding:4px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1))}
.sm-tab{height:34px;min-width:0;padding:0 12px;border:0;border-radius:var(--dsw-radius-md);background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.sm-tab[aria-selected='true']{font-weight:500;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2));box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l3)}
.sm-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px}
.sm-panel{min-width:0;border-radius:var(--dsw-radius-md)}
.sm-panel:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:4px}
.sm-notice{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:10px 12px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.sm-notice p{margin:0}
.sm-notice[data-tone='danger']{color:var(--dsw-alias-state-error-primary)}
.sm-notice[data-tone='warning']{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-1))}
.sm-notice .sm-button{margin-top:4px}
.sm-detail{font-size:12px;line-height:18px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.sm-status,.sm-empty,.sm-note{margin:0;color:var(--dsw-alias-label-tertiary)}
.sm-overview{display:flex;flex-direction:column;gap:24px;min-width:0}
.sm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:0;padding:0;list-style:none}
.sm-card{display:flex;flex-direction:column;gap:6px;min-width:0;padding:14px 16px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))}
.sm-card-title{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.sm-card-value{margin:0;font-size:22px;line-height:30px;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sm-card-line{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-card-line+.sm-card-line{color:var(--dsw-alias-label-tertiary)}
.sm-card .sm-button{align-self:flex-start;margin-top:4px}
.sm-facts{display:flex;flex-direction:column;gap:2px;margin:0}
.sm-facts>div{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.sm-facts dt{color:var(--dsw-alias-label-tertiary)}
.sm-facts dd{margin:0;min-width:0;text-align:end;font-variant-numeric:tabular-nums}
.sm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.sm-hint[data-tone='warning']{color:var(--dsw-alias-state-warn-primary)}
.sm-tag{--sm-tone:var(--dsw-alias-label-secondary);position:relative;isolation:isolate;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-size:10px;line-height:1;font-weight:500;white-space:nowrap;color:var(--sm-tone)}
.sm-tag::before{content:'';position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--sm-tone);opacity:.1}
.sm-tag[data-tone='success']{--sm-tone:var(--dsw-alias-state-success-primary)}
.sm-tag[data-tone='warning']{--sm-tone:var(--dsw-alias-state-warn-primary)}
.sm-tag[data-tone='warning']::before{opacity:.12}
.sm-tag[data-tone='danger']{--sm-tone:var(--dsw-alias-state-error-primary)}
.sm-tag[data-tone='info']{--sm-tone:var(--dsw-alias-state-business-primary)}
.sm-tag[data-tone='neutral']{--sm-tone:var(--dsw-alias-label-tertiary)}
.sm-group{display:flex;flex-direction:column;gap:8px;min-width:0}
.sm-group-title{margin:0;font-size:14px;line-height:22px;font-weight:500}
.sm-table{display:flex;flex-direction:column;min-width:0}
.sm-row{display:grid;align-items:center;gap:4px 16px;min-width:0;padding:8px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.sm-row:last-child{border-bottom:0}
.sm-ws .sm-row{grid-template-columns:minmax(0,2.4fr) minmax(56px,.6fr) minmax(56px,.6fr) minmax(0,2fr) minmax(88px,1fr)}
.sm-top .sm-row{grid-template-columns:minmax(0,2.4fr) minmax(0,1.2fr) minmax(64px,.8fr) minmax(56px,.6fr) minmax(88px,1fr) minmax(0,1.4fr)}
.sm-row-head{padding-top:0;padding-bottom:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.sm-cell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-num{text-align:end;font-variant-numeric:tabular-nums}
.sm-col-name{display:flex;flex-direction:column;gap:2px}
.sm-row-link{position:relative;border-radius:var(--dsw-radius-md)}
.sm-row-link:active{background:var(--dsw-alias-interactive-bg-active)}
.sm-row-open{max-width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;font-weight:500;text-align:start;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.sm-row-open::after{content:'';position:absolute;inset:0;border-radius:inherit}
.sm-row-open:focus-visible{outline:none}
.sm-row-open:focus-visible::after{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
.sm-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-size{display:flex;align-items:center;gap:8px}
.sm-size .sm-num{flex:none;min-width:56px}
.sm-bar{flex:1;min-width:24px;height:6px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.sm-bar-fill{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary)}
.sm-badges{display:flex;flex-wrap:wrap;gap:4px}
.sm-placeholder{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:16px;border:0.5px dashed var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl)}
.sm-placeholder p{margin:0}
.sm-archived{display:flex;flex-direction:column;gap:12px;min-width:0}
.sm-filters{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px 16px;min-width:0}
.sm-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sm-field-grow{flex:1 1 200px}
.sm-input{box-sizing:border-box;height:32px;min-width:0;padding:0 10px;border:0;border-radius:var(--dsw-radius-md);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l4, var(--dsw-alias-border-l3));background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.sm-input-num{width:112px}
.sm-input[aria-invalid='true']{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-error-primary)}
.sm-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:1px}
.sm-field-error{max-width:200px;color:var(--dsw-alias-state-error-primary)}
.sm-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;min-width:0}
.sm-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:24px;padding:0 6px 0 10px;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.sm-chip>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.sm-chip svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.sm-link{padding:0;border:0;background:none;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.sm-chip:focus-visible,.sm-link:focus-visible,.sm-sort:focus-visible,.sm-check:focus-visible,.sm-notice:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
.sm-summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:0;color:var(--dsw-alias-label-tertiary)}
.sm-summary p{margin:0}
.sm-selbar,.sm-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 12px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.sm-selbar-count{flex:1 1 auto;min-width:0;font-weight:500;font-variant-numeric:tabular-nums}
.sm-confirm{flex-direction:column;align-items:flex-start}
.sm-confirm p{margin:0}
.sm-confirm-q{font-weight:500}
.sm-confirm-actions{display:flex;flex-wrap:wrap;gap:8px}
.sm-notice ul{margin:0;padding-inline-start:18px}
.sm-arch .sm-row{grid-template-columns:20px minmax(0,2.4fr) minmax(72px,.9fr) minmax(56px,.6fr) minmax(88px,.9fr) minmax(64px,.7fr) minmax(0,1.5fr) auto}
.sm-arch .sm-row[data-selected='true']{background:var(--dsw-alias-interactive-bg-hover)}
.sm-arch .sm-row-group{display:flex;padding:14px 8px 6px}
.sm-group-cell{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;min-width:0;font-weight:500}
.sm-group-cell .sm-sub{font-weight:400}
.sm-sort{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:none;color:inherit;font:inherit;text-align:start;cursor:pointer}
.sm-sort svg{flex:none;opacity:0}
[aria-sort='ascending']>.sm-sort,[aria-sort='descending']>.sm-sort{color:var(--dsw-alias-label-primary);font-weight:500}
[aria-sort='ascending']>.sm-sort svg,[aria-sort='descending']>.sm-sort svg{opacity:1}
.sm-check{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.sm-check:disabled{cursor:not-allowed}
.sm-row-title{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.sm-arch .sm-col-status{white-space:normal}
.sm-reasons{margin:4px 0 0;padding:0;list-style:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sm-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}
.sm-button-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px}
@media (hover:hover){.sm-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.sm-tab:hover{color:var(--dsw-alias-label-primary)}.sm-row-link:hover{background:var(--dsw-alias-interactive-bg-hover)}}
@container sm-page (max-width: 719px){.sm-cards{grid-template-columns:minmax(0,1fr)}.sm-table .sm-row{grid-template-columns:minmax(0,1fr)}.sm-row-head{display:none}.sm-num{text-align:start}.sm-col-events{display:none}.sm-tabs{max-width:none}}
@media (hover:hover){.sm-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}.sm-sort:hover{color:var(--dsw-alias-label-primary)}.sm-link:hover{text-decoration:underline}}
@container sm-page (max-width: 719px){.sm-arch .sm-arch-row{grid-template-columns:20px minmax(0,1fr)}.sm-arch .sm-arch-row>.sm-cell:not(.sm-col-select){grid-column:2}.sm-arch .sm-row-head{display:flex;flex-wrap:wrap;gap:4px 12px}.sm-arch .sm-row-head>[data-narrow='hide']{display:none}.sm-actions{justify-content:flex-start}.sm-input-num{width:96px}}
.sm-button-danger{color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-state-error-primary)}
.sm-icon-button{flex:none;width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary)}
.sm-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.sm-layer{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.sm-body>.sm-layer{width:auto;max-width:none}
.sm-dialog{display:flex;flex-direction:column;gap:16px;width:100%;max-width:520px;max-height:100%;box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain;padding:24px;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
.sm-dialog-wide{max-width:720px}
.sm-dialog:focus,.sm-step-title:focus{outline:none}
.sm-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.sm-dialog-title{margin:0;font-size:17px;line-height:24px;font-weight:500}
.sm-dialog-foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.sm-dialog p{margin:0}
.sm-step-title{margin:0;font-size:14px;line-height:22px;font-weight:500}
.sm-section{display:flex;flex-direction:column;gap:6px;min-width:0}
.sm-section-title{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.sm-fieldset{display:flex;flex-direction:column;gap:12px;min-width:0;margin:0;padding:0;border:0}
.sm-fieldset legend{padding:0;margin-bottom:8px;font-weight:500}
.sm-choice{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}
.sm-choice>label{display:inline-flex;align-items:center;gap:8px;cursor:pointer}
.sm-choice>.sm-sub,.sm-choice>.sm-field-error{flex-basis:100%;padding-inline-start:24px}
.sm-check-row{display:flex;align-items:flex-start;gap:8px;cursor:pointer}
.sm-check-row .sm-check{flex:none;margin-top:2px}
.sm-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.sm-list>li{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 12px;padding:6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.sm-list>li:last-child{border-bottom:0}
.sm-list>.sm-unit{flex-direction:column;align-items:stretch}
.sm-code{font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.sm-result{display:flex;flex-direction:column;gap:10px;min-width:0}
.sm-plan-ws .sm-row{grid-template-columns:minmax(0,2fr) minmax(48px,.6fr) minmax(56px,.6fr) minmax(64px,.8fr)}
.sm-trash,.sm-trash-body{display:flex;flex-direction:column;gap:12px;min-width:0}
.sm-trash-list .sm-row{grid-template-columns:minmax(0,2.2fr) minmax(64px,.7fr) minmax(64px,.7fr) minmax(0,1.6fr) auto}
.sm-trash-list .sm-col-state{white-space:normal}
.sm-trash-list .sm-sub,.sm-trash-list .sm-row-title{display:block}
@media (hover:hover){.sm-button-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}}
@container sm-page (max-width: 719px){.sm-layer{padding:12px}.sm-dialog{padding:16px}.sm-dialog-foot .sm-button{flex:1 1 auto}}
`

    // ---------- small utilities ----------

    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
    const fill = (template, params) => (params
      ? String(template).replace(/\{(\w+)\}/g, (match, name) => (has(params, name) ? String(params[name]) : match))
      : String(template))
    const messageOf = (error) => {
      if (error && typeof error.message === 'string') return error.message
      if (typeof error === 'string') return error
      return ''
    }
    const report = (error) => {
      try {
        if (typeof console !== 'undefined' && console && typeof console.error === 'function') console.error('[dsh-plugin-sessions]', error)
      } catch {
        // Reporting must never throw either.
      }
    }

    /** A translate function that never throws and always returns a string, with {name} filling. */
    function translator(t) {
      const lookup = (key) => {
        try {
          const value = typeof t === 'function' ? t(key) : undefined
          if (typeof value === 'string' && value.length > 0) return value
        } catch {
          // Fall through to the English table.
        }
        return has(en, key) ? en[key] : key
      }
      return (key, params) => fill(lookup(key), params)
    }

    let numberFormat = null
    const formatNumber = (value) => {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      try {
        if (numberFormat === null) numberFormat = new Intl.NumberFormat()
        return numberFormat.format(n)
      } catch {
        return String(n)
      }
    }

    const SIZE_KEYS = ['size.b', 'size.kb', 'size.mb', 'size.gb', 'size.tb']
    /** On-disk bytes in binary steps, labelled B, KB, MB, GB, TB (as design.md writes them). */
    function formatBytes(tr, bytes) {
      let value = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0
      let unit = 0
      while (value >= 1024 && unit < SIZE_KEYS.length - 1) { value /= 1024; unit += 1 }
      const digits = unit === 0 || value >= 10 ? 0 : 1
      let text
      try {
        text = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value)
      } catch {
        text = value.toFixed(digits)
      }
      return tr(SIZE_KEYS[unit], { n: text })
    }

    const startOfDay = (ms) => { const day = new Date(ms); return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() }
    /** today, yesterday, or N days ago, by calendar day. */
    function formatAgo(tr, ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      const days = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / DAY_MS)
      if (days <= 0) return tr('time.today')
      if (days === 1) return tr('time.yesterday')
      return tr('time.daysAgo', { n: formatNumber(days) })
    }
    const pad = (n) => String(n).padStart(2, '0')
    const formatClock = (ms) => { const at = new Date(ms); return `${pad(at.getHours())}:${pad(at.getMinutes())}` }
    const shortId = (id) => String(id).slice(0, 8)

    /** Localized text for a Remote error ({ code, message }). */
    function errorText(tr, error) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      if (ERROR_CODES.includes(code)) return tr(`error.${code.slice(ERROR_PREFIX.length)}`)
      if (code === 'malformed') return tr('state.malformed')
      if (code === 'unavailable') return tr('error.unavailable')
      // The shell's own single-flight guard (shell.mutate while another mutation runs).
      if (code === 'client/busy') return tr('error.busy')
      return tr('error.unknown')
    }
    /** Localized explanation of a refusal code (for the Archived list and the prune flow). */
    const refusalText = (tr, code) => (REFUSAL_CODES.includes(code) ? tr(`refusal.${code}`) : String(code))

    const normalizeError = (error) => ({
      code: error && typeof error.code === 'string' ? error.code : null,
      message: messageOf(error),
    })

    // ---------- the overview DTO, guarded before render ----------

    const TOTAL_KEYS = [
      'sessions', 'live', 'archived', 'children', 'unreadable', 'bytes', 'archivedBytes', 'archivedRoots', 'archivedChildren',
      'reclaimableBytes', 'reclaimableUnits', 'blockedUnits', 'archivedMissing',
    ]
    const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
    /** A count the Host may not know (overview.largest[].events): null stays null. */
    const countOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
    const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null)
    const time = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

    /** A render-safe copy of an overview response, or null when its shape is not an overview. */
    function readOverview(value) {
      if (!isObject(value) || !isObject(value.totals) || !isObject(value.capabilities) || !isObject(value.config)) return null
      if (!Array.isArray(value.workspaces) || !Array.isArray(value.largest)) return null
      const totals = {}
      for (const key of TOTAL_KEYS) totals[key] = count(value.totals[key])
      const config = value.config
      return {
        generatedAt: time(value.generatedAt),
        storeDir: text(value.storeDir),
        capabilities: { prune: value.capabilities.prune === true, reason: text(value.capabilities.reason) },
        config: {
          allowPermanentDelete: config.allowPermanentDelete === true,
          recentActivityMinutes: count(config.recentActivityMinutes),
          listLimit: count(config.listLimit),
          refreshMs: count(config.refreshMs),
          indexWarnBytes: count(config.indexWarnBytes),
        },
        totals,
        indexLoad: value.indexLoad === 'high' ? 'high' : 'normal',
        workspaces: value.workspaces.filter(isObject).map((ws) => ({
          id: text(ws.id), name: text(ws.name), path: text(ws.path), folder: text(ws.folder),
          sessions: count(ws.sessions), archived: count(ws.archived), bytes: count(ws.bytes), lastActivityAt: time(ws.lastActivityAt),
        })),
        largest: value.largest.filter((row) => isObject(row) && text(row.id) !== null).slice(0, MAX_LARGEST).map((row) => ({
          id: row.id, title: text(row.title), workspaceId: text(row.workspaceId), bytes: count(row.bytes), events: countOrNull(row.events),
          lastActivityAt: time(row.lastActivityAt), live: row.live === true, archived: row.archived === true, child: row.child === true,
        })),
      }
    }

    // ---------- plugin-level state ----------

    /** A tiny external store; listeners never throw into the caller. */
    function createStore(initial) {
      let state = initial
      let version = 0
      const listeners = new Set()
      return {
        get: () => state,
        version: () => version,
        set(next) {
          state = typeof next === 'function' ? next(state) : next
          version += 1
          for (const listener of [...listeners]) {
            try { listener() } catch (error) { report(error) }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /** Re-render on every store change. Subscribes in an effect, so strict-mode replays stay balanced. */
    function useStore(store) {
      const [, setTick] = React.useState(0)
      const seen = store.version()
      React.useEffect(() => {
        let alive = true
        const unsubscribe = store.subscribe(() => { if (alive) setTick((n) => n + 1) })
        if (store.version() !== seen) setTick((n) => n + 1)
        return () => { alive = false; unsubscribe() }
      }, [store])
      return store.get()
    }

    /** The Archived tab's own filters (raw field text) and sort; the workspace filter is ui.archivedFilter. */
    const ARCHIVED_QUERY = Object.freeze({ text: '', olderThanDays: '', largerThanMb: '', sort: 'bytes' })

    /**
     * The model of one plugin activation: the Remote namespace, the overview
     * (single-flight), the UI state that survives a remount, and the two call
     * paths. read() serves the read-only methods; mutate() serves the mutating
     * ones, only from user event handlers, and refreshes the overview after.
     * `ui.revision` counts the moments the store may have changed (Refresh, the
     * timed refresh, every mutation); the list tabs read their data again when
     * it moves. `archived` keeps the Archived tab's query and selection across
     * tab switches and remounts. `ui.busy` names the mutation in flight (at most
     * one: mutate() refuses a second with code client/busy); `ui.dialog` names a
     * tab that shows a modal dialog, so the shell makes the rest of the page
     * inert. `focus.prune` is the control that opened the prune panel.
     */
    function createModel() {
      const remote = createStore({ status: 'pending', api: null, error: null })
      const overview = createStore({ data: null, error: null, loading: false })
      const ui = createStore({ tab: 'overview', archivedFilter: null, prune: null, trashCount: null, revision: 0, busy: null, dialog: null })
      const focus = { prune: null }
      const archived = createStore({ query: ARCHIVED_QUERY, selection: [] })
      const invalidate = () => ui.set((state) => ({ ...state, revision: state.revision + 1 }))

      async function call(method, request) {
        const api = remote.get().api
        if (!api || typeof api[method] !== 'function') return { ok: false, error: { code: 'unavailable', message: '' } }
        try {
          const result = await api[method](request)
          // RemoteResult: { ok: true, value } or { ok: false, error }; a bare value passes through.
          if (isObject(result) && result.ok === true) return { ok: true, value: result.value }
          if (isObject(result) && result.ok === false) return { ok: false, error: normalizeError(result.error) }
          return { ok: true, value: result }
        } catch (error) {
          return { ok: false, error: normalizeError(error) }
        }
      }

      function read(method, request) {
        if (!METHOD_NAMES.includes(method) || MUTATING.includes(method)) {
          return Promise.resolve({ ok: false, error: { code: 'client/not-a-read', message: method } })
        }
        return call(method, request)
      }

      let inflight = null
      let inflightFresh = false
      let sequence = 0
      /** Load the overview; a call in flight is joined, a fresh request supersedes a plain one. */
      function loadOverview(request) {
        const fresh = isObject(request) && request.fresh === true
        if (inflight && (inflightFresh || !fresh)) return inflight
        const id = ++sequence
        overview.set((state) => ({ ...state, loading: true }))
        const promise = call('overview', fresh ? { fresh: true } : {})
          .then((outcome) => {
            if (id !== sequence) return
            if (!outcome.ok) {
              overview.set((state) => ({ ...state, error: outcome.error, loading: false }))
              return
            }
            const data = readOverview(outcome.value)
            if (data) overview.set({ data, error: null, loading: false })
            else overview.set((state) => ({ ...state, error: { code: 'malformed', message: '' }, loading: false }))
          })
          .catch((error) => { report(error) })
          .then(() => { if (inflight === promise) { inflight = null; inflightFresh = false } })
        inflight = promise
        inflightFresh = fresh
        return promise
      }

      /** Read the overview again and tell the list tabs to read theirs. */
      function reload(request) {
        invalidate()
        return loadOverview(request)
      }

      let running = null
      /** One mutation at a time; ui.busy names it while it runs. Never rejects. */
      async function mutate(method, request) {
        if (!MUTATING.includes(method)) return { ok: false, error: { code: 'client/not-a-mutation', message: method } }
        if (running !== null) return { ok: false, error: { code: 'client/busy', message: '' } }
        running = method
        ui.set((state) => ({ ...state, busy: method }))
        let outcome
        try {
          outcome = await call(method, request)
        } finally {
          running = null
          ui.set((state) => ({ ...state, busy: null }))
        }
        if (outcome.ok || (outcome.error && outcome.error.code !== 'unavailable')) void reload({ fresh: true })
        return outcome
      }

      /** Read the trash list again (fresh) for the tab count; used after a mutation made outside the Trash tab. */
      async function refreshTrashCount() {
        const outcome = await read('trash', { fresh: true })
        const data = outcome.ok ? readTrashList(outcome.value) : null
        if (data) ui.set((state) => ({ ...state, trashCount: data.batches.length }))
      }

      return { remote, overview, ui, archived, focus, read, mutate, loadOverview, reload, refreshTrashCount }
    }

    // ---------- components ----------

    const selectActive = (info) => !isObject(info) || !has(info, 'activePanelId') || info.activePanelId === PANEL_ID

    function useDocumentVisible() {
      const readVisible = () => typeof document === 'undefined' || !document || document.visibilityState !== 'hidden'
      const [visible, setVisible] = React.useState(readVisible)
      React.useEffect(() => {
        if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') return undefined
        const onChange = () => setVisible(readVisible())
        document.addEventListener('visibilitychange', onChange)
        onChange()
        return () => document.removeEventListener('visibilitychange', onChange)
      }, [])
      return visible
    }

    function Tag(props) {
      return h('span', { className: 'sm-tag', 'data-tone': props.tone || 'neutral' }, props.children)
    }

    function Facts(props) {
      return h('dl', { className: 'sm-facts' }, props.rows.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value))))
    }

    function Card(props) {
      const titleId = `sm-card-${props.id}`
      return h('li', { className: 'sm-card', 'data-card': props.id, 'aria-labelledby': titleId },
        h('h3', { className: 'sm-card-title', id: titleId }, props.title),
        h('p', { className: 'sm-card-value' }, props.value),
        props.children)
    }

    function SessionsPanelIcon(props) {
      // Glyph only: the sidebar owns the button, label, tooltip and selected fill.
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      },
      h('rect', { x: 2, y: 2.5, width: 12, height: 3.5, rx: 1 }),
      h('path', { d: 'M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6' }),
      h('path', { d: 'M6.5 9h3' }))
    }

    function workspaceLabel(shell, id) {
      if (id === null) return shell.tr('ws.unassigned')
      const data = shell.overview.data
      const ws = data ? data.workspaces.find((entry) => entry.id === id) : undefined
      return (ws && ws.name) || id
    }

    function ErrorNotice(props) {
      const { shell, error, stale } = props
      const { tr } = shell
      const detail = error && error.message ? error.message : ''
      return h('div', { className: 'sm-notice', 'data-tone': 'danger', role: 'alert' },
        h('p', null, tr(stale ? 'state.stale' : 'state.error')),
        h('p', null, errorText(tr, error)),
        detail ? h('p', { className: 'sm-detail' }, tr('state.detail', { message: detail })) : null,
        h('button', { type: 'button', className: 'sm-button sm-button-outline', onClick: () => { void shell.refresh() } }, tr('state.retry')))
    }

    function RemoteNotice(props) {
      const { tr, remote } = props
      const background = props.background || null
      if (remote.status === 'failed') {
        return h('div', { className: 'sm-notice', 'data-tone': 'danger', role: 'alert', ...background },
          h('p', null, tr('state.mountFailed')),
          remote.error ? h('p', { className: 'sm-detail' }, tr('state.detail', { message: remote.error })) : null)
      }
      if (remote.status === 'missing') {
        return h('div', { className: 'sm-notice', 'data-tone': 'danger', role: 'alert', ...background }, h('p', null, tr('state.unavailable')))
      }
      return null
    }

    function Header(props) {
      const { shell } = props
      const { tr } = shell
      const data = shell.overview.data
      const loading = shell.overview.loading
      return h('header', { className: 'sm-head', 'data-window-drag': '', ...(props.background || null) },
        h('div', { className: 'sm-heading' },
          h('h1', { className: 'sm-title', id: 'sm-page-title' }, tr('page.title')),
          data
            ? h('p', { className: 'sm-intro' },
              h('span', null, tr('page.store')),
              data.storeDir
                ? h('code', { className: 'sm-path', title: data.storeDir }, data.storeDir)
                : h('span', { className: 'sm-path', 'data-store': 'unknown' }, tr('page.storeUnknown')))
            : null),
        h('div', { className: 'sm-toolbar' },
          data ? h(Tag, { tone: data.capabilities.prune ? 'success' : 'warning' }, tr(data.capabilities.prune ? 'page.pruneOn' : 'page.pruneOff')) : null,
          data && data.generatedAt !== null ? h('span', { className: 'sm-updated' }, tr('page.updated', { time: formatClock(data.generatedAt) })) : null,
          h('button', {
            type: 'button',
            className: 'sm-button sm-button-outline',
            disabled: shell.remote.status !== 'ready' ? true : undefined,
            'aria-busy': loading ? true : undefined,
            onClick: () => { void shell.refresh() },
          }, tr(loading ? 'page.refreshing' : 'page.refresh'))))
    }

    const tabId = (tab) => `sm-tab-${tab}`
    const panelId = (tab) => `sm-panel-${tab}`

    function Tabs(props) {
      const { tr, tab, onSelect, counts } = props
      const refs = React.useRef([])
      const label = (id) => {
        if (id === 'archived' && typeof counts.archived === 'number') return tr('tab.archivedCount', { n: formatNumber(counts.archived) })
        if (id === 'trash' && typeof counts.trash === 'number') return tr('tab.trashCount', { n: formatNumber(counts.trash) })
        return tr(`tab.${id}`)
      }
      const onKeyDown = (event, index) => {
        let next
        switch (event.key) {
          case 'ArrowLeft': next = (index + TABS.length - 1) % TABS.length; break
          case 'ArrowRight': next = (index + 1) % TABS.length; break
          case 'Home': next = 0; break
          case 'End': next = TABS.length - 1; break
          default: return
        }
        event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        const node = refs.current[next]
        if (node && typeof node.focus === 'function') node.focus()
        onSelect(TABS[next])
      }
      return h('div', { role: 'tablist', 'aria-label': tr('tabs.label'), className: 'sm-tabs', ...(props.background || null) },
        TABS.map((id, index) => h('button', {
          key: id,
          id: tabId(id),
          type: 'button',
          role: 'tab',
          className: 'sm-tab',
          'aria-selected': tab === id,
          'aria-controls': tab === id ? panelId(id) : undefined,
          tabIndex: tab === id ? 0 : -1,
          ref: (node) => { refs.current[index] = node },
          onClick: () => onSelect(id),
          onKeyDown: (event) => onKeyDown(event, index),
        }, label(id))))
    }

    function Cards(props) {
      const { shell, data } = props
      const { tr } = shell
      const totals = data.totals
      const largest = data.largest[0] || null
      const indexHigh = data.indexLoad === 'high'
      const limit = formatBytes(tr, data.config.indexWarnBytes)
      const reviewDisabled = !data.capabilities.prune || totals.reclaimableUnits === 0 || shell.remote.status !== 'ready' || Boolean(shell.busy)
      return h('ul', { className: 'sm-cards' },
        h(Card, { id: 'total', title: tr('card.total'), value: formatNumber(totals.sessions) },
          h(Facts, {
            rows: [
              [tr('card.total.live'), formatNumber(totals.live)],
              [tr('card.total.archived'), formatNumber(totals.archived)],
              [tr('card.total.children'), formatNumber(totals.children)],
              [tr('card.total.unreadable'), formatNumber(totals.unreadable)],
            ],
          })),
        h(Card, { id: 'disk', title: tr('card.disk'), value: formatBytes(tr, totals.bytes) },
          h(Facts, { rows: [[tr('index.label'), h(Tag, { tone: indexHigh ? 'warning' : 'neutral' }, tr(indexHigh ? 'index.high' : 'index.normal'))]] }),
          h('p', { className: 'sm-hint', 'data-tone': indexHigh ? 'warning' : undefined }, tr(indexHigh ? 'index.hintHigh' : 'index.hintNormal', { limit }))),
        h(Card, { id: 'archived', title: tr('card.archived'), value: formatBytes(tr, totals.archivedBytes) },
          h(Facts, {
            rows: [
              [tr('card.archived.roots'), formatNumber(totals.archivedRoots)],
              [tr('card.archived.children'), formatNumber(totals.archivedChildren)],
            ],
          }),
          // Archived ids of the registry whose log is gone: why the registry's count can be higher than the page's.
          totals.archivedMissing > 0
            ? h('p', { className: 'sm-hint', 'data-fact': 'archived-missing' },
              tr(totals.archivedMissing === 1 ? 'card.archived.missingOne' : 'card.archived.missing', { n: formatNumber(totals.archivedMissing) }))
            : null),
        h(Card, { id: 'reclaimable', title: tr('card.reclaim'), value: formatBytes(tr, totals.reclaimableBytes) },
          h(Facts, {
            rows: [
              [tr('card.reclaim.ready'), formatNumber(totals.reclaimableUnits)],
              [tr('card.reclaim.blocked'), formatNumber(totals.blockedUnits)],
            ],
          }),
          h('button', {
            type: 'button',
            className: 'sm-button sm-button-outline',
            disabled: reviewDisabled ? true : undefined,
            onClick: (event) => shell.openPrune({ scope: 'all' }, invokerOf(event)),
          }, tr('card.reclaim.review'))),
        h(Card, { id: 'largest', title: tr('card.largest'), value: largest ? formatBytes(tr, largest.bytes) : tr('card.largest.none') },
          largest ? h('p', { className: 'sm-card-line', title: largest.id }, largest.title || shortId(largest.id)) : null,
          largest ? h('p', { className: 'sm-card-line' }, workspaceLabel(shell, largest.workspaceId)) : null))
    }

    const WS_COLUMNS = ['name', 'sessions', 'archived', 'size', 'activity']
    function WorkspaceTable(props) {
      const { shell, data } = props
      const { tr } = shell
      const max = data.workspaces.reduce((top, ws) => Math.max(top, ws.bytes), 0)
      return h('section', { className: 'sm-group', 'aria-labelledby': 'sm-ws-title' },
        h('h2', { className: 'sm-group-title', id: 'sm-ws-title' }, tr('ws.title')),
        data.workspaces.length === 0
          ? h('p', { className: 'sm-empty' }, tr('ws.empty'))
          : h('div', { role: 'table', className: 'sm-table sm-ws', 'aria-labelledby': 'sm-ws-title' },
            h('div', { role: 'rowgroup' },
              h('div', { role: 'row', className: 'sm-row sm-row-head' },
                WS_COLUMNS.map((column) => h('span', {
                  key: column, role: 'columnheader', className: `sm-cell sm-col-${column}${column === 'sessions' || column === 'archived' ? ' sm-num' : ''}`,
                }, tr(`ws.col.${column}`))))),
            h('div', { role: 'rowgroup' },
              data.workspaces.map((ws, index) => {
                const unassigned = ws.id === null
                const name = unassigned ? tr('ws.unassigned') : ws.name || ws.id
                const sub = unassigned ? (ws.folder ? tr('ws.folder', { folder: ws.folder }) : null) : ws.path
                const share = max > 0 ? Math.round((ws.bytes / max) * 10000) / 100 : 0
                return h('div', { key: unassigned ? `unassigned:${ws.folder || index}` : `ws:${ws.id}`, role: 'row', className: 'sm-row sm-row-link' },
                  h('span', { role: 'cell', className: 'sm-cell sm-col-name' },
                    h('button', {
                      type: 'button',
                      className: 'sm-row-open',
                      'aria-label': tr('ws.open', { name }),
                      onClick: () => shell.openArchived({ workspaceId: ws.id }),
                    }, name),
                    sub ? h('span', { className: 'sm-sub', title: sub }, sub) : null),
                  h('span', { role: 'cell', className: 'sm-cell sm-col-sessions sm-num' }, formatNumber(ws.sessions)),
                  h('span', { role: 'cell', className: 'sm-cell sm-col-archived sm-num' }, formatNumber(ws.archived)),
                  h('span', { role: 'cell', className: 'sm-cell sm-col-size sm-size' },
                    h('span', { className: 'sm-bar', 'aria-hidden': 'true' }, h('span', { className: 'sm-bar-fill', style: { width: `${share}%` } })),
                    h('span', { className: 'sm-num' }, formatBytes(tr, ws.bytes))),
                  h('span', { role: 'cell', className: 'sm-cell sm-col-activity' }, formatAgo(tr, ws.lastActivityAt)))
              }))))
    }

    const TOP_COLUMNS = ['session', 'workspace', 'size', 'events', 'activity', 'state']
    function LargestTable(props) {
      const { shell, data } = props
      const { tr } = shell
      return h('section', { className: 'sm-group', 'aria-labelledby': 'sm-top-title' },
        h('h2', { className: 'sm-group-title', id: 'sm-top-title' }, tr('top.title')),
        data.largest.length === 0
          ? h('p', { className: 'sm-empty' }, tr('top.empty'))
          : h('div', { role: 'table', className: 'sm-table sm-top', 'aria-labelledby': 'sm-top-title' },
            h('div', { role: 'rowgroup' },
              h('div', { role: 'row', className: 'sm-row sm-row-head' },
                TOP_COLUMNS.map((column) => h('span', {
                  key: column, role: 'columnheader', className: `sm-cell sm-col-${column}${column === 'size' || column === 'events' ? ' sm-num' : ''}`,
                }, tr(`top.col.${column}`))))),
            h('div', { role: 'rowgroup' },
              data.largest.map((row) => h('div', { key: row.id, role: 'row', className: 'sm-row' },
                h('span', { role: 'cell', className: 'sm-cell sm-col-session', title: row.id }, row.title || shortId(row.id)),
                h('span', { role: 'cell', className: 'sm-cell sm-col-workspace' }, workspaceLabel(shell, row.workspaceId)),
                h('span', { role: 'cell', className: 'sm-cell sm-col-size sm-num' }, formatBytes(tr, row.bytes)),
                row.events === null
                  ? h('span', { role: 'cell', className: 'sm-cell sm-col-events sm-num', title: tr('top.eventsUnknown'), 'aria-label': tr('top.eventsUnknown') }, '—')
                  : h('span', { role: 'cell', className: 'sm-cell sm-col-events sm-num' }, formatNumber(row.events)),
                h('span', { role: 'cell', className: 'sm-cell sm-col-activity' }, formatAgo(tr, row.lastActivityAt)),
                h('span', { role: 'cell', className: 'sm-cell sm-col-state sm-badges' },
                  row.live ? h(Tag, { key: 'live', tone: 'success' }, tr('badge.live')) : null,
                  row.archived ? h(Tag, { key: 'archived', tone: 'neutral' }, tr('badge.archived')) : null,
                  row.child ? h(Tag, { key: 'child', tone: 'info' }, tr('badge.child')) : null))))))
    }

    function OverviewTab(props) {
      const { shell } = props
      const { tr, overview, remote } = shell
      const data = overview.data
      if (!data) {
        if (remote.status === 'pending') return h('p', { className: 'sm-status', role: 'status' }, tr('state.connecting'))
        if (remote.status !== 'ready') return null // RemoteNotice above the tabs names the cause.
        if (overview.error && !overview.loading) return h(ErrorNotice, { shell, error: overview.error, stale: false })
        return h('p', { className: 'sm-status', role: 'status' }, tr('state.loading'))
      }
      const empty = data.totals.sessions === 0 && data.workspaces.length === 0 && data.largest.length === 0
      return h('div', { className: 'sm-overview' },
        overview.error ? h(ErrorNotice, { shell, error: overview.error, stale: true }) : null,
        data.capabilities.prune
          ? null
          : h('div', { className: 'sm-notice', 'data-tone': 'warning', role: 'note' },
            h('p', null, tr('readOnly.notice', { reason: errorText(tr, { code: data.capabilities.reason }) }))),
        h(Cards, { shell, data }),
        h('p', { className: 'sm-note' }, tr('overview.sizes')),
        empty
          ? h('p', { className: 'sm-empty', role: 'status' }, tr('state.empty'))
          : h(React.Fragment, null, h(WorkspaceTable, { shell, data }), h(LargestTable, { shell, data })))
    }

    // ---------- the Archived tab ----------
    //
    // Rows come from archived(request) only: the Host filters, sorts and caps
    // them (docs/remote-contract.md); the client groups the page it received by
    // workspace and never filters or sorts a list itself. The workspace filter
    // is ui.archivedFilter (the Overview rows set it through openArchived); the
    // other filters, the sort and the selection live in the plugin-level
    // shell.archivedView, so they survive a tab switch. Every request goes out
    // through one timer: 0 ms on open, Refresh, a sort or a workspace pick,
    // FILTER_DEBOUNCE_MS after the last keystroke; strict-mode replays and fast
    // edits collapse into one call, and a late answer to an older request is
    // dropped. shell.ui.revision moves after Refresh, the timed refresh and
    // every shell.mutate(); the list is read again then.
    //
    // Hand-off to the prune flow: 'Prune…' (one row) and 'Prune selected…' call
    // shell.openPrune({ scope: 'selection', rootIds }, invoker) with exactly the
    // chosen root ids, a valid plan request, and the pressed button (focus
    // returns to it when the panel closes); PrunePanel receives it as `request`. The
    // live selection is shell.archivedView.selection (ids, list order is not
    // kept; setArchivedView changes it). This tab never calls plan, apply,
    // restore or purge; its only mutation is unarchive, from a click.
    //
    // Orphan rows (row.orphan: a child whose archived parent has no stored
    // log) are not archived themselves: they get no Unarchive and are left out
    // of 'Unarchive selected', but they can be selected and pruned.

    const parseDays = (raw) => {
      const value = typeof raw === 'string' ? raw.trim() : ''
      if (value === '') return null
      if (!/^\d+$/.test(value)) return undefined
      const n = Number(value)
      return Number.isSafeInteger(n) ? n : undefined
    }
    const parseMegabytes = (raw) => {
      const value = typeof raw === 'string' ? raw.trim() : ''
      if (value === '') return null
      if (!/^\d+(?:[.,]\d+)?$/.test(value)) return undefined
      const bytes = Math.floor(Number(value.replace(',', '.')) * MB)
      return Number.isSafeInteger(bytes) ? bytes : undefined
    }
    /** True when `filter` names a workspace (a string id, or null for Unassigned). */
    const hasWorkspaceFilter = (filter) => isObject(filter) && has(filter, 'workspaceId')
      && (filter.workspaceId === null || (typeof filter.workspaceId === 'string' && filter.workspaceId.length > 0))

    /** The archived request for the current query; every field passes the contract's request check. */
    function archivedRequest(query, filter) {
      const request = { sort: ARCHIVED_SORTS.includes(query.sort) ? query.sort : 'bytes' }
      if (hasWorkspaceFilter(filter)) request.workspaceId = filter.workspaceId
      const days = parseDays(query.olderThanDays)
      if (typeof days === 'number') request.olderThanDays = days
      const bytes = parseMegabytes(query.largerThanMb)
      if (typeof bytes === 'number') request.largerThanBytes = bytes
      const words = typeof query.text === 'string' ? query.text.trim().slice(0, MAX_TEXT) : ''
      if (words) request.text = words
      return request
    }

    /** A render-safe copy of an archived page, or null when its shape is not a page. Duplicate ids keep the first row. */
    function readArchivedPage(value) {
      if (!isObject(value) || !Array.isArray(value.rows)) return null
      const seen = new Set()
      const rows = []
      for (const row of value.rows) {
        if (!isObject(row) || text(row.id) === null || seen.has(row.id)) continue
        seen.add(row.id)
        rows.push({
          id: row.id, title: text(row.title), workspaceId: text(row.workspaceId), bytes: count(row.bytes), childCount: count(row.childCount),
          lastActivityAt: time(row.lastActivityAt), ageDays: count(row.ageDays), blocked: row.blocked === true, orphan: row.orphan === true,
          reasons: Array.isArray(row.reasons)
            ? row.reasons.filter((reason) => isObject(reason) && text(reason.code) !== null).map((reason) => ({ code: reason.code, sessionId: text(reason.sessionId) }))
            : [],
        })
      }
      return { total: Math.max(count(value.total), rows.length), rows }
    }

    /** A render-safe unarchive result, or null. */
    function readUnarchiveResult(value) {
      if (!isObject(value) || !Array.isArray(value.unarchived) || !Array.isArray(value.skipped)) return null
      return {
        unarchived: value.unarchived.filter((id) => text(id) !== null),
        skipped: value.skipped.filter((entry) => isObject(entry) && text(entry.id) !== null).map((entry) => ({ id: entry.id, code: text(entry.code) })),
      }
    }

    /** Groups in order of first appearance, rows in Host order within each group. */
    function groupByWorkspace(rows) {
      const groups = []
      const byKey = new Map()
      for (const row of rows) {
        const key = row.workspaceId === null ? 'unassigned' : `ws:${row.workspaceId}`
        let group = byKey.get(key)
        if (!group) {
          group = { key, workspaceId: row.workspaceId, rows: [], bytes: 0 }
          byKey.set(key, group)
          groups.push(group)
        }
        group.rows.push(row)
        group.bytes += row.bytes
      }
      return groups
    }

    /** Localized reasons, one line per code, naming the members (short ids) it applies to. */
    function reasonLines(tr, reasons) {
      const order = []
      const members = new Map()
      for (const reason of reasons) {
        if (!members.has(reason.code)) { members.set(reason.code, []); order.push(reason.code) }
        const list = members.get(reason.code)
        if (reason.sessionId && !list.includes(reason.sessionId)) list.push(reason.sessionId)
      }
      return order.map((code) => {
        const ids = members.get(code)
        const reason = refusalText(tr, code)
        return ids.length > 0 ? tr('archived.reasonItem', { reason, ids: ids.map(shortId).join(', ') }) : reason
      })
    }

    const formatDay = (ms) => {
      const at = new Date(ms)
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    }
    function formatAge(tr, days) {
      if (days <= 0) return tr('archived.ageNew')
      if (days === 1) return tr('archived.ageOne')
      return tr('archived.age', { n: formatNumber(days) })
    }
    const focusNode = (node) => {
      try {
        if (node && typeof node.focus === 'function') node.focus()
      } catch (error) {
        report(error)
      }
    }

    function SortArrow(props) {
      return h('svg', {
        width: 10, height: 10, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: props.direction === 'ascending' ? 'M5 8.5v-7M2 4.5l3-3 3 3' : 'M5 1.5v7M2 5.5l3 3 3-3' }))
    }

    function CloseGlyph() {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: 'M3 3l6 6M9 3l-6 6' }))
    }

    function NumberField(props) {
      const { tr, id, label, value, invalid, decimal, onChange } = props
      const hintId = `${id}-hint`
      return h('label', { className: 'sm-field' },
        h('span', null, label),
        h('input', {
          id,
          type: 'number',
          className: 'sm-input sm-input-num',
          min: 0,
          step: decimal ? 'any' : 1,
          inputMode: decimal ? 'decimal' : 'numeric',
          value,
          'aria-invalid': invalid ? true : undefined,
          'aria-describedby': invalid ? hintId : undefined,
          onChange: (event) => onChange(String(event && event.target ? event.target.value : '')),
        }),
        invalid ? h('span', { id: hintId, className: 'sm-field-error' }, tr('archived.filter.invalid')) : null)
    }

    /** Toolbar: workspace, older than N days, larger than N MB, text. Values go to the Host, never over a client list. */
    function ArchivedFilters(props) {
      const { shell, query, filter, onQuery, onWorkspace } = props
      const { tr } = shell
      const data = shell.overview.data
      const options = []
      const known = new Set()
      let unassigned = false
      for (const ws of data ? data.workspaces : []) {
        if (ws.id === null) { unassigned = true; continue }
        if (known.has(ws.id)) continue
        known.add(ws.id)
        options.push({ value: `ws:${ws.id}`, label: ws.name || ws.id })
      }
      const current = hasWorkspaceFilter(filter) ? filter.workspaceId : undefined
      if (current === null) unassigned = true
      else if (typeof current === 'string' && !known.has(current)) options.push({ value: `ws:${current}`, label: current })
      const selected = current === undefined ? 'all' : current === null ? 'none' : `ws:${current}`
      const valueOf = (event) => String(event && event.target ? event.target.value : '')
      return h('div', { className: 'sm-filters', role: 'search', 'aria-label': tr('archived.filters') },
        h('label', { className: 'sm-field' },
          h('span', null, tr('archived.filter.workspace')),
          h('select', { className: 'sm-input', value: selected, onChange: (event) => onWorkspace(valueOf(event)) },
            h('option', { value: 'all' }, tr('archived.filter.allWorkspaces')),
            options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
            unassigned ? h('option', { value: 'none' }, tr('ws.unassigned')) : null)),
        h(NumberField, {
          tr, id: 'sm-arch-older', label: tr('archived.filter.olderThan'), value: query.olderThanDays,
          invalid: parseDays(query.olderThanDays) === undefined, decimal: false, onChange: (value) => onQuery({ olderThanDays: value }),
        }),
        h(NumberField, {
          tr, id: 'sm-arch-larger', label: tr('archived.filter.largerThan'), value: query.largerThanMb,
          invalid: parseMegabytes(query.largerThanMb) === undefined, decimal: true, onChange: (value) => onQuery({ largerThanMb: value }),
        }),
        h('label', { className: 'sm-field sm-field-grow' },
          h('span', null, tr('archived.filter.text')),
          h('input', {
            type: 'search',
            className: 'sm-input',
            value: query.text,
            maxLength: MAX_TEXT,
            placeholder: tr('archived.filter.textHint'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => onQuery({ text: valueOf(event).slice(0, MAX_TEXT) }),
          })))
    }

    function ArchivedError(props) {
      const { shell, error, stale, onRetry } = props
      const { tr } = shell
      const detail = error && error.message ? error.message : ''
      return h('div', { className: 'sm-notice', 'data-tone': 'danger', role: 'alert' },
        h('p', null, tr(stale ? 'archived.stale' : 'archived.error')),
        h('p', null, error && error.code === 'malformed' ? tr('archived.malformed') : errorText(tr, error)),
        detail ? h('p', { className: 'sm-detail' }, tr('state.detail', { message: detail })) : null,
        h('button', { type: 'button', className: 'sm-button sm-button-outline', onClick: onRetry }, tr('state.retry')))
    }

    const ARCHIVED_COLUMNS = [
      { id: 'select', narrow: true },
      { id: 'session', sort: 'title', narrow: true },
      { id: 'size', sort: 'bytes', num: true, narrow: true },
      { id: 'children', num: true },
      { id: 'activity', sort: 'lastActivityAt', narrow: true },
      { id: 'age', num: true },
      { id: 'status' },
      { id: 'actions' },
    ]
    const columnClass = (column) => `sm-cell sm-col-${column.id}${column.num ? ' sm-num' : ''}`

    function ArchivedRow(props) {
      const { shell, row, index, selected, selectable, disabled, onToggle, onUnarchive, onPrune } = props
      const { tr } = shell
      const name = row.title || shortId(row.id)
      const whyId = `sm-arch-why-${index}`
      const orphanId = `sm-arch-orphan-${index}`
      const reasons = row.blocked ? reasonLines(tr, row.reasons) : []
      const hint = row.orphan ? tr('archived.orphanHint') : ''
      const described = [row.blocked && reasons.length > 0 ? whyId : null, row.orphan ? orphanId : null].filter(Boolean).join(' ') || undefined
      const at = row.lastActivityAt
      return h('div', { role: 'row', className: 'sm-row sm-arch-row', 'data-id': row.id, 'data-selected': selected ? 'true' : undefined },
        h('span', { role: 'cell', className: 'sm-cell sm-col-select' },
          h('input', {
            type: 'checkbox',
            className: 'sm-check',
            checked: selected,
            disabled: !selected && !selectable ? true : undefined,
            'aria-label': tr('archived.selectRow', { name }),
            onChange: () => onToggle(row.id),
          })),
        h('span', { role: 'cell', className: 'sm-cell sm-col-session' },
          h('span', { className: 'sm-row-title', title: row.id }, name),
          h('span', { className: 'sm-sub' }, workspaceLabel(shell, row.workspaceId))),
        h('span', { role: 'cell', className: 'sm-cell sm-col-size sm-num' }, formatBytes(tr, row.bytes)),
        h('span', { role: 'cell', className: 'sm-cell sm-col-children sm-num' }, formatNumber(row.childCount)),
        h('span', { role: 'cell', className: 'sm-cell sm-col-activity', title: at === null ? undefined : `${formatDay(at)} ${formatClock(at)}` }, at === null ? '' : formatDay(at)),
        h('span', { role: 'cell', className: 'sm-cell sm-col-age sm-num' }, formatAge(tr, row.ageDays)),
        h('span', { role: 'cell', className: 'sm-cell sm-col-status' },
          row.blocked || row.orphan
            ? h('span', { className: 'sm-badges' },
              row.blocked
                ? h('span', { key: 'blocked', className: 'sm-tag', 'data-tone': 'warning', 'aria-describedby': reasons.length > 0 ? whyId : undefined, title: reasons.join(' ') || undefined }, tr('archived.blocked'))
                : null,
              row.orphan ? h('span', { key: 'orphan', className: 'sm-tag', 'data-tone': 'info', 'aria-describedby': orphanId, title: hint }, tr('archived.orphan')) : null)
            : null,
          row.blocked && reasons.length > 0 ? h('ul', { id: whyId, className: 'sm-reasons' }, reasons.map((line, position) => h('li', { key: position }, line))) : null,
          row.orphan ? h('p', { id: orphanId, className: 'sm-reasons' }, hint) : null),
        h('span', { role: 'cell', className: 'sm-cell sm-col-actions' },
          h('span', { className: 'sm-actions' },
            row.orphan
              ? null
              : h('button', {
                type: 'button',
                className: 'sm-button sm-button-outline sm-button-sm',
                disabled: disabled ? true : undefined,
                'aria-label': tr('archived.unarchiveRow', { name }),
                onClick: () => onUnarchive(row.id),
              }, tr('archived.unarchive')),
            h('button', {
              type: 'button',
              className: 'sm-button sm-button-outline sm-button-sm',
              disabled: disabled || shell.readOnly ? true : undefined,
              'aria-label': tr('archived.pruneRow', { name }),
              'aria-describedby': described,
              onClick: (event) => onPrune(row.id, event),
            }, tr('archived.prune')))))
    }

    function ArchivedTable(props) {
      const { shell, groups, sort, loading, selection, onSort, onToggle, onToggleAll, rowProps } = props
      const { tr } = shell
      const ordered = groups.flatMap((group) => group.rows)
      const target = Math.min(ordered.length, MAX_IDS_PER_REQUEST)
      const picked = ordered.filter((row) => selection.has(row.id)).length
      const allChecked = target > 0 && picked >= target
      const partial = picked > 0 && !allChecked
      const capped = selection.size >= MAX_IDS_PER_REQUEST
      let index = 0
      return h('div', { role: 'table', className: 'sm-table sm-arch', 'aria-label': tr('archived.table'), 'aria-busy': loading ? true : undefined },
        h('div', { role: 'rowgroup' },
          h('div', { role: 'row', className: 'sm-row sm-row-head' },
            ARCHIVED_COLUMNS.map((column) => {
              const narrow = column.narrow ? undefined : 'hide'
              if (column.id === 'select') {
                return h('span', { key: column.id, role: 'columnheader', className: columnClass(column) },
                  h('input', {
                    type: 'checkbox',
                    className: 'sm-check',
                    checked: allChecked,
                    ref: (node) => { if (node) node.indeterminate = partial },
                    'aria-label': tr('archived.selectAll'),
                    onChange: onToggleAll,
                  }))
              }
              if (column.sort) {
                const direction = SORT_ORDER[column.sort]
                return h('span', { key: column.id, role: 'columnheader', className: columnClass(column), 'aria-sort': sort === column.sort ? direction : 'none' },
                  h('button', { type: 'button', className: 'sm-sort', title: tr(`archived.sort.${column.sort}`), onClick: () => onSort(column.sort) },
                    h('span', null, tr(`archived.col.${column.id}`)),
                    h(SortArrow, { direction })))
              }
              return h('span', { key: column.id, role: 'columnheader', className: columnClass(column), 'data-narrow': narrow }, tr(`archived.col.${column.id}`))
            }))),
        groups.map((group, groupIndex) => {
          const headingId = `sm-arch-group-${groupIndex}`
          return h('div', { key: group.key, role: 'rowgroup', 'aria-labelledby': headingId },
            h('div', { role: 'row', className: 'sm-row sm-row-group' },
              h('span', { role: 'cell', id: headingId, className: 'sm-cell sm-group-cell', 'aria-colspan': ARCHIVED_COLUMNS.length },
                h('span', null, workspaceLabel(shell, group.workspaceId)),
                h('span', { className: 'sm-sub' }, tr(group.rows.length === 1 ? 'archived.groupSummaryOne' : 'archived.groupSummary', {
                  n: formatNumber(group.rows.length), size: formatBytes(tr, group.bytes),
                })))),
            group.rows.map((row) => h(ArchivedRow, {
              key: row.id,
              ...rowProps,
              shell,
              row,
              index: index++,
              selected: selection.has(row.id),
              selectable: !capped,
              onToggle,
            })))
        }))
    }

    function SelectionBar(props) {
      const { shell, count, bytes, orphans, unarchivable, disabled, triggerRef, onUnarchive, onPrune, onClear } = props
      const { tr } = shell
      return h('div', { className: 'sm-selbar', role: 'group', 'aria-label': tr('archived.selection') },
        h('span', { className: 'sm-selbar-count' }, tr('archived.selected', { n: formatNumber(count), size: formatBytes(tr, bytes) })),
        count >= MAX_IDS_PER_REQUEST ? h('span', { className: 'sm-hint' }, tr('archived.selectionCap', { max: formatNumber(MAX_IDS_PER_REQUEST) })) : null,
        orphans > 0 ? h('span', { className: 'sm-hint' }, tr('archived.selectionOrphans', { n: formatNumber(orphans) })) : null,
        h('button', {
          id: 'sm-arch-unarchive-selected',
          ref: triggerRef,
          type: 'button',
          className: 'sm-button sm-button-outline',
          disabled: disabled || unarchivable === 0 ? true : undefined,
          onClick: onUnarchive,
        }, tr('archived.unarchiveSelected')),
        h('button', { type: 'button', className: 'sm-button sm-button-outline', disabled: disabled || shell.readOnly ? true : undefined, onClick: onPrune }, tr('archived.pruneSelected')),
        h('button', { type: 'button', className: 'sm-button', onClick: onClear }, tr('archived.clearSelection')))
    }

    function UnarchiveConfirm(props) {
      const { shell, count, busy, cancelRef, onCancel, onConfirm } = props
      const { tr } = shell
      const onKeyDown = (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        onCancel()
      }
      return h('div', { className: 'sm-confirm', role: 'group', 'aria-labelledby': 'sm-arch-confirm-q', 'aria-describedby': 'sm-arch-confirm-d', onKeyDown },
        h('p', { id: 'sm-arch-confirm-q', className: 'sm-confirm-q' }, tr('archived.confirm.question', { n: formatNumber(count) })),
        h('p', { id: 'sm-arch-confirm-d', className: 'sm-hint' }, tr('archived.confirm.detail')),
        h('div', { className: 'sm-confirm-actions' },
          h('button', { id: 'sm-arch-confirm-cancel', ref: cancelRef, type: 'button', className: 'sm-button sm-button-outline', onClick: onCancel }, tr('archived.confirm.cancel')),
          h('button', {
            id: 'sm-arch-confirm-ok',
            type: 'button',
            className: 'sm-button sm-button-outline',
            disabled: busy ? true : undefined,
            onClick: onConfirm,
          }, tr('archived.confirm.ok', { n: formatNumber(count) }))))
    }

    /** The outcome of one unarchive call, prepared for UnarchiveNotice. */
    function unarchiveNotice(outcome, names) {
      if (!outcome || !outcome.ok) return { kind: 'error', error: outcome && outcome.error ? outcome.error : { code: null, message: '' }, done: [], skipped: [] }
      const result = readUnarchiveResult(outcome.value)
      if (!result) return { kind: 'malformed', error: null, done: [], skipped: [] }
      return {
        kind: 'result',
        error: null,
        done: result.unarchived,
        skipped: result.skipped.map((entry) => ({ id: entry.id, name: names.get(entry.id) || shortId(entry.id), code: entry.code })),
      }
    }

    function UnarchiveNotice(props) {
      const { shell, notice, noticeRef, onDismiss } = props
      const { tr } = shell
      const lines = []
      if (notice.kind === 'result') {
        const done = notice.done.length
        if (done > 0 || notice.skipped.length === 0) lines.push(h('p', { key: 'done' }, tr(done === 1 ? 'unarchive.doneOne' : 'unarchive.done', { n: formatNumber(done) })))
        if (notice.skipped.length > 0) {
          lines.push(h('p', { key: 'skipped' }, tr('unarchive.skipped', { n: formatNumber(notice.skipped.length) })))
          lines.push(h('ul', { key: 'list' }, notice.skipped.map((entry) => h('li', { key: entry.id, title: entry.id },
            tr('unarchive.skippedItem', { name: entry.name, reason: entry.code ? refusalText(tr, entry.code) : tr('error.unknown') })))))
        }
      } else if (notice.kind === 'malformed') {
        lines.push(h('p', { key: 'malformed' }, tr('unarchive.malformed')))
      } else {
        lines.push(h('p', { key: 'failed' }, tr('unarchive.failed')))
        lines.push(h('p', { key: 'error' }, errorText(tr, notice.error)))
        if (notice.error && notice.error.message) lines.push(h('p', { key: 'detail', className: 'sm-detail' }, tr('state.detail', { message: notice.error.message })))
      }
      const failed = notice.kind !== 'result'
      const partial = notice.kind === 'result' && notice.skipped.length > 0
      return h('div', {
        id: 'sm-arch-notice',
        ref: noticeRef,
        tabIndex: -1,
        className: 'sm-notice',
        'data-notice': 'unarchive',
        'data-tone': failed ? 'danger' : partial ? 'warning' : undefined,
        role: failed || partial ? 'alert' : 'status',
      },
      lines,
      h('button', { type: 'button', className: 'sm-button sm-button-outline', onClick: onDismiss }, tr('unarchive.dismiss')))
    }

    /** Archived tab body. Receives { shell, filter } (filter: { workspaceId } or null, from ui.archivedFilter). */
    function ArchivedTab(props) {
      const { shell, filter } = props
      const { tr } = shell
      const view = isObject(shell.archivedView) ? shell.archivedView : { query: ARCHIVED_QUERY, selection: [] }
      const query = isObject(view.query) ? view.query : ARCHIVED_QUERY
      const selection = Array.isArray(view.selection) ? view.selection : []
      const ready = shell.remote.status === 'ready'
      const revision = isObject(shell.ui) ? shell.ui.revision : 0
      const request = archivedRequest(query, filter)
      const requestKey = JSON.stringify(request)

      const [page, setPage] = React.useState({ data: null, error: null, loading: false })
      const [action, setAction] = React.useState({ busy: false, running: 0, confirming: false, notice: null })
      const [nonce, setNonce] = React.useState(0)
      const alive = React.useRef(false)
      const ticket = React.useRef(0)
      const delay = React.useRef(0)
      const busy = React.useRef(false)
      const cancelRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const noticeRef = React.useRef(null)

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      async function load(sent) {
        const mine = ++ticket.current
        setPage((state) => (state.loading ? state : { ...state, loading: true }))
        let outcome
        try {
          outcome = await shell.read('archived', sent)
        } catch (error) {
          outcome = { ok: false, error: normalizeError(error) }
        }
        if (!alive.current || mine !== ticket.current) return
        if (!outcome.ok) { setPage((state) => ({ ...state, error: outcome.error, loading: false })); return }
        const data = readArchivedPage(outcome.value)
        if (!data) { setPage((state) => ({ ...state, error: { code: 'malformed', message: '' }, loading: false })); return }
        setPage({ data, error: null, loading: false })
        // The selection is kept by id and drops the ids this page no longer lists.
        const listed = new Set(data.rows.map((row) => row.id))
        shell.setArchivedView((current) => {
          const kept = current.selection.filter((id) => listed.has(id))
          return kept.length === current.selection.length ? current : { ...current, selection: kept }
        })
      }

      // One request timer: on open, on a new query, a new revision or a retry.
      React.useEffect(() => {
        if (!ready) return undefined
        const timer = setTimeout(() => { delay.current = 0; void load(request) }, delay.current)
        return () => clearTimeout(timer)
      }, [ready, requestKey, revision, nonce])

      React.useEffect(() => {
        if (action.confirming) focusNode(cancelRef.current)
      }, [action.confirming])

      React.useEffect(() => {
        if (action.notice) focusNode(noticeRef.current)
      }, [action.notice])

      const data = page.data
      const rows = data ? data.rows : []
      const groups = groupByWorkspace(rows)
      const ordered = groups.flatMap((group) => group.rows)
      const chosen = new Set(selection)
      const selectedRows = ordered.filter((row) => chosen.has(row.id))
      const unarchivable = selectedRows.filter((row) => !row.orphan).map((row) => row.id)
      const disabled = !ready || action.busy || Boolean(shell.busy)
      const filtersActive = hasWorkspaceFilter(filter) || ['olderThanDays', 'largerThanBytes', 'text'].some((key) => has(request, key))

      const setQuery = (patch, wait) => {
        delay.current = wait ? FILTER_DEBOUNCE_MS : 0
        shell.setArchivedView((current) => ({ ...current, query: { ...current.query, ...patch } }))
      }
      const pickWorkspace = (value) => {
        delay.current = 0
        if (value === 'all') shell.openArchived(null)
        else if (value === 'none') shell.openArchived({ workspaceId: null })
        else if (value.startsWith('ws:') && value.length > 3) shell.openArchived({ workspaceId: value.slice(3) })
      }
      const sortBy = (key) => {
        if (ARCHIVED_SORTS.includes(key) && key !== request.sort) setQuery({ sort: key }, false)
      }
      const clearFilters = () => {
        delay.current = 0
        shell.setArchivedView((current) => ({ ...current, query: { ...current.query, text: '', olderThanDays: '', largerThanMb: '' } }))
        if (hasWorkspaceFilter(filter)) shell.openArchived(null)
      }
      const retry = () => { delay.current = 0; setNonce((n) => n + 1) }

      const toggle = (id) => shell.setArchivedView((current) => {
        if (current.selection.includes(id)) return { ...current, selection: current.selection.filter((entry) => entry !== id) }
        if (current.selection.length >= MAX_IDS_PER_REQUEST) return current
        return { ...current, selection: [...current.selection, id] }
      })
      const toggleAll = () => {
        const listed = ordered.map((row) => row.id)
        const target = listed.slice(0, MAX_IDS_PER_REQUEST)
        shell.setArchivedView((current) => {
          const all = target.length > 0 && target.every((id) => current.selection.includes(id))
          if (!all) return { ...current, selection: target }
          const drop = new Set(listed)
          return { ...current, selection: current.selection.filter((id) => !drop.has(id)) }
        })
      }
      const clearSelection = () => shell.setArchivedView((current) => (current.selection.length === 0 ? current : { ...current, selection: [] }))

      // The prune hand-off: exactly these root ids, as a plan request for the prune flow.
      const prune = (ids, event) => {
        if (ids.length === 0 || !ready || shell.readOnly) return
        shell.openPrune({ scope: 'selection', rootIds: ids.slice(0, MAX_IDS_PER_REQUEST) }, invokerOf(event))
      }

      async function unarchive(ids) {
        if (busy.current || ids.length === 0 || !ready) return
        busy.current = true
        const names = new Map(rows.map((row) => [row.id, row.title || shortId(row.id)]))
        setAction({ busy: true, running: ids.length, confirming: false, notice: null })
        let outcome
        try {
          outcome = await shell.mutate('unarchive', { ids: ids.slice(0, MAX_IDS_PER_REQUEST) })
        } catch (error) {
          outcome = { ok: false, error: normalizeError(error) }
        }
        busy.current = false
        const notice = unarchiveNotice(outcome, names)
        if (notice.done.length > 0) {
          const done = new Set(notice.done)
          shell.setArchivedView((current) => {
            const kept = current.selection.filter((id) => !done.has(id))
            return kept.length === current.selection.length ? current : { ...current, selection: kept }
          })
        }
        // shell.mutate() moved ui.revision, so the list is read again.
        if (alive.current) setAction({ busy: false, running: 0, confirming: false, notice })
      }
      const askUnarchive = () => {
        if (unarchivable.length > 1) setAction((state) => (state.busy ? state : { ...state, confirming: true }))
        else void unarchive(unarchivable)
      }
      const cancelConfirm = () => {
        setAction((state) => ({ ...state, confirming: false }))
        focusNode(triggerRef.current)
      }

      const workspaceChip = hasWorkspaceFilter(filter)
        ? (() => {
          const label = tr('archived.chip.workspace', { name: workspaceLabel(shell, filter.workspaceId) })
          return h('button', { type: 'button', className: 'sm-chip', 'aria-label': tr('archived.chip.remove', { label }), onClick: () => pickWorkspace('all') },
            h('span', null, label), h(CloseGlyph))
        })()
        : null

      let body
      if (!data) {
        if (page.error) body = null
        else if (shell.remote.status === 'pending') body = h('div', { 'data-placeholder': 'archived' }, h('p', { className: 'sm-status', role: 'status' }, tr('state.connecting')))
        else if (ready) body = h('div', { 'data-placeholder': 'archived' }, h('p', { className: 'sm-status', role: 'status' }, tr('archived.loading')))
        else body = null // RemoteNotice above the tabs names the cause.
      } else if (rows.length === 0) {
        body = h('p', { className: 'sm-empty', role: 'status' }, tr(filtersActive ? 'archived.noMatch' : 'archived.empty'))
      } else {
        body = h(ArchivedTable, {
          shell,
          groups,
          sort: request.sort,
          loading: page.loading,
          selection: chosen,
          onSort: sortBy,
          onToggle: toggle,
          onToggleAll: toggleAll,
          rowProps: { disabled, onUnarchive: (id) => { void unarchive([id]) }, onPrune: (id, event) => prune([id], event) },
        })
      }

      const truncated = data !== null && data.total > rows.length
      return h('div', { className: 'sm-archived' },
        h(ArchivedFilters, { shell, query, filter, onQuery: (patch) => setQuery(patch, true), onWorkspace: pickWorkspace }),
        filtersActive
          ? h('div', { className: 'sm-chips' },
            workspaceChip,
            h('button', { type: 'button', className: 'sm-link', onClick: clearFilters }, tr('archived.clearFilters')))
          : null,
        shell.readOnly && shell.overview.data
          ? h('div', { className: 'sm-notice', 'data-tone': 'warning', role: 'note' },
            h('p', null, tr('archived.readOnly', { reason: errorText(tr, { code: shell.overview.data.capabilities.reason }) })))
          : null,
        page.error ? h(ArchivedError, { shell, error: page.error, stale: data !== null, onRetry: retry }) : null,
        data
          ? h('div', { className: 'sm-summary' },
            h('p', { role: 'status' }, truncated
              ? tr('archived.showing', { shown: formatNumber(rows.length), total: formatNumber(data.total) })
              : tr(data.total === 1 ? 'archived.countOne' : 'archived.count', { n: formatNumber(data.total) })),
            h('p', null, tr('archived.sizes')),
            page.loading ? h('p', null, tr('archived.updating')) : null)
          : null,
        selectedRows.length > 0
          ? h(SelectionBar, {
            shell,
            count: selectedRows.length,
            bytes: selectedRows.reduce((total, row) => total + row.bytes, 0),
            orphans: selectedRows.length - unarchivable.length,
            unarchivable: unarchivable.length,
            disabled,
            triggerRef,
            onUnarchive: askUnarchive,
            onPrune: (event) => prune(selectedRows.map((row) => row.id), event),
            onClear: clearSelection,
          })
          : null,
        action.confirming && unarchivable.length > 1
          ? h(UnarchiveConfirm, { shell, count: unarchivable.length, busy: action.busy, cancelRef, onCancel: cancelConfirm, onConfirm: () => { void unarchive(unarchivable) } })
          : null,
        action.busy
          ? h('p', { className: 'sm-status', role: 'status' }, tr(action.running === 1 ? 'unarchive.runningOne' : 'unarchive.running', { n: formatNumber(action.running) }))
          : null,
        action.notice
          ? h(UnarchiveNotice, { shell, notice: action.notice, noticeRef, onDismiss: () => setAction((state) => ({ ...state, notice: null })) })
          : null,
        body)
    }

    // ---------- dialogs ----------
    //
    // No client package offers a dialog, so the page builds its own in-page
    // modal (docs/placement.md, Dialogs): a layer over the page root with the
    // host mask, and a card with role=dialog, aria-modal and a label. Focus moves
    // to the initial control (Cancel) on open, Tab and Shift+Tab wrap inside the
    // card, Escape and a click on the mask close it unless it is locked (a call
    // in flight; Escape still stops there), and on close focus returns to the
    // control that opened it. Meanwhile the rest of the page is inert: the shell
    // marks its header, tabs and tab panel (ui.prune or ui.dialog); a tab that
    // holds a dialog marks its own content.

    /** React 19 takes `inert` as a boolean; React 18 passes it through only as a string attribute. */
    const INERT = Number.parseInt(String(React.version || ''), 10) >= 19 ? true : ''
    /** Props that make a subtree inert (no focus, no pointer, hidden from assistive technology) while `on`. */
    const inertProps = (on) => (on ? { inert: INERT } : null)
    const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]'
    const activeElement = () => {
      try {
        return typeof document !== 'undefined' && document ? document.activeElement || null : null
      } catch {
        return null
      }
    }
    /** The control a click came from (a browser passes it as currentTarget), so focus can return to it. */
    const invokerOf = (event) => (event && event.currentTarget && typeof event.currentTarget.focus === 'function' ? event.currentTarget : null)
    /** The first candidate that can take focus back: still in the document, and not the body. */
    function focusTarget(candidates) {
      const body = typeof document !== 'undefined' && document ? document.body : null
      for (const node of candidates) {
        if (!node || typeof node.focus !== 'function' || node === body || node.isConnected === false) continue
        return node
      }
      return null
    }
    /** Enabled, tabbable controls inside `container`, in document order. */
    function focusablesIn(container) {
      try {
        if (!container || typeof container.querySelectorAll !== 'function') return []
        return Array.from(container.querySelectorAll(FOCUSABLE)).filter((node) => !node.disabled && node.tabIndex >= 0)
      } catch (error) {
        report(error)
        return []
      }
    }
    const prevent = (event) => { if (event && typeof event.preventDefault === 'function') event.preventDefault() }
    const stop = (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation() }
    const inputValue = (event) => String(event && event.target && event.target.value !== undefined ? event.target.value : '')

    /**
     * The modal layer. Props: name (data-dialog), labelId, describedBy, wide,
     * locked (no Escape or mask close), busy (aria-busy), onCancel, initialRef
     * (the control that takes focus on open), returnFocus(opener) (the node that
     * takes focus back on close; opener is what had focus at open).
     */
    function Dialog(props) {
      const { name, labelId, describedBy, busy, wide, children } = props
      const ref = React.useRef(null)
      const latest = React.useRef(props)
      latest.current = props
      const pressed = React.useRef(false)

      React.useEffect(() => {
        const opener = activeElement()
        const initial = latest.current.initialRef
        focusNode((initial && initial.current) || ref.current)
        return () => {
          let target = null
          try {
            const pick = latest.current.returnFocus
            target = typeof pick === 'function' ? pick(opener) : null
          } catch (error) {
            report(error)
          }
          if (target) focusNode(target)
        }
      }, [])

      const cancel = () => { if (!latest.current.locked) latest.current.onCancel() }
      const onKeyDown = (event) => {
        if (!event) return
        if (event.key === 'Escape') {
          prevent(event)
          stop(event)
          cancel()
          return
        }
        if (event.key !== 'Tab') return
        const dialog = ref.current
        const list = focusablesIn(dialog)
        const active = activeElement()
        const inside = Boolean(dialog && active && active !== dialog && typeof dialog.contains === 'function' && dialog.contains(active))
        if (list.length === 0) {
          prevent(event)
          focusNode(dialog)
          return
        }
        const first = list[0]
        const last = list[list.length - 1]
        if (event.shiftKey ? !inside || active === first : !inside || active === last) {
          prevent(event)
          focusNode(event.shiftKey ? last : first)
        }
      }
      return h('div', {
        className: 'sm-layer',
        'data-layer': name,
        // A click closes only when it starts and ends on the mask itself (not a drag out of the card).
        onMouseDown: (event) => { pressed.current = Boolean(event) && event.target === event.currentTarget },
        onClick: (event) => {
          const onMask = pressed.current && Boolean(event) && event.target === event.currentTarget
          pressed.current = false
          if (onMask) cancel()
        },
      },
      h('div', {
        ref,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': labelId,
        'aria-describedby': describedBy || undefined,
        'aria-busy': busy ? true : undefined,
        tabIndex: -1,
        'data-dialog': name,
        className: wide ? 'sm-dialog sm-dialog-wide' : 'sm-dialog',
        onKeyDown,
      }, children))
    }

    // ---------- Remote answers of the prune flow and the trash, guarded before render ----------

    const UNIT_STATUSES = ['ready', 'blocked']
    const PLAN_EXPIRED = `${ERROR_PREFIX}plan-expired`
    const CONFIRMATION_MISMATCH = `${ERROR_PREFIX}confirmation-mismatch`
    const isBatchId = (value) => typeof value === 'string' && BATCH_ID_PATTERN.test(value)
    const sumOf = (list, pick) => list.reduce((total, item) => total + pick(item), 0)
    const readReasons = (list) => (Array.isArray(list)
      ? list.filter((reason) => isObject(reason) && text(reason.code) !== null).map((reason) => ({ code: reason.code, sessionId: text(reason.sessionId) }))
      : [])
    /** "1 session" or "N sessions": `key` holds {n}, `${key}One` the singular. */
    const plural = (tr, key, n) => tr(n === 1 ? `${key}One` : key, { n: formatNumber(n) })
    const warningText = (tr, code) => (WARNING_CODES.includes(code) ? tr(`warning.${code}`) : String(code))

    /**
     * A render-safe plan, or null. Its totals must agree with its units (the
     * contract's assertPlan rule): the typed confirmation is totals.readySessions,
     * so a plan whose numbers disagree is never offered for confirmation.
     */
    function readPlan(value) {
      if (!isObject(value) || text(value.planId) === null || !Array.isArray(value.units) || !isObject(value.totals) || !Array.isArray(value.byWorkspace)) return null
      const units = []
      const seen = new Set()
      for (const raw of value.units) {
        if (!isObject(raw) || text(raw.rootId) === null || seen.has(raw.rootId) || !UNIT_STATUSES.includes(raw.status)) return null
        if (!Array.isArray(raw.memberIds) || !raw.memberIds.every((id) => text(id) !== null) || !raw.memberIds.includes(raw.rootId)) return null
        seen.add(raw.rootId)
        units.push({
          rootId: raw.rootId, memberIds: [...raw.memberIds], bytes: count(raw.bytes), workspaceId: text(raw.workspaceId), status: raw.status,
          reasons: readReasons(raw.reasons),
        })
      }
      const ready = units.filter((unit) => unit.status === 'ready')
      const totals = {
        units: units.length, ready: ready.length, blocked: units.length - ready.length,
        sessions: sumOf(units, (unit) => unit.memberIds.length), readySessions: sumOf(ready, (unit) => unit.memberIds.length),
        bytes: sumOf(units, (unit) => unit.bytes), readyBytes: sumOf(ready, (unit) => unit.bytes),
      }
      for (const key of Object.keys(totals)) if (value.totals[key] !== totals[key]) return null
      return {
        planId: value.planId,
        units,
        totals,
        byWorkspace: value.byWorkspace.filter(isObject).map((entry) => ({
          workspaceId: text(entry.workspaceId), units: count(entry.units), sessions: count(entry.sessions), bytes: count(entry.bytes),
        })),
      }
    }

    /** A render-safe apply (or restore) result, or null. */
    function readApplyResult(value) {
      if (!isObject(value) || !APPLY_STATES.includes(value.state) || !isObject(value.moved) || !Array.isArray(value.skipped) || !Array.isArray(value.warnings)) return null
      if (value.batchId !== null && !isBatchId(value.batchId)) return null
      return {
        batchId: value.batchId,
        trashDir: text(value.trashDir),
        state: value.state,
        moved: { units: count(value.moved.units), sessions: count(value.moved.sessions), bytes: count(value.moved.bytes) },
        skipped: value.skipped.filter((entry) => isObject(entry) && text(entry.rootId) !== null).map((entry) => ({ rootId: entry.rootId, reasons: readReasons(entry.reasons) })),
        warnings: value.warnings.filter((entry) => isObject(entry) && text(entry.code) !== null).map((entry) => ({ code: entry.code, sessionId: text(entry.sessionId) })),
      }
    }

    /** A render-safe trash list, or null. A row without a valid batch id is left out (no request could name it). */
    function readTrashList(value) {
      if (!isObject(value) || !Array.isArray(value.batches)) return null
      const seen = new Set()
      const batches = []
      for (const raw of value.batches) {
        if (!isObject(raw) || !isBatchId(raw.batchId) || seen.has(raw.batchId)) continue
        seen.add(raw.batchId)
        batches.push({
          batchId: raw.batchId, createdAt: time(raw.createdAt), units: count(raw.units), sessions: count(raw.sessions), bytes: count(raw.bytes),
          // An unknown state is shown as a conflict: it needs a look before anything else.
          state: BATCH_STATES.includes(raw.state) ? raw.state : 'conflict',
        })
      }
      return { trashDir: text(value.trashDir), batches }
    }

    /** A render-safe purge result, or null. */
    function readPurgeResult(value) {
      if (!isObject(value) || !isBatchId(value.batchId)) return null
      return { batchId: value.batchId, removedSessions: count(value.removedSessions), removedBytes: count(value.removedBytes) }
    }

    /** An alert: an optional lead line, the localized error text, and the Host message as detail. */
    function ErrorAlert(props) {
      const { tr, error, lead, extra } = props
      const detail = error && error.message ? error.message : ''
      return h('div', { className: 'sm-notice', 'data-tone': 'danger', role: 'alert' },
        lead ? h('p', null, lead) : null,
        extra ? h('p', null, extra) : null,
        h('p', null, errorText(tr, error)),
        detail ? h('p', { className: 'sm-detail' }, tr('state.detail', { message: detail })) : null)
    }

    /** Units with their refusal reasons (skipped or excluded), one item per unit. */
    function UnitReasons(props) {
      const { shell, units, detail } = props
      const { tr } = shell
      return h('ul', { className: 'sm-list' }, units.map((unit) => h('li', { key: unit.rootId, className: 'sm-unit', 'data-root': unit.rootId },
        h('span', { className: 'sm-row-title', title: unit.rootId }, shortId(unit.rootId)),
        detail ? h('span', { className: 'sm-sub' }, detail(unit)) : null,
        unit.reasons.length > 0 ? h('ul', { className: 'sm-reasons' }, reasonLines(tr, unit.reasons).map((line, index) => h('li', { key: index }, line))) : null)))
    }

    function Warnings(props) {
      const { shell, warnings } = props
      const { tr } = shell
      if (warnings.length === 0) return null
      return h('section', { className: 'sm-section' },
        h('h4', { className: 'sm-section-title' }, tr('prune.result.warnings')),
        h('ul', { className: 'sm-list' }, warnings.map((warning, index) => h('li', { key: index, 'data-warning': warning.code },
          warning.sessionId
            ? tr('prune.warningItem', { warning: warningText(tr, warning.code), id: shortId(warning.sessionId) })
            : warningText(tr, warning.code)))))
    }

    // ---------- the prune flow ----------
    //
    // Three steps on one Host plan (design.md, Prune panel): (1) scope: all
    // archived, older than N days, or the current selection; (2) preview from
    // plan(): nothing moves; (3) confirm: a ticked box and the typed session
    // count enable 'Move to trash'. apply() takes only the planId of the latest
    // plan response and the typed count. Every plan carries the key of the
    // request it answers; a new scope, age, selection or hand-off changes the
    // key and discards the plan, and a late answer to an older request is
    // dropped. plan-expired and confirmation-mismatch return to the preview,
    // which then needs a new plan. The result card offers Undo (restore of
    // this batch). The selection follows the live Archived selection
    // (shell.archivedView) unless the hand-off named other roots (a row's
    // Prune…); with scope selection, any change of the live selection discards
    // the plan as well. Nothing here runs a mutation outside a click.

    const DEFAULT_DAYS = 30
    const uniqueIds = (list) => [...new Set(list.filter((id) => text(id) !== null))].slice(0, MAX_IDS_PER_REQUEST)
    const idKey = (ids) => [...ids].sort().join('\n')
    const sameIds = (a, b) => a.length === b.length && idKey(a) === idKey(b)
    const liveSelection = (view) => (isObject(view) && Array.isArray(view.selection) ? uniqueIds(view.selection) : [])

    /** The scope form for a hand-off: its scope, its age, and its roots when they are not the live selection. */
    function pruneForm(request, live) {
      const scope = isObject(request) && PLAN_SCOPES.includes(request.scope) ? request.scope : 'all'
      const days = scope === 'olderThan' && Number.isSafeInteger(request.olderThanDays) && request.olderThanDays >= 0
        ? String(request.olderThanDays)
        : String(DEFAULT_DAYS)
      const asked = scope === 'selection' && Array.isArray(request.rootIds) ? uniqueIds(request.rootIds) : null
      return { scope, days, fixed: asked !== null && !sameIds(asked, live) ? asked : null }
    }

    /** The plan request for the form (valid for the contract's request check), or null while it is incomplete. */
    function planRequestOf(form, live) {
      if (form.scope === 'all') return { scope: 'all' }
      if (form.scope === 'olderThan') {
        const days = parseDays(form.days)
        return typeof days === 'number' ? { scope: 'olderThan', olderThanDays: days } : null
      }
      const ids = form.fixed || live
      return ids.length > 0 ? { scope: 'selection', rootIds: ids.slice(0, MAX_IDS_PER_REQUEST) } : null
    }

    /** Blocked units counted per refusal code, codes in order of first appearance. */
    function checkCounts(units) {
      const order = []
      const counts = new Map()
      for (const unit of units) {
        if (unit.status !== 'blocked') continue
        for (const code of new Set(unit.reasons.map((reason) => reason.code))) {
          if (!counts.has(code)) { counts.set(code, 0); order.push(code) }
          counts.set(code, counts.get(code) + 1)
        }
      }
      return order.map((code) => ({ code, units: counts.get(code) }))
    }

    const PRUNE_FLOW = Object.freeze({
      step: 'scope', plan: null, planning: null, error: null, notice: null, checked: false, typed: '', running: null, moving: 0, result: null,
    })
    const PRUNE_STEPS = { scope: 1, preview: 2, confirm: 3 }

    /** Prune panel. Receives { shell, request, onClose }; request is a plan request such as { scope: 'all' }. */
    function PrunePanel(props) {
      const { shell, request, onClose } = props
      const { tr } = shell
      const ready = shell.remote.status === 'ready'
      const live = liveSelection(shell.archivedView)
      const requestKey = JSON.stringify(isObject(request) ? request : null)
      const [form, setForm] = React.useState(() => pruneForm(request, live))
      const [flow, setFlow] = React.useState(PRUNE_FLOW)
      const alive = React.useRef(false)
      const ticket = React.useRef(0)
      const inflight = React.useRef(false)
      const moving = React.useRef(false)
      const undoing = React.useRef(false)
      const handled = React.useRef(requestKey)
      const shownStep = React.useRef(PRUNE_FLOW.step)
      const cancelRef = React.useRef(null)
      const stepRef = React.useRef(null)
      const resultRef = React.useRef(null)

      const planRequest = planRequestOf(form, live)
      const planKey = planRequest === null ? null : JSON.stringify({
        ...planRequest,
        rootIds: planRequest.rootIds ? [...planRequest.rootIds].sort() : undefined,
        live: form.scope === 'selection' ? idKey(live) : undefined,
      })
      const plan = flow.plan && flow.plan.key === planKey ? flow.plan.data : null
      const flowRef = React.useRef(flow)
      flowRef.current = flow
      const keyRef = React.useRef(planKey)
      keyRef.current = planKey
      const sentRef = React.useRef(planRequest)
      sentRef.current = planRequest
      const planRef = React.useRef(plan)
      planRef.current = plan

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      // A new hand-off (openPrune with another request) starts over, unless a call is moving data.
      React.useEffect(() => {
        if (handled.current === requestKey) return
        handled.current = requestKey
        if (flowRef.current.running) return
        ticket.current += 1
        inflight.current = false
        const held = flowRef.current.plan !== null
        setForm(pruneForm(request, liveSelection(shell.archivedView)))
        setFlow({ ...PRUNE_FLOW, notice: held ? 'discarded' : null })
      }, [requestKey])

      // A new scope, age or selection discards the plan and drops a plan call in flight.
      React.useEffect(() => {
        const current = flowRef.current
        if (current.running || current.step === 'result') return
        const stale = current.plan !== null && current.plan.key !== planKey
        const orphan = current.planning !== null && current.planning !== planKey
        if (!stale && !orphan) return
        ticket.current += 1
        inflight.current = false
        setFlow((state) => ({
          ...state, step: 'scope', plan: null, planning: null, checked: false, typed: '', error: null, notice: stale ? 'discarded' : state.notice,
        }))
      }, [planKey])

      // A new step moves focus to its heading (the control that was pressed is gone).
      React.useEffect(() => {
        if (shownStep.current === flow.step) return
        shownStep.current = flow.step
        focusNode(flow.step === 'result' ? resultRef.current : stepRef.current)
      }, [flow.step])

      const locked = flow.running !== null
      const editable = !locked && flow.step === 'scope'
      const close = () => { if (flowRef.current.running === null) onClose() }
      const chooseScope = (scope) => {
        if (editable && PLAN_SCOPES.includes(scope)) setForm((state) => (state.scope === scope ? state : { ...state, scope }))
      }
      const editDays = (value) => { if (editable) setForm((state) => ({ ...state, scope: 'olderThan', days: value })) }

      async function preview() {
        const current = flowRef.current
        const sent = sentRef.current
        const key = keyRef.current
        if (sent === null || inflight.current || current.running !== null || !ready || shell.readOnly) return
        inflight.current = true
        const mine = ++ticket.current
        setFlow((state) => ({ ...state, planning: key, error: null, notice: null }))
        let outcome
        try {
          outcome = await shell.read('plan', sent)
        } catch (error) {
          outcome = { ok: false, error: normalizeError(error) }
        }
        if (mine !== ticket.current) return // superseded: a newer request or a discarded plan
        inflight.current = false
        if (!alive.current || keyRef.current !== key) return
        if (!outcome.ok) {
          setFlow((state) => ({ ...state, step: 'scope', planning: null, error: { where: 'plan', error: outcome.error } }))
          return
        }
        const data = readPlan(outcome.value)
        if (!data) {
          setFlow((state) => ({ ...state, step: 'scope', planning: null, error: { where: 'plan', error: { code: 'malformed', message: '' } } }))
          return
        }
        setFlow((state) => ({ ...state, step: 'preview', planning: null, plan: { key, data }, checked: false, typed: '', error: null, notice: null }))
      }

      const back = () => {
        const current = flowRef.current
        if (current.running !== null || current.planning !== null) return
        if (current.step === 'confirm') setFlow((state) => ({ ...state, step: 'preview', checked: false, typed: '', error: null }))
        else if (current.step === 'preview') setFlow((state) => ({ ...state, step: 'scope', error: null }))
      }
      const proceed = () => {
        const data = planRef.current
        if (flowRef.current.step !== 'preview' || flowRef.current.running !== null || !data || data.totals.readySessions === 0) return
        setFlow((state) => ({ ...state, step: 'confirm', checked: false, typed: '', error: null }))
      }
      const setChecked = (checked) => setFlow((state) => (state.running !== null || state.step !== 'confirm' ? state : { ...state, checked }))
      const setTyped = (typed) => setFlow((state) => (state.running !== null || state.step !== 'confirm' ? state : { ...state, typed }))

      async function move() {
        const current = flowRef.current
        const data = planRef.current
        const typed = parseDays(current.typed)
        if (moving.current || current.step !== 'confirm' || current.running !== null || !data || !current.checked) return
        if (typeof typed !== 'number' || typed === 0 || typed !== data.totals.readySessions) return
        moving.current = true
        setFlow((state) => ({ ...state, running: 'apply', moving: typed, error: null }))
        let outcome
        try {
          outcome = await shell.mutate('apply', { planId: data.planId, confirmCount: typed })
        } catch (error) {
          outcome = { ok: false, error: normalizeError(error) }
        }
        moving.current = false
        void shell.refreshTrashCount()
        if (!alive.current) return
        if (!outcome.ok) {
          const code = outcome.error ? outcome.error.code : null
          if (code === PLAN_EXPIRED || code === CONFIRMATION_MISMATCH) {
            // The plan is spent: back to the preview, which needs a new plan.
            ticket.current += 1
            inflight.current = false
            setFlow((state) => ({
              ...state, running: null, step: 'preview', plan: null, planning: null, checked: false, typed: '', error: { where: 'stale', error: outcome.error },
            }))
          } else {
            setFlow((state) => ({ ...state, running: null, error: { where: 'apply', error: outcome.error } }))
          }
          return
        }
        setFlow((state) => ({ ...state, running: null, step: 'result', plan: null, error: null, result: { data: readApplyResult(outcome.value), undo: null } }))
      }

      async function undo() {
        const current = flowRef.current
        const result = current.result
        if (undoing.current || current.running !== null || !result || !result.data || !result.data.batchId) return
        if (result.undo && result.undo.kind === 'restored') return
        undoing.current = true
        const batchId = result.data.batchId
        setFlow((state) => ({ ...state, running: 'restore', result: { ...state.result, undo: null } }))
        let outcome
        try {
          outcome = await shell.mutate('restore', { batchId })
        } catch (error) {
          outcome = { ok: false, error: normalizeError(error) }
        }
        undoing.current = false
        void shell.refreshTrashCount()
        if (!alive.current) return
        let state
        if (!outcome.ok) state = { kind: 'error', error: outcome.error }
        else {
          const data = readApplyResult(outcome.value)
          state = data ? { kind: 'restored', data } : { kind: 'malformed' }
        }
        setFlow((previous) => ({ ...previous, running: null, result: previous.result ? { ...previous.result, undo: state } : previous.result }))
      }

      // ----- render -----
      const button = (key, label, onClick, options = {}) => h('button', {
        key,
        id: options.id,
        ref: options.ref,
        type: 'button',
        className: `sm-button ${options.danger ? 'sm-button-danger' : 'sm-button-outline'}`,
        disabled: options.disabled || locked ? true : undefined,
        'aria-describedby': options.describedBy,
        onClick,
      }, label)

      const stepNumber = PRUNE_STEPS[flow.step]
      const sessionsOf = (n) => plural(tr, 'prune.sessions', n)
      let statusText = ''
      if (flow.planning !== null) statusText = tr('prune.planning')
      else if (flow.running === 'apply') statusText = tr('prune.moving', { sessions: sessionsOf(flow.moving) })
      else if (flow.running === 'restore') statusText = tr('prune.undoing')

      const body = []
      const footer = [button('cancel', tr(flow.step === 'result' ? 'prune.done' : 'prune.cancel'), close, { id: flow.step === 'result' ? 'sm-prune-done' : 'sm-prune-cancel', ref: cancelRef })]

      if (flow.step === 'scope') {
        const ids = form.fixed || live
        const daysInvalid = form.scope === 'olderThan' && planRequest === null
        const roots = shell.overview.data ? shell.overview.data.totals.archivedRoots : null
        const choice = (value, label, disabled) => h('label', null,
          h('input', {
            type: 'radio',
            className: 'sm-check',
            name: 'sm-prune-scope',
            value,
            checked: form.scope === value,
            disabled: disabled || !editable ? true : undefined,
            onChange: () => chooseScope(value),
          }),
          h('span', null, label))
        body.push(h('fieldset', { key: 'scope', className: 'sm-fieldset' },
          h('legend', null, tr('prune.scope.legend')),
          h('div', { className: 'sm-choice' },
            choice('all', tr('prune.scope.all'), false),
            roots === null ? null : h('span', { className: 'sm-sub' }, plural(tr, 'prune.scope.allHint', roots))),
          h('div', { className: 'sm-choice' },
            choice('olderThan', tr('prune.scope.olderThan'), false),
            h('input', {
              id: 'sm-prune-days',
              type: 'number',
              className: 'sm-input sm-input-num',
              min: 0,
              step: 1,
              inputMode: 'numeric',
              value: form.days,
              disabled: !editable ? true : undefined,
              'aria-label': tr('prune.scope.days'),
              'aria-invalid': daysInvalid ? true : undefined,
              'aria-describedby': daysInvalid ? 'sm-prune-days-error' : undefined,
              onChange: (event) => editDays(inputValue(event)),
            }),
            h('span', null, tr('prune.scope.daysUnit')),
            daysInvalid ? h('span', { id: 'sm-prune-days-error', className: 'sm-field-error' }, tr('prune.scope.daysInvalid')) : null),
          h('div', { className: 'sm-choice' },
            choice('selection', tr('prune.scope.selection'), ids.length === 0),
            h('span', { className: 'sm-sub' }, ids.length === 0 ? tr('prune.scope.selectionNone') : plural(tr, 'prune.scope.selected', ids.length)))))
        if (flow.notice === 'discarded') body.push(h('p', { key: 'discarded', className: 'sm-hint', 'data-tone': 'warning' }, tr('prune.discarded')))
        if (flow.error && flow.error.where === 'plan') {
          body.push(flow.error.error && flow.error.error.code === 'malformed'
            ? h('div', { key: 'error', className: 'sm-notice', 'data-tone': 'danger', role: 'alert' }, h('p', null, tr('prune.malformed')))
            : h(ErrorAlert, { key: 'error', tr, error: flow.error.error, lead: tr('prune.planFailed') }))
        }
        footer.push(button('preview', tr('prune.preview'), () => { void preview() }, {
          disabled: planRequest === null || flow.planning !== null || !ready || shell.readOnly,
        }))
      } else if (flow.step === 'preview') {
        if (!plan) {
          // The Host refused the plan at apply time: a new plan is needed.
          if (flow.error && flow.error.where === 'stale') body.push(h(ErrorAlert, { key: 'stale', tr, error: flow.error.error, lead: tr('prune.stalePlan') }))
          footer.push(button('back', tr('prune.back'), back, { disabled: flow.planning !== null }))
          footer.push(button('again', tr('prune.previewAgain'), () => { void preview() }, {
            disabled: planRequest === null || flow.planning !== null || !ready || shell.readOnly,
          }))
        } else {
          const totals = plan.totals
          body.push(h('section', { key: 'summary', id: 'sm-prune-summary', className: 'sm-section', 'aria-labelledby': 'sm-prune-summary-title' },
            h('h4', { id: 'sm-prune-summary-title', className: 'sm-section-title' }, tr('prune.summary')),
            h(Facts, {
              rows: [
                [tr('prune.fact.roots'), formatNumber(totals.ready)],
                [tr('prune.fact.descendants'), formatNumber(totals.readySessions - totals.ready)],
                [tr('prune.fact.sessions'), formatNumber(totals.readySessions)],
                [tr('prune.fact.size'), formatBytes(tr, totals.readyBytes)],
              ],
            }),
            totals.blocked > 0
              ? h('p', { className: 'sm-hint' }, tr('prune.excludedLine', {
                units: plural(tr, 'prune.units', totals.blocked),
                sessions: sessionsOf(totals.sessions - totals.readySessions),
                size: formatBytes(tr, totals.bytes - totals.readyBytes),
              }))
              : null))
          if (totals.units === 0) body.push(h('p', { key: 'empty', className: 'sm-empty', role: 'status' }, tr('prune.emptyPlan')))
          else if (totals.ready === 0) body.push(h('p', { key: 'blocked', className: 'sm-hint', 'data-tone': 'warning', role: 'status' }, tr('prune.allBlocked')))
          if (plan.byWorkspace.length > 0) {
            body.push(h('section', { key: 'ws', className: 'sm-section', 'aria-labelledby': 'sm-prune-ws-title' },
              h('h4', { id: 'sm-prune-ws-title', className: 'sm-section-title' }, tr('prune.byWorkspace')),
              h('div', { id: 'sm-prune-ws', role: 'table', className: 'sm-table sm-plan-ws', 'aria-labelledby': 'sm-prune-ws-title' },
                h('div', { role: 'rowgroup' },
                  h('div', { role: 'row', className: 'sm-row sm-row-head' },
                    ['workspace', 'units', 'sessions', 'size'].map((column) => h('span', {
                      key: column, role: 'columnheader', className: `sm-cell${column === 'workspace' ? '' : ' sm-num'}`,
                    }, tr(`prune.ws.${column}`))))),
                h('div', { role: 'rowgroup' },
                  plan.byWorkspace.map((entry, index) => h('div', { key: entry.workspaceId === null ? `none:${index}` : `ws:${entry.workspaceId}`, role: 'row', className: 'sm-row' },
                    h('span', { role: 'cell', className: 'sm-cell' }, workspaceLabel(shell, entry.workspaceId)),
                    h('span', { role: 'cell', className: 'sm-cell sm-num' }, formatNumber(entry.units)),
                    h('span', { role: 'cell', className: 'sm-cell sm-num' }, formatNumber(entry.sessions)),
                    h('span', { role: 'cell', className: 'sm-cell sm-num' }, formatBytes(tr, entry.bytes))))))))
          }
          const checks = checkCounts(plan.units)
          body.push(h('section', { key: 'checks', id: 'sm-prune-checks', className: 'sm-section', 'aria-labelledby': 'sm-prune-checks-title' },
            h('h4', { id: 'sm-prune-checks-title', className: 'sm-section-title' }, tr('prune.checks')),
            checks.length === 0
              ? h('p', { className: 'sm-hint' }, tr('prune.checksPassed'))
              : h('ul', { className: 'sm-list' }, checks.map((check) => h('li', { key: check.code, 'data-code': check.code },
                h('span', null, refusalText(tr, check.code)),
                h('span', { className: 'sm-num' }, plural(tr, 'prune.units', check.units)))))))
          const blocked = plan.units.filter((unit) => unit.status === 'blocked')
          if (blocked.length > 0) {
            body.push(h('section', { key: 'excluded', id: 'sm-prune-excluded', className: 'sm-section', 'aria-labelledby': 'sm-prune-excluded-title' },
              h('h4', { id: 'sm-prune-excluded-title', className: 'sm-section-title' }, tr('prune.excluded', { n: formatNumber(blocked.length) })),
              h(UnitReasons, {
                shell,
                units: blocked,
                detail: (unit) => [workspaceLabel(shell, unit.workspaceId), sessionsOf(unit.memberIds.length), formatBytes(tr, unit.bytes)].join(' · '),
              })))
          }
          footer.push(button('back', tr('prune.back'), back))
          footer.push(button('continue', tr('prune.continue'), proceed, { disabled: totals.readySessions === 0 }))
        }
      } else if (flow.step === 'confirm' && plan) {
        const totals = plan.totals
        const needed = totals.readySessions
        const typed = parseDays(flow.typed)
        const wrong = flow.typed.trim() !== '' && typed !== needed
        const canMove = flow.checked && typed === needed && needed > 0 && ready && !shell.busy
        body.push(h('p', { key: 'summary' }, tr('prune.confirm.summary', {
          sessions: sessionsOf(needed),
          size: formatBytes(tr, totals.readyBytes),
          roots: plural(tr, 'prune.roots', totals.ready),
          descendants: plural(tr, 'prune.descendants', needed - totals.ready),
        })))
        body.push(h('label', { key: 'check', className: 'sm-check-row' },
          h('input', {
            id: 'sm-prune-check',
            type: 'checkbox',
            className: 'sm-check',
            checked: flow.checked,
            disabled: locked ? true : undefined,
            onChange: (event) => setChecked(Boolean(event && event.target && event.target.checked)),
          }),
          h('span', null, tr('prune.confirm.check'))))
        body.push(h('label', { key: 'count', id: 'sm-prune-count-label', className: 'sm-field', htmlFor: 'sm-prune-count' },
          // The number is shown without digit grouping: it is exactly what to type.
          h('span', null, tr('prune.confirm.type', { n: String(needed) })),
          h('input', {
            id: 'sm-prune-count',
            type: 'text',
            inputMode: 'numeric',
            autoComplete: 'off',
            spellCheck: false,
            className: 'sm-input sm-input-num',
            value: flow.typed,
            disabled: locked ? true : undefined,
            'aria-invalid': wrong ? true : undefined,
            'aria-describedby': wrong ? 'sm-prune-count-hint' : undefined,
            onChange: (event) => setTyped(inputValue(event)),
          })))
        if (wrong) body.push(h('p', { key: 'hint', id: 'sm-prune-count-hint', className: 'sm-field-error' }, tr('prune.confirm.typeHint', { n: String(needed) })))
        if (flow.error && flow.error.where === 'apply') body.push(h(ErrorAlert, { key: 'error', tr, error: flow.error.error, lead: tr('prune.applyFailed') }))
        footer.push(button('back', tr('prune.back'), back))
        footer.push(button('move', tr('prune.move'), () => { void move() }, { danger: true, disabled: !canMove }))
      } else if (flow.step === 'result' && flow.result) {
        body.push(h(PruneResult, { key: 'result', shell, result: flow.result, locked, titleRef: resultRef, onUndo: () => { void undo() } }))
      }

      return h(Dialog, {
        name: 'prune',
        labelId: 'sm-prune-title',
        wide: true,
        busy: locked,
        locked,
        onCancel: close,
        initialRef: cancelRef,
        returnFocus: (opener) => focusTarget([shell.pruneInvoker(), opener, shell.panelNode()]),
      },
      h('div', { className: 'sm-dialog-head' },
        h('h2', { id: 'sm-prune-title', className: 'sm-dialog-title' }, tr('prune.title')),
        h('button', {
          id: 'sm-prune-close',
          type: 'button',
          className: 'sm-button sm-icon-button',
          title: tr('prune.close'),
          disabled: locked ? true : undefined,
          onClick: close,
        }, h(CloseGlyph), h('span', { className: 'sm-sr' }, tr('prune.close')))),
      stepNumber
        ? h('h3', { id: 'sm-prune-step', ref: stepRef, tabIndex: -1, className: 'sm-step-title' }, tr('prune.step', { n: stepNumber, name: tr(`prune.step.${flow.step}`) }))
        : null,
      shell.readOnly && shell.overview.data && flow.step !== 'result'
        ? h('div', { className: 'sm-notice', 'data-tone': 'warning', role: 'note' },
          h('p', null, tr('prune.readOnly', { reason: errorText(tr, { code: shell.overview.data.capabilities.reason }) })))
        : null,
      body,
      // data-placeholder: the hook the shell tests (client-overview.test.mjs) find the panel by.
      flow.step === 'result' ? null : h('p', { className: 'sm-hint', 'data-placeholder': 'prune' }, tr('prune.nothingMoved')),
      h('p', { id: 'sm-prune-status', className: 'sm-status', role: 'status', 'aria-live': 'polite' }, statusText || null),
      h('div', { className: 'sm-dialog-foot' }, footer))
    }

    /** The result card: moved and skipped counts (skips with reasons), the trash location, warnings, and Undo. */
    function PruneResult(props) {
      const { shell, result, locked, titleRef, onUndo } = props
      const { tr } = shell
      const data = result.data
      if (!data) {
        return h('section', { id: 'sm-prune-result', className: 'sm-result', 'aria-labelledby': 'sm-prune-result-title' },
          h('h3', { id: 'sm-prune-result-title', ref: titleRef, tabIndex: -1, className: 'sm-step-title' }, tr('prune.result.unknown')),
          h('div', { className: 'sm-notice', 'data-tone': 'danger', role: 'alert' }, h('p', null, tr('prune.applyMalformed'))))
      }
      const title = data.batchId === null ? tr('prune.result.nothing') : tr(`prune.result.${data.state}`)
      const moved = [plural(tr, 'prune.units', data.moved.units), plural(tr, 'prune.sessions', data.moved.sessions), formatBytes(tr, data.moved.bytes)].join(' · ')
      const rows = [
        [tr('prune.result.moved'), moved],
        [tr('prune.result.skipped'), plural(tr, 'prune.units', data.skipped.length)],
      ]
      if (data.batchId) rows.push([tr('prune.result.batch'), h('code', { className: 'sm-code' }, data.batchId)])
      if (data.trashDir) rows.push([tr('prune.result.location'), h('code', { className: 'sm-code', title: data.trashDir }, data.trashDir)])
      const undo = result.undo
      const restored = undo && undo.kind === 'restored'
      return h('section', { id: 'sm-prune-result', className: 'sm-result', 'aria-labelledby': 'sm-prune-result-title', 'data-state': data.state },
        h('h3', { id: 'sm-prune-result-title', ref: titleRef, tabIndex: -1, className: 'sm-step-title' }, title),
        h(Facts, { rows }),
        data.state === 'needs-recovery' ? h('p', { className: 'sm-hint', 'data-tone': 'warning' }, tr('prune.result.recoveryHint')) : null,
        data.skipped.length > 0
          ? h('section', { className: 'sm-section' },
            h('h4', { className: 'sm-section-title' }, tr('prune.result.skippedList')),
            h(UnitReasons, { shell, units: data.skipped }))
          : null,
        h(Warnings, { shell, warnings: data.warnings }),
        data.batchId
          ? h('div', { className: 'sm-confirm-actions' },
            h('button', {
              id: 'sm-prune-undo',
              type: 'button',
              className: 'sm-button sm-button-outline',
              disabled: locked || restored || Boolean(shell.busy) ? true : undefined,
              'aria-describedby': 'sm-prune-undo-hint',
              onClick: onUndo,
            }, tr('prune.undo')),
            h('p', { id: 'sm-prune-undo-hint', className: 'sm-hint' }, tr('prune.undoHint')))
          : null,
        restored
          ? h('div', { className: 'sm-section', 'data-undo': 'restored' },
            h('p', null, tr('prune.undone', { sessions: plural(tr, 'prune.sessions', undo.data.moved.sessions) })),
            undo.data.skipped.length > 0 ? h('p', null, tr('prune.undoSkipped', { n: formatNumber(undo.data.skipped.length) })) : null,
            undo.data.skipped.length > 0 ? h(UnitReasons, { shell, units: undo.data.skipped }) : null,
            h(Warnings, { shell, warnings: undo.data.warnings }))
          : null,
        undo && undo.kind === 'error' ? h(ErrorAlert, { tr, error: undo.error, lead: tr('prune.undoFailed') }) : null,
        undo && undo.kind === 'malformed'
          ? h('div', { className: 'sm-notice', 'data-tone': 'danger', role: 'alert' }, h('p', null, tr('prune.undoMalformed')))
          : null)
    }

    // ---------- the Trash tab ----------
    //
    // Batches come from trash(request): the first read on open goes out through
    // a 0 ms timer (strict-mode replays collapse into one call; the shell tests
    // that never fire timers see the loading state), later reads after Refresh,
    // a timed refresh or a mutation (ui.revision) ask for { fresh: true }.
    // Restore batch runs from a click with no confirmation (it never
    // overwrites). Delete permanently… opens a dialog that needs the typed
    // batch id and then a second, explicit confirmation before purge({ batchId,
    // confirm }); it is disabled, with the reason, when allowPermanentDelete is
    // false. While a change runs, every batch action is off and a status line
    // says what runs.

    const TRASH_COLUMNS = ['batch', 'sessions', 'size', 'state', 'actions']
    const BATCH_TONES = { complete: 'success', 'needs-recovery': 'warning', conflict: 'danger' }

    /** The outcome of one restore or purge, prepared for TrashNotice. */
    function trashNotice(op, outcome, batchId) {
      if (!outcome || !outcome.ok) return { kind: 'error', op, batchId, error: outcome && outcome.error ? outcome.error : { code: null, message: '' } }
      const data = op === 'restore' ? readApplyResult(outcome.value) : readPurgeResult(outcome.value)
      return data ? { kind: 'done', op, batchId, data } : { kind: 'malformed', op, batchId }
    }

    function TrashNotice(props) {
      const { shell, notice, noticeRef, onDismiss } = props
      const { tr } = shell
      const lines = []
      let tone
      if (notice.kind === 'done' && notice.op === 'restore') {
        const data = notice.data
        lines.push(h('p', { key: 'done' }, tr('trash.restored', { sessions: plural(tr, 'prune.sessions', data.moved.sessions), id: notice.batchId })))
        if (data.skipped.length > 0) {
          tone = 'warning'
          lines.push(h('p', { key: 'skipped' }, tr('trash.restoreSkipped', { n: formatNumber(data.skipped.length) })))
          lines.push(h(UnitReasons, { key: 'units', shell, units: data.skipped }))
        }
        if (data.warnings.length > 0) lines.push(h(Warnings, { key: 'warnings', shell, warnings: data.warnings }))
      } else if (notice.kind === 'done') {
        lines.push(h('p', { key: 'done' }, tr('trash.deleted', {
          id: notice.batchId, sessions: plural(tr, 'prune.sessions', notice.data.removedSessions), size: formatBytes(tr, notice.data.removedBytes),
        })))
      } else if (notice.kind === 'malformed') {
        tone = 'danger'
        lines.push(h('p', { key: 'malformed' }, tr('trash.malformedAnswer')))
      } else {
        tone = 'danger'
        const error = notice.error
        lines.push(h('p', { key: 'failed' }, tr(notice.op === 'restore' ? 'trash.restoreFailed' : 'trash.deleteFailed')))
        lines.push(h('p', { key: 'error' }, errorText(tr, error)))
        if (error && error.message) lines.push(h('p', { key: 'detail', className: 'sm-detail' }, tr('state.detail', { message: error.message })))
      }
      return h('div', {
        id: 'sm-trash-notice',
        ref: noticeRef,
        tabIndex: -1,
        className: 'sm-notice',
        'data-notice': 'trash',
        'data-tone': tone,
        role: tone ? 'alert' : 'status',
      },
      lines,
      h('button', { type: 'button', className: 'sm-button sm-button-outline', onClick: onDismiss }, tr('trash.dismiss')))
    }

    /** The permanent-delete dialog: the typed batch id, then a second, explicit confirmation. */
    function PurgeDialog(props) {
      const { shell, purge, cancelRef, inputRef, returnFocus, onCancel, onType, onNext, onBack, onConfirm } = props
      const { tr } = shell
      const final = purge.stage === 'final'
      const matches = purge.typed.trim() === purge.batchId
      const wrong = !final && purge.typed.trim() !== '' && !matches
      const locked = purge.running
      const sessions = plural(tr, 'prune.sessions', purge.sessions)
      const size = formatBytes(tr, purge.bytes)
      const off = locked ? true : undefined
      return h(Dialog, { name: 'purge', labelId: 'sm-purge-title', describedBy: 'sm-purge-detail', locked, busy: locked, onCancel, initialRef: cancelRef, returnFocus },
        h('div', { className: 'sm-dialog-head' }, h('h2', { id: 'sm-purge-title', className: 'sm-dialog-title' }, tr('purge.title'))),
        final ? h('h3', { className: 'sm-step-title' }, tr('purge.finalTitle')) : null,
        h('p', { id: 'sm-purge-detail' }, final
          ? tr('purge.finalDetail', { sessions, size, id: purge.batchId })
          : tr('purge.detail', { id: purge.batchId, sessions, size })),
        final
          ? null
          : h('label', { className: 'sm-field' },
            h('span', null, tr('purge.type')),
            h('code', { className: 'sm-code' }, purge.batchId),
            h('input', {
              id: 'sm-purge-id',
              ref: inputRef,
              type: 'text',
              className: 'sm-input',
              value: purge.typed,
              autoComplete: 'off',
              autoCapitalize: 'off',
              spellCheck: false,
              disabled: off,
              'aria-invalid': wrong ? true : undefined,
              'aria-describedby': wrong ? 'sm-purge-hint' : undefined,
              onChange: (event) => onType(inputValue(event)),
            })),
        wrong ? h('p', { id: 'sm-purge-hint', className: 'sm-field-error' }, tr('purge.typeHint')) : null,
        purge.error ? h(ErrorAlert, { tr, error: purge.error, lead: tr('trash.deleteFailed') }) : null,
        h('p', { id: 'sm-purge-status', className: 'sm-status', role: 'status', 'aria-live': 'polite' }, locked ? tr('purge.running', { id: purge.batchId }) : null),
        h('div', { className: 'sm-dialog-foot' },
          h('button', { key: 'cancel', id: 'sm-purge-cancel', ref: cancelRef, type: 'button', className: 'sm-button sm-button-outline', disabled: off, onClick: onCancel }, tr('purge.cancel')),
          final ? h('button', { key: 'back', type: 'button', className: 'sm-button sm-button-outline', disabled: off, onClick: onBack }, tr('purge.back')) : null,
          final
            ? h('button', { key: 'yes', id: 'sm-purge-confirm', type: 'button', className: 'sm-button sm-button-danger', disabled: locked || !matches ? true : undefined, onClick: onConfirm }, tr('purge.confirm'))
            : h('button', { key: 'next', id: 'sm-purge-next', type: 'button', className: 'sm-button sm-button-danger', disabled: locked || !matches ? true : undefined, onClick: onNext }, tr('purge.continue'))))
    }

    /** Trash tab body. Receives { shell }. */
    function TrashTab(props) {
      const { shell } = props
      const { tr } = shell
      const ready = shell.remote.status === 'ready'
      const revision = isObject(shell.ui) ? shell.ui.revision : 0
      const config = shell.overview.data ? shell.overview.data.config : null

      const [page, setPage] = React.useState({ data: null, error: null, loading: false })
      const [action, setAction] = React.useState({ busy: null, batchId: null, notice: null })
      const [purge, setPurge] = React.useState(null)
      const [nonce, setNonce] = React.useState(0)
      const alive = React.useRef(false)
      const ticket = React.useRef(0)
      const loaded = React.useRef(false)
      const busy = React.useRef(false)
      const invoker = React.useRef(null)
      const purged = React.useRef(false)
      const noticeRef = React.useRef(null)
      const cancelRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const shownStage = React.useRef(null)
      const purgeRef = React.useRef(purge)
      purgeRef.current = purge
      const open = purge !== null
      const stage = purge ? purge.stage : null

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      async function load() {
        const mine = ++ticket.current
        const request = loaded.current ? { fresh: true } : {}
        loaded.current = true
        setPage((state) => (state.loading ? state : { ...state, loading: true }))
        let outcome
        try {
          outcome = await shell.read('trash', request)
        } catch (error) {
          outcome = { ok: false, error: normalizeError(error) }
        }
        if (!alive.current || mine !== ticket.current) return
        if (!outcome.ok) { setPage((state) => ({ ...state, error: outcome.error, loading: false })); return }
        const data = readTrashList(outcome.value)
        if (!data) { setPage((state) => ({ ...state, error: { code: 'malformed', message: '' }, loading: false })); return }
        setPage({ data, error: null, loading: false })
        shell.setTrashCount(data.batches.length)
      }

      // One request timer: on open, on a new revision (Refresh, timed refresh, mutation) or a retry.
      React.useEffect(() => {
        if (!ready) return undefined
        const timer = setTimeout(() => { void load() }, 0)
        return () => clearTimeout(timer)
      }, [ready, revision, nonce])

      React.useEffect(() => {
        if (action.notice) focusNode(noticeRef.current)
      }, [action.notice])

      // While the dialog is open the shell makes the header and the tabs inert.
      React.useEffect(() => {
        if (!open) return undefined
        shell.setDialog('trash')
        return () => shell.setDialog(null)
      }, [open])

      // The second confirmation starts on Cancel; back at the typing stage, focus goes to the field.
      React.useEffect(() => {
        const previous = shownStage.current
        shownStage.current = stage
        if (previous === null || stage === null || previous === stage) return
        focusNode(stage === 'final' ? cancelRef.current : inputRef.current)
      }, [stage])

      const data = page.data
      const batches = data ? data.batches : []
      const running = action.busy !== null || Boolean(shell.busy)
      const purgeAllowed = config !== null && config.allowPermanentDelete === true
      const actionsOff = !ready || shell.readOnly || running
      const purgeHint = shell.readOnly ? null : config === null ? tr('trash.deleteUnknown') : purgeAllowed ? null : tr('trash.deleteOff')

      async function restore(batchId) {
        if (busy.current || purgeRef.current || !ready || shell.readOnly || shell.busy) return
        busy.current = true
        setAction({ busy: 'restore', batchId, notice: null })
        let outcome
        try {
          outcome = await shell.mutate('restore', { batchId })
        } catch (error) {
          outcome = { ok: false, error: normalizeError(error) }
        }
        busy.current = false
        // shell.mutate() moved ui.revision, so the list is read again.
        if (alive.current) setAction({ busy: null, batchId: null, notice: trashNotice('restore', outcome, batchId) })
      }

      const openPurge = (batch, event) => {
        if (busy.current || purgeRef.current || !ready || shell.readOnly || !purgeAllowed || shell.busy) return
        invoker.current = invokerOf(event)
        purged.current = false
        setAction((state) => (state.notice ? { ...state, notice: null } : state))
        setPurge({ batchId: batch.batchId, sessions: batch.sessions, bytes: batch.bytes, stage: 'type', typed: '', error: null, running: false })
      }
      const closePurge = () => { if (purgeRef.current && !purgeRef.current.running) setPurge(null) }
      const typeId = (value) => setPurge((state) => (state && !state.running && state.stage === 'type' ? { ...state, typed: value } : state))
      const toFinal = () => setPurge((state) => (state && !state.running && state.stage === 'type' && state.typed.trim() === state.batchId
        ? { ...state, stage: 'final', error: null }
        : state))
      const toTyping = () => setPurge((state) => (state && !state.running && state.stage === 'final' ? { ...state, stage: 'type', error: null } : state))

      async function confirmPurge() {
        const current = purgeRef.current
        if (!current || current.stage !== 'final' || current.running || busy.current) return
        const typed = current.typed.trim()
        if (typed !== current.batchId) return
        busy.current = true
        setPurge((state) => (state ? { ...state, running: true, error: null } : state))
        setAction((state) => ({ ...state, busy: 'purge', batchId: current.batchId, notice: null }))
        let outcome
        try {
          outcome = await shell.mutate('purge', { batchId: current.batchId, confirm: typed })
        } catch (error) {
          outcome = { ok: false, error: normalizeError(error) }
        }
        busy.current = false
        if (!alive.current) return
        if (outcome.ok) {
          // The batch row leaves the list: focus goes to the notice, not back to the row.
          purged.current = true
          setPurge(null)
          setAction({ busy: null, batchId: null, notice: trashNotice('purge', outcome, current.batchId) })
          return
        }
        const mismatch = Boolean(outcome.error) && outcome.error.code === CONFIRMATION_MISMATCH
        setPurge((state) => (state
          ? { ...state, running: false, stage: mismatch ? 'type' : state.stage, typed: mismatch ? '' : state.typed, error: outcome.error }
          : state))
        setAction((state) => ({ ...state, busy: null, batchId: null }))
      }

      let body
      if (!data) {
        const loading = (key) => h('div', { 'data-placeholder': 'trash' }, h('p', { className: 'sm-status', role: 'status' }, tr(key)))
        if (page.error) body = null
        else if (shell.remote.status === 'pending') body = loading('state.connecting')
        else if (ready) body = loading('trash.loading')
        else body = null // RemoteNotice above the tabs names the cause.
      } else if (batches.length === 0) {
        body = h('p', { className: 'sm-empty', role: 'status' }, tr('trash.empty'))
      } else {
        body = h('div', { role: 'table', className: 'sm-table sm-trash-list', 'aria-label': tr('trash.table'), 'aria-busy': page.loading ? true : undefined },
          h('div', { role: 'rowgroup' },
            h('div', { role: 'row', className: 'sm-row sm-row-head' },
              TRASH_COLUMNS.map((column) => h('span', {
                key: column, role: 'columnheader', className: `sm-cell sm-col-${column}${column === 'sessions' || column === 'size' ? ' sm-num' : ''}`,
              }, tr(`trash.col.${column}`))))),
          h('div', { role: 'rowgroup' },
            batches.map((batch, index) => {
              const at = batch.createdAt
              const hintId = `sm-trash-why-${index}`
              const hint = batch.state === 'needs-recovery' ? tr('trash.needsRecoveryHint') : batch.state === 'conflict' ? tr('trash.conflictHint') : null
              return h('div', { key: batch.batchId, role: 'row', className: 'sm-row', 'data-batch': batch.batchId },
                h('span', { role: 'cell', className: 'sm-cell sm-col-batch' },
                  h('span', { className: 'sm-row-title' }, at === null ? '' : `${formatDay(at)} ${formatClock(at)}`),
                  h('code', { className: 'sm-sub sm-code', title: batch.batchId }, batch.batchId)),
                h('span', { role: 'cell', className: 'sm-cell sm-col-sessions sm-num' },
                  formatNumber(batch.sessions),
                  h('span', { className: 'sm-sub' }, plural(tr, 'prune.units', batch.units))),
                h('span', { role: 'cell', className: 'sm-cell sm-col-size sm-num' }, formatBytes(tr, batch.bytes)),
                h('span', { role: 'cell', className: 'sm-cell sm-col-state' },
                  h('span', { className: 'sm-tag', 'data-tone': BATCH_TONES[batch.state], 'aria-describedby': hint ? hintId : undefined, title: hint || undefined },
                    tr(`batchState.${batch.state}`)),
                  hint ? h('p', { id: hintId, className: 'sm-reasons' }, hint) : null),
                h('span', { role: 'cell', className: 'sm-cell sm-col-actions' },
                  h('span', { className: 'sm-actions' },
                    h('button', {
                      type: 'button',
                      className: 'sm-button sm-button-outline sm-button-sm',
                      disabled: actionsOff ? true : undefined,
                      'aria-label': tr('trash.restoreRow', { id: batch.batchId }),
                      onClick: () => { void restore(batch.batchId) },
                    }, tr('trash.restore')),
                    h('button', {
                      type: 'button',
                      className: 'sm-button sm-button-danger sm-button-sm',
                      disabled: actionsOff || !purgeAllowed ? true : undefined,
                      'aria-label': tr('trash.deleteRow', { id: batch.batchId }),
                      'aria-describedby': purgeHint ? 'sm-trash-purge-off' : undefined,
                      onClick: (event) => openPurge(batch, event),
                    }, tr('trash.delete')))))
            })))
      }

      const total = batches.reduce((sum, batch) => sum + batch.bytes, 0)
      return h('div', { className: 'sm-trash' },
        h('div', { className: 'sm-trash-body', 'data-trash': 'list', ...inertProps(open) },
          shell.readOnly && shell.overview.data
            ? h('div', { className: 'sm-notice', 'data-tone': 'warning', role: 'note' },
              h('p', null, tr('trash.readOnly', { reason: errorText(tr, { code: shell.overview.data.capabilities.reason }) })))
            : null,
          page.error
            ? h('div', { className: 'sm-notice', 'data-tone': 'danger', role: 'alert' },
              h('p', null, tr(data ? 'trash.stale' : 'trash.error')),
              h('p', null, page.error.code === 'malformed' ? tr('trash.malformed') : errorText(tr, page.error)),
              page.error.message ? h('p', { className: 'sm-detail' }, tr('state.detail', { message: page.error.message })) : null,
              h('button', { type: 'button', className: 'sm-button sm-button-outline', onClick: () => setNonce((n) => n + 1) }, tr('state.retry')))
            : null,
          data
            ? h('div', { className: 'sm-summary' },
              data.trashDir ? h('p', { className: 'sm-intro' }, h('span', null, tr('trash.location')), h('code', { className: 'sm-path', title: data.trashDir }, data.trashDir)) : null,
              batches.length > 0 ? h('p', null, `${plural(tr, 'trash.batches', batches.length)} · ${formatBytes(tr, total)}`) : null)
            : null,
          data && batches.length > 0 && purgeHint ? h('p', { id: 'sm-trash-purge-off', className: 'sm-hint' }, purgeHint) : null,
          h('p', { id: 'sm-trash-status', className: 'sm-status', role: 'status', 'aria-live': 'polite' },
            action.busy === 'restore' ? tr('trash.restoring', { id: action.batchId }) : null),
          action.notice
            ? h(TrashNotice, { shell, notice: action.notice, noticeRef, onDismiss: () => setAction((state) => ({ ...state, notice: null })) })
            : null,
          body),
        purge
          ? h(PurgeDialog, {
            shell,
            purge,
            cancelRef,
            inputRef,
            returnFocus: (opener) => (purged.current ? null : focusTarget([invoker.current, opener])),
            onCancel: closePurge,
            onType: typeId,
            onNext: toFinal,
            onBack: toTyping,
            onConfirm: () => { void confirmPurge() },
          })
          : null)
    }

    const BODIES = { overview: OverviewTab, archived: ArchivedTab, trash: TrashTab }

    // ---------- the page ----------

    function Page(props) {
      const { model, t, usePanelInfo } = props
      const tr = React.useMemo(() => translator(t), [t])
      const remote = useStore(model.remote)
      const overview = useStore(model.overview)
      const ui = useStore(model.ui)
      const archivedView = useStore(model.archived)
      const panelRef = React.useRef(null)
      const panelActive = typeof usePanelInfo === 'function' ? usePanelInfo(selectActive) !== false : true
      const documentVisible = useDocumentVisible()
      const visible = panelActive && documentVisible
      const ready = remote.status === 'ready'
      const refreshMs = overview.data ? overview.data.config.refreshMs : 0

      // Fetch on open, and once the namespace appears. A strict-mode replay joins the call in flight.
      React.useEffect(() => {
        if (ready) void model.loadOverview({})
      }, [ready])

      // Timed refresh: only when configured and while the page is visible.
      React.useEffect(() => {
        if (!ready || !visible || !(refreshMs > 0)) return undefined
        const timer = setInterval(() => { void model.reload({}) }, Math.max(refreshMs, MIN_REFRESH_MS))
        return () => clearInterval(timer)
      }, [ready, visible, refreshMs])

      const selectTab = (tab) => model.ui.set((state) => ({ ...state, tab }))
      const shell = {
        t,
        tr,
        remote,
        overview,
        ui,
        readOnly: overview.data ? !overview.data.capabilities.prune : false,
        read: model.read,
        mutate: model.mutate,
        refresh: () => model.reload({ fresh: true }),
        selectTab,
        // The Archived tab's query and selection (plugin-level, see createModel).
        archivedView,
        setArchivedView: (update) => {
          const current = model.archived.get()
          const next = typeof update === 'function' ? update(current) : update
          if (isObject(next) && next !== current) model.archived.set(next)
        },
        openArchived: (filter) => model.ui.set((state) => ({ ...state, tab: 'archived', archivedFilter: isObject(filter) ? filter : null })),
        // `invoker` is the control that opened the panel; focus returns to it when the panel closes.
        openPrune: (request, invoker) => {
          model.focus.prune = invoker && typeof invoker.focus === 'function' ? invoker : null
          model.ui.set((state) => ({ ...state, prune: isObject(request) ? request : { scope: 'all' } }))
        },
        closePrune: () => model.ui.set((state) => ({ ...state, prune: null })),
        pruneInvoker: () => model.focus.prune,
        setTrashCount: (n) => model.ui.set((state) => ({ ...state, trashCount: typeof n === 'number' ? n : null })),
        refreshTrashCount: () => model.refreshTrashCount().catch((error) => { report(error) }),
        // The mutation in flight (apply, unarchive, restore or purge), or null; a second one is refused.
        busy: typeof ui.busy === 'string' ? ui.busy : null,
        // A tab that shows a modal dialog names itself here, so the rest of the page is inert.
        setDialog: (name) => model.ui.set((state) => (state.dialog === name ? state : { ...state, dialog: typeof name === 'string' ? name : null })),
        panelNode: () => panelRef.current,
        errorText: (error) => errorText(tr, error),
        refusalText: (code) => refusalText(tr, code),
        formatBytes: (bytes) => formatBytes(tr, bytes),
        formatAgo: (ms) => formatAgo(tr, ms),
        formatNumber,
        shortId,
      }
      const tab = TABS.includes(ui.tab) ? ui.tab : 'overview'
      const Body = BODIES[tab]
      const counts = {
        archived: overview.data ? overview.data.totals.archivedRoots : null,
        trash: typeof ui.trashCount === 'number' ? ui.trashCount : null,
      }
      // While a dialog is open, everything behind it is inert: the prune panel covers the whole
      // page; a tab's dialog (ui.dialog) lives inside the tab panel, and that tab marks its own content.
      const modal = ui.prune ? 'prune' : ui.dialog === 'trash' && tab === 'trash' ? 'trash' : null
      const background = inertProps(modal !== null)
      return h('section', { className: 'sm-page', 'aria-labelledby': 'sm-page-title' },
        h('div', { className: 'sm-body' },
          h(Header, { shell, background }),
          h(RemoteNotice, { tr, remote, background }),
          h(Tabs, { tr, tab, onSelect: selectTab, counts, background }),
          ui.prune ? h(PrunePanel, { shell, request: ui.prune, onClose: shell.closePrune }) : null,
          h('div', {
            role: 'tabpanel', id: panelId(tab), 'aria-labelledby': tabId(tab), tabIndex: 0, className: 'sm-panel', ref: panelRef, ...inertProps(modal === 'prune'),
          },
          h(Body, { key: tab, shell, filter: tab === 'archived' ? ui.archivedFilter : null }))))
    }

    // ---------- registration ----------

    /** One stylesheet in the document head, removed when the plugin unloads. */
    function insertStyles() {
      try {
        if (typeof document === 'undefined' || !document || !document.head) return () => {}
        if (document.getElementById(STYLE_ID)) return () => {}
        const element = document.createElement('style')
        element.id = STYLE_ID
        element.textContent = CSS
        document.head.appendChild(element)
        return () => {
          try {
            if (element.parentNode) element.parentNode.removeChild(element)
          } catch (error) {
            report(error)
          }
        }
      } catch (error) {
        report(error)
        return () => {}
      }
    }

    /**
     * The hand-written Remote contribution for the whole package: the typert
     * registry admits one registration per package name, so every method rides
     * one mount (pattern of packages/usage/src/client.js:1713-1760).
     */
    const strictJson = {
      mode: 'strict',
      typeSymbol: `${PACKAGE}#JsonValue`,
      create: () => ({ parse: (value) => value }),
    }
    function contribution() {
      return {
        package: PACKAGE,
        descriptors: METHOD_NAMES.map((method) => ({
          id: `${PACKAGE}#${NS}/${method}`,
          service: NS,
          namespace: NS,
          method,
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: strictJson }],
          result: { mode: 'src-json' },
        })),
      }
    }

    /** Run one apply step; a failure is reported and never escapes apply. */
    const guard = (step) => {
      try { step() } catch (error) { report(error) }
    }
    const safeGet = (ctx, key) => {
      try { return ctx.get(key) } catch { return undefined }
    }

    function apply(ctx) {
      const model = createModel()

      guard(() => ctx.effect(insertStyles, 'sessions: stylesheet'))

      const locale = safeGet(ctx, 'locale')
      const hasLocale = isObject(locale) && typeof locale.register === 'function' && typeof locale.bind === 'function'
      if (hasLocale) {
        guard(() => ctx.effect(() => {
          try {
            const dispose = locale.register(NS, { en, zh })
            return typeof dispose === 'function' ? dispose : () => {}
          } catch (error) {
            report(error)
            return () => {}
          }
        }, 'sessions: dictionaries'))
      }
      let bound = null
      if (hasLocale) {
        try { bound = locale.bind(NS) } catch { bound = null }
      }
      const t = typeof bound === 'function' ? bound : (key) => (has(en, key) ? en[key] : key)
      const label = translator(t)
      // `locale: NS` makes the renderer pass a live `t` prop to the page.
      const withLocale = hasLocale ? { locale: NS } : {}

      // Mount the Remote namespace in one effect owned by this plugin. A mount
      // failure must never throw out of apply: the page shows it instead.
      guard(() => ctx.effect(async () => {
        let dispose
        try {
          dispose = await ctx.remote.$mount(contribution())
        } catch (error) {
          model.remote.set({ status: 'failed', api: null, error: messageOf(error) })
          return () => {}
        }
        const api = safeGet(ctx, `remote.${NS}`)
        model.remote.set(api && (typeof api === 'object' || typeof api === 'function')
          ? { status: 'ready', api, error: null }
          : { status: 'missing', api: null, error: null })
        return () => {
          model.remote.set({ status: 'pending', api: null, error: null })
          try {
            if (typeof dispose === 'function') dispose()
          } catch (error) {
            report(error)
          }
        }
      }, 'sessions: mount remote'))

      function SessionsPage(props) {
        const own = isObject(props) ? props : {}
        return h(Page, {
          model,
          t: typeof own.t === 'function' ? own.t : t,
          usePanelInfo: typeof own.usePanelInfo === 'function' ? own.usePanelInfo : null,
        })
      }

      // 1. The page. It registers before the row: selecting an unregistered key throws.
      guard(() => ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID, ...withLocale },
        SessionsPage,
      )))

      // 2. The sidebar row that opens it, after Plugins (0) and Automation tasks (10).
      guard(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => label('panel'), ...withLocale },
        SessionsPanelIcon,
      )))
    }

    return { inject: ['slots', 'remote'], apply }
  },
})
