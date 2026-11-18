# Sessions manager: page placement contract

Spike record for the client half of `dsh-plugin-sessions`. It answers one question for the client build tasks: where the **Sessions** page lives in the Web GUI, how it registers, what it may inject, which tokens and row patterns it copies, how it localizes, how it shows dialogs, and which host behavior constrains the design. [design.md](design.md) stays the design authority; this file only fixes the placement.

Path prefixes used below:

- `APP/` = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/` (the installed app, `0.2.2-rc.3`). Read with a file-read tool only: the packages are inside `app.asar`, so shell `cat`/`ls`/`rg` fail there.
- `UP/` = `/Users/macbook/projects/deepseek-harness/` (upstream clone, `0.2.2-rc.4`). It is used only where the installed app does not ship the file.
- `INSPECT/` = `/tmp/sessions-plugin-inspect/` (live inspect output that was saved from the running host).

## Summary

| Item | Result |
|---|---|
| Placement | A **global main panel**: one `main` keyed entry (the page) plus one `sidebar.panellist` entry (the sidebar row that opens it), with the same id. This is the pattern that the Plugins page and Automation tasks use. |
| Rejected | `settings.section` (Settings dialog page). Its content column is at most 564 px wide, and the dialog closes on Escape or a mask click. |
| Usable width | The center column is the frame width minus the left sidebar (280 px by default, 56 px rail, 0 when hidden). The right sidebar has no track while the page shows. The page content column is `min(960px, center − 2 × clamp(24px, 4vw, 48px))`. That is 904 px at a 1280 px window and 960 px at 1440 px. |
| Ids | Panel id and `main` key `sessions-manager`. Locale namespace `sessionsManager` (D1). |
| Client inject | `['slots', 'remote']`. Read `locale`, `layout`, `remote.sessionsManager` and `remoteAccess` lazily with `ctx.get`. |
| `dsh.client.inject` | `@deepseek-ai/dsh-client-ui-layout`, `@deepseek-ai/dsh-client-ui-sidebar`, `@deepseek-ai/dsh-api-gateway` |
| Dialogs | The host has no dialog service, and its Modal primitive is reachable only by requiring a client package, which is not allowed. The plugin builds its own in-page dialog layer. |

## Evidence

### Inspect providers (cordis_inspect_list, live)

| Platform | Provider id | Method |
|---|---|---|
| host | `Service` | `listService` |
| host | `Event` | `listEvents` |
| host | `Config` | `listConfigs` |
| host | `Tool` | `listTools` |
| client | `Service` | `listService` |
| client | `Event` | `listEvents` |
| client | `Builtin` | `listBuiltins` |
| client | `Slots` | `listSubTree` (optional input `{ root }`) |
| client | `Theme` | `listTokens` |

The client providers answer only while a Harness page is connected. During this spike, `Slots.listSubTree` and `Theme.listTokens` timed out, and then reported "no connected Harness page". The slot entries below therefore come from `INSPECT/client-slots-listSubTree.txt`, a `Slots.listSubTree` run with no input on the same host. The token names come from host source; see [Tokens](#tokens). When a page is connected, re-run both queries with no input and compare.

### Slots.listSubTree entries

Each entry is quoted from the saved output, compacted to one line. In each entry, `purpose`, `registration` and `keyDomain` come from the client runner's build-time slot catalog (`UP/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`). The tree position comes from live declarations. For example, `main`'s "already taken: conversation" is a static source scan. It is not a live occupant list.

| Slot | Position in the live tree | Entry (INSPECT line) |
|---|---|---|
| `sidebar.panellist` | child of the factory `sidebar.panel.icon` | `{"type":"slot","name":"sidebar.panellist","kind":"list","scope":"root","purpose":"Global panel icons.","replaceRisk":"none","registration":[{"name":"id","type":"string","required":true},{"name":"order","type":"number","required":false},{"name":"label","type":"string \| (() => string)","required":false}],"children":[]}` (1407-1432) |
| `sidebar.panel.icon` | a root-scope factory, not a slot | `{"type":"factory","name":"sidebar.panel.icon","scope":"root","children":[<sidebar.panellist>]}` (1402-1434) |
| `sidebar.panellist.actions` | child of `sidebar` | `{"type":"slot","name":"sidebar.panellist.actions","kind":"list","scope":"root","purpose":"Rows of the panel list's More menu; the sidebar shows More only while this list has registrations.","replaceRisk":"none","registration":[id*, order, label]}` (612-637) |
| `settings.section` | `sidebar` → `sidebar.settings` | `{"type":"slot","name":"settings.section","kind":"list","scope":"root","purpose":"One settings page per list entry.","replaceRisk":"none","registration":[id*, order, label]}` (196-220) |
| `settings.section.icon` | `sidebar` → `sidebar.settings` | `{"type":"slot","name":"settings.section.icon","kind":"list","scope":"root","purpose":"Optional navigation icons addressed by the matching settings.section id.","replaceRisk":"none","registration":[id*, order, label]}` (426-451) |
| `sidebar.footer.action` | child of `sidebar` | `{"type":"slot","name":"sidebar.footer.action","kind":"list","scope":"root","purpose":"Optional actions beside Settings at the sidebar foot.","replaceRisk":"none","registration":[id*, order, label]}` (454-479) |
| `settings.plugins.tab` | child of `settings.section` | `{"type":"slot","name":"settings.plugins.tab","kind":"list","scope":"root","purpose":"One page inside the Plugins settings section.","replaceRisk":"none","registration":[id*, order, label]}` (264-288) |
| `main` (the page seat) | child of `root` | `{"type":"slot","name":"main","kind":"keyed","scope":"root","purpose":"Central panel selected by sidebar entry id.","replaceRisk":"shadows-shipped-ui","registration":[{"name":"key","type":"string","required":true}],"keyDomain":"open: any string the owner dispatches (no compile-time key set), already taken: conversation"}` (666-681) |

In the table, `id*, order, label` stands for the same three fields as in the `sidebar.panellist` row: `id` string (required), `order` number (optional), `label` `string | (() => string)` (optional). `main`'s `replaceRisk: shadows-shipped-ui` applies only to the reserved key `conversation`. A new key adds a panel beside it.

### Owning packages (installed app README and source)

| Claim | Quote | path:line |
|---|---|---|
| Panel row and page are one id | "Plugins add an icon component to the root-scoped `sidebar.panellist` list with an `id`, optional `order`, and a string or locale-aware `label`. The same id addresses the component registered in the layout's root-scoped `main` keyed slot; selecting a missing main entry throws without changing the current selection. The label supplies plain visible text, the accessible name, and the collapsed tooltip." | `APP/dsh-client-ui-sidebar/README.md:42` |
| Row geometry | "Expanded navigation rows are 32px high with a 2px gap; collapsed rail controls remain 36px high with a 12px gap." | `APP/dsh-client-ui-sidebar/README.md:42` |
| More menu and unpin | "While the root-scoped `sidebar.panellist.actions` list has registrations, a **More** button … Plugins always shows. … Unpinning hides only the row … The main panel, its registration, and the current selection stay unchanged." | `APP/dsh-client-ui-sidebar/README.md:44` |
| The icon factory | "The sidebar declares the `sidebar.panel.icon` Component Factory, which owns the `sidebar.panellist` list; panel rows and the More menu render a panel's registered icon through that factory. Panel metadata is derived from list registrations and locale changes; selection belongs to the layout store." | `APP/dsh-client-ui-sidebar/README.md:83` |
| Global panels | "Global panels occupy the root-scoped `main` keyed slot; `conversation` is the reserved key for the Conversation. `ctx.layout.selectPanel(id)` selects a registered panel, and `null` selects the Conversation without changing the current Session. The Plugins page contributes one of the shipped global panels." | `APP/dsh-client-ui-layout/README.md:36` |
| Column widths | "The sidebar spans 264–420px, defaults to 280px, and retains a 56px rail when collapsed at widths of 768px and above. Below 768px … it uses a modal drawer … Below 1024px it collapses automatically" | `APP/dsh-client-ui-layout/README.md:30` |
| Right column is released | "The right column's root controller renders `rightbar.session` through `SessionProvider` only while the Conversation is selected; its unmount report releases the track." | `APP/dsh-client-ui-layout/README.md:65` |
| Entry pages pad the top | "entry pages in the main panel (plugin manager and similar, not the conversation) pad their top by it" (`--dsh-frame-top-clearance`, 48px on macOS) | `APP/dsh-client-ui-layout/README.md:43` |
| Layout state is transient | "Layout state resets on reload." | `APP/dsh-client-ui-layout/README.md:12` |
| Settings pages | "feature pages register `settings.section` contributions; the Plugins section hosts `settings.plugins.tab` pages" | `APP/dsh-client-ui-settings/README.md:45` |
| Settings icon | "use `ctx.slots.inject('settings.section.icon', ...)` and register an icon component with the same `id` as its `settings.section` contribution. … the icon's `label` option is not displayed. The component receives `size` in pixels and `active`" | `APP/dsh-client-ui-settings/README.md:47` |
| Settings size | "The Settings panel uses a shared 800 × 800 layout, bounded by the viewport. Longer sections scroll inside the content column" | `APP/dsh-client-ui-settings-general/README.md:25` |
| Settings closes | "`Escape` closes the top dialog … closing the dialog clears the section selection." | `APP/dsh-client-ui-settings-general/README.md:44` |
| Settings nav labels | "nav labels may be locale-following thunks, resolved through `resolveSlotLabel` and re-rendered on the section ledger bump or the locale revision (an optional `ctx.get('locale')` read; no hard locale dependency)" | `APP/dsh-client-ui-settings-general/README.md:80` |

Source lines that the decision relies on:

- `APP/dsh-client-ui-layout/src/client/AppFrame.tsx:46-51`: `MainPanel` renders exactly one entry, `renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })`. The owner props are `{}`.
- `APP/dsh-client-ui-layout/src/client/AppFrame.tsx:296`: the grid is `${cols.sidebar}px minmax(…, 1fr) minmax(0px, ${rightbarMax}px)`. The center column takes all space not used by the sidebar and right tracks.
- `APP/dsh-client-ui-layout/src/client/columns.ts:11-31`: `CENTER_MIN 400`, `SIDEBAR_MIN 264`, `SIDEBAR_MAX 420`, `SIDEBAR_DEFAULT 280`, `SIDEBAR_COLLAPSED 56`, `SIDEBAR_DRAWER_BREAKPOINT 768`, `SIDEBAR_AUTO_COLLAPSE 1024`.
- `APP/dsh-client-ui-layout/src/client/index.ts:72-75`: "Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; other keys receive no Session binding." `'main': { kind: 'keyed'; scope: 'root' }`.
- `APP/dsh-client-ui-layout/src/client/service.ts:72-78`: `selectPanel` throws when the key is not registered.
- `APP/dsh-client-ui-layout/src/client/stores.ts:81,94-102`: selection starts at `null` (the Conversation). `retainMainPanels` resets it to `null` when the selected key unregisters.
- `APP/dsh-client-ui-sidebar/src/client/contract/slots.ts:44-47,102-108`: "Global panel icons. Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata." The owner props are `{ size: number; active: boolean }`.
- `APP/dsh-client-ui-sidebar/src/client/SidebarRoot.tsx:76-92`: the row reads `active` through `usePanelInfo`, sets `aria-label={label}` and `aria-current="page"`, calls `selectPanel(id)` on click, and renders the icon at `size: wide ? 16 : 18` inside an `aria-hidden` span.
- `APP/dsh-client-ui-sidebar/src/client/index.ts:58-71`: labels are `resolveSlotLabel(options.label) ?? id`, sorted by `order ?? 0`, and recomputed on `ctx.locale.subscribe`.
- Precedents in the installed app: `APP/dsh-client-ui-plugin-manager/src/client/index.ts:83,129-149,167-173` (Plugins: `main` key `plugins`, row `order: 0`) and `APP/dsh-client-ui-schedule/src/client/index.ts:218-246` (Automation tasks: `main` key `schedules`, row `order: 10`).
- `APP/dsh-client-ui-settings-general/src/client/SettingsRoot.module.css:99,104,106,249`: `grid-template-columns: 188px minmax(0, 1fr)`, `width: 800px`, `max-width: calc(100vw - 48px)`, and the options area `padding: 0 24px 24px`.

## Decision

**Rule:** use `sidebar.panellist` only if the evidence shows that its panel renders a full-width content area (usable width of at least 720 px, not a narrow side column) that stays mounted while the user works in it. Otherwise use `settings.section`. Fallback D15 applies only if no slot reaches 720 px.

**Result: `sidebar.panellist` + `main`.** Each part of the rule holds:

1. **It is the full-width center column, not a side column.** The `sidebar.panellist` row selects the `main` entry with the same id (sidebar README:42, layout README:36). `main` is the frame's center column (`AppFrame.tsx:320`, `<CenterColumn>{main}</CenterColumn>`). While a global panel shows, the right column takes no track (layout README:65), so the center column is the frame width minus the left sidebar track.
2. **Usable width.** The Plugin Manager pattern copied here ([Row pattern](#row-pattern)) gives a content column of `min(960px, center − 2 × clamp(24px, 4vw, 48px))`, or `center − 40px` below 768 px.

   | Window width | Left track | Center | Content column |
   |---|---|---|---|
   | 1440 | 280 (expanded) | 1160 | **960** |
   | 1280 | 280 | 1000 | **904** |
   | 1088 | 280 | 808 | **720** (threshold with the default sidebar) |
   | 1024 | 280 | 744 | 662 |
   | 1000 | 56 (auto rail, Web/Linux) or 0 (macOS) | 944 / 1000 | **864 / 920** |
   | 844 | 56 | 788 | **720** (threshold with the rail) |
   | 783 | 0 (macOS hidden, Windows caption) | 783 | **720** |
   | < 768 | drawer, 0 | full width | width − 40 (single column) |

   The content is at least 720 px at common desktop sizes: from 1088 px with the expanded sidebar (more if the user drags it wider, up to 420 px), and from about 844 px with the rail. Between 1024 and 1087 px with the sidebar expanded, the content is 662–719 px. Toggling the sidebar (Mod+B on Desktop, Mod+Alt+B on Web) gives the full width. The page layout must wrap to one column below 720 px; the cards already wrap per design.md.
3. **It stays mounted while the user works in it.** The selection lives in the root layout store (`stores.ts:94-97`). It changes only by an explicit navigation: another panel row, a Session row or New Session (`selectPanel(null)` in `APP/dsh-client-ui-workspace/src/client/navigation.ts:520,552`), archiving the Session that is open behind the page (`navigation.ts:507-521`), a reload (`stores.ts:81`), or unregistering the panel (`stores.ts:98-102`). Initial Session restoration after a load uses `'preserve'` and does not switch panels (`UP/packages/client/ui-workspace/src/client/navigation.ts:477,484,502`). Opening Settings puts a dialog above the page; the page stays mounted beneath it.

**Rejected: `settings.section`.** Its usable content width is at most **564 px** at every window size: an 800 px panel minus the 188 px navigation track minus 2 × 24 px padding (`SettingsRoot.module.css:99,104,249`). The panel also shrinks with `max-width: calc(100vw - 48px)` (`:106`). This is below 720 px, so the rule rejects it. It also fails the mount condition: Settings is a modal over the whole app, and Escape, a mask click or Close dismiss it and clear the section selection (settings-general README:44). A stray Escape during the typed prune confirmation would close the whole page.

Other seats considered and rejected:

- `settings.plugins.tab`: one tab inside the Plugins settings section, so it is narrower than `settings.section` and is still inside the dialog.
- `sidebar.footer.action`: an action button beside Settings. It receives only `{ wide }` (`contract/slots.ts:197-201`) and has no content area.
- `sidebar.panellist.actions`: rows of the More menu (`contract/slots.ts:48-49,132-149`). It has no content area, and this plugin does not register there.
- Right sidebar tab (`sidebar.right.pane.tab`): scope `session`, 300 px minimum, 45 % default (layout README:30). It also closes whenever a global panel shows.

## Registration

The client half is one plain script registered through `window.__ModuleLoader__.load`, as in `packages/router/src/client.js` and `packages/usage/src/client.js`. Copy-ready skeleton; the page body itself is T11's work:

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-sessions',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'sessionsManager'          // locale namespace (D1)
    const PANEL_ID = 'sessions-manager'   // sidebar.panellist id === main key
    const en = { panel: 'Sessions' /* , … */ }
    const zh = { panel: '会话管理' /* , … same keys */ }

    function SessionsPanelIcon({ size, active }) {
      // Glyph only. The sidebar owns the button, label, tooltip, aria-current and the
      // selected fill. `active` is true while this panel is shown.
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': 'true' } /* , paths */)
    }

    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale) ctx.effect(() => locale.register(NS, { en, zh }), 'sessions: dictionaries')
      const t = locale ? locale.bind(NS) : (key) => en[key] ?? key
      // `locale: NS` makes the renderer pass a live `t` prop; without a locale face it would throw.
      const withLocale = locale ? { locale: NS } : {}

      // 1. The page. Register it before the row: selecting an unregistered key throws.
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID, ...withLocale },
        function SessionsPage(props) {
          // props: owner share {} · framework standard props (usePanelInfo, …) · props.t
          // when withLocale is set · no sessionId (root scope, no Session binding).
          return h(Page, { ctx, t: props.t ?? t, usePanelInfo: props.usePanelInfo })
        },
      ))

      // 2. The sidebar row that opens it. It is ordered after Plugins (0) and Automation tasks (10).
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), ...withLocale },
        SessionsPanelIcon,
      ))
    }

    return { inject: ['slots', 'remote'], apply }
  },
})
```

Fields and where they come from:

| Registration | Field | Value | Evidence |
|---|---|---|---|
| `main` | `name` | `'main'` | slot entry (INSPECT 668) |
| | `key` | `'sessions-manager'`, required, unique, never `conversation` | `registration: key*` (INSPECT 673-679); `plugin-manager/src/client/index.ts:132-135` |
| | `locale` | `'sessionsManager'` (gives `props.t`) | `plugin-manager index.ts:135`, `ui-schedule index.ts:221`; renderer `UP/packages/client/ui-renderer/src/client/scoped-slots.tsx:604-613` |
| | component props | owner `{}` (`AppFrame.tsx:49`), root standard props including `usePanelInfo` (`ui-layout index.ts:49-52`), `t` if `locale` is set, no `sessionId` (`ui-layout index.ts:72-75`) | |
| `sidebar.panellist` | `name` | `'sidebar.panellist'` | INSPECT 1409 |
| | `id` | `'sessions-manager'` (must equal the `main` key) | `registration: id*` (INSPECT 1415-1418); sidebar README:42 |
| | `order` | `20` (ascending; ties keep registration order) | INSPECT 1420-1423; `contract/slots.ts:114-115`; Plugins 0 (`plugin-manager index.ts:170`), tasks 10 (`ui-schedule index.ts:243`) |
| | `label` | `() => t('panel')`: visible text, accessible name and collapsed tooltip | `string \| (() => string)` (INSPECT 1426-1428); sidebar README:42; `ui-sidebar index.ts:61,71` |
| | icon | **the registered component itself** is the icon. It receives `{ size, active }`: `size` is 16 expanded and 18 in the rail | `contract/slots.ts:102-108`; `SidebarRoot.tsx:92`; `PanelIcon.tsx:10-11` |

**How the icon slot is registered:** the plugin does **not** register into `sidebar.panel.icon`. That name is a factory that ui-sidebar defines (`ui-sidebar index.ts:89-92`). The factory renders the plugin's `sidebar.panellist` component for one id (`renderSlot('sidebar.panellist', { size, active }, { only: id })`, `PanelIcon.tsx:11`), in the sidebar row and in the More menu. `settings.section.icon` is not used, because Settings is rejected.

**How the label is localized:** the label is a thunk. The sidebar resolves it with `resolveSlotLabel` and resolves it again on every `ctx.locale.subscribe` notification (`ui-sidebar index.ts:61,71`), so a language switch updates the row with no re-registration. With no locale service, the thunk falls back to the English dictionary.

## Loading

**Client inject array: `['slots', 'remote']`.** Both services are present on every page:

- `slots` is the slot registry service (ui-renderer). Every client plugin in this repo injects it (`packages/router/src/client.js:1195`, `packages/usage/src/client.js:1565`).
- `remote` is `ctx.remote` from `@deepseek-ai/dsh-api-gateway/client` ("`@deepseek-ai/dsh-api-gateway/client` provides `ctx.remote`", `UP/packages/api/gateway/README.md:12`). The gateway's client row is `"immediately": true` (`APP/dsh-api-gateway/package.json:39-47`). The workspace already injects it (`packages/usage/src/client.js:1565`).

Do not add any other service to `inject`. A missing injected service leaves the whole client entry pending and breaks web boot (`packages/router/test/client.test.mjs:137-139`). Read these lazily and tolerate `undefined`:

| Service | Read | Use |
|---|---|---|
| `locale` | `ctx.get('locale')` | dictionaries, `bind`, `locale: NS` on the entries |
| `remote.sessionsManager` | `ctx.get('remote.sessionsManager')` after `await ctx.remote.$mount(contribution)` inside a `ctx.effect` with try/catch | the Host methods. A mount failure must never throw out of `apply` (`packages/usage/src/client.js:1780-1806`). This namespace exists only after the mount, so it must never be injected. |
| `layout` | `ctx.get('layout')` | optional: `panelInfo` or `selectPanel` if a plugin-level store must react to leaving the page. The main component already receives `usePanelInfo`. |
| `remoteAccess` | `ctx.get('remoteAccess')` | optional; see [Doubts](#doubts). |

**`package.json` → `dsh.client.inject`** (these entries only order activation; they do not import code):

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-ui-layout",
      "@deepseek-ai/dsh-client-ui-sidebar",
      "@deepseek-ai/dsh-api-gateway"
    ]
  }
}
```

- `@deepseek-ai/dsh-client-ui-layout` declares `main` (`APP/dsh-client-ui-layout/src/client/index.ts:192-202`).
- `@deepseek-ai/dsh-client-ui-sidebar` declares the `sidebar.panel.icon` factory with its `sidebar.panellist` child (`APP/dsh-client-ui-sidebar/src/client/index.ts:89-92`).
- `@deepseek-ai/dsh-api-gateway` provides `ctx.remote`, as in `packages/usage/package.json:26-30`.
- "`inject` names package rows whose factories must arrive before this row materializes" (`UP/docs/subsystems/client-modules.md:17-19`). Both slot owners are on the web boot required list (frame and sidebar, `UP/packages/client/web/README.md:77`), so these edges never hold the page back on a working host.
- The current scaffold sets `"immediately": true`. That marks stage-one prefetch (`client-modules.md:17`). The page is not needed at boot, and `packages/usage` omits the flag. Removing it is recommended, not required.

## Tokens

The `Theme.listTokens` provider returns the built-in token directory of `APP/dsh-client-ui-theme/src/client/index.ts:153-168`, plus any names that registered themes add (`:237-250`). Tokens marked *listed* below are in that directory. The others are confirmed in the host stylesheets. Use only `--dsw-*` references. For an unlisted token, a fallback to a listed one is allowed (`var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))`).

| Role | Token | Status | Evidence |
|---|---|---|---|
| Page ground | `--dsw-alias-bg-base` | listed: "Application base background." | `theme index.ts:154`; frame `AppFrame.module.css:8` |
| Raised surface (cards, guide box) | `--dsw-alias-bg-layer-1` | listed | `theme index.ts:155`; `PluginManagerPage.module.css:840` |
| Dialog surface | `--dsw-alias-bg-layer-2` | listed | `theme index.ts:156`; Settings panel `SettingsRoot.module.css:109` |
| Stat-card fill and stroke | `--dsw-alias-settings-card-fill` / `--dsw-alias-settings-card-stroke` | source (`= bg-layer-2` / `border-l4`) | `APP/dsh-client-ui-theme/src/styles/base.css:32-33`; `PluginManagerPage.module.css:1875-1877` |
| Subtle border | `--dsw-alias-border-l1` | listed | `theme index.ts:158` |
| Row separator | `--dsw-alias-border-l2` | listed | `theme index.ts:159`; rows `PluginManagerPage.module.css:1610`, facts `:1565` |
| Hairline frame (icon box, header divider) | `--dsw-alias-border-l3` | source | `design-platform.css:198,350`; `PluginManagerPage.module.css:406,159` |
| Input border | `--dsw-alias-border-l4` | source | `design-platform.css:199`; `PluginManagerPage.module.css:777` |
| Primary label | `--dsw-alias-label-primary` | listed: "Primary text color." | `theme index.ts:161`; `PluginManagerPage.module.css:29` |
| Secondary label | `--dsw-alias-label-secondary` | listed | `theme index.ts:162`; `PluginManagerPage.module.css:202` |
| Tertiary label (descriptions, meta) | `--dsw-alias-label-tertiary` | source | `design-platform.css:262,414`; `PluginManagerPage.module.css:500` |
| Success | `--dsw-alias-state-success-primary` | listed | `theme index.ts:165`; tint `color-mix(in srgb, … 10%, transparent)` `PluginManagerPage.module.css:1326` |
| Warning | `--dsw-alias-state-warn-primary` (ink), `--dsw-alias-state-warn-tertiary` (fill) | listed / source | `theme index.ts:166`; `design-platform.css:295,297`; `PluginManagerPage.module.css:858,874,1340-1342` |
| Error / destructive | `--dsw-alias-state-error-primary` | listed | `theme index.ts:163`; `.danger` `PluginManagerPage.module.css:645-649`, `.dangerButton` `:1404-1407` |
| Idle / inactive | `--dsw-alias-state-idle-primary` | listed | `theme index.ts:164` |
| Accent (links, info, focus default) | `--dsw-alias-state-business-primary` | source | `design-platform.css:277`; `focus.css:11` |
| Hover fill | `--dsw-alias-interactive-bg-hover` | source | `design-platform.css:242`; `PluginManagerPage.module.css:462` |
| Press fill | `--dsw-alias-interactive-bg-active` | source | `design-platform.css:238`; `PluginManagerPage.module.css:457` |
| Danger hover | `--dsw-alias-interactive-bg-hover-danger` | source | `design-platform.css:240`; `PluginManagerPage.module.css:680,685` |
| Radius | `--dsw-radius-xs` 4, `-sm` 8, `-md` 12, `-lg` 16, `-xl` 20, `-panel` 28 | source | `APP/dsh-client-ui-theme/src/styles/base.css:18-23`. Rows and cards use `-xl`, buttons and inputs `-md`, small icon buttons `-sm`, dialogs `-panel`. |
| Focus ring | `outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px or 2px` | source | `APP/dsh-client-ui-theme/src/styles/focus.css:2-13`; `PluginManagerPage.module.css:362-365,492-495` |
| Dialog mask and elevation | `--dsw-alias-bg-mask-1` + `backdrop-filter: var(--dsw-mask-blur)`, `box-shadow: var(--dsw-elevation-prominent)` | source | `SettingsRoot.module.css:80-81,110` |

Spot-check candidates for re-running `Theme.listTokens`: `--dsw-alias-label-secondary`, `--dsw-alias-state-warn-primary`, `--dsw-alias-border-l2`.

## Row pattern

The Plugin Manager page is the reference for management lists. Its React primitives (`SegmentedTabs`, `Switch`, `Tag`, `Button`, `Checkbox`, `Modal`) are **not** available to the plugin: `@deepseek-ai/dsh-client-ui-primitives` is not readable in the installed app, and it must not be required. Copy markup and CSS from `UP/packages/client/ui-primitives/src/<Name>.tsx|.module.css`, and rename the classes under a `sm-` prefix. All CSS refs below are `APP/dsh-client-ui-plugin-manager/src/client/PluginManagerPage.module.css`. TSX refs are `…/PluginManagerPage.tsx`.

**Page frame**

```text
section.page                 flex column, align center, height 100%, padding 0 var(--inset)      css 9-30
  --inset: clamp(24px, 4vw, 48px)   (20px under 767px)                                            css 10, 32-36
  > * { width: 100%; max-width: 960px }                                                           css 38-42
  div.pageBody               flex:1, min-height:0, overflow-y:auto, gap 32px, padding 0 inset 48px css 64-80
    header.pageHead [data-window-drag]   flex wrap, space-between, gap 16, padding-top 28px       css 162-172; tsx 1700
      (macOS: padding-top calc(28px + var(--dsh-frame-top-clearance, 0px)))                       css 178-180
      h1.pageTitle 20px/28px 500 · p.pageIntro 13px/20px label-secondary                          css 188-203
      div.toolbar                gap 8px 16px, buttons 32px high, 13px, radius md                css 213-223, 610-618
      div.pageTabs > SegmentedTabs (Overview · Archived · Trash), min-width 240px                 css 1730-1734, 1788-1791; tsx 1732-1746
    section.group            flex column gap 8                                                    css 278-282
      div.groupHead > h3.groupTitle 14px/22px 500                                                 css 284-296; tsx 1668-1677
      ul.cards               flex column gap 2px, list-style none                                 css 367-377
```

**Card row** (one clickable entry with an end control: workspace rows, largest sessions, batches)

```text
li.card.cardLink             margin 0 -8px (hover fill reaches 8px past content), radius xl        css 379-389, 450-452
  :active  background interactive-bg-active                                                       css 456-458
  @media (hover:hover) :hover  background interactive-bg-hover                                    css 460-464
  div.cardHead               flex, align center, gap 14px, padding 8px                            css 391-396
    span.cardIcon            48×48, 0.5px border-l3, radius lg, label-secondary                    css 398-409
    div.cardMain             flex 1, min-width 0, column gap 4                                    css 420-426
      div.titleRow           flex wrap gap 8 (title + tags)                                       css 428-434
        button.cardTitle.cardOpen  14px/20px 500, ellipsis; ::after inset 0 stretches over card   css 436-443, 466-486
          :focus-visible::after  focus ring, offset 2px                                            css 488-495
      span.cardDesc          13px/18px label-tertiary, 1-line clamp                                css 497-505
    div.cardEnd              position relative, z-index 1 (stays clickable above the stretch), gap 8 css 547-554
```

Markup source: `CardHead` tsx 446-470, the package card tsx 567-597.

**Dense rows** (archived roots, plan units, Trash batches when a 48 px icon is too heavy)

```text
ul.rows                      flex column, no gap                                                  css 1600-1606
  li.row [data-state=off|failed]   padding 12px 2px, border-bottom 0.5px border-l2, last none     css 1608-1615
    div.rowLine              flex, align center, gap 16                                           css 1622-1627
      span.rowIcon 40×40 (optional) · div.rowMain (gap 2)                                         css 1629-1647
        span.rowId 13.5px/20px 500 label-primary (off → label-secondary)                          css 1649-1659
        code.rowModule mono 11.5px/16px label-tertiary (short id, path)                           css 1661-1667
      span.rowState 12.5px/18px label-secondary, nowrap (failed → error)                          css 1701-1714
      end control (switch, buttons)
    p.rowFailure 12px/18px error, indented 56px                                                   css 1716-1722
```

Markup source: tsx 312-350. Label/value lists such as the result card use `dl.facts > div` (min-height 44, padding 8px 2px, border-bottom border-l2, `dt` 13px secondary, `dd` end-aligned), css 1554-1591 and tsx 362-388. Stat cards copy `.versionPanel` (0.5px `settings-card-stroke`, radius xl, `settings-card-fill`), css 1872-1878.

**Hover and selected treatment**

- Hover: `--dsw-alias-interactive-bg-hover`, only inside `@media (hover: hover)`, because a tap latches `:hover` (css 4-7, 460-464). Press: `--dsw-alias-interactive-bg-active` (css 456-458).
- Selected (a checked row in Archived): the host's list selection uses the same fill as hover, `--dsw-alias-interactive-bg-hover` (`APP/dsh-client-ui-workspace/src/client/rows/Rows.module.css:24-26`), together with the checked checkbox and `aria-selected`/`aria-checked`. The Plugin Manager has no persistent selected row. The other host selected fill, `--dsw-specific-sidebar-nav-item-active`, belongs to navigation cells (`SettingsRoot.module.css:184-186`) and is not used for data rows.
- Tags such as *live*, *archived*, *child* and *blocked*: 18 px high, `padding: 0 7px`, 10 px text (`.statusTag`, css 332-337). Copy `Tag.module.css` for the tones.

## Locale

Confirmed on this host:

- **Service:** `ctx.get('locale')` returns the `LocaleRuntime` (`APP/dsh-client-locale/README.md:86`). It is immediate-tier infrastructure on every web page (renderer comment, `UP/packages/client/ui-renderer/src/client/scoped-slots.tsx:606-607`). The plugin still reads it lazily, as `packages/router/src/client.js:1180-1182` does.
- **Register:** `ctx.effect(() => locale.register('sessionsManager', { en, zh }), …)`. The object form requires both baseline locales `zh` and `en`; other languages are optional (locale README:40). A dictionary registered after mount is picked up without a remount (README:40).
- **Bind:** `const t = locale.bind('sessionsManager')` returns a stable translate function per namespace (README:96). Missing keys fall back through the language chain, then `common`, then the key itself (README:68,96).
- **Live `t` prop:** setting `locale: 'sessionsManager'` on the `main` registration makes the renderer pass `props.t` bound to the locale seat, so slot-rendered copy updates without a reload (README:12; `scoped-slots.tsx:604-613`). Use `props.t` for all page copy. A closure `t` translates correctly but does not re-render the page on a switch.
- **How the language changes:** the user selects a language in **Settings → General → Language**. It applies immediately and is stored as `locale.preference` in the Host settings (README:12,34). A switch advances the locale revision, emits `locale/change`, and updates the `t` seat (README:86). The sidebar re-resolves the row label on the same notification (`ui-sidebar index.ts:71`). Text captured outside the render path, such as a string built once in `apply`, keeps the old language (README:139). Build user-visible strings at render time.
- Placeholders: keep named placeholders verbatim in both dictionaries (README:40). Host refusal codes and ids stay untranslated; their explanations are dictionary keys.

## Dialogs

- **No host dialog service.** No client package provides a dialog, modal, confirm or toast service (`ctx.provide` and `ctx.reflect.provide` calls under `UP/packages/client` were searched). `contextMenus` exists, but it is a menu service.
- **The host Modal is not reachable.** `Modal` lives in `@deepseek-ai/dsh-client-ui-primitives` (`UP/packages/client/ui-primitives/src/Modal.tsx`, which portals to `document.body`, `:59,95`). Requiring that package is forbidden: "Do not `require('@deepseek-ai/dsh-client-ui-primitives')` … Write your own controls instead … keep behavior users rely on, such as Modal focus and Escape handling" (plugin practices reference in `@deepseek-ai/dsh-agent-preset`, `references/practices.md:35`). The same reference forbids writing DOM outside the component or appending to `document.body` (`:36`).
- **An overlay seat is reachable:** `shell.overlay` is a root list slot, "Frame-wide floating layer, above every column and outside their scroll containers" (INSPECT 16-21; `ui-layout index.ts:98-107`). The layer is click-through, and entries opt back into pointer events (`AppFrame.module.css:363-372`). Automation tasks uses it for a delete toast that outlives its panel (`ui-schedule index.ts:136-149`).

**Default: the plugin builds its own dialog inside the page.** The page root is `position: relative`. The dialog is a `position: absolute; inset: 0` layer inside it, with the mask `--dsw-alias-bg-mask-1`, a centered `bg-layer-2` card with `radius-panel` and `elevation-prominent`, `role="dialog"`, `aria-modal="true"` and `aria-labelledby`. While it is open, the page body behind it is `inert`. It moves initial focus to a `data-autofocus` control and traps Tab. Escape and a mask click close it, except while an apply call is in flight. It restores focus to the control that opened it. It stops Escape propagation so that the host does not also act on the key. Copy the structure from `UP/packages/client/ui-primitives/src/Modal.tsx` and `Modal.module.css`, and copy the confirm patterns from `RiskConfirmation.tsx`. The prune panel (D7) and the permanent-delete confirmation (D9) both use this layer. `shell.overlay` is needed only for a notice that must survive leaving the page, which v1 does not have.

## Constraints

| Constraint | Effect on the design | Evidence |
|---|---|---|
| Not session-scoped. | `main` and `sidebar.panellist` are root scope. The page gets no `sessionId`, and the right sidebar unmounts its Session content while the page shows. The page must not use Session-scoped hooks or slots. | INSPECT 670, 1411; `ui-layout index.ts:72-75`; layout README:65; `UP/packages/client/ui-sidebar-right/README.md:103` (`mounted` is `undefined` "while a global panel replaces it") |
| The page unmounts on navigation. | `MainPanel` renders one entry by key. A Session row, New Session, another panel row, archiving the open Session, a reload, or disabling the plugin unmounts the page and drops all React state. Durable state (plans, batches, results) belongs to the Host. On every mount the page re-reads the Overview, the plan status and the Trash list. A Remote call in flight keeps running on the Host. Tab, filters and scroll may be kept in a plugin-level store if wanted (as the Plugins page does, `plugin-manager index.ts:129-131,150-152`). | `AppFrame.tsx:46-51`; `navigation.ts:507-521,552`; `stores.ts:81,98-102`; layout README:12 |
| The page owns its scrolling. | The center column is `overflow: hidden`, and `.mainPanel` is a flex column with `min-height: 0`. The page root is `height: 100%`, and one inner body scrolls (`overflow-y: auto`). Do not rely on document scroll. Tables inside the body must not add a second vertical scroller. | `AppFrame.module.css:68-83`; `PluginManagerPage.module.css:20-24,64-80` |
| Window chrome. | Mark the header row `data-window-drag` (macOS drag region). Pad its top by `--dsh-frame-top-clearance` on macOS. Below 768 px the frame adds a 48 px top pad to global panels. | layout README:43,47; `AppFrame.module.css:94-103,282-284`; `PluginManagerPage.module.css:178-180` |
| Width varies. | Lay out for a 960 px maximum and degrade to one column below 720 px. Wrap the cards and drop low-value table columns. | [Decision](#decision) width table |
| The row registers with the page. | Register `main` first, in the same `apply`. A click on a row whose `main` entry is missing throws. | `service.ts:72-78`; sidebar README:42 |
| The row can be unpinned. | While a More menu exists (the official entry-customization plugin registers one), the user can hide the Sessions row into More. Pins reset on plugin reload. Nothing changes for the page. | sidebar README:44 |
| Host modal stack. | The in-page dialog is not in the host shortcut modal registry. Mod+B and the Settings shortcut still act while it is open. The Settings dialog can open above it. | `ui-layout index.ts:206-219`; settings-general README:44 |
| Theme switches live. | Use CSS variables only. Never cache computed colors. | `ui-layout` README:51 |
| A component crash blanks the entry. | A throwing render shows nothing (console: `slot entry crashed in 'main'`). Guard Remote results before render. | `references/practices.md:35` |
| No analytics. | Unofficial panel rows report no click events. | sidebar README:71 |

**GUI steps that open the page** (for the manual checklist):

1. Open the Harness GUI (Desktop app, or the Web GUI URL) with the `dsh-plugin-sessions` bundle enabled under **Plugins**.
2. In the left sidebar, find the global panel rows under **New Session**: **Plugins**, **Automation tasks**, **Sessions**. Click **Sessions**. The center column shows the page, and the row shows as selected (`aria-current="page"`).
3. Collapsed rail (Web or Linux, a window under 1024 px, or a collapsed sidebar): click the Sessions icon. Its tooltip is the localized label.
4. macOS Desktop with the sidebar collapsed: the column is hidden. Open it with the control beside the traffic lights, or press Mod+B. Then click **Sessions**.
5. Browser window under 768 px: open the drawer with the header's sidebar opener, then tap **Sessions**. The drawer closes on navigation.
6. If the row is unpinned: click **More** in the panel list, then **Sessions**.
7. To leave: click any Session, **New Session**, or another panel row. To return: click **Sessions** again. The page mounts fresh and reads the Host again.
8. After a page reload, the GUI shows the Conversation. Repeat step 2.

## Doubts

- **The live client queries were not re-run.** No Harness page was connected during this spike: `Slots.listSubTree` and `Theme.listTokens` timed out. The slot entries come from the saved run in `INSPECT/`, and the tokens from host source. Re-run both with a page open. The `{ root }` input that would list occupants (for example, which panel orders are taken) was rejected as "input must be an object", because the tool passed it as a string.
- **The width figures are computed, not measured.** They come from the frame constants and the Plugin Manager CSS. They assume `4vw ≈` frame width (true when the frame fills the window) and the default 280 px sidebar. Measure once in the GUI at 1280 px.
- **`remoteAccess` gating is open.** The Plugins page registers its panel only `whenAccess('pluginManager/listBundles')` (`plugin-manager index.ts:106`). For a plugin Remote, the access action string is not confirmed here. v1 registers unconditionally. The Host refuses non-owner callers (design.md, *User-only*), and the page shows the refusal. T11 can add the gate once the action name is known.
- **The Chinese label `会话管理` is a proposal.** design.md fixes only the English title *Sessions*. A row named only "Sessions" sits next to the sidebar's own session list, so a longer zh label is clearer.
- **The `immediately` flag in the scaffold** is harmless but unneeded; see [Loading](#loading). The flag is set in `package.json`, which belongs to another task.
