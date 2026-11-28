
## Apply architecture

The dwindle path in apply.js is a **single-shot batch**: pins are
bounded by a persistent pin-memory (`/tmp/focus-now-pins.json`, keyed by
hyprctl-path + workspace + member spec). Invariants:

- A resize target attempted twice is accepted wherever it landed — never
  re-attempted. Ordinary residue is accepted after the first attempt.
- The pin spec is position-ordered along the comb axis, so a movewindow
  reshuffle earns every member a fresh attempt budget.
- Pins emit shallow→deep along the comb axis (lean direction detected by a
  probe pin, cached per spec); each pin reserves deeper leaves' shares
  plus ~12px gap pads so the comb tail cannot starve.
- Focused window is free-filled when it is the deepest leaf (siblings
  pinned to collapseSize leave it the remainder); elsewhere it gets a
  feasible-bounded pin capped by `span − Σ sibling floors`.
- Corrective sweep is shrink-only; nothing ever grows back (no rebounds).
- Damage (≤0 or under floor) escalation ladder per window set, 15s
  cooldowns: flatten ≤2 → mode-cycle rebuild ≤1 → bandNormalize ≤1,
  then only invisible absolute rescues (uncapped — a hidden window must
  always be recovered).

## The arithmetic wall and the band fallback

Dwindle clamps make `collapseSize` undeliverable on the column axis at
high window counts: `Σ(siblings)×(collapseSize+~12px pads) + focused`
exceeds the span, so ~1–2 leaves always squeeze ≤0 — every restructure
relocates the wedge rather than eliminating it, and root orientation is
fixed so movetoroot/togglesplit chains re-columize whatever they move.

`bandNormalize` is the terminal rung: it switches the workspace to the
flat **lua:rows** layout (every leaf a full-width band, collapse on the
height axis, exact-rect `geom` layoutmsg — no clamps). It calls the
service's own `workspaceMode` IPC via `hl.exec_cmd` (stays on the
hyprctl-eval channel so tests' hyprctl mock intercepts it), which writes
`columns.<ws>.mode="rows"` in `~/.config/omarchy/focus-now.json` — without
that write the service's reconcile loop re-asserts the dwindle preset and
reverts the rule. Fallback: `hl.workspace_rule` + the same config write.

Non-comb (mixed band/column) trees get shrink-only sibling pins with no
focused pixel pin; wedge recovery uses a bounded movetoroot (rescN ≤3
damaged applies per spec, per-leaf 30s cooldown).

## lua:tree — the dwindle emulator

`mode="mix"` no longer targets real dwindle: `workspaceDesiredLayout` maps
mix to **lua:tree**, a lua-registered binary-split layout in columns.lua
that emulates dwindle semantics (split-focused insert by aspect,
togglesplit flips the parent split, directional move swaps leaf position,
resize adjusts the nearest ancestor ratio, movetoroot promotes) while
rendering by ratio subdivision — leaves can never clamp or go negative,
so the entire wedge/ladder/budget machinery is bypassed on managed
workspaces.

The apply contract is the **`sizes`** verb (`sizes a:w,h ...`): apply.js
runs the same `Model.layoutTargets` planner as dwindle (which emits
per-window sizes, not positions) and the layout solves node ratios in
closed form — h-nodes demand Σkid widths / max heights, v-nodes vice
versa, ratio = kid0's share of the pair. Unlisted windows keep their
rendered size; oversubscribed demands scale uniformly. Solved ratios
persist into the tree (serialized as `t` lines in the state file), so
the arrangement survives `hyprctl reload`.

Deployment caveat: the service copies `columns.lua` from the plugin dir
to `~/.config/hypr/focus-now-columns.lua` on start — edits to the
generated file are overwritten. Edit `columns.lua` in the repo and copy
to BOTH the plugin dir and `~/.config/hypr/`.

## base/mode config invariant

`columns.<ws>.base` wins over `mode` in the desired-layout computation —
a non-dwindle base (scrolling/floating) makes any stored columns/rows
mode unreachable. The panel enforces the pairing (mode chips dimmed
unless base=dwindle), but IPC writers must too: `setWorkspaceLayout`
resets `base=dwindle` when setting a lua mode, and `setWorkspaceBase`
resets `mode=mix` when setting a non-dwindle base. A stale base left
behind by a mode-set once stranded `bandNormalize` on scrolling instead
of lua:rows.

Tests: `node --test tests/` (79). Fixture models dwindle's ratio clamps
(combRatios/absResizeComb) — absolute resizes deliver box sizes minus
gap pads, so residue under target is expected. Test apply processes share
`/tmp/focus-now-trace.log` with the live plugin (fixture addresses like
`a`,`b`,`c` in the trace are test noise).

## Keybind loss on config reload (opts_enabled regex bug — fixed)

`column_opts()` reads focus-now.json with regexes. `opts_enabled` used to
match ANY `"enabled": false` in the file — including per-workspace presets
under `columns.*` — so disabling one workspace preset made the whole
window-management bind block (swap + resize keys) skip at load. The reads
are now scoped to the text before `"columns"`.

Related: `hyprctl reload` recreates the whole lua state (globals, binds,
`hl.on` handlers all wiped) and re-runs modules from the top — binds must
be re-registered at load every time, which is also why the bind block sits
inside `register_management_binds()` (also re-invoked deferred from the
`config.reloaded` handler as a second safety net).

## Hot reload does NOT recompile Panel.qml

The shell logs "Local plugin changed, reloading" on every deploy, but the
bar-widget component keeps serving the version compiled at shell start —
edited Panel.qml never takes effect live no matter how many reloads fire.
Verify UI changes by screenshot after `omarchy restart shell` (a few
seconds of bar downtime). Other gotchas:

- Strings load from `i18n/` (directory in `Commons.Translations`), not the
  root `en.json` — deploy `i18n/en.json` to `i18n/en.json`.
- The panel IPC (`qs -p /usr/share/omarchy/shell ipc call focus-now.panel
  open|close|toggle`) can only summon/hide, not switch tabs. To verify a
  non-default tab, temporarily flip `activeTab`'s default, restart the
  shell, screenshot, revert, restart again.
- Panel screenshots: `grim /tmp/x.png` then `magick /tmp/x.png -crop
  700x1080+1220+0 out.png` (panel sits bottom-right on a 1920x1080 eDP-1).
