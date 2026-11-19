import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "FocusNowModel.js" as Model

// Focus Now watches Hyprland's active-window stream. With hover focus enabled
// it temporarily owns input.follow_mouse/mouse_refocus, restoring the previous
// values whenever the option, service, or plugin is disabled.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string home: Quickshell.env("HOME")
  readonly property string configPath: home + "/.config/omarchy/focus-now.json"
  readonly property string pluginDir: (manifest && manifest.__sourceDir)
    ? manifest.__sourceDir
    : (home + "/.config/omarchy/plugins/eb.focus-now")

  property var rawConfig: ({})
  readonly property var config: Model.normalizeConfig(rawConfig)
  property bool configLoaded: false

  property string binTimeout: "/usr/bin/timeout"
  property string binHyprctl: "/usr/bin/hyprctl"
  property string binNode: ""

  property string pendingAddress: ""
  property string lastHandledAddress: ""
  property bool applying: false
  property bool hoverHeld: false
  property string managedAddress: ""
  property string managedMode: ""
  property int savedFollowMouse: -1
  property bool savedMouseRefocus: true

  function log(message) {
    console.log("focus-now " + new Date().toISOString() + " " + message)
  }

  function syncBins() {
    var bins = config.bins || {}
    root.binTimeout = bins.timeout || "/usr/bin/timeout"
    root.binHyprctl = bins.hyprctl || "/usr/bin/hyprctl"
    if (bins.node) root.binNode = bins.node
  }

  onConfigChanged: {
    syncBins()
    if (config.enabled && config.hoverFocus) holdHoverFocus()
    else releaseHoverFocus()
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
      includeFloating: normalized.includeFloating
    }, null, 2) + "\n")
  }

  function setEnabled(value) { saveConfig({ enabled: !!value }) }
  function setHoverFocus(value) { saveConfig({ hoverFocus: !!value }) }
  function setMode(mode) {
    if (Model.EXPAND_MODES.indexOf(mode) < 0) mode = "off"
    saveConfig({ expandMode: mode })
  }
  function setWidthMultiplier(value) { saveConfig({ widthMultiplier: Model.nearestMultiplier(value, 0.85) }) }
  function setHeightMultiplier(value) { saveConfig({ heightMultiplier: Model.nearestMultiplier(value, 0.85) }) }
  function stepWidth(direction) { saveConfig({ widthMultiplier: Model.stepMultiplier(config.widthMultiplier, direction) }) }
  function stepHeight(direction) { saveConfig({ heightMultiplier: Model.stepMultiplier(config.heightMultiplier, direction) }) }

  function nodeCandidates() {
    return [
      home + "/.local/share/mise/shims/node",
      home + "/.local/share/mise/installs/node/latest/bin/node",
      home + "/.local/bin/node",
      "/usr/bin/node",
      "/usr/local/bin/node",
      "/run/current-system/sw/bin/node"
    ]
  }

  function resolveNode() {
    if (root.binNode) return
    var command = [root.binTimeout, "-k", "2", "3", "/usr/bin/bash", "-c",
      'for c in "$@"; do [ -x "$c" ] && { printf "%s" "$c"; exit 0; }; done; exit 1',
      "focus-now-node"]
    var candidates = nodeCandidates()
    for (var i = 0; i < candidates.length; i++) command.push(candidates[i])
    nodeProbe.command = command
    nodeProbe.running = false
    nodeProbe.running = true
  }

  function holdHoverFocus() {
    hoverWatchdog.restart()
    if (root.hoverHeld) {
      setMouseConfig(1, true)
      return
    }
    captureMouseProc.running = false
    captureMouseProc.running = true
  }

  function releaseHoverFocus() {
    hoverWatchdog.stop()
    if (!root.hoverHeld) return
    root.hoverHeld = false
    setMouseConfig(root.savedFollowMouse >= 0 ? root.savedFollowMouse : 1, root.savedMouseRefocus)
  }

  function setMouseConfig(followMouse, refocus) {
    mouseProc.command = [root.binTimeout, "-k", "2", "3", root.binHyprctl, "eval",
      "hl.config({ input = { follow_mouse = " + Number(followMouse) + ", mouse_refocus = " + (refocus ? "true" : "false") + " } })"]
    mouseProc.running = false
    mouseProc.running = true
  }

  function hyprAddress(address) {
    var value = String(address || "")
    if (value.indexOf("0x") === 0) return value
    if (/^[0-9a-f]+$/i.test(value)) return "0x" + value
    return value
  }

  function clearManagedWindow(detached) {
    if (!root.managedAddress || !root.managedMode) {
      root.managedAddress = ""
      root.managedMode = ""
      return
    }
    cleanupProc.command = [root.binTimeout, "-k", "2", "3", root.binHyprctl, "eval",
      Model.clearManagedFullscreenEval(root.managedAddress, root.managedMode)]
    root.managedAddress = ""
    root.managedMode = ""
    if (detached) cleanupProc.startDetached()
    else {
      cleanupProc.running = false
      cleanupProc.running = true
    }
  }

  function requestRefresh(address) {
    if (!config.enabled) return
    if (!config.hoverFocus && config.expandMode === "off") return
    address = hyprAddress(address)
    if (!address) return
    root.pendingAddress = address
    debounce.restart()
  }

  function centerEval(address) {
    return 'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
      'if w.address == "' + String(address) + '" then target = w break end end; ' +
      'if target and target.workspace and target.workspace.tiled_layout == "scrolling" then ' +
      'hl.dispatch(hl.dsp.layout("center")) end'
  }

  function startAction() {
    var address = root.pendingAddress
    if (!address || address === "") return
    root.lastHandledAddress = address
    root.pendingAddress = ""

    if ((config.expandMode === "fullscreen" || config.expandMode === "near") && root.binNode) {
      var priorManagedAddress = root.managedAddress
      var priorManagedMode = root.managedMode
      root.managedAddress = ""
      root.managedMode = ""
      root.applying = true
      actionProc.command = [
        root.binTimeout, "-k", "2", "8", root.binNode,
        root.pluginDir + "/apply.js",
        address,
        String(config.widthMultiplier),
        String(config.heightMultiplier),
        config.includeFloating ? "1" : "0",
        config.hoverFocus ? "1" : "0",
        root.binHyprctl,
        priorManagedAddress,
        priorManagedMode,
        config.expandMode
      ]
      actionProc.running = false
      actionProc.running = true
      return
    }

    if (config.hoverFocus) {
      root.applying = true
      actionProc.command = [root.binTimeout, "-k", "2", "4", root.binHyprctl, "eval", root.centerEval(address)]
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
      includeFloating: config.includeFloating,
      active: lastHandledAddress,
      pending: pendingAddress,
      managed: managedAddress,
      managedMode: managedMode,
      normalized: hyprAddress(lastHandledAddress),
      applying: applying,
      hoverHeld: hoverHeld,
      hoverWatchdog: hoverWatchdog.running,
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
      try { root.rawConfig = JSON.parse(text() || "{}") || {} }
      catch (e) { root.rawConfig = {} }
      root.configLoaded = true
      root.syncBins()
      root.resolveNode()
      if (root.config.enabled && root.config.hoverFocus) root.holdHoverFocus()
    }
    onLoadFailed: {
      root.rawConfig = {}
      root.configLoaded = true
      root.syncBins()
      root.resolveNode()
      if (root.config.enabled && root.config.hoverFocus) root.holdHoverFocus()
    }
  }

  Timer {
    id: debounce
    interval: 120
    repeat: false
    onTriggered: root.startAction()
  }

  Timer {
    id: hoverWatchdog
    interval: 500
    repeat: true
    onTriggered: {
      if (root.hoverHeld && !hoverProbe.running) hoverProbe.running = true
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var result = Model.parseJson(text, null)
        if (result && result.address) {
          root.managedAddress = result.managed ? String(result.address) : ""
          root.managedMode = String(result.managed || "")
        }
      }
    }
    onExited: {
      root.applying = false
      if (root.pendingAddress && root.pendingAddress !== root.lastHandledAddress) debounce.restart()
    }
  }

  Process {
    id: mouseProc
  }

  Process {
    id: hoverProbe
    command: [root.binTimeout, "-k", "2", "3", "/usr/bin/bash", "-c",
      root.binHyprctl + " getoption input:follow_mouse -j; printf '\\n---S---\\n'; " +
      root.binHyprctl + " getoption input:mouse_refocus -j"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root.hoverHeld || !root.config.enabled || !root.config.hoverFocus) return
        var parts = String(text || "").split("\n---S---\n")
        var follow = Model.parseJson(parts[0] || "{}", {})
        var refocus = Model.parseJson(parts.length > 1 ? parts[1] : "{}", {})
        if (Number(follow && follow.int) !== 1 || !(refocus && refocus.bool === true)) {
          root.setMouseConfig(1, true)
        }
      }
    }
  }

  Process {
    id: cleanupProc
  }

  Process {
    id: captureMouseProc
    command: [root.binTimeout, "-k", "2", "3", "/usr/bin/bash", "-c",
      root.binHyprctl + " getoption input:follow_mouse -j; printf '\\n---S---\\n'; " +
      root.binHyprctl + " getoption input:mouse_refocus -j"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parts = String(text || "").split("\n---S---\n")
        var follow = Model.parseJson(parts[0] || "{}", {})
        var refocus = Model.parseJson(parts.length > 1 ? parts[1] : "{}", {})
        var savedFollow = Number(follow && follow.int)
        if (isFinite(savedFollow)) root.savedFollowMouse = savedFollow
        if (refocus && typeof refocus.bool === "boolean") root.savedMouseRefocus = refocus.bool
        root.hoverHeld = true
        root.setMouseConfig(1, true)
      }
    }
    onExited: function(code) {
      if (code !== 0 && !root.hoverHeld) root.log("could not capture mouse focus settings")
    }
  }

  Process {
    id: nodeProbe
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var found = String(text || "").trim()
        if (found.charAt(0) === "/") root.binNode = found
        else root.log("node not found; automatic expansion is disabled")
      }
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      var name = String(event && event.name ? event.name : "")
      if (name !== "activewindowv2" && name !== "activewindow") return
      var data = []
      try {
        if (event && typeof event.parse === "function") data = event.parse(4) || []
      } catch (e) {
        data = []
      }
      var address = data.length ? String(data[0] || "") : ""
      if (address) root.requestRefresh(address)
      else snapshotProbe.running = true
    }
  }

  Process {
    id: snapshotProbe
    command: [root.binTimeout, "-k", "2", "3", root.binHyprctl, "-j", "activewindow"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var active = Model.parseActiveWindow(text)
        if (active && active.address) root.requestRefresh(active.address)
      }
    }
  }

  Component.onDestruction: {
    debounce.running = false
    hoverWatchdog.stop()
    if (actionProc.running) actionProc.running = false
    if (captureMouseProc.running) captureMouseProc.running = false
    if (mouseProc.running) mouseProc.running = false
    if (hoverProbe.running) hoverProbe.running = false
    if (snapshotProbe.running) snapshotProbe.running = false
    root.clearManagedWindow(true)
    if (root.hoverHeld) {
      root.hoverHeld = false
      mouseProc.command = [root.binTimeout, "-k", "2", "3", root.binHyprctl, "eval",
        "hl.config({ input = { follow_mouse = " + Number(root.savedFollowMouse >= 0 ? root.savedFollowMouse : 1) +
        ", mouse_refocus = " + (root.savedMouseRefocus ? "true" : "false") + " } })"]
      mouseProc.startDetached()
    }
  }

  IpcHandler {
    target: "focus-now"

    function status(): string { return root.statusJson() }
    function ping(): string { return "ok" }
    function enable(): string { root.setEnabled(true); return "enabled" }
    function disable(): string { root.setEnabled(false); return "disabled" }
    function toggle(): string { root.setEnabled(!root.config.enabled); return root.config.enabled ? "enabled" : "disabled" }
    function hoverOn(): string { root.setHoverFocus(true); return "on" }
    function hoverOff(): string { root.setHoverFocus(false); return "off" }
    function hoverToggle(): string { root.setHoverFocus(!root.config.hoverFocus); return root.config.hoverFocus ? "on" : "off" }
    function fullscreen(): string { root.setMode("fullscreen"); return "fullscreen" }
    function near(): string { root.setMode("near"); return "near" }
    function noExpand(): string { root.setMode("off"); return "off" }
    function width(value: string): string { root.setWidthMultiplier(Number(value)); return String(root.config.widthMultiplier) }
    function height(value: string): string { root.setHeightMultiplier(Number(value)); return String(root.config.heightMultiplier) }
    function widthUp(): string { root.stepWidth(1); return String(root.config.widthMultiplier) }
    function widthDown(): string { root.stepWidth(-1); return String(root.config.widthMultiplier) }
    function heightUp(): string { root.stepHeight(1); return String(root.config.heightMultiplier) }
    function heightDown(): string { root.stepHeight(-1); return String(root.config.heightMultiplier) }
    function refresh(): string {
      if (root.lastHandledAddress) root.requestRefresh(root.lastHandledAddress)
      else snapshotProbe.running = true
      return "ok"
    }
  }
}
