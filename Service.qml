import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import "FocusNowModel.js" as Model

// Focus Now watches Hyprland's active-window stream. With hover focus enabled
// it temporarily owns input.follow_mouse/mouse_refocus, restoring the previous
// values whenever the option, service, or plugin is disabled.
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
  property string lastHandledAddress: ""
  property bool applying: false
  property bool hoverHeld: false
  property bool hoverBridgeInstalled: false
  property bool stateBridgeInstalled: false
  property string managedAddress: ""
  property string managedMode: ""
  property var managedFullscreenAddrs: ({})
  property var fullscreenStates: ({})
  property double expandHoldUntil: 0
  property string heldAddress: ""
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
      hoverDelay: normalized.hoverDelay,
      fullscreenDelay: normalized.fullscreenDelay,
      includeFloating: normalized.includeFloating,
      stickyFullscreen: normalized.stickyFullscreen
    }, null, 2) + "\n")
  }

  function setEnabled(value) { saveConfig({ enabled: !!value }) }
  function setHoverFocus(value) { saveConfig({ hoverFocus: !!value }) }
  function setStickyFullscreen(value) { saveConfig({ stickyFullscreen: !!value }) }
  function setMode(mode) {
    if (Model.EXPAND_MODES.indexOf(mode) < 0) mode = "off"
    saveConfig({ expandMode: mode })
  }
  function setWidthMultiplier(value) { saveConfig({ widthMultiplier: Model.nearestMultiplier(value, 0.85) }) }
  function setHeightMultiplier(value) { saveConfig({ heightMultiplier: Model.nearestMultiplier(value, 0.85) }) }
  function stepWidth(direction) { saveConfig({ widthMultiplier: Model.stepMultiplier(config.widthMultiplier, direction) }) }
  function stepHeight(direction) { saveConfig({ heightMultiplier: Model.stepMultiplier(config.heightMultiplier, direction) }) }
  function setHoverDelay(value) { saveConfig({ hoverDelay: Model.normalizeHoverDelay(value) }) }
  function stepHoverDelay(direction) { saveConfig({ hoverDelay: Model.stepHoverDelay(config.hoverDelay, direction) }) }
  function setFullscreenDelay(value) { saveConfig({ fullscreenDelay: Model.normalizeFullscreenDelay(value) }) }
  function stepFullscreenDelay(direction) { saveConfig({ fullscreenDelay: Model.stepFullscreenDelay(config.fullscreenDelay, direction) }) }

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
    root.syncBridges()
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
    if (config.enabled && config.hoverFocus) holdHoverFocus()
    else releaseHoverFocus()
  }

  function installHoverBridge() {
    if (!root.ipcOwner) return
    root.hoverBridgeInstalled = true
    hoverBridgeProc.command = [root.timeoutBinary, "-k", "2", "3", root.hyprctlBinary, "eval",
      Model.installHoverBridgeEval(config.includeFloating)]
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
    debounce.restart()
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
        config.stickyFullscreen ? "1" : "0"
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
      hoverDelay: config.hoverDelay,
      fullscreenDelay: config.fullscreenDelay,
      includeFloating: config.includeFloating,
      stickyFullscreen: config.stickyFullscreen,
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
        for (var address in clients) {
          var win = clients[address]
          var previous = root.fullscreenStates[address] || 0
          var current = win.fullscreenMode || 0
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
      }
    }
  }

  Process {
    id: ipcLockProc
    command: ["/usr/bin/mkdir", root.serviceLockPath]
    onExited: function(code) {
      if (!root || root.destroyed) return
      if (code === 0) root.becomeIpcOwner()
    }
  }

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
        }
      }
    }
    onExited: {
      if (!root || root.destroyed) return
      root.applying = false
      if (root.pendingAddress && root.pendingAddress !== root.lastHandledAddress) debounce.restart()
    }
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
      if (root && !root.destroyed && code !== 0 && root.hoverBridgeInstalled) {
        root.hoverBridgeInstalled = false
        root.log("could not install floating hover bridge")
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
        if (found.charAt(0) === "/") root.binNode = found
        else root.log("node not found; automatic expansion is disabled")
      }
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!root || root.destroyed || !root.ipcOwner) return
      var eventName = String(event && event.name ? event.name : "")
      if (eventName === "configreloaded") {
        if (root.hoverBridgeInstalled) hoverBridgeReload.restart()
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
      if (eventName !== "activewindowv2" && eventName !== "activewindow") return
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
    function near(): string { root.setMode("near"); return "near" }
    function noExpand(): string { root.setMode("off"); return "off" }
    function width(value: string): string { root.setWidthMultiplier(Number(value)); return String(root.config.widthMultiplier) }
    function height(value: string): string { root.setHeightMultiplier(Number(value)); return String(root.config.heightMultiplier) }
    function widthUp(): string { root.stepWidth(1); return String(root.config.widthMultiplier) }
    function widthDown(): string { root.stepWidth(-1); return String(root.config.widthMultiplier) }
    function heightUp(): string { root.stepHeight(1); return String(root.config.heightMultiplier) }
    function heightDown(): string { root.stepHeight(-1); return String(root.config.heightMultiplier) }
    function hoverDelay(value: string): string { root.setHoverDelay(Number(value)); return String(root.config.hoverDelay) }
    function hoverDelayUp(): string { root.stepHoverDelay(1); return String(root.config.hoverDelay) }
    function hoverDelayDown(): string { root.stepHoverDelay(-1); return String(root.config.hoverDelay) }
    function fullscreenDelay(value: string): string { root.setFullscreenDelay(Number(value)); return String(root.config.fullscreenDelay) }
    function fullscreenDelayUp(): string { root.stepFullscreenDelay(1); return String(root.config.fullscreenDelay) }
    function fullscreenDelayDown(): string { root.stepFullscreenDelay(-1); return String(root.config.fullscreenDelay) }
    function refresh(): string {
      if (root.lastHandledAddress) root.requestRefresh(root.lastHandledAddress)
      else snapshotProbe.running = true
      return "ok"
    }
  }
}
