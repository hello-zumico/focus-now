import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import "FocusNowModel.js" as Model

// Focus Now watches Hyprland's active-window stream. With hover focus enabled
// it temporarily owns input.follow_mouse/mouse_refocus (follow_mouse=1,
// refocus off), restoring the previous values whenever the option, service,
// or plugin is disabled.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string homeDirectory: Quickshell.env("HOME")
  property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"
  readonly property string configPath: homeDirectory + "/.config/omarchy/focus-now.json"
  readonly property string pluginDir: manifest && manifest.__sourceDir
    ? String(manifest.__sourceDir)
    : homeDirectory + "/.config/omarchy/plugins/zumico.focus-now"

  property var rawConfig: ({})
  readonly property var config: Model.normalizeConfig(rawConfig)
  property bool configLoaded: false
  property bool destroyed: false
  property bool ipcOwner: false
  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
  readonly property string serviceLockPath: runtimeDir + "/focus-now-" + Quickshell.processId + ".lock"

  property string timeoutBinary: "/usr/bin/timeout"
  property string hyprctlBinary: "/usr/bin/hyprctl"
  property string binQuickshell: "/usr/bin/quickshell"
  property string binNode: ""

  property string pendingAddress: ""
  property string repairRetryAddress: ""
  property int repairRetries: 0
  property int repairDeadline: 0
  property string lastHandledAddress: ""
  property bool applying: false
  // Workspace awaiting lua:columns adoption verification. Armed only after the
  // rule-write process exits so an unrelated workspaces refresh cannot observe
  // the stale pre-rule layout and falsely revert.
  property string pendingColumnsVerify: ""
  property string pendingColumnsVerifyName: ""
  property bool hoverHeld: false
  property bool hoverBridgeInstalled: false
  property int hoverBridgeRetries: 0
  property bool stateBridgeInstalled: false
  property string managedAddress: ""
  property string managedMode: ""
  property var managedFullscreenAddrs: ({})
  property var fullscreenStates: ({})
  property var ruleReassertedAt: ({})
  property double expandHoldUntil: 0
  property string heldAddress: ""
  property string releaseRestoreAddress: ""
  property string hoverMonitorAddress: ""
  property int savedFollowMouse: -1
  property bool savedMouseRefocus: true

  function log(message) {
    console.log("focus-now " + new Date().toISOString() + " " + message)
  }

  function syncBins() {
    var bins = config.bins || {}
    root.timeoutBinary = bins.timeout || "/usr/bin/timeout"
    root.hyprctlBinary = bins.hyprctl || "/usr/bin/hyprctl"
    if (bins.node) root.binNode = bins.node
  }

  onConfigChanged: {
    if (!root.ipcOwner) return
    syncBins()
    syncBridges()
    if (!config.enabled) {
      root.clearManagedWindow()
      pendingAddress = ""
      lastHandledAddress = ""
    } else {
      if (config.expandMode === "off") root.clearManagedWindow()
      requestRefresh(lastHandledAddress)
    }
  }

  function saveConfig(patch) {
    var merged = Object.assign({}, rawConfig || {}, patch || {})
    var normalized = Model.normalizeConfig(merged)
    rawConfig = merged
    configFile.setText(JSON.stringify({
      enabled: normalized.enabled,
      hoverFocus: normalized.hoverFocus,
      expandMode: normalized.expandMode,
      widthMultiplier: normalized.widthMultiplier,
      heightMultiplier: normalized.heightMultiplier,
      collapseSize: normalized.collapseSize,
      hoverDelay: normalized.hoverDelay,
      fullscreenDelay: normalized.fullscreenDelay,
      includeFloating: normalized.includeFloating,
      stickyFullscreen: normalized.stickyFullscreen,
      mouseRefocus: normalized.mouseRefocus,
      animate: normalized.animate,
      animateSpeed: normalized.animateSpeed,
      columns: normalized.columns
    }, null, 2) + "\n")
  }

  function setEnabled(value) { saveConfig({ enabled: !!value }) }
  function setHoverFocus(value) { saveConfig({ hoverFocus: !!value }) }
  function setStickyFullscreen(value) { saveConfig({ stickyFullscreen: !!value }) }
  function setMouseRefocus(value) { saveConfig({ mouseRefocus: !!value }) }
  function setAnimate(value) { saveConfig({ animate: !!value }); syncAnimateSpeedLeaf() }
  function setAnimateSpeed(value) { saveConfig({ animateSpeed: Model.normalizeAnimateSpeed(value) }); syncAnimateSpeedLeaf() }
  function stepAnimateSpeed(direction) { saveConfig({ animateSpeed: Model.stepAnimateSpeed(config.animateSpeed, direction) }); syncAnimateSpeedLeaf() }
  // The compositor leaf can't wait for the next apply/recalc — eval it now.
  // Passing the values avoids racing the config file's flush.
  function syncAnimateSpeedLeaf() {
    if (!root.ipcOwner || root.destroyed) return
    animSpeedProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      "if focus_now_apply_anim_speed then focus_now_apply_anim_speed(" +
      Number(config.animateSpeed || 0) + ", " + (config.animate ? "true" : "false") + ") end"]
    animSpeedProc.running = false
    animSpeedProc.running = true
  }
  function setMode(mode) {
    if (Model.EXPAND_MODES.indexOf(mode) < 0) mode = "off"
    saveConfig({ expandMode: mode })
  }
  function setWidthMultiplier(value) { saveConfig({ widthMultiplier: Model.nearestMultiplier(value, 0.85) }) }
  function setHeightMultiplier(value) { saveConfig({ heightMultiplier: Model.nearestMultiplier(value, 0.85) }) }
  function stepWidth(direction) { saveConfig({ widthMultiplier: Model.stepMultiplier(config.widthMultiplier, direction) }) }
  function stepHeight(direction) { saveConfig({ heightMultiplier: Model.stepMultiplier(config.heightMultiplier, direction) }) }
  function setCollapseSize(value) { saveConfig({ collapseSize: Model.normalizeCollapseSize(value) }) }
  function stepCollapseSize(direction) { saveConfig({ collapseSize: Model.stepCollapseSize(config.collapseSize, direction) }) }
  function setHoverDelay(value) { saveConfig({ hoverDelay: Model.normalizeHoverDelay(value) }) }
  function stepHoverDelay(direction) { saveConfig({ hoverDelay: Model.stepHoverDelay(config.hoverDelay, direction) }) }
  function setFullscreenDelay(value) { saveConfig({ fullscreenDelay: Model.normalizeFullscreenDelay(value) }) }
  function stepFullscreenDelay(direction) { saveConfig({ fullscreenDelay: Model.stepFullscreenDelay(config.fullscreenDelay, direction) }) }

  // Per-workspace columns layout ("lua:columns" via hl.workspace_rule). The
  // rule switches the workspace's layout live; the layout file reads open
  // direction and enablement back from this same config object.
  function workspaceColumnsEntry(name) {
    var cols = (rawConfig && rawConfig.columns) || {}
    var stored = cols[name] || {}
    var entry = Object.assign({ enabled: false, open: "horizontal", base: "dwindle", mode: "mix" }, stored)
    if (entry.base !== "scrolling" && entry.base !== "floating") entry.base = "dwindle"
    // A stored entry without a mode predates the mix option and meant the
    // columns provider; only an explicit mix/off opts the overlay out.
    if (entry.mode !== "columns" && entry.mode !== "rows")
      entry.mode = (stored.mode === "mix" || stored.mode === "off" || entry.enabled !== true) ? "mix" : "columns"
    return entry
  }

  // The tiled layout a workspace should run under its preset: the omarchy
  // base (dwindle/scrolling/floating) or a flat provider when base is
  // dwindle and the overlay picks columns/rows. Empty when the preset is
  // off and the omarchy layer decides.
  function workspaceDesiredLayout(name) {
    var entry = workspaceColumnsEntry(name)
    if (!entry.enabled) return ""
    if (entry.base !== "dwindle") return entry.base
    return entry.mode === "mix" ? "lua:tree" : "lua:" + entry.mode
  }

  function setWorkspaceColumns(name, enabled) {
    if (enabled) root.setWorkspaceLayout(name, "columns")
    else root.setWorkspacePreset(name, false)
  }

  function setWorkspaceOpen(name, open) {
    var cols = Object.assign({}, (rawConfig && rawConfig.columns) || {})
    var entry = workspaceColumnsEntry(name)
    entry.open = open === "vertical" ? "vertical" : "horizontal"
    cols[String(name)] = entry
    saveConfig({ columns: cols })
  }

  function setWorkspaceMode(name, mode) {
    root.setWorkspaceLayout(name, mode)
  }

  // Overlay pick from the panel's Mix|Columns|Rows chips (and the mode
  // keybindings). Mix keeps the omarchy base; columns/rows claim the
  // workspace for the flat provider.
  function setWorkspaceLayout(name, mode) {
    var cols = Object.assign({}, (rawConfig && rawConfig.columns) || {})
    var entry = workspaceColumnsEntry(name)
    entry.enabled = true
    entry.mode = mode === "columns" || mode === "rows" ? mode : "mix"
    // The base is the omarchy fallback under Mix — it wins over every other
    // desired layout, so a non-mix mode can only take effect with a dwindle
    // base. The panel's mode chips enforce that pairing; normalize it here so
    // IPC calls (bandNormalize, bindings) can't strand a lua mode on a stale
    // scrolling/floating base and emit the wrong rule.
    if (entry.mode !== "mix") entry.base = "dwindle"
    cols[String(name)] = entry
    saveConfig({ columns: cols })
    workspaceRuleEval(String(name), workspaceDesiredLayout(name))
    // Persist the base like setWorkspaceBase does: a non-mix mode forces
    // base=dwindle, and a stale scrolling/floating mode file left behind by
    // an earlier base pick would read as a deliberate omarchy toggle and
    // reconcile would stomp the base right back, reverting the mode.
    workspaceBasePersistEval(String(name), entry.base)
  }

  // The row's master toggle: on applies the stored preset, off releases the
  // workspace to the omarchy layer (its saved mode file, else the default).
  function setWorkspacePreset(name, on) {
    var cols = Object.assign({}, (rawConfig && rawConfig.columns) || {})
    var entry = workspaceColumnsEntry(name)
    entry.enabled = !!on
    cols[String(name)] = entry
    saveConfig({ columns: cols })
    workspaceRuleEval(String(name), on ? workspaceDesiredLayout(name) : "release")
  }

  // Base pick from the panel's Tiling|Scrolling|Floating chips. The base is
  // what the workspace returns to when the overlay is Mix, and for numeric
  // workspaces it is persisted as an omarchy saved-mode file — same format
  // omarchy-hyprland-workspace-layout-toggle writes — so it survives reloads.
  function setWorkspaceBase(name, base) {
    var cols = Object.assign({}, (rawConfig && rawConfig.columns) || {})
    var entry = workspaceColumnsEntry(name)
    entry.enabled = true
    entry.base = base === "scrolling" || base === "floating" ? base : "dwindle"
    // Base wins over the mode overlay when it's not dwindle — a stored
    // columns/rows mode becomes unreachable under scrolling/floating. The
    // panel keeps mode=mix while a non-dwindle base is picked; mirror that so
    // the entry is never an unreachable combination.
    if (entry.base !== "dwindle") entry.mode = "mix"
    cols[String(name)] = entry
    saveConfig({ columns: cols })
    workspaceRuleEval(String(name), workspaceDesiredLayout(name))
    workspaceBasePersistEval(String(name), entry.base)
  }

  function workspaceBasePersistEval(name, base) {
    if (!root.ipcOwner) return
    workspaceBaseProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      'local name = ' + JSON.stringify(String(name)) + ' ' +
      'local base = ' + JSON.stringify(String(base)) + ' ' +
      'local ws = hl.get_workspace(name) ' +
      'local id = (ws and ws.id) or tonumber(name) or -1 ' +
      'local dir = (os.getenv("XDG_STATE_HOME") or (os.getenv("HOME") .. "/.local/state")) .. "/omarchy/workspace-layouts" ' +
      'local def = "dwindle" ' +
      'local df = io.open(dir .. "/default.lua", "r") ' +
      'if df then def = (df:read("*a") or ""):match([[default%s*=%s*"(%w+)"]]) or "dwindle" df:close() end ' +
      'if id and id >= 1 then ' +
      '  local p = dir .. "/" .. tostring(id) .. ".lua" ' +
      '  if base == def then os.remove(p) else ' +
      '    local f = io.open(p, "w") ' +
      '    if f then f:write("o.workspace_mode({ workspace = \\"" .. tostring(id) .. "\\", mode = \\"" .. base .. "\\" })\\n") f:close() end ' +
      '  end ' +
      'end']
    workspaceBaseProc.running = false
    workspaceBaseProc.running = true
  }

  // desired: "release" | "dwindle" | "scrolling" | "floating" | "lua:columns"
  // | "lua:rows" | "lua:tree". Omarchy modes go through o.workspace_mode so modes[],
  // floating arrange, and the saved-mode machinery stay in sync; release
  // replays the workspace's own saved file or the omarchy default.
  function workspaceRuleEval(name, desired) {
    if (!root.ipcOwner) return
    root.pendingColumnsVerifyName = String(desired).indexOf("lua:") === 0 ? String(name) : ""
    root.pendingColumnsVerify = ""
    // Switching a workspace's provider retiles every window and delivers a
    // burst of focus events; letting each trigger an apply makes the applies'
    // convergence resizes visibly fight the retile. Hold applies while the
    // transition settles and park one refresh for the expansion owner so a
    // single apply re-asserts it afterwards (dwindle needs it; flat layouts
    // keep st.geom and the emit is a no-op).
    root.expandHoldUntil = Math.max(root.expandHoldUntil, Date.now() + 1000)
    if (root.lastHandledAddress) root.heldAddress = root.lastHandledAddress
    // Mark the transition for the next apply: a workspace arriving on
    // dwindle keeps whatever split tree it last had, and the seam ops'
    // clamped deltas on a stale tree crush windows into degenerate sizes
    // before the repair ladder rebuilds. The apply consumes the marker and
    // flattens first instead of converging on the stale topology.
    var mark = 'local tf = io.open("/tmp/focus-now-transition-" .. (' +
        JSON.stringify(String(name)) + '):gsub("[^%w]", "_"), "w") ' +
        'if tf then tf:write("1") tf:close() end '
    var lua
    if (desired === "release") {
      lua = 'local name = ' + JSON.stringify(String(name)) + ' ' +
        'local ws = hl.get_workspace(name) ' +
        'local id = (ws and ws.id) or tonumber(name) or -1 ' +
        'local dir = (os.getenv("XDG_STATE_HOME") or (os.getenv("HOME") .. "/.local/state")) .. "/omarchy/workspace-layouts" ' +
        'local f = id >= 1 and io.open(dir .. "/" .. tostring(id) .. ".lua", "r") ' +
        'if f then f:close() dofile(dir .. "/" .. tostring(id) .. ".lua") ' +
        'else ' +
        '  local def = "dwindle" ' +
        '  local df = io.open(dir .. "/default.lua", "r") ' +
        '  if df then def = (df:read("*a") or ""):match([[default%s*=%s*"(%w+)"]]) or "dwindle" df:close() end ' +
        '  o.workspace_mode({ workspace = name, mode = def }) ' +
        'end'
    } else if (desired === "lua:columns" || desired === "lua:rows" || desired === "lua:tree") {
      lua = 'o.workspace_mode({ workspace = ' + JSON.stringify(String(name)) + ', mode = "dwindle" }); ' +
            'hl.workspace_rule({ workspace = ' + JSON.stringify(String(name)) +
            ', layout = "' + desired + '" })'
    } else {
      lua = 'o.workspace_mode({ workspace = ' + JSON.stringify(String(name)) +
            ', mode = "' + desired + '" })'
    }
    lua = mark + lua
    workspaceRuleProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval", lua]
    workspaceRuleProc.running = false
    workspaceRuleProc.running = true
  }

  function reconcileLayouts(text) {
    var m = String(text || "").match(/\]:\d+: ([^\n]*)/)
    if (!m) return
    var configured = (rawConfig && rawConfig.columns) || {}
    var reasserted = root.ruleReassertedAt || {}
    var changed = false
    var pairs = String(m[1] || "").split(";")
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf("=")
      if (eq < 0) continue
      var name = pairs[i].slice(0, eq)
      var rest = pairs[i].slice(eq + 1)
      var eq2 = rest.indexOf("=")
      var real = eq2 < 0 ? rest : rest.slice(0, eq2)
      var fileMode = eq2 >= 0 ? rest.slice(eq2 + 1) : ""
      var entry = configured[name]
      if (!entry || !entry.enabled || !real || real === "missing" || real === "nil") continue
      var base = entry.base === "scrolling" || entry.base === "floating" ? entry.base : "dwindle"
      var mode = entry.mode === "columns" || entry.mode === "rows" ? entry.mode
               : (entry.mode === "mix" || entry.mode === "off") ? "mix" : "columns"
      // A saved omarchy file that disagrees with the entry's base came from a
      // deliberate workspace-layout toggle — that choice outranks the plugin
      // entry, and the file re-asserts itself on every reload anyway. Sync the
      // entry's base to the file rather than disabling the preset: once the
      // file cycles back to dwindle the preset resumes its lua layout.
      var fileBase = (fileMode === "scrolling" || fileMode === "floating") ? fileMode
                   : fileMode === "dwindle" ? "dwindle" : ""
      if (fileBase && fileBase !== base) {
        root.log("workspace " + name + " has a saved " + fileBase + " layout; syncing focus-now base")
        var cols = Object.assign({}, configured)
        var updated = Object.assign({}, entry)
        updated.base = fileBase
        // Under a columns/rows overlay the file toggle is a base override —
        // setWorkspaceBase's invariant (non-dwindle base ⇒ mix) applies the
        // same way here, else the mode would be stranded unreachable.
        if (fileBase !== "dwindle") { updated.mode = "mix"; mode = "mix" }
        cols[name] = updated
        saveConfig({ columns: cols })
        base = fileBase
      }
      var wanted = base !== "dwindle" ? base : (mode === "mix" ? "lua:tree" : "lua:" + mode)
      // Floating does not appear in tiled_layout, so it cannot be verified or
      // re-asserted from the probe.
      if (wanted === "floating" || real === wanted) continue
      if (Date.now() - (reasserted[name] || 0) <= 30000) continue
      reasserted[name] = Date.now()
      changed = true
      root.log("workspace " + name + " on " + real + "; re-asserting " + wanted)
      workspaceRuleEval(name, wanted)
    }
    if (changed) root.ruleReassertedAt = reasserted
  }

  function refreshWorkspaces() {
    if (!root.ipcOwner || root.destroyed) return
    workspacesProc.running = false
    workspacesProc.running = true
    monitorsProc.running = false
    monitorsProc.running = true
  }

  // Rows shown by the panel: every workspace hyprctl knows about plus every
  // configured columns workspace plus the scratchpad, so a special workspace
  // can be enabled before it exists. Enabled reflects the workspace's actual
  // reported layout, so a compositor-wide lua:columns default shows truthfully.
  readonly property var workspaceRows: {
    var names = {}
    var layouts = {}
    var list = root.workspaces || []
    for (var i = 0; i < list.length; i++) {
      var nm = String(list[i].name || "")
      if (nm) { names[nm] = true; layouts[nm] = String(list[i].layout || "") }
    }
    var cols = (config && config.columns) || {}
    for (var key in cols) names[key] = true
    // Every workspace in the focused monitor's block — omarchy gives each
    // monitor ten — so layouts can be pre-set before a window ever lands.
    // The block comes from the focused monitor's active workspace; guests
    // parked on this monitor appear via the hyprctl list anyway.
    var aw = root.focusedWorkspaceId || 0
    if (aw < 1) aw = 1
    var base0 = Math.floor((aw - 1) / 10) * 10
    for (var w = base0 + 1; w <= base0 + 10; w++) names[String(w)] = true
    names["special:scratchpad"] = true
    var ordered = Object.keys(names).sort(function(a, b) {
      var an = /^special:/.test(a), bn = /^special:/.test(b)
      if (an !== bn) return an ? 1 : -1
      if (an) return a < b ? -1 : 1
      return Number(a) - Number(b)
    })
    var rows = []
    for (i = 0; i < ordered.length; i++) {
      var n = ordered[i]
      var e = cols[n] || {}
      // hyprctl's tiledLayout can lag the actual provider (a lua:rows assert
      // still reports lua:columns), so a config entry owns the mode when it
      // exists; the live report only reveals layouts set outside our config.
      var liveFlat = layouts[n] === "lua:columns" || layouts[n] === "lua:rows" || layouts[n] === "lua:tree"
      var enabled = ("enabled" in e) ? !!e.enabled : liveFlat
      var mode = ("mode" in e) ? (e.mode === "rows" || e.mode === "columns" ? e.mode
                                : (e.mode === "mix" || e.mode === "off") ? "mix" : "columns")
                               : (e.enabled ? "columns" : "mix")
      var base = ("base" in e) ? (e.base === "scrolling" || e.base === "floating" ? e.base : "dwindle")
                               : "dwindle"
      rows.push({ name: n, special: /^special:/.test(n), enabled: enabled, open: e.open || "horizontal", base: base, mode: mode })
    }
    return rows
  }
  property var workspaces: []
  property int focusedWorkspaceId: 0

  function nodeCandidates() {
    return [
      homeDirectory + "/.local/share/mise/shims/node",
      homeDirectory + "/.local/share/mise/installs/node/latest/bin/node",
      homeDirectory + "/.local/bin/node",
      "/usr/bin/node",
      "/usr/local/bin/node",
      "/run/current-system/sw/bin/node"
    ]
  }

  function resolveNode() {
    if (!root.ipcOwner || root.binNode) return
    var command = [root.timeoutBinary, "-k", "2", "3", "/usr/bin/bash", "-c",
      'for candidate; do if test -x "$candidate"; then printf "%s" "$candidate"; exit 0; fi; done; exit 1',
      "focus-now-node"]
    var candidates = nodeCandidates()
    for (var i = 0; i < candidates.length; i++) command.push(candidates[i])
    nodeProbe.command = command
    nodeProbe.running = false
    nodeProbe.running = true
  }

  function becomeIpcOwner() {
    if (root.ipcOwner || root.destroyed) return
    root.ipcOwner = true
    root.syncBins()
    root.resolveNode()
    root.installFlatLayout()
    root.syncBridges()
    root.refreshWorkspaces()
  }

  // The flat layouts live in Hyprland's lua state, which resets on every
  // config load, so nothing installed through hyprctl eval survives a reload.
  // Ship the provider as ~/.config/hypr/focus-now-columns.lua and guarantee a
  // pcall-guarded require inside hyprland.lua — the same marker convention
  // Omarchist and hyprmoncfg use — so the layouts, their key translation, and
  // the layoutmsg verbs always come back with the user's config. Copying
  // every start keeps the file in step with plugin updates; reload only when
  // something changed.
  function installFlatLayout() {
    flatLayoutInstallProc.command = ["/usr/bin/bash", "-c",
      'src="$1"; dst="$HOME/.config/hypr/focus-now-columns.lua"; cfg="$HOME/.config/hypr/hyprland.lua"; ' +
      'changed=0; ' +
      'if ! cmp -s "$src" "$dst" 2>/dev/null; then install -Dm644 "$src" "$dst"; changed=1; fi; ' +
      'if ! grep -qF "hypr.focus-now-columns" "$cfg" 2>/dev/null; then ' +
      'printf "\\n-- Added by focus-now (zumico.focus-now): flat columns/rows layout provider.\\npcall(require, \\"hypr.focus-now-columns\\")\\n" >> "$cfg"; changed=1; fi; ' +
      'if [ "$changed" = 1 ]; then hyprctl reload; fi',
      "bash", root.pluginDir + "/columns.lua"]
    flatLayoutInstallProc.running = false
    flatLayoutInstallProc.running = true
  }

  function installStateBridge() {
    if (!root.ipcOwner || root.stateBridgeInstalled) return
    root.stateBridgeInstalled = true
    stateBridgeProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      Model.installStateBridgeEval(root.binQuickshell, root.omarchyPath + "/shell", config.expandMode !== "off",
        config.widthMultiplier, config.heightMultiplier)]
    stateBridgeProc.running = false
    stateBridgeProc.running = true
  }

  function uninstallStateBridge() {
    if (!root.stateBridgeInstalled) return
    root.stateBridgeInstalled = false
    stateBridgeProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      Model.uninstallStateBridgeEval()]
    stateBridgeProc.running = false
    stateBridgeProc.running = true
  }

  function syncBridges() {
    if (!root.ipcOwner || !root.configLoaded) return
    if (config.enabled && (config.hoverFocus || config.expandMode !== "off")) {
      root.stateBridgeInstalled = false
      installStateBridge()
    } else uninstallStateBridge()
    if (config.enabled && config.hoverFocus) {
      holdHoverFocus()
      startHoverReleaseMonitor()
    } else {
      releaseHoverFocus()
      stopHoverReleaseMonitor()
    }
  }

  function installHoverBridge() {
    if (!root.ipcOwner) return
    root.hoverBridgeInstalled = true
    hoverBridgeProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      Model.installHoverBridgeEval(config.includeFloating, config.mouseRefocus)]
    hoverBridgeProc.running = false
    hoverBridgeProc.running = true
  }

  function uninstallHoverBridge() {
    root.hoverBridgeInstalled = false
    hoverBridgeProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      Model.uninstallHoverBridgeEval(root.savedFollowMouse >= 0 ? root.savedFollowMouse : 1, root.savedMouseRefocus)]
    hoverBridgeProc.running = false
    hoverBridgeProc.running = true
  }

  function holdHoverFocus() {
    if (!root.ipcOwner) return
    if (!root.hoverHeld) {
      captureMouseProc.running = false
      captureMouseProc.running = true
      return
    }
    installHoverBridge()
  }

  function releaseHoverFocus() {
    if (!root.hoverHeld && !root.hoverBridgeInstalled) return
    root.hoverHeld = false
    uninstallHoverBridge()
  }

  function stopFloatingHoverMonitor() {
    root.hoverMonitorAddress = ""
    if (floatingHoverMonitor.running) floatingHoverMonitor.running = false
  }

  function startHoverReleaseMonitor() {
    if (!root.ipcOwner || !root.binNode) return
    hoverReleaseProc.command = [root.binNode,
      root.pluginDir + "/hover-release.js",
      root.hyprctlBinary,
      String(Math.max(150, Number(config.hoverDelay) || 350))]
    hoverReleaseProc.running = false
    hoverReleaseProc.running = true
  }

  function stopHoverReleaseMonitor() {
    if (hoverReleaseProc.running) hoverReleaseProc.running = false
    hoverReleaseEval(false)
  }

  function hoverReleaseEval(released) {
    if (!root.ipcOwner || root.destroyed) return
    hoverReleaseEvalProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      "if focus_now_set_hover_release then focus_now_set_hover_release(" +
      (released ? "true" : "false") + ") end"]
    hoverReleaseEvalProc.running = false
    hoverReleaseEvalProc.running = true
  }

  // Pointer sits off every window: focus is sticky — nothing is applied, the
  // layout holds exactly as it was. But sweep-through focus may have left the
  // highlight on a sibling, so hand focus back to the window still holding
  // the expansion share. Re-entry refreshes the expansion as usual.
  function onHoverReleaseLine(line) {
    var result = Model.parseJson(line, null)
    if (!result) return
    if ((result.outside === true || result.release === true)
        && root.workspaceDesiredLayout(String(root.focusedWorkspaceId)) === "scrolling") return
    if (result.outside === true) {
      // Pointer just left every window — a queued expansion can only have been
      // armed by sweep-through focus; drop it before the debounce fires. A
      // deliberate request queued after this (e.g. keyboard focus while the
      // pointer sits on the bar) is untouched.
      if (root.pendingAddress) {
        root.log("hover gap cancelled expansion " + root.pendingAddress)
        root.pendingAddress = ""
        if (!root.applying) debounce.stop()
      }
      if (root.heldAddress) root.heldAddress = ""
      // An apply already in flight toward a swept sibling will finish
      // expanding it — re-expand the real owner when it exits.
      var outsideOwner = hyprAddress(result.expanded)
      if (root.applying && outsideOwner && root.lastHandledAddress !== outsideOwner)
        root.releaseRestoreAddress = outsideOwner
      return
    }
    hoverReleaseEval(result.release === true)
    var address = hyprAddress(result.address)
    if (result.release === true) {
      var expanded = hyprAddress(result.expanded)
      // A debounced or held apply for a swept-through sibling would still fire
      // after the pointer left, stealing the expansion (and the highlight)
      // from the current owner — drop any queued target that isn't the owner.
      if (root.pendingAddress && root.pendingAddress !== expanded) {
        root.log("hover release cancelled expansion " + root.pendingAddress + " owner=" + expanded)
        root.pendingAddress = ""
        if (!root.applying) debounce.stop()
      }
      if (root.heldAddress && root.heldAddress !== expanded) root.heldAddress = ""
      // An in-flight apply toward a different target finishes expanding the
      // swept sibling — re-expand the real owner once it exits.
      if (root.applying && expanded && root.lastHandledAddress !== expanded)
        root.releaseRestoreAddress = expanded
      if (expanded && expanded !== address) root.refocusExpandedWindow(expanded)
    } else if (address) {
      if (result.hover === true && !root.applying) root.refocusExpandedWindow(address)
      root.requestRefresh(address)
    }
  }

  function refocusExpandedWindow(address) {
    if (!root.ipcOwner || root.destroyed) return
    refocusExpandedProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      'hl.dispatch(hl.dsp.focus({ window = "address:' + address + '" }))']
    refocusExpandedProc.running = false
    refocusExpandedProc.running = true
  }

  function startFloatingHoverMonitor() {
    root.stopFloatingHoverMonitor()
    if (!root.binNode || root.managedMode.indexOf("floating:") !== 0) return
    root.hoverMonitorAddress = root.managedAddress
    floatingHoverMonitor.command = [
      root.binNode,
      root.pluginDir + "/hover-monitor.js",
      root.managedAddress,
      root.hyprctlBinary,
      root.managedMode
    ]
    floatingHoverMonitor.running = false
    floatingHoverMonitor.running = true
  }

  function hyprAddress(address) {
    var value = String(address || "")
    if (value.indexOf("0x") === 0) return value
    if (/^[0-9a-f]+$/i.test(value)) return "0x" + value
    return value
  }

  function clearManagedWindow(detached) {
    root.stopFloatingHoverMonitor()
    var evalSource = root.managedAddress && root.managedMode
      ? Model.clearManagedWindowEval(root.managedAddress, root.managedMode) + "; "
      : ""
    evalSource += Model.clearAllManagedFullscreenEval()
    cleanupProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval", evalSource]
    root.managedAddress = ""
    root.managedMode = ""
    root.managedFullscreenAddrs = ({})
    root.heldAddress = ""
    if (detached) cleanupProc.startDetached()
    else {
      cleanupProc.running = false
      cleanupProc.running = true
    }
  }

  function requestRefresh(address) {
    if (!root.ipcOwner || !config.enabled) return
    if (!config.hoverFocus && config.expandMode === "off") return
    address = hyprAddress(address)
    if (!address) return
    if (Date.now() < root.expandHoldUntil) {
      root.heldAddress = address
      return
    }
    root.pendingAddress = address
    // Focus events emitted by a running apply's own dispatches (the scrolling
    // collapse sequence focuses every column in turn) must not re-arm the
    // debounce — actionProc.onExited restarts it when the pending address is
    // actually a new target.
    if (!root.applying) debounce.restart()
  }

  function centerEval(address) {
    return 'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
      'if w.address == "' + String(address) + '" then target = w break end end; ' +
      'if target and target.workspace and target.workspace.tiled_layout == "scrolling" then ' +
      'hl.dispatch(hl.dsp.layout("center")) end'
  }

  function startAction() {
    if (!root.ipcOwner) return
    if (Date.now() < root.expandHoldUntil) {
      if (root.pendingAddress) root.heldAddress = root.pendingAddress
      root.pendingAddress = ""
      return
    }
    var address = root.pendingAddress
    if (!address || address === "") return
    root.lastHandledAddress = address
    root.pendingAddress = ""

    if ((config.expandMode === "fullscreen" || config.expandMode === "near") && root.binNode) {
      root.stopFloatingHoverMonitor()
      var priorManagedAddress = root.managedAddress
      var priorManagedMode = root.managedMode
      root.managedAddress = ""
      root.managedMode = ""
      root.applying = true
      actionProc.command = [
        root.timeoutBinary, "-k", "2", "8", root.binNode,
        root.pluginDir + "/apply.js",
        address,
        String(config.widthMultiplier),
        String(config.heightMultiplier),
        config.includeFloating ? "1" : "0",
        config.hoverFocus ? "1" : "0",
        root.hyprctlBinary,
        priorManagedAddress,
        priorManagedMode,
        config.expandMode,
        config.stickyFullscreen ? "1" : "0",
        String(config.collapseSize),
        config.animate ? "1" : "0",
        String(config.animateSpeed)
      ]
      actionProc.running = false
      actionProc.running = true
      return
    }

    if (config.hoverFocus) {
      root.applying = true
      actionProc.command = [root.timeoutBinary, "-k", "2", "4", root.hyprctlBinary, "eval", root.centerEval(address)]
      actionProc.running = false
      actionProc.running = true
    }
  }

  function statusJson() {
    return JSON.stringify({
      enabled: config.enabled,
      hoverFocus: config.hoverFocus,
      expandMode: config.expandMode,
      widthMultiplier: config.widthMultiplier,
      heightMultiplier: config.heightMultiplier,
      collapseSize: config.collapseSize,
      hoverDelay: config.hoverDelay,
      fullscreenDelay: config.fullscreenDelay,
      includeFloating: config.includeFloating,
      animate: config.animate,
      animateSpeed: config.animateSpeed,
      stickyFullscreen: config.stickyFullscreen,
      mouseRefocus: config.mouseRefocus,
      active: lastHandledAddress,
      pending: pendingAddress,
      managed: managedAddress,
      managedMode: managedMode,
      normalized: hyprAddress(lastHandledAddress),
      applying: applying,
      hoverHeld: hoverHeld,
      hoverBridge: hoverBridgeInstalled,
      stateBridge: stateBridgeInstalled,
      hoverMonitor: floatingHoverMonitor.running,
      ipcOwner: ipcOwner,
      holdUntil: Math.max(0, root.expandHoldUntil - Date.now()),
      held: heldAddress,
      fsStates: fullscreenStates,
      managedFs: managedFullscreenAddrs,
      node: binNode
    })
  }

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      if (!root || root.destroyed) return
      var source = ""
      try { source = text() || "" } catch (e) { source = "" }
      try { root.rawConfig = JSON.parse(source || "{}") || {} }
      catch (e) { root.rawConfig = {} }
      root.configLoaded = true
      root.syncBins()
      root.resolveNode()
      root.syncBridges()
    }
    onLoadFailed: {
      if (!root || root.destroyed) return
      root.rawConfig = {}
      root.configLoaded = true
      root.syncBins()
      root.resolveNode()
      root.syncBridges()
    }
  }

  Timer {
    id: debounce
    interval: root.configLoaded ? root.config.hoverDelay : 120
    repeat: false
    onTriggered: root.startAction()
  }

  Timer {
    id: hoverBridgeReload
    interval: 250
    repeat: false
    onTriggered: {
      if (root.config.enabled && root.config.hoverFocus) root.installHoverBridge()
    }
  }

  Timer {
    id: stateBridgeReload
    interval: 250
    repeat: false
    onTriggered: {
      if (root.config.enabled && (root.config.hoverFocus || root.config.expandMode !== "off")) {
        root.stateBridgeInstalled = false
        root.installStateBridge()
      }
    }
  }

  Timer {
    id: repairRetryTimer
    interval: 400
    repeat: false
    onTriggered: {
      if (root.repairRetryAddress) root.requestRefresh(root.repairRetryAddress)
    }
  }

  Timer {
    id: holdReleaseTimer
    interval: 250
    repeat: true
    running: root.heldAddress !== ""
    onTriggered: {
      if (!root.heldAddress || Date.now() < root.expandHoldUntil) return
      var address = root.heldAddress
      root.heldAddress = ""
      root.requestRefresh(address)
    }
  }

  Timer {
    id: fullscreenReleaseDebounce
    interval: 120
    repeat: false
    onTriggered: {
      fullscreenReleaseProc.running = false
      fullscreenReleaseProc.running = true
    }
  }

  Process {
    id: fullscreenReleaseProc
    command: [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "-j", "clients"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed || !root.ipcOwner) return
        var clients = Model.parseClients(text)
        var next = {}
        var exited = false
        for (var address in clients) {
          var win = clients[address]
          var previous = root.fullscreenStates[address] || 0
          var current = win.fullscreenMode || 0
          if (previous !== 0 && current === 0) exited = true
          // A managed window leaving fullscreen keeps fullscreenClient == 1;
          // Focus Now's own clears set client = 0, so only a user toggle lands
          // here. Require tracked managed state: compositor churn on sticky
          // orphans and lingering client flags must not arm the hold.
          var wasManaged = root.managedFullscreenAddrs[address] === true
          if (wasManaged && previous !== 0 && current === 0 && (win.fullscreenClientMode || 0) === 1) {
            root.managedFullscreenAddrs[address] = false
            root.expandHoldUntil = Date.now() + root.config.fullscreenDelay
            root.log("managed fullscreen released by user; expansion held")
          } else if (wasManaged && current === 0 && (win.fullscreenClientMode || 0) === 0) {
            root.managedFullscreenAddrs[address] = false
          }
          next[address] = current
        }
        root.fullscreenStates = next
        // Leaving fullscreen keeps the same window focused, so no activewindow
        // event fires and the shrunken window is never re-expanded. Probe the
        // active window; for a managed release the hold just armed above makes
        // requestRefresh park it until the delay is over.
        if (exited) snapshotProbe.running = true
      }
    }
  }

  Process {
    id: flatLayoutInstallProc
  }

  Process {
    id: animSpeedProc
  }

  Process {
    id: workspaceRuleProc
    onExited: function(code) {
      if (!root || root.destroyed) return
      if (code === 0) transitionExpandTimer.restart()
      if (root.pendingColumnsVerifyName) {
        root.pendingColumnsVerify = root.pendingColumnsVerifyName
        root.pendingColumnsVerifyName = ""
        refreshWorkspaces()
      }
    }
  }

  Timer {
    id: transitionExpandTimer
    interval: Math.max(1, root.expandHoldUntil - Date.now() + 50)
    repeat: false
    onTriggered: {
      if (!root.ipcOwner || root.destroyed || !root.config.enabled) return
      snapshotProbe.running = false
      snapshotProbe.running = true
    }
  }

  Process {
    id: workspaceBaseProc
  }

  Process {
    id: monitorsProc
    command: [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "-j", "monitors"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed) return
        var list = Model.parseJson(text, [])
        for (var i = 0; i < list.length; i++) {
          var m = list[i]
          if (m && m.focused && m.activeWorkspace && (m.activeWorkspace.id || 0) > 0) {
            root.focusedWorkspaceId = m.activeWorkspace.id
            break
          }
        }
      }
    }
  }

  Process {
    id: workspacesProc
    command: [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "-j", "workspaces"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed) return
        var list = Model.parseJson(text, [])
        var names = []
        if (Array.isArray(list)) {
          for (var i = 0; i < list.length; i++) {
            var name = String(list[i].name || "")
            if (name) names.push({ name: name, layout: String(list[i].tiledLayout || "") })
          }
        }
        root.workspaces = names

        // Workspace rules get dropped — reloads, saved-layout files from
        // omarchy-hyprland-workspace-layout-toggle, special workspaces cycling
        // hidden→shown. tiledLayout only ever lags lua↔lua or back to a real
        // name, so the real provider comes from the live workspace object via
        // an eval probe; anything not matching the configured mode re-asserts.
        var configured = (rawConfig && rawConfig.columns) || {}
        var wanted = []
        for (var wname in configured) {
          if (configured[wname] && configured[wname].enabled) wanted.push(String(wname))
        }
        if (wanted.length && !layoutProbeProc.running) {
          layoutProbeProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
            "local dir = (os.getenv(\"XDG_STATE_HOME\") or (os.getenv(\"HOME\") .. \"/.local/state\")) .. \"/omarchy/workspace-layouts\" " +
            "local parts = {} " +
            "for _, n in ipairs({" + wanted.map(function(n) { return JSON.stringify(n) }).join(",") + "}) do " +
            "  local w = hl.get_workspace(n) " +
            "  local fm = \"\" " +
            "  if w and w.id and w.id >= 1 then " +
            "    local f = io.open(dir .. \"/\" .. tostring(w.id) .. \".lua\", \"r\") " +
            "    if f then fm = (f:read(\"*a\") or \"\"):match([[mode%s*=%s*\"(%w+)\"]]) or \"\" f:close() end " +
            "  end " +
            "  parts[#parts+1] = n .. \"=\" .. tostring(w and w.tiled_layout or \"missing\") .. \"=\" .. fm " +
            "end " +
            "error(table.concat(parts, \";\"))"]
          layoutProbeProc.running = true
        }

        // A lua:columns workspace rule silently stays on dwindle when the
        // layout provider is not registered (e.g. columns.lua not installed).
        // Revert the toggle in that case instead of leaving a dead config.
        var pending = root.pendingColumnsVerify
        if (pending) {
          var seen = null
          for (var i = 0; i < names.length; i++) {
            if (names[i].name === pending) { seen = names[i]; break }
          }
          if (seen) {
            root.pendingColumnsVerify = ""
            if (seen.layout !== "lua:columns" && seen.layout !== "lua:rows" && seen.layout !== "lua:tree") {
              root.log("columns layout not registered; leaving workspace " + pending + " on dwindle")
              var cols = Object.assign({}, (rawConfig && rawConfig.columns) || {})
              var entry = Object.assign({ enabled: false, open: "horizontal" }, cols[pending] || {})
              entry.enabled = false
              cols[pending] = entry
              saveConfig({ columns: cols })
              workspaceRuleEval(pending, "release")
            }
          }
          // A workspace that does not exist yet (e.g. special:scratchpad before
          // it is opened) stores the rule for later; keep pending until it
          // appears and reports an actual layout.
        }
      }
    }
  }

  Timer {
    id: workspacesPoll
    interval: 5000
    repeat: true
    running: root.ipcOwner && !root.destroyed
    onTriggered: root.refreshWorkspaces()
  }

  Process {
    id: layoutProbeProc
    command: []
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed || !root.ipcOwner) return
        root.reconcileLayouts(text)
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed || !root.ipcOwner) return
        root.reconcileLayouts(text)
      }
    }
  }

  Process {
    id: ipcLockProc
    command: ["/usr/bin/mkdir", root.serviceLockPath]
    onExited: function(code) {
      if (!root || root.destroyed) return
      if (code === 0) root.becomeIpcOwner()
      else ipcLockRetry.restart()
    }
  }

  // The previous instance's rmdir is detached and can land after this mkdir;
  // losing that race leaves the service without an IPC target or any events
  // until the next reload. A real second owner keeps failing the same way, so
  // give up after a few seconds.
  Timer {
    id: ipcLockRetry
    interval: 400
    repeat: true
    onTriggered: {
      if (root.destroyed || root.ipcOwner) { running = false; return }
      ipcLockRetries += 1
      if (ipcLockRetries > 15) { running = false; return }
      ipcLockProc.running = false
      ipcLockProc.running = true
    }
  }
  property int ipcLockRetries: 0

  Process {
    id: actionProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed) return
        var result = Model.parseJson(text, null)
        if (result && result.address) {
          root.managedAddress = result.managed ? String(result.address) : ""
          root.managedMode = String(result.managed || "")
          if (result.managed === "fullscreen" || result.managed === "maximized") {
            var tracked = root.managedFullscreenAddrs
            tracked[String(result.address)] = true
            root.managedFullscreenAddrs = tracked
          }
          root.startFloatingHoverMonitor()
          // An apply can exit with a workspace still mid-repair (cooldowns
          // bounded its tools). Re-apply on a short delay so wedged trees
          // converge without waiting for a focus event: a fast phase of
          // short-interval retries, then a slow tail until the deadline —
          // a deep wedge keeps healing while an unfixable tree is only
          // nudged occasionally instead of looping applies forever.
          if (result.repair) {
            var now = Date.now()
            var addr = String(result.address)
            if (addr !== root.repairRetryAddress || !root.repairDeadline) {
              root.repairRetries = 0
              root.repairDeadline = now + 90000
            }
            if (root.repairRetries < 10 || now < root.repairDeadline) {
              root.repairRetries += 1
              root.repairRetryAddress = addr
              repairRetryTimer.interval = root.repairRetries <= 10 ? 400 : 15000
              repairRetryTimer.restart()
            }
          } else {
            root.repairRetries = 0
            root.repairRetryAddress = ""
            root.repairDeadline = 0
          }
        }
      }
    }
    onExited: function(code) {
      if (!root || root.destroyed) return
      root.applying = false
      if (code !== 0) root.log("expansion failed " + root.lastHandledAddress + " exit=" + code)
      if (root.releaseRestoreAddress) {
        var restore = root.releaseRestoreAddress
        root.releaseRestoreAddress = ""
        root.requestRefresh(restore)
      }
      if (root.pendingAddress && root.pendingAddress !== root.lastHandledAddress) debounce.restart()
    }
  }

  Process {
    id: hoverReleaseProc
    stdout: SplitParser {
      onRead: function(line) {
        if (!root || root.destroyed) return
        root.onHoverReleaseLine(line)
      }
    }
    // A dead monitor leaves expansions stuck released or unreleased forever —
    // respawn it unless the service is shutting down or release monitoring is
    // legitimately off (disabled / hoverFocus off paths already guard it).
    onExited: {
      if (!root || root.destroyed) return
      if (root.ipcOwner && config.enabled && config.hoverFocus) {
        hoverReleaseProc.running = false
        hoverReleaseProc.running = true
      }
    }
  }

  Process {
    id: hoverReleaseEvalProc
  }

  Process {
    id: refocusExpandedProc
  }

  Process {
    id: floatingHoverMonitor
    stdout: SplitParser {
      onRead: function(line) {
        if (!root || root.destroyed) return
        var result = Model.parseJson(line, null)
        if (!result || result.address !== root.hoverMonitorAddress) return
        if (result.reason === "left") {
          if (root.managedAddress === result.address) {
            root.managedAddress = ""
            root.managedMode = ""
          }
        } else if (result.reason === "entered") {
          root.requestRefresh(result.address)
        }
      }
    }
    onExited: {
      if (root && !root.destroyed) root.hoverMonitorAddress = ""
    }
  }

  Process {
    id: hoverBridgeProc
    onExited: function(code) {
      if (!root || root.destroyed || !root.ipcOwner || !root.hoverHeld) return
      if (code === 0) {
        root.hoverBridgeInstalled = true
        root.hoverBridgeRetries = 0
      } else {
        root.hoverBridgeInstalled = false
        root.log("could not install floating hover bridge: exit " + code)
        if (root.config.enabled && root.config.hoverFocus && root.hoverBridgeRetries < 3) {
          root.hoverBridgeRetries += 1
          hoverBridgeReload.restart()
        }
      }
    }
  }

  Process {
    id: stateBridgeProc
    onExited: function(code) {
      if (root && !root.destroyed && code !== 0 && root.stateBridgeInstalled) {
        root.stateBridgeInstalled = false
        root.log("could not install window-state bridge")
      }
    }
  }

  Process {
    id: cleanupProc
  }

  Process {
    id: captureMouseProc
    command: [root.timeoutBinary, "-k", "2", "3", "/usr/bin/bash", "-c",
      root.hyprctlBinary + " getoption input:follow_mouse -j; printf '\\n---S---\\n'; " +
      root.hyprctlBinary + " getoption input:mouse_refocus -j"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed || !root.config.enabled || !root.config.hoverFocus) return
        var sections = String(text || "").split("\n---S---\n")
        var follow = Model.parseJson(sections[0] || "{}", {})
        var refocus = Model.parseJson(sections.length > 1 ? sections[1] : "{}", {})
        var savedFollow = Number(follow && follow.int)
        if (isFinite(savedFollow)) root.savedFollowMouse = savedFollow
        if (refocus && typeof refocus.bool === "boolean") root.savedMouseRefocus = refocus.bool
        root.hoverHeld = true
        root.installHoverBridge()
      }
    }
    onExited: function(code) {
      if (root && !root.destroyed && code !== 0 && !root.hoverHeld) root.log("could not capture mouse focus settings")
    }
  }

  Process {
    id: nodeProbe
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed) return
        var found = String(text || "").trim()
        if (found.charAt(0) === "/") {
          root.binNode = found
          // The probe resolves after syncBridges already ran — without this,
          // node-dependent monitors (hover release) silently never start.
          root.syncBridges()
        } else root.log("node not found; automatic expansion is disabled")
      }
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!root || root.destroyed || !root.ipcOwner) return
      var eventName = String(event && event.name ? event.name : "")
      if (eventName === "configreloaded") {
        if (root.config.enabled && root.config.hoverFocus) {
          root.hoverBridgeRetries = 0
          hoverBridgeReload.restart()
        }
        if (root.stateBridgeInstalled) stateBridgeReload.restart()
        return
      }
      var data = []
      try {
        if (event && typeof event.parse === "function") data = event.parse(4) || []
      } catch (e) {
        data = []
      }
      var address = data.length ? String(data[0] || "") : ""
      if (eventName === "fullscreen") {
        if (root.ipcOwner) fullscreenReleaseDebounce.restart()
        return
      }
      if (eventName === "changefloatingmode") {
        if (address) root.requestRefresh(address)
        else snapshotProbe.running = true
        return
      }
      // movewindow/swapwindow reorder the tree without touching focus — the
      // moved window's slot (and every leaf's split ratios) change, so the
      // expansion must re-apply against the new arrangement.
      if (eventName === "movewindow" || eventName === "swapwindow") {
        snapshotProbe.running = true
        return
      }
      if (eventName !== "activewindowv2") return
      if (address) root.requestRefresh(address)
      else snapshotProbe.running = true
    }
  }

  Process {
    id: snapshotProbe
    command: [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "-j", "activewindow"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root || root.destroyed || !root.ipcOwner) return
        var active = Model.parseActiveWindow(text)
        if (active && active.address) root.requestRefresh(active.address)
      }
    }
  }

  Component.onCompleted: {
    ipcLockProc.running = true
  }

  Component.onDestruction: {
    root.destroyed = true
    debounce.running = false
    hoverBridgeReload.stop()
    stateBridgeReload.stop()
    if (ipcLockProc.running) ipcLockProc.running = false
    if (actionProc.running) actionProc.running = false
    if (captureMouseProc.running) captureMouseProc.running = false
    if (hoverBridgeProc.running) hoverBridgeProc.running = false
    if (stateBridgeProc.running) stateBridgeProc.running = false
    if (snapshotProbe.running) snapshotProbe.running = false
    if (nodeProbe.running) nodeProbe.running = false
    if (floatingHoverMonitor.running) floatingHoverMonitor.running = false
    if (!root.ipcOwner) return

    root.ipcOwner = false
    Quickshell.execDetached(["/usr/bin/rmdir", root.serviceLockPath])
    root.clearManagedWindow(true)
    if (root.stateBridgeInstalled) {
      root.stateBridgeInstalled = false
      stateBridgeProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
        Model.uninstallStateBridgeEval()]
      stateBridgeProc.startDetached()
    }
    if (root.hoverHeld || root.hoverBridgeInstalled) {
      root.hoverHeld = false
      root.hoverBridgeInstalled = false
      hoverBridgeProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
        Model.uninstallHoverBridgeEval(root.savedFollowMouse >= 0 ? root.savedFollowMouse : 1, root.savedMouseRefocus)]
      hoverBridgeProc.startDetached()
    }
  }

  ShellIpc {
    id: ipcHandler
    target: root.ipcOwner ? "focus-now" : ""
    enabled: root.ipcOwner

    function status(): string { return root.statusJson() }
    function ping(): string { return "ok" }
    function enable(): string { root.setEnabled(true); return "enabled" }
    function disable(): string { root.setEnabled(false); return "disabled" }
    function toggle(): string { root.setEnabled(!root.config.enabled); return root.config.enabled ? "enabled" : "disabled" }
    function hoverOn(): string { root.setHoverFocus(true); return "on" }
    function hoverOff(): string { root.setHoverFocus(false); return "off" }
    function hoverToggle(): string { root.setHoverFocus(!root.config.hoverFocus); return root.config.hoverFocus ? "on" : "off" }
    function fullscreen(): string { root.setMode("fullscreen"); return "fullscreen" }
    function stickyOn(): string { root.setStickyFullscreen(true); return "on" }
    function stickyOff(): string { root.setStickyFullscreen(false); return "off" }
    function stickyToggle(): string { root.setStickyFullscreen(!root.config.stickyFullscreen); return root.config.stickyFullscreen ? "on" : "off" }
    function animateOn(): string { root.setAnimate(true); return "on" }
    function animateOff(): string { root.setAnimate(false); return "off" }
    function animateToggle(): string { root.setAnimate(!root.config.animate); return root.config.animate ? "on" : "off" }
    function animateSpeed(value: string): string { root.setAnimateSpeed(Number(value)); return String(root.config.animateSpeed) }
    function animateSpeedUp(): string { root.stepAnimateSpeed(1); return String(root.config.animateSpeed) }
    function animateSpeedDown(): string { root.stepAnimateSpeed(-1); return String(root.config.animateSpeed) }
    function near(): string { root.setMode("near"); return "near" }
    function noExpand(): string { root.setMode("off"); return "off" }
    function width(value: string): string { root.setWidthMultiplier(Number(value)); return String(root.config.widthMultiplier) }
    function height(value: string): string { root.setHeightMultiplier(Number(value)); return String(root.config.heightMultiplier) }
    function widthUp(): string { root.stepWidth(1); return String(root.config.widthMultiplier) }
    function widthDown(): string { root.stepWidth(-1); return String(root.config.widthMultiplier) }
    function heightUp(): string { root.stepHeight(1); return String(root.config.heightMultiplier) }
    function heightDown(): string { root.stepHeight(-1); return String(root.config.heightMultiplier) }
    function collapseSize(value: string): string { root.setCollapseSize(Number(value)); return String(root.config.collapseSize) }
    function collapseSizeUp(): string { root.stepCollapseSize(1); return String(root.config.collapseSize) }
    function collapseSizeDown(): string { root.stepCollapseSize(-1); return String(root.config.collapseSize) }
    function hoverDelay(value: string): string { root.setHoverDelay(Number(value)); return String(root.config.hoverDelay) }
    function hoverDelayUp(): string { root.stepHoverDelay(1); return String(root.config.hoverDelay) }
    function hoverDelayDown(): string { root.stepHoverDelay(-1); return String(root.config.hoverDelay) }
    function fullscreenDelay(value: string): string { root.setFullscreenDelay(Number(value)); return String(root.config.fullscreenDelay) }
    function fullscreenDelayUp(): string { root.stepFullscreenDelay(1); return String(root.config.fullscreenDelay) }
    function fullscreenDelayDown(): string { root.stepFullscreenDelay(-1); return String(root.config.fullscreenDelay) }
    function columns(name: string): string { root.setWorkspaceColumns(name, true); return "on" }
    function columnsOff(name: string): string { root.setWorkspaceColumns(name, false); return "off" }
    function columnsToggle(name: string): string {
      var entry = (root.config.columns || {})[name] || {}
      root.setWorkspaceColumns(name, !entry.enabled)
      return entry.enabled ? "off" : "on"
    }
    // Toggle decisions read the config entry, not the live layout report —
    // hyprctl's tiledLayout can lag the actual provider (a lua:rows assert
    // reports lua:columns), while the config is the intent the service owns.
    function columnsModeToggle(name: string): string {
      var entry = root.workspaceColumnsEntry(name)
      var off = entry.enabled && entry.base === "dwindle" && entry.mode === "columns"
      if (off) root.setWorkspacePreset(name, false)
      else root.setWorkspaceLayout(name, "columns")
      return off ? "off" : "columns"
    }
    function rowsModeToggle(name: string): string {
      var entry = root.workspaceColumnsEntry(name)
      var off = entry.enabled && entry.base === "dwindle" && entry.mode === "rows"
      if (off) root.setWorkspacePreset(name, false)
      else root.setWorkspaceLayout(name, "rows")
      return off ? "off" : "rows"
    }
    function workspacePreset(name: string, on: bool): string {
      root.setWorkspacePreset(name, on)
      return on ? "on" : "off"
    }
    function workspaceBase(name: string, base: string): string {
      root.setWorkspaceBase(name, base)
      return base
    }
    function workspaceMode(name: string, mode: string): string {
      root.setWorkspaceLayout(name, mode)
      return mode
    }
    function openVertical(name: string): string { root.setWorkspaceOpen(name, "vertical"); return "vertical" }
    function openHorizontal(name: string): string { root.setWorkspaceOpen(name, "horizontal"); return "horizontal" }
    function workspaces(): string { return JSON.stringify(root.workspaceRows) }
    function refresh(): string {
      if (root.lastHandledAddress) root.requestRefresh(root.lastHandledAddress)
      else snapshotProbe.running = true
      return "ok"
    }
  }
}
