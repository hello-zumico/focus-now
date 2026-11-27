# Focus Now

An Omarchy shell plugin for Hyprland that acts when a window receives focus:

- **Hover focus + center** — enables focus-follows-mouse and centers the focused column on scrolling workspaces.
- **Fullscreen** — gives the focused window real fullscreen and restores other fullscreen windows on the workspace.
- **Sticky fullscreen** — an option under Fullscreen that keeps managed-fullscreen windows fullscreen after they lose focus instead of restoring them.
- **Near full** — expands the focused window to configurable width and height multipliers. Neighboring tiled windows share the remainder; when there is no neighbor on an axis, the focused window claims the full dimension.

Settings live in `~/.config/omarchy/focus-now.json` and hot-reload:

```json
{
  "enabled": true,
  "hoverFocus": true,
  "expandMode": "near",
  "widthMultiplier": 0.85,
  "heightMultiplier": 0.85,
  "collapseSize": 57,
  "hoverDelay": 120,
  "fullscreenDelay": 5000,
  "includeFloating": false,
  "stickyFullscreen": false,
  "mouseRefocus": false,
  "animate": true,
  "animateSpeed": 0
}
```

Allowed multipliers: `0.25`, `0.33`, `0.40`, `0.50`, `0.60`, `0.67`, `0.75`, `0.80`, `0.85`, `0.90`, `0.95` — settings snap to the nearest preset. `collapseSize` sets the smallest width or height in pixels (`32`–`300`, default `57`) a neighboring window shrinks to when making room; use `fullscreen` for edge-to-edge.

`expandMode` is one of `off`, `fullscreen`, or `near`; fullscreen and near-full are mutually exclusive. `hoverDelay` is the dwell time in milliseconds before a focused window expands (0–2000, default 120). `fullscreenDelay` is the pause in milliseconds after a Focus Now-managed window unfullscreens before hover expansion resumes (1000–60000, default 5000) — it prevents the focus jump onto the shrunken window's neighbor from instantly re-expanding. `stickyFullscreen` only applies while `expandMode` is `fullscreen`: off (default), each newly focused window replaces the previous managed fullscreen; on, every window Focus Now fullscreens stays fullscreen after losing focus until the plugin is disabled or expansion is turned off. `mouseRefocus` only applies while `hoverFocus` is on: off (default), hover focus works with `follow_mouse` alone; on, Hyprland also warps the pointer to the center of windows focused without mouse input — note this also fires on app menus and dialogs, which can look like a cursor jump. `animate` (default `true`) controls whether expansion and collapse transitions interpolate; off, every Focus Now geometry change snaps instantly. Only the plugin's own geometry changes are affected — your other Hyprland animations are untouched. `animateSpeed` is the transition duration in milliseconds (`0`–`3000`, default `0` = keep Hyprland's own animation speed); when set it drives the compositor's `windowsMove` leaf, so only window move/resize transitions take that duration — fades, workspace switches, and open/close animations keep your settings. Setting it back to `0` re-applies your configured `windowsMove` (or `windows`) animation definition, so nothing stays overridden.

`columns` opts workspaces into a flat columns-of-stacks layout (the `lua:columns` provider) keyed by workspace name — including special workspaces like `special:scratchpad`. Each entry takes `enabled`, `open` (`"horizontal"` opens new windows as a new slot, `"vertical"` stacks them into the focused slot), and `mode` (`"columns"` for columns of vertical stacks, `"rows"` for rows of horizontal stacks — or mix them on different workspaces). On this layout collapsed windows reach `collapseSize` exactly on either axis and can never reorder, and the structure survives `hyprctl reload`.

The provider installs itself: the service copies `columns.lua` to `~/.config/hypr/focus-now-columns.lua` and adds a marked `pcall(require, "hypr.focus-now-columns")` block to `hyprland.lua` on first start — Hyprland's lua state resets on every config load, so nothing installed via `hyprctl eval` could survive a reload. Workspaces toggled in the panel get `hl.workspace_rule({ workspace = name, layout = "lua:columns" | "lua:rows" })` applied live.

Key handling is translated inside the provider, so the stock Omarchy bindings keep working on flat workspaces with no user-side changes: `SUPER + J` toggles a window between its own slot and a neighboring stack (`togglesplit` reaches `layout_msg` and is aliased to `togglestack`), `SUPER + SHIFT + arrows` reorder slots and stack members via the `move` verb (the swap dispatcher never reaches lua layouts, so these keys are rebound and fall back to `window.swap` on other layouts), and the `SUPER + code:20/21` resize families (±100/±25/±300 on x and y) emit the `resize` verb. Known gaps on flat workspaces: `SUPER + mouse` drag/resize has no flat equivalent, `SUPER + P` pseudo is dwindle-only, and `SUPER + L` cycles a workspace onto a stock layout until the next reload.

## Install

```bash
omarchy plugin add https://github.com/hello-zumico/focus-now.git --enable
```

Remove it with:

```bash
omarchy plugin remove zumico.focus-now
```

## Install for development

```bash
rsync -a --delete --exclude .git /path/to/focus-now/ ~/.config/omarchy/plugins/zumico.focus-now/
omarchy-shell shell rescanPlugins
omarchy plugin enable zumico.focus-now --section right
```

Right-click the bar icon to toggle the plugin. Click it for the switches and width/height selectors.

## Commands

```bash
omarchy-shell focus-now status
omarchy-shell focus-now toggle
omarchy-shell focus-now hoverToggle
omarchy-shell focus-now fullscreen
omarchy-shell focus-now stickyOn
omarchy-shell focus-now stickyOff
omarchy-shell focus-now stickyToggle
omarchy-shell focus-now near
omarchy-shell focus-now noExpand
omarchy-shell focus-now width 0.9
omarchy-shell focus-now height 0.8
omarchy-shell focus-now widthUp
omarchy-shell focus-now widthDown
omarchy-shell focus-now heightUp
omarchy-shell focus-now heightDown
omarchy-shell focus-now collapseSize 80
omarchy-shell focus-now collapseSizeUp
omarchy-shell focus-now collapseSizeDown
omarchy-shell focus-now columns 2
omarchy-shell focus-now columnsOff 2
omarchy-shell focus-now columnsToggle special:scratchpad
omarchy-shell focus-now openVertical 2
omarchy-shell focus-now openHorizontal 2
omarchy-shell focus-now workspaces
omarchy-shell focus-now refresh
```

## Safety notes

- While `hoverFocus` is enabled, the plugin records Hyprland's previous `input.follow_mouse` and `input.mouse_refocus` values, enables pointer focus (`follow_mouse=1`, and `mouse_refocus` matching the `mouseRefocus` option — off by default, since refocus warps the pointer to the window center on every non-mouse focus, which hits menu popups), and restores the recorded values when the option or plugin is disabled/unloaded.
- Near-full mode supports the scrolling layout through `colresize`; on other layouts it uses Hyprland's relative window resize dispatcher iteratively.
- Floating windows are ignored unless `includeFloating` is set. On Omarchy floating workspaces, that setting also controls whether Focus Now keeps hover focus active; with it off, Omarchy's click-to-focus behavior is preserved.
- Fullscreen/maximized state created by the user is preserved; Focus Now only clears the exact compositor state it applied itself. With `stickyFullscreen` on, managed fullscreen windows persist after losing focus — disabling the plugin or switching expansion off sweeps all of them.
- The installed `focus-now-columns.lua` also carries a minimize watchdog: any window that lands on `special:minimized` without the `omarchy-minimized-from-N` tag (which `omarchy-hyprland-window-minimize` writes on every legitimate minimize) is bounced back to the workspace it came from. Self-minimize requests and stray dispatches can no longer disappear windows.
- The plugin runs unsandboxed inside `omarchy-shell`, like every Omarchy shell plugin.

## Develop

```bash
npm test
omarchy plugin validate .
```
