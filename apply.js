#!/usr/bin/env node

const { spawnSync } = require("node:child_process")
const path = require("node:path")
const Model = require(path.join(__dirname, "FocusNowModel.js"))

const [address, widthValue, heightValue, floatingValue, centerValue, hyprctlPath,
  priorAddress, priorMode, requestedMode, stickyValue] = process.argv.slice(2)
const requestedAddress = String(address || "")
const hyprctl = String(hyprctlPath || "/usr/bin/hyprctl")
const expandMode = String(requestedMode || "near")
const includeFloating = floatingValue === "1"
const stickyFullscreen = stickyValue === "1"
const previousAddress = String(priorAddress || "")
const previousMode = String(priorMode || "")
const options = {
  widthMultiplier: Model.nearestMultiplier(Number(widthValue), 0.85),
  heightMultiplier: Model.nearestMultiplier(Number(heightValue), 0.85),
  includeFloating
}

if (!requestedAddress || !hyprctl) process.exit(0)

function call(argumentsList) {
  const result = spawnSync(hyprctl, argumentsList, { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || "hyprctl failed")
  return result.stdout || ""
}

function json(name) {
  return call(["-j", name])
}

function lua(source) {
  call(["eval", source])
}

function dispatch(source) {
  call(["dispatch", source])
}

function snapshot() {
  const clients = Model.parseClients(json("clients"))
  return clients || {}
}

function monitors() {
  return Model.parseMonitors(json("monitors"))
}

function active() {
  const window = Model.parseActiveWindow(json("activewindow"))
  return window ? String(window.address || "") : ""
}

function layoutName(clients) {
  const target = clients[requestedAddress]
  const workspaceId = target && target.workspaceId
  if (workspaceId === undefined || workspaceId === null) return ""
  const workspaces = Model.parseJson(json("workspaces"), [])
  const match = (workspaces || []).find(candidate =>
    candidate && (candidate.id === workspaceId || candidate.name === workspaceId))
  return match ? String(match.tiledLayout || "") : ""
}

function emit(mode) {
  process.stdout.write(JSON.stringify({ address: requestedAddress, managed: String(mode || "") }) + "\n")
}

function delay(milliseconds) {
  spawnSync("/usr/bin/sleep", [String(milliseconds / 1000)], { stdio: "ignore" })
}

function titleInset(window) {
  if (!Model.hasTag(window, "omarchy-floating-workspace")) return 0
  try {
    const setting = Model.parseJson(call(["getoption", "plugin:hyprbars:bar_height", "-j"]), {})
    return Math.max(0, Number(setting.int) || 0)
  } catch (_) {
    return 0
  }
}

function cursor() {
  const position = Model.parseJson(json("cursorpos"), null)
  return position ? { x: Number(position.x), y: Number(position.y) } : null
}

function onlyWindow(clients) {
  const target = clients[requestedAddress]
  return !!target && Model.workspaceWindows(clients, target, includeFloating).length === 1
}

function restoreRectangle(targetAddress, rectangle) {
  const window = targetAddress ? snapshot()[targetAddress] : null
  if (!window || !window.floating || !rectangle) return false
  lua(Model.restoreFloatingEval(targetAddress, rectangle))
  return true
}

function restorePreviousFloating(restoreCurrent) {
  const rectangle = Model.parseManagedFloating(previousMode)
  if (!rectangle || (previousAddress === requestedAddress && !restoreCurrent)) return
  restoreRectangle(previousAddress, rectangle)
}

function allowManagedMode(target, clients) {
  if (!target || !target.fullscreen) return !!target
  if (expandMode === "fullscreen" &&
      Model.isManagedFullscreen(target, requestedAddress, "fullscreen")) return true
  if (!Model.isManagedFullscreen(target, previousAddress, previousMode)) return false
  if (Model.managedFullscreenApplies(target, previousAddress, previousMode, expandMode, onlyWindow(clients))) return true
  lua(Model.clearManagedFullscreenEval(requestedAddress, previousMode))
  return true
}

function applyFullscreenMode() {
  if (!stickyFullscreen) lua(Model.clearOtherFullscreenEval(requestedAddress))
  lua(Model.setManagedFullscreenEval(requestedAddress))
  emit("fullscreen")
}

function hoveredWindow() {
  for (let attempt = 0; attempt < 13; attempt++) {
    if (active() !== requestedAddress) return null
    const window = snapshot()[requestedAddress]
    const pointer = cursor()
    const inFrame = Model.pointInsideWindow(window, pointer, 0, 2)
    const inClientArea = Model.pointInsideWindow(window, pointer, titleInset(window), 2)
    if ((attempt === 0 && inFrame) || inClientArea) return { window, pointer }
    if (attempt < 12) delay(50)
  }
  return null
}

function applyFloatingMode(target) {
  const hovered = hoveredWindow()
  if (!hovered) return false
  const area = Model.floatingTarget(hovered.window, monitors(), options)
  const rectangle = Model.floatingPlacement(hovered.window, area, hovered.pointer)
  if (!rectangle) return false
  lua(Model.floatingResizeEval(requestedAddress, rectangle))
  return true
}

function applyScrollingMode() {
  const clients = snapshot()
  const target = clients[requestedAddress]
  const columns = target ? Model.clusterStrips(Model.workspaceWindows(clients, target, includeFloating), "x") : []
  const share = columns.length > 1 ? options.widthMultiplier : 1
  const selector = 'w.address == "' + requestedAddress + '"'
  lua(
    'local target = nil; for _, w in ipairs(hl.get_windows()) do if ' + selector +
    ' then target = w break end end; if target and target.workspace and ' +
    'target.workspace.tiled_layout == "scrolling" then hl.dispatch(hl.dsp.layout("colresize ' +
    share + '")) end'
  )
}

function workspaceFingerprint(clients) {
  const target = clients[requestedAddress]
  return Model.workspaceWindows(clients, target || {}, includeFloating)
    .map(window => [window.address, window.x, window.y, window.w, window.h].map(Math.round).join(":"))
    .sort()
    .join("|")
}

let rootPromotionUsed = false
function promoteToRoot() {
  if (rootPromotionUsed || active() !== requestedAddress) return false
  const clients = snapshot()
  const target = clients[requestedAddress]
  if (!target) return false
  const plan = Model.layoutTargets(target, clients, monitors(), options)
  if (Model.targetReached(target, plan[requestedAddress])) return false
  rootPromotionUsed = true
  lua(Model.moveToRootEval())
  return true
}

function applyOneLayoutPass() {
  const clients = snapshot()
  const target = clients[requestedAddress]
  if (!target || active() !== requestedAddress) return false
  const plan = Model.layoutOps(target, clients, monitors(), options)
  const first = plan.ops.filter(operation => (operation.candidate || 0) === 0)

  if (first.length) lua(Model.resizeEval(first))
  const afterFirst = snapshot()
  if (Model.targetReached(afterFirst[requestedAddress], plan.targets[requestedAddress])) return false
  if (first.some(operation => !Model.sameSize(clients[operation.address], afterFirst[operation.address], 8))) return true

  const alternatives = plan.ops
    .filter(operation => (operation.candidate || 0) !== 0)
    .sort((left, right) => Math.abs(right.dx) + Math.abs(right.dy) - Math.abs(left.dx) - Math.abs(left.dy))
  for (const operation of alternatives) {
    try {
      dispatch(Model.resizeCommand(operation.address, operation.dx, operation.dy, operation.relative))
    } catch (_) {
      continue
    }
    const after = snapshot()
    if (!Model.sameSize(clients[operation.address], after[operation.address], 8)) return true
  }
  return false
}

try {
  if (active() !== requestedAddress) process.exit(0)
  const initial = snapshot()
  const previousWindow = previousAddress ? initial[previousAddress] : null
  const targetWindow = initial[requestedAddress]
  const sameWorkspace = !!(previousWindow && targetWindow &&
    String(previousWindow.workspaceId) === String(targetWindow.workspaceId))
  if (sameWorkspace) restorePreviousFloating(expandMode !== "near" || !includeFloating)
  if (sameWorkspace && !(stickyFullscreen && expandMode === "fullscreen") &&
      previousAddress && previousAddress !== requestedAddress &&
      (previousMode === "fullscreen" || previousMode === "maximized")) {
    lua(Model.clearManagedFullscreenEval(previousAddress, previousMode))
  }
  if (!allowManagedMode(initial[requestedAddress], initial)) {
    emit("")
    process.exit(0)
  }

  if (expandMode === "fullscreen") {
    applyFullscreenMode()
    process.exit(0)
  }

  lua(Model.clearOtherFullscreenEval(requestedAddress))

  const current = snapshot()[requestedAddress]
  if (!Model.isActionable(current, includeFloating)) {
    if (previousAddress === requestedAddress) restoreRectangle(previousAddress, Model.parseManagedFloating(previousMode))
    emit("")
    process.exit(0)
  }

  if (current.floating) {
    const savedRectangle = previousAddress === requestedAddress ? Model.parseManagedFloating(previousMode) : null
    const applied = applyFloatingMode(current)
    emit(savedRectangle ? previousMode : (applied ? Model.managedFloatingMode(current) : ""))
    process.exit(0)
  }

  if (layoutName(snapshot()) === "scrolling") {
    applyScrollingMode()
    emit("")
    process.exit(0)
  }

  if (onlyWindow(snapshot())) {
    lua(Model.setManagedMaximizedEval(requestedAddress))
    emit("maximized")
    process.exit(0)
  }

  const fingerprints = new Set()
  for (let pass = 0; pass < 8; pass++) {
    const fingerprint = workspaceFingerprint(snapshot())
    if (fingerprints.has(fingerprint)) {
      if (promoteToRoot()) continue
      break
    }
    fingerprints.add(fingerprint)
    if (!applyOneLayoutPass() && !promoteToRoot()) break
  }
  emit("")
} catch (_) {
  process.exit(0)
}
