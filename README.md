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
  "hoverDelay": 120,
  "fullscreenDelay": 5000,
  "includeFloating": false,
  "stickyFullscreen": false,
  "mouseRefocus": false
}
```

Allowed multipliers: `0.25`, `0.33`, `0.40`, `0.50`, `0.60`, `0.67`, `0.75`, `0.80`, `0.85`, `0.90`, `0.95` — settings snap to the nearest preset. The 95% cap keeps a usable sliver of each neighbor visible so they stay selectable; use `fullscreen` for edge-to-edge.

`expandMode` is one of `off`, `fullscreen`, or `near`; fullscreen and near-full are mutually exclusive. `hoverDelay` is the dwell time in milliseconds before a focused window expands (0–2000, default 120). `fullscreenDelay` is the pause in milliseconds after a Focus Now-managed window unfullscreens before hover expansion resumes (1000–60000, default 5000) — it prevents the focus jump onto the shrunken window's neighbor from instantly re-expanding. `stickyFullscreen` only applies while `expandMode` is `fullscreen`: off (default), each newly focused window replaces the previous managed fullscreen; on, every window Focus Now fullscreens stays fullscreen after losing focus until the plugin is disabled or expansion is turned off. `mouseRefocus` only applies while `hoverFocus` is on: off (default), hover focus works with `follow_mouse` alone; on, Hyprland also warps the pointer to the center of windows focused without mouse input — note this also fires on app menus and dialogs, which can look like a cursor jump.

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
omarchy-shell focus-now refresh
```

## Safety notes

- While `hoverFocus` is enabled, the plugin records Hyprland's previous `input.follow_mouse` and `input.mouse_refocus` values, enables pointer focus (`follow_mouse=1`, and `mouse_refocus` matching the `mouseRefocus` option — off by default, since refocus warps the pointer to the window center on every non-mouse focus, which hits menu popups), and restores the recorded values when the option or plugin is disabled/unloaded.
- Near-full mode supports the scrolling layout through `colresize`; on other layouts it uses Hyprland's relative window resize dispatcher iteratively.
- Floating windows are ignored unless `includeFloating` is set. On Omarchy floating workspaces, that setting also controls whether Focus Now keeps hover focus active; with it off, Omarchy's click-to-focus behavior is preserved.
- Fullscreen/maximized state created by the user is preserved; Focus Now only clears the exact compositor state it applied itself. With `stickyFullscreen` on, managed fullscreen windows persist after losing focus — disabling the plugin or switching expansion off sweeps all of them.
- The plugin runs unsandboxed inside `omarchy-shell`, like every Omarchy shell plugin.

## Develop

```bash
npm test
omarchy plugin validate .
```
