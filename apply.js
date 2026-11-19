const { execFileSync } = require("node:child_process")
const path = require("node:path")
const M = require(path.join(__dirname, "FocusNowModel.js"))

const focusedAddress = String(process.argv[2] || "")
const widthMultiplier = Number(process.argv[3])
const heightMultiplier = Number(process.argv[4])
const includeFloating = process.argv[5] === "1"
const centerAfter = process.argv[6] === "1"
const hyprctl = String(process.argv[7] || "/usr/bin/hyprctl")
const managedAddress = String(process.argv[8] || "")
const managedMode = String(process.argv[9] || "")
const expandMode = String(process.argv[10] || "near")
if (!focusedAddress || !hyprctl) process.exit(0)

const debug = process.env.FOCUS_NOW_DEBUG === "1"
function trace(message, value) {
  if (debug) console.error("[focus-now]", message, value === undefined ? "" : JSON.stringify(value))
}

const cfg = {
  widthMultiplier: M.nearestMultiplier(widthMultiplier, 0.85),
  heightMultiplier: M.nearestMultiplier(heightMultiplier, 0.85),
  includeFloating
}

function hyprJson(what) {
  return execFileSync(hyprctl, ["-j", what], { encoding: "utf8" })
}

function evalLua(code) {
  execFileSync(hyprctl, ["eval", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function dispatch(command) {
  execFileSync(hyprctl, ["dispatch", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function activeAddress() {
  try {
    return String(JSON.parse(hyprJson("activewindow")).address || "")
  } catch (e) {
    return ""
  }
}

function activeLayout() {
  try {
    return String(JSON.parse(hyprJson("activeworkspace")).tiledLayout || "")
  } catch (e) {
    return ""
  }
}

function clientsByAddress() {
  return M.parseClients(hyprJson("clients"))
}

function prepareFocused(clients) {
  const focused = clients[focusedAddress]
  if (!focused || !focused.fullscreen) return !!focused
  if (M.isManagedFullscreen(focused, managedAddress, managedMode)) {
    if (M.managedFullscreenApplies(focused, managedAddress, managedMode, expandMode, isOnlyWorkspaceWindow(clients))) {
      trace("keeping managed fullscreen state", focused)
      return true
    }
    trace("clearing managed fullscreen state", focused)
    evalLua(M.clearManagedFullscreenEval(focusedAddress, managedMode))
    return true
  }
  trace("preserving user fullscreen state", {
    focused,
    managedAddress,
    managedMode
  })
  return false
}

function isOnlyWorkspaceWindow(clients) {
  const focused = clients[focusedAddress]
  return !!focused && M.workspaceWindows(clients, focused, includeFloating).length === 1
}

function finish(managed) {
  process.stdout.write(JSON.stringify({ address: focusedAddress, managed: String(managed || "") }) + "\n")
}

function maximizeFocused() {
  evalLua(M.setManagedMaximizedEval(focusedAddress))
}

function applyFullscreen() {
  evalLua(M.clearOtherFullscreenEval(focusedAddress))
  evalLua(M.setManagedFullscreenEval(focusedAddress))
}

function cursorPos() {
  try {
    const pos = JSON.parse(hyprJson("cursorpos"))
    return { x: Number(pos.x), y: Number(pos.y) }
  } catch (e) {
    return null
  }
}

function floatingTopInset(focused) {
  if (!M.hasTag(focused, "omarchy-floating-workspace")) return 0
  try {
    const option = JSON.parse(execFileSync(hyprctl, ["getoption", "plugin:hyprbars:bar_height", "-j"], { encoding: "utf8" }))
    return Math.max(0, Number(option.int) || 0)
  } catch (e) {
    return 0
  }
}

function sleep(milliseconds) {
  execFileSync("/usr/bin/sleep", [String(milliseconds / 1000)], { stdio: "ignore" })
}

function hoveredFloatingWindow() {
  for (let i = 0; i < 13; i++) {
    if (activeAddress() !== focusedAddress) return null
    const focused = clientsByAddress()[focusedAddress]
    const cursor = cursorPos()
    const insideWindow = M.pointInsideWindow(focused, cursor, 0, 2)
    const insideContent = M.pointInsideWindow(focused, cursor, floatingTopInset(focused), 2)
    if ((i === 0 && insideWindow) || insideContent) return { focused, cursor }
    if (i < 12) sleep(50)
  }
  return null
}

function applyFloating() {
  const hovered = hoveredFloatingWindow()
  if (!hovered) {
    trace("floating skipped because pointer stayed outside the window")
    return false
  }
  const focused = hovered.focused
  const cursor = hovered.cursor
  const monitors = M.parseMonitors(hyprJson("monitors"))
  const target = M.floatingTarget(focused, monitors, cfg)
  const placement = M.floatingPlacement(focused, target, cursor)
  if (!placement) return false
  evalLua(M.floatingResizeEval(focusedAddress, placement))
  trace("floating applied", placement)
  return true
}

function restoreManagedFloating(address, rect) {
  if (!address || !rect) return false
  const prior = clientsByAddress()[address]
  if (!prior || !prior.floating) return false
  evalLua(M.restoreFloatingEval(address, rect))
  trace("floating restored", { address, rect })
  return true
}

function restorePriorManagedFloating(restoreCurrent) {
  const rect = M.parseManagedFloating(managedMode)
  if (!rect || (managedAddress === focusedAddress && !restoreCurrent)) return false
  return restoreManagedFloating(managedAddress, rect)
}

function applyScrolling() {
  const clients = clientsByAddress()
  const focused = clients[focusedAddress]
  const siblings = focused ? M.workspaceWindows(clients, focused, includeFloating) : []
  const columns = focused ? M.clusterStrips(siblings, "x") : []
  const width = columns.length > 1 ? cfg.widthMultiplier : 1.0
  const center = centerAfter ? 'hl.dispatch(hl.dsp.layout("center"));' : ""
  evalLua(
    'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
    'if w.address == "' + focusedAddress + '" then target = w break end end; ' +
    'if target and target.workspace and target.workspace.tiled_layout == "scrolling" then ' +
    'hl.dispatch(hl.dsp.layout("colresize ' + width + '"));' + center + ' end'
  )
}

function layoutKey(clients) {
  const focused = clients[focusedAddress]
  const windows = focused ? M.workspaceWindows(clients, focused, includeFloating) : []
  return windows
    .map(win => `${win.address}:${Math.round(win.x)}:${Math.round(win.y)}:${Math.round(win.w)}:${Math.round(win.h)}`)
    .sort()
    .join("|")
}

let triedMoveToRoot = false

function promoteToRoot() {
  if (triedMoveToRoot || activeAddress() !== focusedAddress) return false
  const clients = clientsByAddress()
  const focused = clients[focusedAddress]
  if (!focused) return false
  const monitors = M.parseMonitors(hyprJson("monitors"))
  const targets = M.layoutTargets(focused, clients, monitors, cfg)
  if (M.targetReached(focused, targets[focusedAddress])) return false
  triedMoveToRoot = true
  trace("moving to root", { focused, target: targets[focusedAddress] })
  evalLua(M.moveToRootEval())
  return true
}

function stepDwindle() {
  const clients = clientsByAddress()
  const monitors = M.parseMonitors(hyprJson("monitors"))
  const focused = clients[focusedAddress]
  if (!focused || activeAddress() !== focusedAddress) {
    trace("step skipped", { focused: focusedAddress, active: activeAddress() })
    return false
  }
  const plan = M.layoutOps(focused, clients, monitors, cfg)
  trace("plan", plan)
  const ops = plan.ops.slice().sort((a, b) =>
    (Math.abs(b.dx) + Math.abs(b.dy)) - (Math.abs(a.dx) + Math.abs(a.dy)))
  const primary = ops.filter(op => (op.candidate || 0) === 0)
  try {
    if (primary.length) evalLua(M.resizeEval(primary))
  } catch (e) {
    trace("batch dispatch failed", { ops: primary, error: String(e && e.stderr || e) })
  }
  let afterClients = clientsByAddress()
  if (M.targetReached(afterClients[focusedAddress], plan.targets[focusedAddress])) {
    trace("target reached", afterClients[focusedAddress])
    return false
  }
  for (const op of primary) {
    const before = clients[op.address]
    const after = afterClients[op.address]
    trace("op result", { op, before, after })
    if (!(before && after && M.sameSize(before, after, 8))) return true
  }
  for (const op of ops) {
    if ((op.candidate || 0) === 0) continue
    const before = clients[op.address]
    try {
      dispatch(M.resizeCommand(op.address, op.dx, op.dy, op.relative))
    } catch (e) {
      trace("dispatch failed", { op, error: String(e && e.stderr || e) })
      continue
    }
    afterClients = clientsByAddress()
    const after = afterClients[op.address]
    trace("op result", { op, before, after })
    if (!(before && after && M.sameSize(before, after, 8))) return true
  }
  return false
}

try {
  const active = activeAddress()
  trace("start", { focusedAddress, active, expandMode, managedAddress, managedMode })
  if (active !== focusedAddress) process.exit(0)
  restorePriorManagedFloating(expandMode !== "near" || !includeFloating)
  const clients = clientsByAddress()
  if (!prepareFocused(clients)) {
    finish("")
    process.exit(0)
  }
  if (expandMode === "fullscreen") {
    applyFullscreen()
    finish("fullscreen")
    process.exit(0)
  }
  const currentClients = clientsByAddress()
  const focusedNow = currentClients[focusedAddress]
  if (!M.isActionable(focusedNow, includeFloating)) {
    if (managedAddress === focusedAddress) {
      restoreManagedFloating(managedAddress, M.parseManagedFloating(managedMode))
    }
    finish("")
    process.exit(0)
  }
  if (focusedNow.floating) {
    const existingRect = managedAddress === focusedAddress ? M.parseManagedFloating(managedMode) : null
    const applied = applyFloating()
    finish(existingRect ? managedMode : (applied ? M.managedFloatingMode(focusedNow) : ""))
    process.exit(0)
  }
  const layout = activeLayout()
  trace("layout", layout)
  if (layout === "scrolling") {
    applyScrolling()
    finish("")
    process.exit(0)
  }
  const onlyWindow = isOnlyWorkspaceWindow(clientsByAddress())
  trace("only workspace window", onlyWindow)
  if (onlyWindow) {
    maximizeFocused()
    finish("maximized")
    process.exit(0)
  }
  const seenLayouts = new Set()
  for (let i = 0; i < 8; i++) {
    const key = layoutKey(clientsByAddress())
    if (seenLayouts.has(key)) {
      if (promoteToRoot()) continue
      trace("stopping on repeated layout", key)
      break
    }
    seenLayouts.add(key)
    if (!stepDwindle() && !promoteToRoot()) break
  }
  finish("")
} catch (e) {
  trace("fatal", String(e && e.stack || e))
  process.exit(0)
}
