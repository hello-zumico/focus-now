#!/usr/bin/env node

const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const Model = require(path.join(__dirname, "FocusNowModel.js"))

const [address, widthValue, heightValue, floatingValue, centerValue, hyprctlPath,
  priorAddress, priorMode, requestedMode, stickyValue, collapseValue,
  animateValue, animateSpeedValue] = process.argv.slice(2)
const requestedAddress = String(address || "")
const hyprctl = String(hyprctlPath || "/usr/bin/hyprctl")
const expandMode = String(requestedMode || "near")
const includeFloating = floatingValue === "1"
const stickyFullscreen = stickyValue === "1"
const animateLayout = animateValue !== "0"
const animateSpeedMs = Model.normalizeAnimateSpeed(animateSpeedValue)
const previousAddress = String(priorAddress || "")
const previousMode = String(priorMode || "")
const options = {
  widthMultiplier: Model.nearestMultiplier(Number(widthValue), 0.85),
  heightMultiplier: Model.nearestMultiplier(Number(heightValue), 0.85),
  collapseSize: Model.normalizeCollapseSize(collapseValue),
  includeFloating
}

if (!requestedAddress || !hyprctl) process.exit(0)

// The service kills applies at 8s; stop looping early enough to still
// reach the final emit, which is what arms (or clears) the repair chain.
const RUN_STARTED_MS = Date.now()
const RUN_DEADLINE_MS = RUN_STARTED_MS + 6500

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
  // Topology-changing dispatches invalidate every cached split tree — a
  // stale seam→controller map emits ops on the wrong side of a seam and
  // crushes windows.
  if (/movetoroot|togglesplit|movesplit|swapwindow|movewindow|splitratio/.test(source)) {
    bustTreeCache()
  }
  call(["eval", source])
}

function dispatch(source) {
  if (/movetoroot|togglesplit|movesplit|swapwindow|movewindow|splitratio/.test(source)) {
    bustTreeCache()
  }
  call(["dispatch", source])
}

// Probing and the animate=off mode mute compositor animations. The service
// wraps apply.js in `timeout`, so a kill mid-run must not leave animations
// off: restore on any exit path, including signals.
let animationsMuted = false
function restoreAnimations() {
  if (!animationsMuted) return
  animationsMuted = false
  try { lua("hl.config({ animations = { enabled = true } })") } catch (_) {}
}
function muteAnimations() {
  try {
    lua("hl.config({ animations = { enabled = false } })")
    animationsMuted = true
  } catch (_) {}
}
// The service wraps apply.js in `timeout`, so a kill mid-run can land while
// repair work is unfinished — and without a final emit the service's
// repair-retry chain never arms, leaving damage on screen with nothing
// scheduled to fix it. Emit a repair flag on any exit that skipped the
// normal emit; the retried apply re-evaluates the real state and clears the
// flag itself when nothing is left to do.
let emitted = false
let repairOnKill = false
function emitRepairOnKill() {
  if (emitted || !repairOnKill || !requestedAddress || foreignManaged) return
  emitted = true
  try {
    fs.writeSync(1, JSON.stringify({
      address: requestedAddress, managed: "", repair: true
    }) + "\n")
  } catch (_) {}
}
function cleanupOnExit() {
  restoreAnimations()
  emitRepairOnKill()
}
process.on("exit", cleanupOnExit)
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => process.exit(1))
}

function snapshot() {
  const clients = Model.parseClients(json("clients"))
  return clients || {}
}

let cachedMonitors = null
function monitors() {
  if (!cachedMonitors) cachedMonitors = Model.parseMonitors(json("monitors"))
  return cachedMonitors
}

function active() {
  const window = Model.parseActiveWindow(json("activewindow"))
  return window ? String(window.address || "") : ""
}

function workspaceRecord(target) {
  const workspaceId = target && target.workspaceId
  if (workspaceId === undefined || workspaceId === null) return null
  const workspaces = Model.parseJson(json("workspaces"), [])
  return (workspaces || []).find(candidate =>
    candidate && (candidate.id === workspaceId || candidate.name === workspaceId)) || null
}

function layoutName(clients) {
  const match = workspaceRecord(clients[requestedAddress])
  if (!match) return ""
  // The workspaces-json tiledLayout field can lag a layout switch; the live
  // workspace object's tiled_layout is authoritative.
  try {
    const result = spawnSync(hyprctl,
      ["eval", "local w = hl.get_workspace(" + JSON.stringify(String(match.name)) +
       "); error(tostring(w and w.tiled_layout))"],
      { encoding: "utf8" })
    const text = String((result.stderr || "") + (result.stdout || ""))
    const m = text.match(/\]:\d+: (\S+)/)
    if (m && m[1] !== "nil") return m[1]
  } catch (_) {}
  return String(match.tiledLayout || "")
}

// The layout persists its slot structure (ordered member lists per slot) so
// apply can preserve stack membership instead of inferring it from
// overlapping-rect geometry, which fails when members share an exact rect.
const COLUMNS_STATE_PATH = (process.env.HOME || "") + "/.local/state/focus-now-columns.txt"
function slotStructure(wsName) {
  try {
    const text = fs.readFileSync(COLUMNS_STATE_PATH, "utf8")
    let inWs = false
    const cols = []
    for (const line of text.split("\n")) {
      const parts = line.split("\t")
      if (parts[0] === "ws") {
        inWs = parts[1] === wsName
      } else if (inWs && parts[0] === "col") {
        cols[Number(parts[1]) - 1] = (parts[2] || "").split(" ").filter(Boolean)
      }
    }
    return cols.filter(Boolean)
  } catch (_) {
    return []
  }
}

function emit(mode) {
  // A managed window can hold fullscreen state on its own workspace while an
  // apply runs elsewhere. Emitting here would overwrite the service's single
  // managed-address slot and orphan that window's tracking, so cross-workspace
  // applies stay silent and leave the tracked state untouched.
  if (foreignManaged) return
  emitted = true
  const payload = { address: requestedAddress, managed: String(mode || "") }
  if (arguments.length > 1 && arguments[1]) payload.repair = true
  process.stdout.write(JSON.stringify(payload) + "\n")
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
  const windows = target ? Model.workspaceWindows(clients, target, includeFloating) : []
  const columns = target ? Model.clusterStrips(windows, "x") : []
  const share = columns.length > 1 ? options.widthMultiplier : 1
  const mon = target ? Model.monitorForWindow(target, monitors()) : null
  const wa = mon && mon.wa
  let gaps = [0, 0, 0, 0]
  try {
    const gapOpt = Model.parseJson(call(["getoption", "general:gaps_out", "-j"]), null)
    if (gapOpt && typeof gapOpt.css === "string") {
      const parts = gapOpt.css.trim().split(/\s+/).map(Number)
      if (parts.length >= 4 && parts.slice(0, 4).every(n => Number.isFinite(n))) gaps = parts.slice(0, 4)
    }
  } catch (_) {}
  const areaW = wa ? wa.w - gaps[3] - gaps[1] : 0
  const collapseShare = areaW > 0 ? Math.min(0.5, Math.max(0.005, options.collapseSize / areaW)) : 0.02
  // Same contract as the tiled layouts: collapse every sibling column to
  // collapseSize, then expand the focused column to its share. colresize acts
  // on the focused column, so each sibling is focused in turn; focus returns
  // to the target at the end.
  const ops = []
  for (const strip of columns) {
    if (strip.windows.some(w => w.address === requestedAddress)) continue
    const win = strip.windows.find(w => !w.floating)
    if (!win) continue
    ops.push(
      'hl.dispatch(hl.dsp.focus({ window = "address:' + win.address + '" }))',
      'hl.dispatch(hl.dsp.layout("colresize ' + collapseShare + '"))'
    )
  }
  ops.push(
    'hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" }))',
    'hl.dispatch(hl.dsp.layout("colresize ' + share + '"))'
  )
  lua(
    'local target = nil; for _, w in ipairs(hl.get_windows()) do if ' +
    'w.address == "' + requestedAddress + '" then target = w break end end; ' +
    'if target and target.workspace and target.workspace.tiled_layout == "scrolling" then ' +
    ops.join('; ') + ' end'
  )
}

function workspaceFingerprint(clients) {
  const target = clients[requestedAddress]
  return Model.workspaceWindows(clients, target || {}, includeFloating)
    .map(window => [window.address, window.x, window.y, window.w, window.h].map(Math.round).join(":"))
    .sort()
    .join("|")
}

let foreignManaged = false
// A resize that moved a window counts as progress only when it moved toward
// the layout target; a step that pushed it further away is undone, because
// the direction a delta takes a window depends on its slot in the split tree.
function movedTowardTarget(before, after, want) {
  if (!before || !after || !want) return false
  const distance = function(win) {
    return Math.abs(win.w - (want.w > 0 ? want.w : win.w)) +
      Math.abs(win.h - (want.h > 0 ? want.h : win.h))
  }
  return distance(after) + 2 < distance(before)
}

const DAMAGE_SIZE = 24
const FLOOR_GUARD = Math.max(DAMAGE_SIZE, options.collapseSize - 9)
// An op is unsafe when it collapses a tiled window on the workspace past the
// collapse floor or into a non-positive size that corrupts the split tree.
function collateralDamage(before, after, target) {
  for (const address in after) {
    const win = after[address]
    const prev = before[address]
    if (!win || !prev || win.floating) continue
    if (String(win.workspaceId) !== String(target.workspaceId)) continue
    if (win.w < 1 || win.h < 1) return win
    if ((win.w < FLOOR_GUARD && win.w + 2 < prev.w) ||
        (win.h < FLOOR_GUARD && win.h + 2 < prev.h)) return win
  }
  return null
}

// Dwindle clamps splitRatio to [0.1, 1.9], so a large delta may move a window
// by less than requested; reversing with the full delta would overshoot toward
// the opposite clamp. Undo using the measured change on the target window.
function undoResize(operation, beforeWin, afterWin) {
  const dx = operation.dx
    ? (beforeWin && afterWin
        ? -Math.sign(operation.dx) * Math.round(Math.abs(afterWin.w - beforeWin.w))
        : -operation.dx)
    : 0
  const dy = operation.dy
    ? (beforeWin && afterWin
        ? -Math.sign(operation.dy) * Math.round(Math.abs(afterWin.h - beforeWin.h))
        : -operation.dy)
    : 0
  if (!dx && !dy) return
  try {
    lua("hl.dispatch(" + Model.resizeCommand(operation.address, dx, dy, operation.relative) + ")")
  } catch (_) {}
}

// A window collapsed to a sliver or non-positive size sits on a skewed or
// corrupted split node that resize undos cannot reach. Resetting the node's
// ratio to even repairs it; the ratio dispatch only applies to the focused
// window's parent, so each damaged window is focused and reset inside a
// single Lua batch and the target refocused at the end.
const HEAL_COOLDOWN_PATH = "/tmp/focus-now-heals.json"
const REORIENT_COOLDOWN_PATH = "/tmp/focus-now-reorients.json"
const REBUILD_COOLDOWN_PATH = "/tmp/focus-now-rebuilds.json"
const HEAL_COOLDOWN_MS = 900
// Rebuilds churn the whole workspace; rung-3+ escalation and the post-apply
// check share this much longer window so legitimate mid-convergence shapes
// are never reset.
const REBUILD_COOLDOWN_MS = 25000

function cooledRecently(path, address, ms) {
  try {
    const marks = Model.parseJson(fs.readFileSync(path, "utf8"), {}) || {}
    return !!marks[address] && Date.now() - marks[address] < (ms || HEAL_COOLDOWN_MS)
  } catch (_) {
    return false
  }
}

function markCooled(path, addresses) {
  let marks = {}
  try {
    marks = Model.parseJson(fs.readFileSync(path, "utf8"), {}) || {}
  } catch (_) {}
  try {
    const now = Date.now()
    for (const address of addresses) marks[address] = now
    fs.writeFileSync(path, JSON.stringify(marks))
  } catch (_) {}
}

const TRACE_PATH = "/tmp/focus-now-trace.log"
function trace(msg) {
  try {
    fs.appendFileSync(TRACE_PATH, new Date().toISOString().slice(11, 23) + " " + msg + "\n")
  } catch (_) {}
}

// Multiple apply.js invocations overlap (one per service event). Concurrent
// runs interleave dispatches and race the cooldown files — a repair pass in
// one run gets flipped back by the next run before its mark lands. Serialize
// the apply with a mkdir lock so each run sees the other's finished state.
const LOCK_PATH = "/tmp/focus-now.lock"
function acquireLock(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(LOCK_PATH)
      return true
    } catch (e) {
      if (e.code !== "EEXIST") return false
      try {
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 30000) {
          fs.rmdirSync(LOCK_PATH)
          continue
        }
      } catch (_) { continue }
      if (Date.now() >= deadline) return false
      const until = Date.now() + 20
      while (Date.now() < until) {}
    }
  }
}
function releaseLock() {
  try { fs.rmdirSync(LOCK_PATH) } catch (_) {}
}

function healedRecently(address) {
  return cooledRecently(HEAL_COOLDOWN_PATH, address)
}

function markHealed(addresses) {
  markCooled(HEAL_COOLDOWN_PATH, addresses)
}

function damagedWindows(target, clients, except) {
  const damaged = {}
  for (const address in clients) {
    const win = clients[address]
    if (!win || win.floating || (except && except[address])) continue
    if (String(win.workspaceId) !== String(target.workspaceId)) continue
    if (win.w < DAMAGE_SIZE || win.h < DAMAGE_SIZE) damaged[address] = win
  }
  return damaged
}

// A window pushed under the damage floor is the one failure no ratio reset
// reaches — growing it back is a pure-additive repair that cannot damage
// its neighbors (they clamp at their own floors). Anything above the floor
// is the equalizer's job.
function rescueNegatives(target, clients) {
  if (!target) return false
  const ws = String(target.workspaceId)
  const damaged = []
  for (const address in clients) {
    const win = clients[address]
    if (!win || win.floating || win.address === target.address) continue
    if (String(win.workspaceId) !== ws) continue
    // Absolute resizes land exactly — a relative grow on a right/bottom
    // child can answer with a shrink and spiral into more negatives.
    const nw = win.w < FLOOR_GUARD ? options.collapseSize : 0
    const nh = win.h < FLOOR_GUARD ? options.collapseSize : 0
    if (nw || nh) damaged.push([address, nw || win.w, nh || win.h])
  }
  if (!damaged.length) return false
  const emit = list =>
    lua(list.map(([a, w, h]) => "hl.dispatch(" + Model.resizeCommand(a, w, h, false) + ")").join("; "))
  trace("RESCUE " + damaged.map(([a, w, h]) => a.slice(-6) + " =" + w + "/" + h).join(" "))
  try {
    emit(damaged)
  } catch (_) {
    return false
  }
  // Still degenerate after both signs? The window lives inside a broken
  // subtree whose seams can't be moved without wrecking the other axis —
  // reparent it to the root split, where the next pass resizes it cleanly.
  const stuck = []
  for (const [address] of damaged) {
    const win = snapshot()[address]
    if (win && (win.w < FLOOR_GUARD || win.h < FLOOR_GUARD)) stuck.push(address)
  }
  if (stuck.length) {
    const cmds = []
    for (const address of stuck) {
      cmds.push('hl.dispatch(hl.dsp.focus({ window = "address:' + address + '" }))')
      cmds.push('hl.dispatch(hl.dsp.layout("movetoroot"))')
    }
    cmds.push('hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" }))')
    try {
      lua(cmds.join("; "))
    } catch (_) {}
  }
  return true
}

function healDegenerate(target, knownClients, except) {
  if (!target) return false
  // A window that keeps re-damaging after healing is stuck on a node the
  // ratio reset cannot fix — cooldown it instead of looping heal → refocus
  // applies forever.
  const damaged = damagedWindows(target, knownClients || snapshot(), except)
  // The focused window is always healable even when it was already damaged
  // going in — the user is looking at it.
  const liveTarget = (knownClients || snapshot())[target.address]
  if (liveTarget && !liveTarget.floating &&
      (liveTarget.w < DAMAGE_SIZE || liveTarget.h < DAMAGE_SIZE)) {
    damaged[target.address] = liveTarget
  }
  let hasSliver = false
  for (const address in damaged) { hasSliver = true; break }
  if (!hasSliver) return false
  const now = knownClients ? snapshot() : (knownClients || snapshot())
  const nowDamaged = damagedWindows(target, now, except)
  const t = now[target.address]
  if (t && !t.floating && (t.w < DAMAGE_SIZE || t.h < DAMAGE_SIZE)) nowDamaged[target.address] = t
  const commands = []
  const healedAddresses = []
  for (const address in nowDamaged) {
    if (healedRecently(address)) continue
    trace("HEAL " + address.slice(-6) + " " + nowDamaged[address].w + "x" + nowDamaged[address].h)
    commands.push('hl.dispatch(hl.dsp.focus({ window = "address:' + address + '" }))')
    commands.push('hl.dispatch(hl.dsp.layout("splitratio 1 exact"))')
    healedAddresses.push(address)
  }
  if (!commands.length) return false
  commands.push('hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" }))')
  // Mark before dispatching: a concurrent apply must see the heal attempt
  // even while this run's layout is still settling.
  markHealed(healedAddresses)
  try {
    lua(commands.join("; "))
  } catch (_) {
    return false
  }
  // Escalation: a splitratio reset does nothing for a leaf under a collapsed
  // parent split. Rotate the subtree (togglesplit) and reset again, then
  // reparent to root as the last resort — same ladder rescueNegatives uses.
  const still = damagedWindows(target, snapshot(), except)
  const stubborn = []
  for (const address in still) {
    if (healedAddresses.indexOf(address) < 0) continue
    stubborn.push(address)
  }
  if (!stubborn.length) return true
  const flipCmds = []
  for (const address of stubborn) {
    flipCmds.push('hl.dispatch(hl.dsp.focus({ window = "address:' + address + '" }))')
    flipCmds.push('hl.dispatch(hl.dsp.layout("togglesplit"))')
    flipCmds.push('hl.dispatch(hl.dsp.layout("splitratio 1 exact"))')
  }
  flipCmds.push('hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" }))')
  try {
    lua(flipCmds.join("; "))
  } catch (_) {
    return true
  }
  const afterFlip = damagedWindows(target, snapshot(), except)
  const stuckNow = []
  for (const address in afterFlip) stuckNow.push(address)
  if (!stuckNow.length) return true
  // A leaf whose own size went negative stays poisoned through every split
  // op — reinserts and rebuilds derive its region from the broken size.
  // Floating honors exact resizes: float it, give it a sane box, re-tile.
  const floatCmds = []
  for (const address of stuckNow) {
    floatCmds.push('hl.dispatch(hl.dsp.window.float({ window = "address:' + address + '" }))')
    floatCmds.push('hl.dispatch(hl.dsp.window.resize({ window = "address:' + address +
      '", x = 640, y = 400, relative = false }))')
    floatCmds.push('hl.dispatch(hl.dsp.window.float({ window = "address:' + address + '" }))')
  }
  floatCmds.push('hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" }))')
  try {
    lua(floatCmds.join("; "))
  } catch (_) {
    return true
  }
  const afterFloat = damagedWindows(target, snapshot(), except)
  let stillBroken = false
  for (const address in afterFloat) { stillBroken = true; break }
  if (!stillBroken) return true
  return rebuildWorkspaceTree(target, "damaged=" + Object.keys(afterFloat).map(a => a.slice(-6)).join(",")) ? 2 : true
}

const FLATTEN_COOLDOWN_PATH = "/tmp/focus-now-flatten.json"
const FLATTEN_COOLDOWN_MS = 4000

// A tree whose leaves all share one axis's outer span is a comb — every seam
// is leaf-controlled, so a wedge there is either still converging or pinned
// by an app-level minimum; flattening only reorders windows it cannot help.
function combGeom(clients, wsId) {
  const ws = []
  for (const a in clients) {
    const w = clients[a]
    if (w && !w.floating && String(w.workspaceId) === String(wsId)) ws.push(w)
  }
  if (ws.length < 3) return true
  const same = f => ws.every(w => Math.abs(f(w) - f(ws[0])) <= 14)
  return (same(w => w.x) && same(w => w.x + w.w)) ||
         (same(w => w.y) && same(w => w.y + w.h))
}

// A wedged dwindle tree where the focused window is buried under a sibling's
// region cannot be opened leaf-by-leaf — movetoroot on just the focused
// window collapses its ex-mates into degenerate nodes. Reparenting EVERY
// window to the root produces a flat comb where every seam is reachable.
function flattenWorkspaceTree(target, why) {
  const ws = String(target.workspaceId)
  if (cooledRecently(FLATTEN_COOLDOWN_PATH, ws, FLATTEN_COOLDOWN_MS)) return false
  markCooled(FLATTEN_COOLDOWN_PATH, [ws])
  trace("FLATTEN ws" + ws + " " + why)
  const snap = snapshot()
  const cmds = []
  for (const a in snap) {
    const w = snap[a]
    if (!w || w.floating || String(w.workspaceId) !== ws) continue
    cmds.push('hl.dispatch(hl.dsp.focus({ window = "address:' + a + '" }))')
    cmds.push('hl.dispatch(hl.dsp.layout("movetoroot"))')
  }
  if (cmds.length < 4) return false
  cmds.push('hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" }))')
  try {
    lua(cmds.join("; "))
    return true
  } catch (_) { return false }
}

// A dwindle tree can be split into shapes the seam machinery cannot fix —
// zero-size internal nodes poison every child under them, and nested splits
// pin siblings above the collapse floor. Cycling the workspace through
// scrolling clamps every window back to a sane column width, so the dwindle
// tree it returns to is rebuilt from clean geometry. Cooldown-bound: the
// rebuild is visible churn.
function rebuildWorkspaceTree(target, why) {
  const ws = String(target.workspaceId)
  if (cooledRecently(REBUILD_COOLDOWN_PATH, ws, REBUILD_COOLDOWN_MS)) return false
  markCooled(REBUILD_COOLDOWN_PATH, [ws])
  trace("REBUILD ws" + ws + " " + why)
  try {
    lua('o.workspace_mode({ workspace = "' + ws + '", mode = "scrolling" })')
    lua('o.workspace_mode({ workspace = "' + ws + '", mode = "dwindle" })')
  } catch (_) {
    return false
  }
  return true
}

// Dwindle's ratio clamps give each nested sliver its own minimum width, so
// collapsed columns land at uneven sizes and shrinking past the floor is a
// no-op. Growth is the only direction the compositor reliably honors (it
// pulls from the wider subtree), so slivers are equalized upward toward the
// widest one. Seam sign varies with position, so both directions are tried
// per op and verified against a fresh snapshot.
function collapsedSlivers(target, clients, columns) {
  const slivers = []
  for (const address in clients) {
    const win = clients[address]
    if (!win || win.floating || win.address === target.address) continue
    if (String(win.workspaceId) !== String(target.workspaceId)) continue
    // Collect slivers below the collapse floor too — equalization itself can
    // squeeze a sibling under it, and a sub-floor sliver is a hidden window.
    if (columns) {
      if (win.h >= win.w * 3 && win.w <= 200 && win.w >= DAMAGE_SIZE) slivers.push(win)
    } else {
      if (win.w >= win.h * 3 && win.h <= 200 && win.h >= DAMAGE_SIZE) slivers.push(win)
    }
  }
  return slivers
}

// A collapsed sliver only honors the collapse size when its split node leaves
// it room: a column pinned above the floor shares a big region with the
// expanded window (the floor is a fraction of the region, not a pixel size),
// and a band squeezed under the damage threshold sits in a stack with no
// vertical room left. Either way, flipping the node moves the window to the
// axis that has capacity — oversized columns become bands at the collapse
// size, damaged bands become columns with a real floor. The focus dispatches
// refire applies that converge the reoriented windows.
// togglesplit rotates the window's parent node, which rotates the parent's
// whole sibling subtree too. When that sibling is itself a split (a nested
// pair or stack), one reorient drags every window inside it to the other
// axis — typically into a region that cannot fit them, so the next apply
// reorients them back and the whole cluster oscillates. Only a window whose
// sibling is a leaf can flip without rotating a subtree.
// Returns the node in the cached axis tree whose child is the leaf strip
// containing address — i.e. the split togglesplit would rotate. Null when
// no cached tree describes a leaf parent (unknown topology).
function leafParentNode(address, axis, addresses) {
  const cache = readTreeCache()
  const prefix = hyprctl + ":" + axis + ":"
  for (const key in cache) {
    if (key.indexOf(prefix) !== 0) continue
    const spec = key.slice(prefix.length).split(",").map(function(group) { return group.split("+") })
    let leafIdx = -1
    for (let i = 0; i < spec.length; i++) {
      if (spec[i].indexOf(address) !== -1) { leafIdx = i; break }
    }
    if (leafIdx < 0) continue
    // Stale caches from other window sets can describe the wrong parent.
    let foreign = false
    for (let i = 0; i < spec.length; i++) {
      for (let j = 0; j < spec[i].length; j++) {
        if (addresses.indexOf(spec[i][j]) === -1) { foreign = true; break }
      }
      if (foreign) break
    }
    if (foreign) continue
    const stack = [cache[key]]
    while (stack.length) {
      const node = stack.pop()
      if (!node || node.leaf !== undefined) continue
      if (node.left && node.left.leaf === leafIdx) return { node: node, left: true }
      if (node.right && node.right.leaf === leafIdx) return { node: node, left: false }
      if (node.left) stack.push(node.left)
      if (node.right) stack.push(node.right)
    }
  }
  return null
}

function siblingIsLeaf(address, axis, addresses) {
  const found = leafParentNode(address, axis, addresses)
  if (!found) return true
  const sibling = found.left ? found.node.right : found.node.left
  return sibling && sibling.leaf !== undefined
}

// A strip narrower than its members' lane minimum is structurally deficient:
// side-by-side members inside it cannot all reach the collapse floor. The
// fix is rotating a side-by-side split INSIDE the strip so those members
// stack as bands instead. The flip target is the member disjoint from the
// most others — togglesplitting it rotates the highest internal split.
// A pure vertical stack (no x-disjoint pair) shares one lane and just needs
// width, which the seam ops handle — flipping it would only scramble the
// region.
function reorientCrampedRegions(target, clients) {
  if (!target) return false
  const need = options.collapseSize
  const wsId = String(target.workspaceId)
  const windows = []
  for (const address in clients) {
    const w = clients[address]
    if (w && !w.floating && String(w.workspaceId) === wsId && w.address !== target.address) {
      windows.push(w)
    }
  }
  const x1 = w => Math.min(w.x, w.x + w.w), x2 = w => Math.max(w.x, w.x + w.w)
  const xDisjoint = (a, b) => x2(a) <= x1(b) || x2(b) <= x1(a)
  for (const strip of Model.clusterStrips(windows, "x")) {
    if (strip.windows.length < 2) continue
    const span = strip.a2 - strip.a1
    if (span >= Model.minWindowsSpan(strip.windows, "x", need)) continue
    let flip = null
    let flipCount = 0
    for (const win of strip.windows) {
      let count = 0
      for (const o of strip.windows) if (o !== win && xDisjoint(o, win)) count++
      if (count > flipCount) { flip = win; flipCount = count }
    }
    if (!flip || flip.address === target.address) continue
    if (cooledRecently(REORIENT_COOLDOWN_PATH, flip.address)) continue
    trace("CRAMPED strip " + Math.round(strip.a1) + "-" + Math.round(strip.a2) +
          " members=" + strip.windows.map(w => w.address.slice(-6)).join(",") +
          " flip=" + flip.address.slice(-6) + " " + flip.w + "x" + flip.h)
    markCooled(REORIENT_COOLDOWN_PATH, [flip.address])
    try {
      lua([
        'hl.dispatch(hl.dsp.focus({ window = "address:' + flip.address + '" }))',
        'hl.dispatch(hl.dsp.layout("togglesplit"))',
        'hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" }))'
      ].join("; "))
    } catch (_) {
      return false
    }
    return true
  }
  return false
}

function reorientOversizedSlivers(target, clients, preClients) {
  if (!target) return false
  const limit = options.collapseSize + 20
  const commands = []
  const reoriented = []
  const flippedParents = {}
  const addresses = []
  for (const address in clients) {
    const win = clients[address]
    if (!win || win.floating || win.address === target.address) continue
    if (String(win.workspaceId) !== String(target.workspaceId)) continue
    addresses.push(address)
  }
  for (const address in clients) {
    const win = clients[address]
    if (!win || win.floating || win.address === target.address) continue
    if (String(win.workspaceId) !== String(target.workspaceId)) continue
    if (cooledRecently(REORIENT_COOLDOWN_PATH, address)) continue
    const column = win.h >= win.w * 3
    const band = win.w >= win.h * 3
    // A window with a non-positive dimension is broken in both axes —
    // togglesplit only rotates the broken box. It needs a region-level
    // flip (reorientCrampedRegions) or a heal, not a local one.
    if (win.w <= 0 || win.h <= 0) continue
    const damaged = column ? win.w < DAMAGE_SIZE : (band && win.h < DAMAGE_SIZE)
    // An oversized sliver only proves misorientation when its size stayed
    // put through the apply: a sliver still moving is under-converged, not
    // pinned, and a flip would scramble a healthy (if plump) family.
    const pre = preClients && preClients[address]
    if (!damaged && pre && Math.abs(pre.w - win.w) + Math.abs(pre.h - win.h) > 12) continue
    const outOfRange = column ? (win.w < DAMAGE_SIZE || win.w > limit)
                              : (band && (win.h < DAMAGE_SIZE || win.h > limit))
    if (!outOfRange) continue
    // togglesplit rotates the window's immediate parent, and the parent
    // split axis is determined by how the window is separated from its
    // neighbors — not the orientation the window happens to render as.
    // A side-by-side neighbor (shared y-range, disjoint x-range) means an
    // x-split parent; a stacked neighbor means a y-split parent. A
    // band-shaped leaf under a side-by-side split flips to stacked, not
    // to a column.
    // Negative sizes invert the span arithmetic — normalize before
    // comparing so damaged windows still classify their parent split.
    const wx1 = Math.min(win.x, win.x + win.w), wx2 = Math.max(win.x, win.x + win.w)
    const wy1 = Math.min(win.y, win.y + win.h), wy2 = Math.max(win.y, win.y + win.h)
    const hasXSibling = addresses.some(a => {
      if (a === address) return false
      const o = clients[a]
      const ox1 = Math.min(o.x, o.x + o.w), ox2 = Math.max(o.x, o.x + o.w)
      const oy1 = Math.min(o.y, o.y + o.h), oy2 = Math.max(o.y, o.y + o.h)
      return oy1 < wy2 && oy2 > wy1 && (ox1 >= wx2 || ox2 <= wx1)
    })
    const hasYSibling = addresses.some(a => {
      if (a === address) return false
      const o = clients[a]
      const ox1 = Math.min(o.x, o.x + o.w), ox2 = Math.max(o.x, o.x + o.w)
      const oy1 = Math.min(o.y, o.y + o.h), oy2 = Math.max(o.y, o.y + o.h)
      return ox1 < wx2 && ox2 > wx1 && (oy1 >= wy2 || oy2 <= wy1)
    })
    const parentAxis = hasXSibling ? "x" : (hasYSibling ? "y" : null)
    // Two candidates sharing one parent split (a nested pair) would each
    // rotate the same node — the second flip undoes the first.
    const parent = parentAxis ? leafParentNode(address, parentAxis, addresses) : null
    if (parent) {
      const parentKey = parentAxis + ":" + parent.node.lo + ":" + parent.node.hi + ":" + parent.node.seam
      if (flippedParents[parentKey]) continue
      flippedParents[parentKey] = true
      // Damaged windows flip regardless of sibling topology — a broken
      // leaf is already invisible, and rotating its subtree can only put
      // the region's spare room on the axis that lacks it. Merely
      // oversized windows stay restricted to leaf siblings.
      const sibling = parent.left ? parent.node.right : parent.node.left
      if (!damaged && !(sibling && sibling.leaf !== undefined)) continue
    } else if (!damaged && !parentAxis) continue
    trace("REORIENT " + address.slice(-6) + " " + win.w + "x" + win.h +
          (column ? " col" : " band") + (damaged ? " damaged" : "") +
          " pax=" + parentAxis)
    commands.push('hl.dispatch(hl.dsp.focus({ window = "address:' + address + '" }))')
    commands.push('hl.dispatch(hl.dsp.layout("togglesplit"))')
    reoriented.push(address)
  }
  if (!commands.length) return false
  commands.push('hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" }))')
  markCooled(REORIENT_COOLDOWN_PATH, reoriented)
  try {
    lua(commands.join("; "))
  } catch (_) {
    return false
  }
  return true
}

// Equalizing is intentionally gentle: one grow on the narrowest sliver, a few
// pixels at a time. Dwindle honors a resize as a seam move, and a large delta
// overshoots far past the request — squeezing the adjacent sliver under its
// floor, which then heals and re-collapses, and the two bounce. A small step
// can only steal a few pixels, so repeated applies converge instead of
// oscillating.
const SLIVER_GROW_STEP = 6

// Grow the narrowest collapsed sliver on one axis toward the widest — or
// toward the collapse size when even the widest sits below it, so a lone
// under-sized sliver still reaches the configured floor.
// A sliver's parent-split seam index under split-ratio semantics, used to
// know which strip group a resize feeds. Returns the seam index or -1.
function sliverParentSeam(address, target, clients, columns) {
  const axis = columns ? "x" : "y"
  const windows = Model.workspaceWindows(clients, target, includeFloating)
  const strips = Model.clusterStrips(Model.axisPool(target, windows, axis), axis)
  const spec = strips.map(s => s.windows.map(w => w.address))
  const idx = spec.findIndex(g => g.indexOf(address) >= 0)
  if (idx < 0) return -1
  const tree = readTreeCache()[treeCacheKey(spec, axis)]
  if (!tree) return -1
  let node = tree
  let seam = -1
  while (node && node.leaf === undefined) {
    seam = node.seam
    node = idx < node.seam ? node.left : node.right
  }
  return seam
}

function equalizeCollapsedSlivers(target) {
  if (!target) return false
  let clients = snapshot()
  let changed = false
  for (const columns of [true, false]) {
    const axis = columns ? "x" : "y"
    const resizeCmd = (address, delta) =>
      "hl.dispatch(" + Model.resizeCommand(address,
        columns ? delta : 0,
        columns ? 0 : delta, true) + ")"
    // A single nudge often lands short (ratio clamps deliver partial
    // deltas), so iterate until the spread closes or progress stops. Each
    // sliver below the goal gets one correct-signed grow in a single
    // batched eval, so an iteration costs one log line total.
    for (let iter = 0; iter < 4; iter++) {
      const slivers = collapsedSlivers(target, clients, columns)
      if (!slivers.length) break
      const sizes = slivers.map(function(w) { return columns ? w.w : w.h })
      const low = Math.min.apply(null, sizes)
      const high = Math.max.apply(null, sizes)
      const gap = high - low
      if (gap <= 1) break
      // Equalize toward the collapse floor, or the smallest sliver when
      // everything already sits above it — a fat sliver gets pulled down
      // through its seam when it can move, while thin ones grow.
      const goal = Math.max(options.collapseSize, low)
      // Equalization is per-SEAM, not per-window: a resize moves the
      // window's parent-split seam, transferring px between the two subtree
      // groups. Walking the tree outer-to-inner, each seam's move levels the
      // sliver means on its two sides — m px transferred changes a side's
      // mean by m/leafCount, so m = (meanR - meanL) / (1/nL + 1/nR). A seam
      // with slivers on only one side pushes that side toward the goal.
      const windows = Model.workspaceWindows(clients, target, includeFloating)
      const strips = Model.clusterStrips(Model.axisPool(target, windows, axis), axis)
      const spec = strips.map(s => s.windows.map(w => w.address))
      const sliverSpan = {}
      for (const sliver of slivers) {
        const idx = spec.findIndex(g => g.indexOf(sliver.address) >= 0)
        if (idx >= 0) sliverSpan[idx] = columns ? sliver.w : sliver.h
      }
      const tree = readTreeCache()[treeCacheKey(spec, axis)]
      const cmds = []
      const unknown = []
      if (tree) {
        const stats = function(n) {
          if (n.leaf !== undefined) {
            const sz = sliverSpan[n.leaf]
            return { n: sz === undefined ? 0 : 1, sum: sz || 0 }
          }
          const L = stats(n.left), R = stats(n.right)
          n.Ls = L; n.Rs = R
          return { n: L.n + R.n, sum: L.sum + R.sum }
        }
        stats(tree)
        const nodes = []
        const visit = function(n) {
          if (!n || n.leaf !== undefined) return
          nodes.push(n)
          visit(n.left)
          visit(n.right)
        }
        visit(tree)
        for (const node of nodes) {
          const L = node.Ls, R = node.Rs
          let m = 0
          if (L.n && R.n) {
            m = (R.sum / R.n - L.sum / L.n) / (1 / L.n + 1 / R.n)
          } else if (L.n) {
            m = L.n * (goal - L.sum / L.n)
          } else if (R.n) {
            m = R.n * (R.sum / R.n - goal)
          }
          m = Math.round(m)
          if (!m) continue
          // Emit on the seam's probed controller (it may live inside a
          // multi-member strip), else a direct leaf child — `resize +m`
          // moves the seam +m either way, corrected for the measured scale.
          let ctl = node.controller
          if (!ctl) {
            const leaf = node.right.leaf !== undefined ? node.right
                       : node.left.leaf !== undefined ? node.left : null
            if (!leaf || spec[leaf.leaf].length !== 1) continue
            ctl = spec[leaf.leaf][0]
          }
          const scale = node.scale || 0
          const delta = scale
            ? Math.round(m * Math.sign(scale) / Math.max(1, Math.abs(scale)))
            : m
          if (delta) cmds.push(resizeCmd(ctl, delta))
        }
      }
      for (const sliver of slivers) {
        const idx = spec.findIndex(g => g.indexOf(sliver.address) >= 0)
        if (idx < 0 || sliverSpan[idx] === undefined || tree) continue
        unknown.push({ sliver, need: goal - (columns ? sliver.w : sliver.h) })
      }
      if (cmds.length) {
        lua(cmds.join("; "))
        changed = true
        clients = snapshot()
      }
      // Slivers whose split side is unknown need the probe-and-correct
      // path: shrink first, reverse with the lost span on top if needed.
      for (const { sliver, need } of unknown) {
        if (!need) continue
        const step = Math.min(SLIVER_GROW_STEP, Math.abs(need))
        for (const sign of [Math.sign(need) || 1, -(Math.sign(need) || 1)]) {
          try {
            dispatch(Model.resizeCommand(sliver.address,
              columns ? sign * step : 0,
              columns ? 0 : sign * step, true))
          } catch (_) {
            continue
          }
          clients = snapshot()
          const after = clients[sliver.address]
          const v = after && (columns ? after.w : after.h)
          const now = columns ? sliver.w : sliver.h
          if (Math.abs(v - goal) < Math.abs(now - goal)) { changed = true; break }
          if (v !== null && ((need > 0 && v < now) || (need < 0 && v > now))) {
            try {
              dispatch(Model.resizeCommand(sliver.address,
                columns ? -sign * (step + Math.abs(now - v)) : 0,
                columns ? 0 : -sign * (step + Math.abs(now - v)), true))
              clients = snapshot()
            } catch (_) {}
            changed = true
            break
          }
        }
      }
      const afterClients = snapshot()
      const afterSizes = collapsedSlivers(target, afterClients, columns)
        .map(function(w) { return columns ? w.w : w.h })
      clients = afterClients
      if (!afterSizes.length ||
          Math.max.apply(null, afterSizes) - Math.min.apply(null, afterSizes) >= gap) break
    }
  }
  return changed
}

const TREE_CACHE_PATH = "/tmp/focus-now-trees.json"

function readTreeCache() {
  try {
    return Model.parseJson(fs.readFileSync(TREE_CACHE_PATH, "utf8"), {}) || {}
  } catch (_) {
    return {}
  }
}

function writeTreeCache(cache) {
  try {
    fs.writeFileSync(TREE_CACHE_PATH, JSON.stringify(cache))
  } catch (_) {}
}

function bustTreeCache() {
  try { fs.unlinkSync(TREE_CACHE_PATH) } catch (_) {}
}

function animationsEnabled() {
  try {
    const opt = Model.parseJson(call(["getoption", "animations:enabled", "-j"]), null)
    return !!(opt && (opt.bool === true || Number(opt.int) === 1))
  } catch (_) {
    return false
  }
}

// The last windowsMove leaf speed (ms) the plugin wrote to the compositor,
// shared with columns.lua so either side can revert it.
const ANIM_SPEED_STATE = "/tmp/focus-now-animspeed"
function animSpeedState() {
  try { return Number(fs.readFileSync(ANIM_SPEED_STATE, "utf8")) || 0 } catch (_) { return 0 }
}
function writeAnimSpeedState(value) {
  try { fs.writeFileSync(ANIM_SPEED_STATE, String(value)) } catch (_) {}
}

// The last `hl.animation({ ... leaf = "name" ... })` literal in the config
// sources — Omarchy defaults first, user files last so their definitions win.
// Used to restore the windowsMove leaf to the user's own settings.
function configuredAnimationLeaf(leaf) {
  const roots = ["/usr/share/omarchy/default/hypr",
                 (process.env.HOME || "") + "/.config/hypr"]
  const files = []
  const walk = (dir, out) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      const p = dir + "/" + e.name
      if (e.isDirectory()) walk(p, out)
      else if (e.name.endsWith(".lua")) out.push(p)
    }
  }
  for (const dir of roots) {
    const local = []
    walk(dir, local)
    local.sort()
    files.push(...local)
  }
  const re = new RegExp("hl\\.animation\\s*\\(\\s*\\{[^\\}]*leaf\\s*=\\s*\"" + leaf + "\"[^\\}]*\\}", "g")
  let found = null
  for (const file of files) {
    let text = ""
    try { text = fs.readFileSync(file, "utf8") } catch (_) { continue }
    let m
    while ((m = re.exec(text))) found = m[0]
  }
  return found
}

// animateSpeed=0 means "the compositor's own speed" — restore windowsMove to
// what the user's config declares (their own leaf, else the windows parent
// leaf cloned, else nothing). Runtime leaf overrides can't be undefined, so
// re-emitting the declared definition is the closest true revert.
function revertWindowsMoveLeaf() {
  const own = configuredAnimationLeaf("windowsMove")
  if (own) {
    try { lua(own) } catch (_) {}
    return
  }
  const parent = configuredAnimationLeaf("windows")
  if (parent) {
    try { lua(parent.replace(/leaf\s*=\s*"windows"/, 'leaf = "windowsMove"')) } catch (_) {}
  }
}

function stripRep(strip, axis) {
  const sorted = strip.windows.slice().sort((a, b) => {
    const primary = axis === "x" ? b.w - a.w : b.h - a.h
    if (Math.abs(primary) > 4) return primary
    return axis === "x" ? b.h - a.h : b.w - a.w
  })
  return sorted[0]
}

function liveStripsFromSpec(spec, clients, axis) {
  const result = new Array(spec.length)
  for (let i = 0; i < spec.length; i++) {
    const windows = []
    let a1 = Infinity
    let a2 = -Infinity
    for (const addr of spec[i]) {
      const win = clients[addr]
      if (!win) return null
      windows.push(win)
      const start = axis === "x" ? win.x : win.y
      const end = start + (axis === "x" ? win.w : win.h)
      if (start < a1) a1 = start
      if (end > a2) a2 = end
    }
    if (!(a2 > a1)) return null
    result[i] = { a1, a2, windows }
  }
  return result
}

function stripsGeometry(strips, mon, axis, fixedStart, fixedEnd) {
  const k = strips.length
  if (k < 1) return null
  for (let i = 1; i < k; i++) {
    if (strips[i].a1 < strips[i - 1].a2 - 2) return null
  }
  const halfGap = k > 1 ? Math.max(0, (strips[1].a1 - strips[0].a2) / 2) : 0
  const monStart = mon && mon.wa ? (axis === "x" ? mon.wa.x : mon.wa.y) : strips[0].a1
  const outerPad = halfGap > 0 ? Math.min(2, Math.max(0, strips[0].a1 - monStart)) : 0
  const seams = new Array(k + 1)
  seams[0] = fixedStart !== undefined ? fixedStart : strips[0].a1 - outerPad
  for (let m = 1; m < k; m++) {
    seams[m] = (strips[m - 1].a2 + strips[m].a1) / 2
  }
  seams[k] = fixedEnd !== undefined ? fixedEnd : strips[k - 1].a2 + outerPad
  const pads = new Array(k)
  for (let i = 0; i < k; i++) {
    const leftPad = Math.max(0, strips[i].a1 - seams[i])
    const rightPad = Math.max(0, seams[i + 1] - strips[i].a2)
    pads[i] = leftPad + rightPad
  }
  return { seams, pads, halfGap, totalSpan: seams[k] - seams[0] }
}

function buildTreeFromProbeData(lo, hi, reps, controllerForSeam, shiftedBySeam, scaleForSeam) {
  if (lo === hi) return { leaf: lo }
  if (lo + 1 === hi) {
    return {
      lo,
      hi,
      seam: hi,
      controller: controllerForSeam[hi] || reps[lo].address,
      scale: (scaleForSeam && scaleForSeam[hi]) || 0,
      left: { leaf: lo },
      right: { leaf: hi }
    }
  }
  const candidates = []
  for (let m = lo + 1; m <= hi; m++) {
    let shiftedByOther = false
    for (let other = lo + 1; other <= hi; other++) {
      if (other === m) continue
      if (shiftedBySeam[other] && shiftedBySeam[other][m]) {
        shiftedByOther = true
        break
      }
    }
    if (!shiftedByOther) candidates.push(m)
  }
  let rootSeam = candidates.find(m => !controllerForSeam[m])
  if (rootSeam === undefined) {
    candidates.sort((a, b) => {
      const count = seam => {
        const map = shiftedBySeam[seam] || {}
        let total = 0
        for (let s = lo + 1; s <= hi; s++) if (s !== seam && map[s]) total++
        return total
      }
      return count(b) - count(a)
    })
    rootSeam = candidates[0] !== undefined ? candidates[0] : hi
  }
  return {
    lo,
    hi,
    seam: rootSeam,
    controller: controllerForSeam[rootSeam] || null,
    scale: scaleForSeam[rootSeam] || 0,
    left: buildTreeFromProbeData(lo, rootSeam - 1, reps, controllerForSeam, shiftedBySeam, scaleForSeam),
    right: buildTreeFromProbeData(rootSeam, hi, reps, controllerForSeam, shiftedBySeam, scaleForSeam)
  }
}

function treeCacheKey(spec, axis) {
  return hyprctl + ":v3:" + axis + ":" + spec.map(group => group.slice().sort().join("+")).join(",")
}

// Discovers the binary split tree over K >= 3 strips once per workspace window
// arrangement using reversible probes while animations are suppressed, then
// caches the topology so subsequent focus changes execute in a single shot.
function discoverAxisTree(strips, reps, mon, axis, muteState, forceProbe) {
  const k = strips.length
  const spec = strips.map(s => s.windows.map(w => w.address))
  if (k === 2) {
    const ctrlIdx = strips[1].windows.length < strips[0].windows.length ? 1 : 0
    return {
      lo: 0,
      hi: 1,
      seam: 1,
      controller: reps[ctrlIdx].address,
      left: { leaf: 0 },
      right: { leaf: 1 }
    }
  }
  const cache = readTreeCache()
  const key = treeCacheKey(spec, axis)
  if (!forceProbe && cache[key]) return cache[key]

  if (!muteState.checked) {
    muteState.checked = true
    muteState.wasAnimated = animationsEnabled()
    if (muteState.wasAnimated) {
      const wasMuted = animationsMuted
      muteAnimations()
      muteState.muted = animationsMuted && !wasMuted
    }
  }

  const controllerForSeam = {}
  const shiftedBySeam = {}
  const scaleForSeam = {}
  // Signed seam displacement per rep probe — a single rep can move several
  // seams (its own parent seam directly, nested ones as side-effects), so
  // recording only the biggest leaves outer seams controllerless and the
  // focused window trapped inside its region's fixed share.
  const repShift = {}
  for (let i = 0; i < k; i++) {
    const base = snapshot()
    const baseStrips = liveStripsFromSpec(spec, base, axis)
    const baseGeom = baseStrips ? stripsGeometry(baseStrips, mon, axis) : null
    if (!baseGeom) return null
    for (const sign of [1, -1]) {
      const op = {
        address: reps[i].address,
        dx: axis === "x" ? sign * 40 : 0,
        dy: axis === "y" ? sign * 40 : 0,
        relative: true
      }
      try {
        dispatch(Model.resizeCommand(op.address, op.dx, op.dy, true))
      } catch (_) {
        continue
      }
      const after = snapshot()
      undoResize(op, base[op.address], after[op.address])
      const afterStrips = liveStripsFromSpec(spec, after, axis)
      const afterGeom = afterStrips ? stripsGeometry(afterStrips, mon, axis) : null
      if (!afterGeom) continue
      let bestSeam = -1
      let bestShift = 0
      for (let m = 1; m < k; m++) {
        const shift = afterGeom.seams[m] - baseGeom.seams[m]
        if (Math.abs(shift) >= 2) {
          const prev = repShift[m] && repShift[m][i]
          if (!prev || Math.abs(shift) > Math.abs(prev.shift))
            (repShift[m] = repShift[m] || {})[i] = { shift, sign }
        }
        if (Math.abs(shift) > bestShift) {
          bestShift = Math.abs(shift)
          bestSeam = m
        }
      }
      // Both signs are probed: dwindle grows a window on one border and
      // shrinks it on the other, so +40 and -40 move different seams —
      // a seam only reachable via shrink (like a subtree's outer edge)
      // would otherwise stay controllerless.
      if (bestSeam > 0 && bestShift >= 2) {
        if (!shiftedBySeam[bestSeam]) shiftedBySeam[bestSeam] = {}
        for (let m = 1; m < k; m++) {
          if (m !== bestSeam && Math.abs(afterGeom.seams[m] - baseGeom.seams[m]) >= 1.2) {
            shiftedBySeam[bestSeam][m] = true
          }
        }
      }
    }
  }
  // Each movable seam gets the rep that displaced it most, with the signed
  // seam-pixels per resize-pixel that probe measured — a controller on the
  // seam's right moves it the opposite way, and dwindle's ratio mapping is
  // rarely 1:1. Emitting ops without this inverts deltas.
  for (const m in repShift) {
    let bestRep = -1
    let bestAbs = 0
    for (const i in repShift[m]) {
      const v = Math.abs(repShift[m][i].shift)
      if (v > bestAbs) { bestAbs = v; bestRep = Number(i) }
    }
    if (bestRep < 0) continue
    controllerForSeam[m] = reps[bestRep].address
    scaleForSeam[m] = repShift[m][bestRep].shift / (repShift[m][bestRep].sign * 40)
  }
  if (!Object.keys(controllerForSeam).length) return null
  const tree = buildTreeFromProbeData(0, k - 1, reps, controllerForSeam, shiftedBySeam, scaleForSeam)
  cache[key] = tree
  writeTreeCache(cache)
  return tree
}

function buildAxisEntry(strips, mon, axis, muteState, forceProbe) {
  const reps = strips.map(s => stripRep(s, axis))
  const spec = strips.map(s => s.windows.map(w => w.address))
  const tree = discoverAxisTree(strips, reps, mon, axis, muteState, forceProbe)
  if (!tree) return null
  const subEntries = {}
  const perpAxis = axis === "x" ? "y" : "x"
  for (let i = 0; i < strips.length; i++) {
    if (strips[i].windows.length <= 1) continue
    if (strips[i].windows.some(w => w.address === requestedAddress)) continue
    const bands = Model.clusterStrips(strips[i].windows, perpAxis)
    const list = []
    // Members stacked on the perpendicular axis need seam ops too: the
    // top-level entry on that axis only pools windows overlapping the
    // focused window, so a sibling region's interior stack would otherwise
    // get no ops and a hogging leaf could squeeze its neighbors off-screen.
    if (bands.length >= 2) {
      const perpEntry = buildAxisEntry(bands, mon, perpAxis, muteState, forceProbe)
      if (perpEntry) list.push(perpEntry)
    }
    for (const band of bands) {
      const subStrips = Model.clusterStrips(band.windows, axis)
      if (subStrips.length < 2) continue
      const subEntry = buildAxisEntry(subStrips, mon, axis, muteState, forceProbe)
      if (subEntry) list.push(subEntry)
    }
    if (list.length) subEntries[i] = list
  }
  return { axis, spec, reps, tree, subEntries }
}

function commandsForAxisEntry(entry, clients, mon, targets, fixedStart, fixedEnd, overrideSpan) {
  const { axis, spec, reps, tree, subEntries } = entry
  const strips = liveStripsFromSpec(spec, clients, axis)
  if (!strips) return null
  const geom = stripsGeometry(strips, mon, axis, fixedStart, fixedEnd)
  if (!geom || !(geom.totalSpan > 0)) return null
  const focusedIdx = overrideSpan !== undefined
    ? -1
    : strips.findIndex(s => s.windows.some(w => w.address === requestedAddress))
  // A top-level axis whose strips don't contain the focused window means the
  // spec was built from a mid-transition snapshot (e.g. right after
  // movetoroot remaps windows) — emitting would distribute the whole span
  // among siblings and expand a random one. Bail; the next pass re-probes.
  if (overrideSpan === undefined && focusedIdx < 0) return null
  const minClient = options.collapseSize
  const baseMins = strips.map(s => Model.minWindowsSpan(s.windows, axis, minClient))
  const stripMins = strips.map((s, idx) => {
    // A settled collapsed strip already sits at its real floor: dwindle
    // clamps anything below it, so the space it occupies cannot actually
    // be taken. Reserving only collapseSize lets a growing sibling steal
    // that phantom slack and pushes the strip's windows off the screen
    // edge (negative sizes) — reserve the span it truly occupies instead.
    // Mid-transition strips (still large) keep the small reservation so
    // their shrink feeds the expansion.
    const span = s.a2 - s.a1
    if (span > minClient + 24) return baseMins[idx]
    const settled = s.windows.every(w => {
      const t = targets[w.address]
      const v = t ? (axis === "x" ? t.w : t.h) : 0
      return v <= minClient + 8
    })
    return settled ? Math.max(baseMins[idx], span) : baseMins[idx]
  })
  const wantClient = strips.map((s, idx) => {
    if (overrideSpan !== undefined) return stripMins[idx]
    const rep = reps[idx]
    const t = targets[rep.address]
    const v = t ? (axis === "x" ? t.w : t.h) : 0
    return Math.max(baseMins[idx], v > 0 ? v : baseMins[idx])
  })
  const clampRatio = r => Math.max(0.1, Math.min(1.9, r))
  const sumRange = (arr, a, b) => {
    let s = 0
    for (let i = a; i <= b; i++) s += arr[i]
    return s
  }
  const commands = []
  function emitChild(child, childSpan) {
    if (!child) return
    if (child.leaf !== undefined) {
      const idx = child.leaf
      const subs = subEntries && subEntries[idx]
      if (subs) {
        for (const sub of subs) {
          // Same-axis subs live inside the leaf's seam span; perpendicular
          // subs span the strip's full extent on their own axis, so fixed
          // bounds and the allocated span only apply to the former.
          const sameAxis = sub.axis === axis
          const subCmds = commandsForAxisEntry(
            sub, clients, mon, targets,
            sameAxis ? geom.seams[idx] : undefined,
            sameAxis ? geom.seams[idx + 1] : undefined,
            sameAxis ? childSpan : undefined
          )
          if (subCmds && subCmds.length) commands.push(...subCmds)
        }
      }
      return
    }
    emitNode(child, childSpan)
  }
  function emitNode(node, newBoxSpan) {
    if (!node || node.leaf !== undefined || !(newBoxSpan > 0)) return
    const { lo, hi, seam } = node
    const oldParent = geom.seams[hi + 1] - geom.seams[lo]
    const oldFirst = geom.seams[seam] - geom.seams[lo]
    if (!(oldParent > 0)) return
    const oldRatio = clampRatio(2 * oldFirst / oldParent)
    const padLeft = sumRange(geom.pads, lo, seam - 1)
    const padRight = sumRange(geom.pads, seam, hi)
    const minLeftBox = sumRange(stripMins, lo, seam - 1) + padLeft
    const minRightBox = sumRange(stripMins, seam, hi) + padRight
    const wantLeftClient = sumRange(wantClient, lo, seam - 1)
    const wantRightClient = sumRange(wantClient, seam, hi)
    let targetFirst
    if (focusedIdx >= lo && focusedIdx < seam) {
      targetFirst = Math.max(minLeftBox, Math.min(newBoxSpan - minRightBox, newBoxSpan - (wantRightClient + padRight)))
    } else if (focusedIdx >= seam && focusedIdx <= hi) {
      targetFirst = Math.max(minLeftBox, Math.min(newBoxSpan - minRightBox, wantLeftClient + padLeft))
    } else {
      const availClient = Math.max(0, newBoxSpan - padLeft - padRight)
      const wantAll = wantLeftClient + wantRightClient
      targetFirst = padLeft + (wantAll > 0 ? availClient * (wantLeftClient / wantAll) : availClient / 2)
    }
    let actualFirst
    if (node.controller) {
      // Ops in this batch execute in order: ancestor ops land first, so by
      // the time this op runs the seam sits at its live position rescaled
      // into the predicted box — not at oldFirst. All movement and floor
      // math must use the scaled position.
      const boxScale = newBoxSpan / oldParent
      const scaledFirst = oldFirst * boxScale
      const seamMove = targetFirst - scaledFirst
      // The probe measured how many seam-pixels one resize-pixel buys for
      // this controller (negative when the window sits right of the seam).
      // Fall back to the ratio heuristic for unprobed (cached/k=2) nodes.
      // Only the side LOSING span can be pushed under its floor. Bound the
      // seam movement when the controller lives on that side — an ancestor
      // op earlier in this batch may already have squeezed its share — and
      // never let either side's predicted post-op span drop below its
      // model-computed floor.
      const ctlIdx = strips.findIndex(s =>
        s.windows.some(w => w.address === node.controller))
      const ctlOnLeft = ctlIdx >= 0 && ctlIdx < node.seam
      const ctl = clients[node.controller]
      const cur = (ctl ? (axis === "x" ? ctl.w : ctl.h) : 0) * boxScale
      let move = seamMove
      if (move < 0) {
        // Bound against the LIVE first share too: ancestor ops earlier in
        // this batch may have under-delivered, leaving the real box smaller
        // than the scaled prediction — the excess would crush the side.
        const firstShare = Math.min(scaledFirst, oldFirst)
        let minMove = minLeftBox - firstShare
        if (ctlOnLeft) minMove = Math.max(minMove, FLOOR_GUARD - Math.min(cur, firstShare))
        if (move < minMove) move = Math.min(0, minMove)
      } else if (move > 0) {
        const rightShare = Math.min(newBoxSpan - scaledFirst, oldParent - oldFirst)
        let maxMove = rightShare - minRightBox
        if (!ctlOnLeft) maxMove = Math.min(maxMove, Math.min(cur, rightShare) - FLOOR_GUARD)
        if (move > maxMove) move = Math.max(0, maxMove)
      }
      // Convert the wanted seam move into a resize delta on the controller.
      // The probe measured seam-pixels per resize-pixel — but only ever
      // DE-amplify (|scale| > 1 asks for a smaller delta): a sub-1 scale is
      // usually a stale reading taken at a ratio clamp, and amplifying by
      // 1/scale emits an op far past the bounded move, crushing the
      // shrinking side. An unamplified delta can only under-deliver, which
      // the pass loop corrects. Unprobed nodes use window-centric sign:
      // +delta grows the controller's box, moving the seam by +delta when
      // the controller is left of the seam, -delta when right.
      let delta
      if (node.scale) {
        delta = Math.round(move * Math.sign(node.scale) / Math.max(1, Math.abs(node.scale)))
        actualFirst = scaledFirst + delta * node.scale
      } else {
        // Unprobed controller: its response scale and sign are unknown, so
        // a full-size request can land on a different seam entirely and
        // crush the layout. Send a bounded probe-sized step in the move's
        // direction; the next pass re-measures with a real scale.
        entry.usedUnprobed = true
        delta = Math.sign(move) * Math.min(Math.abs(move), 80) * (ctlOnLeft ? 1 : -1)
        actualFirst = scaledFirst + move
      }
      // Hard cap: a shrink request can never take more than the controller
      // itself has — dwindle cascades the excess into sibling splits and
      // crushes them to negative sizes. Grow requests are already bounded
      // by the shrinking side's floor.
      const ctlShrinks = ctlOnLeft ? delta < 0 : delta > 0
      if (ctlShrinks) {
        const cap = Math.max(0, cur - FLOOR_GUARD)
        delta = Math.sign(delta) * Math.min(Math.abs(delta), Math.round(cap))
      }
      trace("OP " + axis + " seam" + node.seam + " ctl=" + (node.controller||"?").slice(-6) +
            " scale=" + (node.scale||0).toFixed(2) + " move=" + Math.round(seamMove) +
            " delta=" + delta + " tgt=" + Math.round(targetFirst) +
            " minL=" + Math.round(minLeftBox) + " minR=" + Math.round(minRightBox))
      if (Math.abs(delta) >= 1) {
        commands.push("hl.dispatch(" + Model.resizeCommand(
          node.controller,
          axis === "x" ? delta : 0,
          axis === "y" ? delta : 0,
          true
        ) + ")")
      }
    } else {
      actualFirst = newBoxSpan / 2 * oldRatio
    }
    emitChild(node.left, actualFirst)
    emitChild(node.right, newBoxSpan - actualFirst)
  }
  emitChild(tree, overrideSpan !== undefined ? overrideSpan : geom.totalSpan)
  return commands
}

// Walks the split tree to the focused leaf; a node without a controller on
// that path is a seam no leaf resize can reach (its children are both
// subtrees), so the focused window's share is structurally capped and only
// a movetoroot restructure can free it.
function seamPathBlocked(node, leafIdx) {
  while (node && node.leaf === undefined) {
    if (!node.controller) return true
    node = leafIdx < node.seam ? node.left : node.right
  }
  return false
}

// A comb — every internal node with at least one leaf child — is the only
// dwindle topology where every seam is leaf-reachable. A node with two
// subtree children buries a seam no resize can move.
function treeIsComb(node) {
  while (node && node.leaf === undefined) {
    const l = node.left.leaf !== undefined, r = node.right.leaf !== undefined
    if (!l && !r) return false
    node = l ? node.right : node.left
  }
  return true
}

const MOVEROOT_COOLDOWN_PATH = "/tmp/focus-now-movetoroot.json"

function runExactPass(initialClients, forceProbe) {
  const target = initialClients[requestedAddress]
  if (!target || active() !== requestedAddress) return { handled: true }
  const allMonitors = monitors()
  const mon = Model.monitorForWindow(target, allMonitors)
  const windows = Model.workspaceWindows(initialClients, target, includeFloating)
  // The focused window must be in the pool — if it isn't, the snapshot caught
  // a mid-remap/mid-flight frame and any ops would act on phantom geometry.
  if (!windows.some(w => w.address === requestedAddress)) return { handled: true }
  const muteState = { checked: false, wasAnimated: false, muted: false }
  const axes = []
  let lanesBlocked = false
  for (const axis of ["x", "y"]) {
    const strips = Model.clusterStrips(Model.axisPool(target, windows, axis), axis)
    for (const strip of strips) {
      if (strip.windows.length > 1 &&
          Model.clusterStrips(strip.windows, axis).length > 1) lanesBlocked = true
    }
    if (strips.length < 2) continue
    const entry = buildAxisEntry(strips, mon, axis, muteState, forceProbe)
    if (!entry) {
      restoreAnimations()
      return { handled: false }
    }
    axes.push(entry)
  }
  const baseClients = muteState.checked ? snapshot() : initialClients
  const baseTarget = baseClients[requestedAddress]
  if (!baseTarget) {
    restoreAnimations()
    return { handled: true }
  }
  const targets = Model.layoutTargets(baseTarget, baseClients, allMonitors, options)
  for (const entry of axes) {
    const strips = liveStripsFromSpec(entry.spec, baseClients, entry.axis)
    if (strips) trace("SPEC " + entry.axis + " " + entry.spec.map((g, i) =>
      "[" + i + "]" + g.map(a => a.slice(-6)).join("+") + ":" +
      Math.round(strips[i].a2 - strips[i].a1)).join(" ") +
      " f=" + entry.spec.findIndex(g => g.indexOf(requestedAddress) >= 0) +
      " wants=" + entry.spec.map(g => {
        const t = targets[g[0]] || {}
        return Math.round(entry.axis === "x" ? (t.w || 0) : (t.h || 0))
      }).join(","))
  }
  const focusWant = targets[requestedAddress]
  const focusedGap = focusWant
    ? Math.max(focusWant.w > 0 ? focusWant.w - baseTarget.w : 0,
               focusWant.h > 0 ? focusWant.h - baseTarget.h : 0)
    : 0
  const blocked = focusedGap > 40 && axes.some(entry => {
    const idx = entry.spec.findIndex(group => group.indexOf(requestedAddress) >= 0)
    return idx >= 0 && seamPathBlocked(entry.tree, idx)
  })
  // A non-comb tree, or a strip whose members form side-by-side lanes on
  // this axis, carries seams no leaf resize can reach — ops computed from
  // the inferred topology land on wrong sides and crush windows. When the
  // layout isn't already at its targets, don't emit: signal the pass loop
  // to flatten with movetoroot and re-probe the comb it produces.
  const nonComb = axes.some(entry => !treeIsComb(entry.tree)) || lanesBlocked
  if (nonComb && !allTargetsReached(baseClients, targets)) {
    restoreAnimations()
    return { handled: false, nonComb: true, blocked }
  }
  const batch = []
  if (muteState.muted) batch.push("hl.config({ animations = { enabled = true } })")
  for (const entry of axes) {
    const cmds = commandsForAxisEntry(entry, baseClients, mon, targets)
    if (!cmds) {
      restoreAnimations()
      return { handled: false }
    }
    batch.push(...cmds)
  }
  // Absolute sibling collapses ride the tail of the batch, but only when the
  // focused window needs the room — collapsing into an over-target focused
  // window's shrink batch perturbs the same seams the ops just moved. The
  // seam ops were computed against pre-collapse geometry so they run first;
  // each leaf-absolute resize then pins a plump sibling exactly on its model
  // target (excess axis only, so shared-column members don't race), and the
  // focused window claims up to what the collapses freed — absolute resizes
  // climb ancestors, and the cap keeps the request inside space this batch
  // actually released so path-siblings aren't crushed below their pins.
  if (focusedGap > 160) {
    let freedX = 0, freedY = 0
    for (const a in targets) {
      if (a === requestedAddress) continue
      const w = baseClients[a], tw = targets[a]
      if (!w || !tw || w.floating ||
          String(w.workspaceId) !== String(baseTarget.workspaceId)) continue
      const sx = w.w - (tw.w || 0), sy = w.h - (tw.h || 0)
      if (Math.max(sx, sy) > 120) {
        batch.push('hl.dispatch(' + Model.resizeCommand(a,
          sx > 120 && tw.w > 0 ? tw.w : w.w,
          sy > 120 && tw.h > 0 ? tw.h : w.h, false) + ')')
        freedX += Math.max(0, sx); freedY += Math.max(0, sy)
      }
    }
    const tw = targets[requestedAddress]
    if (tw && baseTarget) {
      const gx = tw.w > 0 ? Math.min(tw.w - baseTarget.w, freedX) : 0
      const gy = tw.h > 0 ? Math.min(tw.h - baseTarget.h, freedY) : 0
      if (Math.max(gx, gy) > 160)
        batch.push('hl.dispatch(' + Model.resizeCommand(requestedAddress,
          gx > 160 ? baseTarget.w + gx : baseTarget.w,
          gy > 160 ? baseTarget.h + gy : baseTarget.h, false) + ')')
    }
  }
  // An empty batch is only a finished layout when every window actually sits
  // at its target — otherwise the tree produced no usable ops (degenerate
  // splits the seam math cannot reach) and the generic pass loop must try.
  if (!batch.length) {
    const reached = allTargetsReached(baseClients, targets)
    return { handled: reached, empty: !reached, blocked, nonComb }
  }
  // The plan was computed against baseClients; a tree mutation racing the
  // apply (a user togglesplit/swap fires no focus event) would land these
  // ops on a different tree and crush windows. Re-snapshot before emitting
  // and replan instead — the retry sees the mutation's settled state.
  {
    const fresh = snapshot()
    const freshTarget = fresh[requestedAddress]
    const wsId = String(baseTarget.workspaceId)
    let stale = !freshTarget
    if (!stale) {
      for (const a in baseClients) {
        const w = baseClients[a], f = fresh[a]
        if (!w || w.floating || String(w.workspaceId) !== wsId) continue
        if (!f || Math.abs(f.w - w.w) > 8 || Math.abs(f.h - w.h) > 8) { stale = true; break }
      }
      if (!stale) for (const a in fresh) {
        const f = fresh[a]
        if (f && !f.floating && String(f.workspaceId) === wsId && !baseClients[a]) { stale = true; break }
      }
    }
    if (stale) {
      trace("STALE-REPLAN")
      restoreAnimations()
      return { handled: false, retryFresh: true }
    }
  }
  trace("BATCH " + batch.join(" | "))
  lua(batch.join("; "))
  // The unmute travels in the batch so probes stay instant; clear the guard
  // only once it has actually run (a throw above leaves the exit handler to
  // restore instead).
  animationsMuted = false

  const after = snapshot()
  const afterTarget = after[requestedAddress]
  if (!afterTarget) return { handled: true }
  if (!forceProbe && !muteState.checked) {
    const hasSliver = Object.values(after).some(w =>
      w && !w.floating && String(w.workspaceId) === String(afterTarget.workspaceId) &&
      (w.w < DAMAGE_SIZE || w.h < DAMAGE_SIZE))
    const want = targets[requestedAddress]
    const stalled = want && !Model.targetReached(afterTarget, want, 64) &&
      !movedTowardTarget(baseTarget, afterTarget, want)
    if (hasSliver || stalled) {
      if (hasSliver) healDegenerate(afterTarget, after)
      return { handled: false, retryFresh: true, nonComb }
    }
  }
  const polish = []
  for (const entry of axes) {
    const beforeStrips = liveStripsFromSpec(entry.spec, baseClients, entry.axis)
    const afterStrips = liveStripsFromSpec(entry.spec, after, entry.axis)
    const beforeGeom = beforeStrips ? stripsGeometry(beforeStrips, mon, entry.axis) : null
    const afterGeom = afterStrips ? stripsGeometry(afterStrips, mon, entry.axis) : null
    if (!beforeGeom || !afterGeom) continue
    if (Math.abs(afterGeom.totalSpan - beforeGeom.totalSpan) > 24) continue
    const afterTargets = Model.layoutTargets(afterTarget, after, allMonitors, options)
    const cmds2 = commandsForAxisEntry(entry, after, mon, afterTargets)
    if (cmds2 && cmds2.length) polish.push(...cmds2)
  }
  if (polish.length) lua(polish.join("; "))
  return { handled: true, blocked, nonComb, unprobed: axes.some(e => e.usedUnprobed) }
}

// Sum of per-window distance to targets — the convergence metric the pass
// loop uses to detect both stalls and oscillation.
function targetDistance(clients, targets) {
  let dist = 0
  for (const address in targets) {
    const win = clients[address], t = targets[address]
    if (!win || !t) continue
    dist += Math.abs(win.w - (t.w > 0 ? t.w : win.w)) +
            Math.abs(win.h - (t.h > 0 ? t.h : win.h))
  }
  return dist
}

function applyExactDwindle(initialClients) {
  // Each pass moves the seams only partway toward the targets (dwindle clamps
  // ratio-driven requests against node floors), so a single batch leaves the
  // focused window short of its share. Loop passes until the layout settles:
  // a repeated fingerprint, or a pass that brings no net progress toward the
  // targets, means further batches only churn.
  const fingerprints = new Set()
  let clients = initialClients
  let forceProbe = false
  let lastDist = Infinity
  let failures = 0
  let delivered = false
  let reprobed = false
  for (let pass = 0; pass < 12; pass++) {
    const beforeSizes = {}
    for (const a in clients) { const w = clients[a]; if (w) beforeSizes[a] = w.w + "x" + w.h }
    const res = runExactPass(clients, forceProbe)
    if (!res.handled) {
      // A pass that fails after earlier passes already emitted ops leaves
      // the layout mid-flight — still count it handled so the generic pass
      // loop doesn't churn measure/undo cycles on converged geometry. Retry
      // with a fresh probe first: the failure is usually transient geometry
      // mid-transition. An empty batch means the seams are all at their
      // targets — the residual is pad noise no op can reach; don't re-probe.
      // A non-comb tree means ops would land on a topology the inferred
      // seams don't model — flatten first instead of emitting.
      if (res.empty && !res.nonComb) return pass > 0
      if (res.nonComb || res.empty || ++failures > 2) {
        if (!res.nonComb || cooledRecently(MOVEROOT_COOLDOWN_PATH, requestedAddress)) return pass > 0
        markCooled(MOVEROOT_COOLDOWN_PATH, [requestedAddress])
        trace("MOVEROOT " + requestedAddress.slice(-6))
        lua('hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" })); hl.dispatch(hl.dsp.layout("movetoroot"))')
        clients = snapshot()
        forceProbe = true
        continue
      }
      clients = snapshot()
      forceProbe = true
      continue
    }
    forceProbe = false
    clients = snapshot()
    for (const a in beforeSizes) {
      const w = clients[a]
      if (w && w.w + "x" + w.h !== beforeSizes[a]) { delivered = true; break }
    }
    const target = clients[requestedAddress]
    if (!target) return true
    // Rescue crush damage between passes so stale-tree ops never build on
    // negative boxes.
    if (rescueNegatives(target, clients)) clients = snapshot()
    const targets = Model.layoutTargets(target, clients, monitors(), options)
    const dist = targetDistance(clients, targets)
    if (allTargetsReached(clients, targets)) break
    const fingerprint = workspaceFingerprint(clients)
    const repeated = fingerprints.has(fingerprint)
    fingerprints.add(fingerprint)
    if (repeated || dist >= lastDist - 8) {
      // A stall (or zero-delivery batch repeating the same fingerprint)
      // means the remaining distance sits behind seams no leaf resize can
      // reach — clamped ratios floor leaves at a share of their parent's
      // box, so only restructuring frees them. Flatten into a comb once,
      // then exact ops finish the job.
      // Only escalate once progress has demonstrably stalled: a "blocked"
      // seam (no probed controller) still gets bounded probe-step ops that
      // often DO deliver — movetoroot while those are landing just churns
      // the layout into a fresh wedge.
      // The residual must also be *takeable*: when every sibling already
      // sits at its floor, the focused window's deficit is ratio-clamp
      // residue no restructuring can recover.
      let surplus = 0
      for (const a in targets) {
        if (a === requestedAddress) continue
        const w = clients[a], t = targets[a]
        if (w && t && !w.floating) {
          surplus = Math.max(surplus, w.w - (t.w || 0), w.h - (t.h || 0))
        }
      }
      const stuck = dist > 48 && delivered && surplus > 120
      // A stall with unprobed ops in flight: probe-steps may have moved the
      // geometry enough that a fresh probe now measures real scales —
      // re-probe once before restructuring.
      if (res.unprobed && !reprobed) {
        reprobed = true
        forceProbe = true
        clients = snapshot()
        continue
      }
      // Restructuring only pays off when it can recover real pixels — a
      // sibling surplus to take, or the focused window itself crushed.
      // Floored siblings leave residue no restructure can reach.
      const takeable = surplus > 120 || Math.min(target.w, target.h) < 120
      if ((res.nonComb || stuck || res.blocked) && takeable &&
          !cooledRecently(MOVEROOT_COOLDOWN_PATH, requestedAddress)) {
        markCooled(MOVEROOT_COOLDOWN_PATH, [requestedAddress])
        trace("MOVEROOT " + requestedAddress.slice(-6))
        lua('hl.dispatch(hl.dsp.focus({ window = "address:' + requestedAddress + '" })); hl.dispatch(hl.dsp.layout("movetoroot"))')
        clients = snapshot()
        forceProbe = true
        lastDist = Infinity
        fingerprints.clear()
        continue
      }
      break
    }
    lastDist = dist
  }
  return true
}

// On a lua-registered flat layout there is no split tree: the layout places
// columns from client widths sent through layoutmsg, so every collapsed
// column reaches the exact collapse floor in a single dispatch, with no
// reordering possible. Columns are vertical stacks: windows sharing an
// x-range form one column and get per-window client heights.
// Gap constants matching columns.lua (SEAM between siblings, EDGE at the
// work-area edge); the layout inflates client rects to cell boxes with these.
const FLAT_EDGE = 2
const FLAT_SEAM = 7

function applyLuaColumns(initialClients, layout) {
  // layout:single_window_aspect_ratio pads a lone tiled window into a centered
  // square when the layout supplies no visual box — which is every window
  // under this provider. It silently fights the flex fill, so neutralize it
  // whenever a columns apply runs (it is a global compositor option).
  lua('hl.config({ layout = { single_window_aspect_ratio = { 0, 0 } } })')
  const target = initialClients[requestedAddress]
  if (!target || active() !== requestedAddress) return false
  const all = Model.workspaceWindows(initialClients, target, includeFloating)
    .filter(w => w && !w.floating)
  if (all.length < 2 || !all.some(w => w.address === requestedAddress)) return false
  const mon = Model.monitorForWindow(target, monitors())
  // The layout's ctx.area is the monitor work area inset by gaps_out.
  // CSS order: top right bottom left.
  let gaps = [0, 0, 0, 0]
  const gapOpt = Model.parseJson(call(["getoption", "general:gaps_out", "-j"]), null)
  if (gapOpt && typeof gapOpt.css === "string") {
    const parts = gapOpt.css.trim().split(/\s+/).map(Number)
    if (parts.length >= 4 && parts.slice(0, 4).every(n => Number.isFinite(n))) gaps = parts.slice(0, 4)
  }
  const wa = mon && mon.wa
  if (!wa) return false
  const area = {
    x: wa.x + gaps[3], y: wa.y + gaps[0],
    w: wa.w - gaps[3] - gaps[1], h: wa.h - gaps[0] - gaps[2]
  }
  const windows = all.filter(w => w.monitor === target.monitor)

  // The flat structure: slots tile the outer axis, each slot's members tile
  // its inner extent. Slots are geometric strips (windows sharing the outer
  // range); members order by their inner coordinate — identical to the
  // layout's own columns/rows model, so stacks and mixtures keep their
  // orientation instead of collapsing into a single plane.
  const rows = layout === "lua:rows"
  const outer = rows ? "y" : "x"
  const inner = rows ? "x" : "y"
  const lo = w => outer === "x" ? w.x : w.y
  const hi = w => outer === "x" ? w.x + w.w : w.y + w.h
  const ilo = w => inner === "x" ? w.x : w.y
  const ihi = w => inner === "x" ? w.x + w.w : w.y + w.h
  // Prefer the layout's own slot structure (authoritative stack membership);
  // fall back to geometric strips when no structure exists yet.
  const liveSet = new Set(windows.map(w => w.address))
  const wsName = workspaceRecord(target) && String(workspaceRecord(target).name || "")
  const structCols = wsName ? slotStructure(wsName) : []
  const slots = []
  const slotted = new Set()
  for (const col of structCols) {
    const members = col.filter(a => liveSet.has(a))
    if (members.length) {
      slots.push({ windows: members.map(a => windows.find(w => w.address === a)) })
      members.forEach(a => slotted.add(a))
    }
  }
  const leftovers = windows.filter(w => !slotted.has(w.address))
    .sort((a, b) => lo(a) - lo(b) || a.address.localeCompare(b.address))
  for (const w of leftovers) slots.push({ windows: [w] })
  if (!slots.length) {
    for (const s of Model.clusterStrips(windows, outer)) slots.push(s)
  }
  slots.sort((a, b) => {
    const a1 = Math.min(...a.windows.map(lo))
    const b1 = Math.min(...b.windows.map(lo))
    return a1 - b1
  })
  const focusedIndex = slots.findIndex(s =>
    s.windows.some(w => w.address === requestedAddress))
  if (focusedIndex < 0) return false

  const collapse = Math.max(1, options.collapseSize)
  const rects = {}
  const n = slots.length
  const oStart = outer === "x" ? area.x : area.y
  const oSpan = outer === "x" ? area.w : area.h
  const iStart = inner === "x" ? area.x : area.y
  const iSpan = inner === "x" ? area.w : area.h
  const oPads = 2 * FLAT_EDGE + 2 * FLAT_SEAM * (n - 1)
  const sibMin = s => Math.max(1, Model.minWindowsSpan(s.windows, outer, collapse))
  const otherSum = slots.reduce((sum, s, i) =>
    i === focusedIndex ? sum : sum + sibMin(s), 0)
  // Sibling minimums can overflow the outer span (stale geometry, merged
  // slots) and starve the focused slot to 1px — scale them down to fit.
  const focusedFloor = Math.min(Math.max(240, collapse), oSpan - oPads)
  const roomForOthers = Math.max(0, oSpan - oPads - focusedFloor)
  const oScale = otherSum > roomForOthers && otherSum > 0 ? roomForOthers / otherSum : 1
  let cursor = oStart
  for (let i = 0; i < n; i++) {
    const slot = slots[i]
    const share = i === focusedIndex
      ? Math.max(1, oSpan - oPads - otherSum * oScale)
      : Math.max(1, Math.round(sibMin(slot) * oScale))
    const before = i === 0 ? FLAT_EDGE : FLAT_SEAM
    const after = i === n - 1 ? FLAT_EDGE : FLAT_SEAM
    const pos = cursor + before
    cursor += before + share + after

    const members = slot.windows.slice().sort((a, b) => ilo(a) - ilo(b) || a.address.localeCompare(b.address))
    const m = members.length
    const iPads = 2 * FLAT_EDGE + 2 * FLAT_SEAM * (m - 1)
    const iAvail = Math.max(1, iSpan - iPads)
    const slotFocused = i === focusedIndex
    const others = members.filter(w => w.address !== requestedAddress).length
    let icursor = iStart
    const iFocusedFloor = Math.min(Math.max(240, collapse), iAvail)
    const iRoom = Math.max(0, iAvail - iFocusedFloor)
    const iScale = collapse * others > iRoom && others > 0 ? iRoom / (collapse * others) : 1
    const iSib = Math.max(1, Math.round(collapse * iScale))
    for (let j = 0; j < m; j++) {
      const w = members[j]
      const isFocused = slotFocused && w.address === requestedAddress
      let size
      if (slotFocused) {
        size = isFocused ? Math.max(1, iAvail - iSib * others) : iSib
      } else {
        const curSum = members.reduce((sum, mm) => sum + Math.max(1, ihi(mm) - ilo(mm)), 0)
        size = Math.max(1, Math.round(iAvail * Math.max(1, ihi(w) - ilo(w)) / curSum))
      }
      const ibefore = j === 0 ? FLAT_EDGE : FLAT_SEAM
      const iafter = j === m - 1 ? FLAT_EDGE : FLAT_SEAM
      const r = {}
      if (outer === "x") { r.x = pos; r.w = share } else { r.y = pos; r.h = share }
      if (inner === "x") { r.x = icursor + ibefore; r.w = size } else { r.y = icursor + ibefore; r.h = size }
      rects[w.address] = r
      icursor += ibefore + size + iafter
    }
  }

  // Windows on other monitors keep their current rect so the geom map covers
  // the whole workspace and the flat scaffold never double-books them.
  const parts = all.map(w => {
    const r = rects[w.address] || {}
    const x = Math.round(r.x !== undefined ? r.x : w.x)
    const y = Math.round(r.y !== undefined ? r.y : w.y)
    const wv = Math.round(r.w !== undefined ? r.w : Math.max(w.w, collapse))
    const hv = Math.round(r.h !== undefined ? r.h : Math.max(w.h, collapse))
    return w.address + ":" + x + "," + y + "," + Math.max(1, wv) + "," + Math.max(1, hv)
  })
  trace("GEOM " + parts.join(" "))
  lua("hl.dispatch(hl.dsp.layout(\"geom " + parts.join(" ") + "\"))")
  return true
}

function isFlatLuaLayout(name) {
  return name === "lua:columns" || name === "lua:rows"
}

function allTargetsReached(clients, targets) {
  if (!Model.targetReached(clients[requestedAddress], targets[requestedAddress])) return false
  for (const address in targets) {
    if (address === requestedAddress) continue
    if (!Model.targetReached(clients[address], targets[address], 4)) return false
  }
  return true
}

function movedAwayFromTarget(before, after, want) {
  if (!before || !after || !want) return false
  const distance = function(win) {
    return Math.abs(win.w - (want.w > 0 ? want.w : win.w)) +
      Math.abs(win.h - (want.h > 0 ? want.h : win.h))
  }
  return distance(after) > distance(before) + 2
}

const flippedSigns = {}
function signKey(operation) {
  return operation.address + ":" + (operation.dx ? "x" : "y")
}

function orientOp(operation) {
  if (!flippedSigns[signKey(operation)]) return operation
  return {
    address: operation.address,
    dx: -operation.dx,
    dy: -operation.dy,
    relative: operation.relative
  }
}

function trySingleOp(operation, clients, target, targets) {
  try {
    dispatch(Model.resizeCommand(operation.address, operation.dx, operation.dy, operation.relative))
  } catch (_) {
    return { ok: false }
  }
  const after = snapshot()
  const beforeWin = clients[operation.address]
  const movedWindow = after[operation.address]
  const want = targets[operation.address]
  const damaged = collateralDamage(clients, after, target)
  if (movedAwayFromTarget(beforeWin, movedWindow, want)) {
    undoResize(operation, beforeWin, movedWindow)
    if (damaged) healDegenerate(target, after)
    return { ok: false, wrongWay: true }
  }
  if (damaged) {
    undoResize(operation, beforeWin, movedWindow)
    healDegenerate(target, after)
    return { ok: false, damaged: damaged }
  }
  if (Model.sameSize(beforeWin, movedWindow, 4)) return { ok: false, noop: true }
  if (movedTowardTarget(beforeWin, movedWindow, want)) return { ok: true }
  undoResize(operation, beforeWin, movedWindow)
  return { ok: false, noop: true }
}

function tryOpWithHalving(operation, clients, target, targets) {
  let step = operation
  let lastDamaged = null
  for (let round = 0; round < 4; round++) {
    const base = round === 0 ? clients : snapshot()
    const baseTarget = base[requestedAddress] || target
    const res = trySingleOp(step, base, baseTarget, targets)
    if (res.ok) return res
    if (!res.damaged) return res
    lastDamaged = res.damaged
    const priorDamaged = base[res.damaged.address]
    if (priorDamaged && priorDamaged.address !== step.address) {
      const priorDim = step.dx ? priorDamaged.w : priorDamaged.h
      if (priorDim <= FLOOR_GUARD + 4) break
    }
    const nextDx = Math.trunc(step.dx / 2.5)
    const nextDy = Math.trunc(step.dy / 2.5)
    if (Math.abs(nextDx) + Math.abs(nextDy) < 16) break
    step = { address: step.address, dx: nextDx, dy: nextDy, relative: step.relative }
  }
  return { ok: false, damaged: lastDamaged }
}

function tryOpEitherDirection(rawOperation, clients, target, targets) {
  const operation = orientOp(rawOperation)
  const first = tryOpWithHalving(operation, clients, target, targets)
  if (first.ok || first.damaged) return first
  const flipped = {
    address: operation.address,
    dx: -operation.dx,
    dy: -operation.dy,
    relative: operation.relative
  }
  const second = tryOpWithHalving(flipped, snapshot(), target, targets)
  if (second.ok || second.damaged) {
    flippedSigns[signKey(rawOperation)] = !flippedSigns[signKey(rawOperation)]
  }
  return second
}

function unfocusedMean(clients, targets, axis) {
  let sum = 0
  let count = 0
  for (const address in targets) {
    if (address === requestedAddress) continue
    const want = axis === "x" ? targets[address].w : targets[address].h
    const win = clients[address]
    if (!win || !(want > 0)) continue
    sum += axis === "x" ? win.w : win.h
    count++
  }
  return count > 0 ? sum / count : 0
}

// When expanding the focused window is blocked because a sibling inside an
// opposing subtree is already at the collapse floor while another sibling in
// that subtree still holds space, growing the floor-pinned sibling toward the
// unfocused mean pulls room across their shared split without taking space
// from the focused window.
function relieveFloorSibling(damaged, axis, targets) {
  if (!damaged || damaged.address === requestedAddress) return false
  const key = damaged.address + ":relief:" + axis
  const preferred = flippedSigns[key] ? [-1, 1] : [1, -1]
  const initial = snapshot()
  const initialDamaged = initial[damaged.address]
  if (!initialDamaged) return false
  const curDim = axis === "x" ? initialDamaged.w : initialDamaged.h
  const mean = unfocusedMean(initial, targets, axis)
  const want = Math.max(16, Math.min(320, Math.round((mean || curDim + 45) - curDim)))
  const magnitudes = want > 44 ? [want, Math.max(16, Math.trunc(want / 2.2))] : [want]
  let fresh = initial
  for (const magnitude of magnitudes) {
    for (const sign of preferred) {
      const base = fresh || snapshot()
      fresh = null
      const baseTarget = base[requestedAddress]
      const baseDamaged = base[damaged.address]
      if (!baseTarget || !baseDamaged) return false
      const op = {
        address: damaged.address,
        dx: axis === "x" ? sign * magnitude : 0,
        dy: axis === "y" ? sign * magnitude : 0,
        relative: true
      }
      try {
        dispatch(Model.resizeCommand(op.address, op.dx, op.dy, op.relative))
      } catch (_) {
        continue
      }
      const after = snapshot()
      const afterTarget = after[requestedAddress]
      const afterDamaged = after[damaged.address]
      const grew = axis === "x"
        ? (afterDamaged && afterDamaged.w > baseDamaged.w + 4)
        : (afterDamaged && afterDamaged.h > baseDamaged.h + 4)
      const targetHeld = afterTarget &&
        afterTarget.w >= baseTarget.w - 2 &&
        afterTarget.h >= baseTarget.h - 2
      if (grew && targetHeld && !collateralDamage(base, after, baseTarget)) {
        if (sign === -1) flippedSigns[key] = true
        return true
      }
      undoResize(op, baseDamaged, afterDamaged)
      healDegenerate(baseTarget, after)
    }
  }
  return false
}

function temperedAlternative(operation, clients, targets, floorBlocked) {
  if (!floorBlocked) return operation
  const axis = operation.dx ? "x" : "y"
  const win = clients[operation.address]
  const want = targets[operation.address]
  if (!win || !want) return operation
  const cur = axis === "x" ? win.w : win.h
  const targetDim = axis === "x" ? want.w : want.h
  if (!(targetDim > 0) || cur >= 240 || cur <= targetDim) return operation
  const mean = Math.round(unfocusedMean(clients, targets, axis))
  const balancedTarget = Math.max(targetDim, mean)
  if (cur <= balancedTarget + 4) return null
  const mag = cur - balancedTarget
  return {
    address: operation.address,
    dx: axis === "x" ? Math.sign(operation.dx) * mag : 0,
    dy: axis === "y" ? Math.sign(operation.dy) * mag : 0,
    relative: operation.relative
  }
}

function applyOneLayoutPass(clients) {
  const target = clients[requestedAddress]
  if (!target || active() !== requestedAddress) return false
  const plan = Model.layoutOps(target, clients, monitors(), options)
  if (allTargetsReached(clients, plan.targets)) return false
  const first = plan.ops.filter(operation => (operation.candidate || 0) === 0)

  let moved = false
  const blocked = []
  for (let i = 0; i < first.length; i++) {
    const base = i === 0 ? clients : snapshot()
    const baseTarget = base[requestedAddress]
    if (!baseTarget) return false
    const res = tryOpEitherDirection(first[i], base, baseTarget, plan.targets)
    if (res.ok) moved = true
    else if (res.damaged) blocked.push({ damaged: res.damaged, axis: first[i].dx ? "x" : "y" })
  }
  if (moved) return true

  for (const item of blocked) {
    if (relieveFloorSibling(item.damaged, item.axis, plan.targets)) return true
  }

  const freshClients = first.length || blocked.length ? snapshot() : clients
  const freshTarget = freshClients[requestedAddress]
  if (!freshTarget) return false
  const alternatives = plan.ops
    .filter(operation => (operation.candidate || 0) !== 0)
    .sort((left, right) => Math.abs(right.dx) + Math.abs(right.dy) - Math.abs(left.dx) - Math.abs(left.dy))
  for (let i = 0; i < alternatives.length; i++) {
    const base = i === 0 ? freshClients : snapshot()
    const baseTarget = base[requestedAddress]
    if (!baseTarget) return false
    const adjusted = temperedAlternative(alternatives[i], base, plan.targets, blocked.length > 0)
    if (!adjusted) continue
    if (tryOpEitherDirection(adjusted, base, baseTarget, plan.targets).ok) return true
  }
  return false
}

// Flag unresolved damage so the service re-applies without waiting for a
// focus event — a wedged tree must not wait for the user to notice. Early
// exits (non-actionable target, managed-mode bail) run this too: a target
// crushed negative by a togglesplit fails isActionable and would otherwise
// emit clean while the workspace stays damaged.
function computeRepairPending() {
  const postCheck = snapshot()
  const postTarget = postCheck[requestedAddress]
  if (!postTarget || postTarget.floating || layoutName(postCheck) !== "dwindle") return false
  const wsId = String(postTarget.workspaceId)
  const comb = combGeom(postCheck, wsId)
  for (const a in postCheck) {
    const w = postCheck[a]
    if (w && !w.floating && String(w.workspaceId) === wsId &&
        (w.w < DAMAGE_SIZE || w.h < DAMAGE_SIZE ||
         (!comb && a !== requestedAddress && Math.min(w.w, w.h) > 90))) return true
  }
  if (Math.min(postTarget.w, postTarget.h) < 120) return true
  // Focused window far under its target while a sibling holds the surplus:
  // still repairable — the next apply can take it.
  const targets = Model.layoutTargets(postTarget, postCheck, monitors(), options) || {}
  const want = targets[requestedAddress]
  const deficit = want ? Math.max(want.w > 0 ? want.w - postTarget.w : 0,
                                want.h > 0 ? want.h - postTarget.h : 0) : 0
  if (deficit > 160) {
    for (const a in postCheck) {
      const w = postCheck[a], t = targets[a]
      if (a !== requestedAddress && w && t && !w.floating &&
          String(w.workspaceId) === wsId &&
          (w.w - (t.w || 0) > 120 || w.h - (t.h || 0) > 120)) return true
    }
  }
  return false
}

try {
  if (active() !== requestedAddress) process.exit(0)
  // Concurrent applies interleave dispatches and race the repair cooldowns —
  // serialize so each run dispatches against the previous run's settled state.
  if (acquireLock(3000)) process.on("exit", releaseLock)
  // animate=off: every geometry change snaps instantly — mute compositor
  // animations for the whole run (restored by the exit handler above).
  if (!animateLayout && animationsEnabled()) muteAnimations()
  // animateSpeed>0: the plugin owns the "windowsMove" leaf (Omarchy never
  // defines it), so only move/resize transitions take the configured
  // duration — every other animation keeps the user's own settings. Setting
  // it back to 0 re-emits the config's own definition so nothing stays
  // overridden.
  if (animateLayout && animateSpeedMs > 0) {
    try {
      lua("hl.animation({ leaf = \"windowsMove\", enabled = true, speed = " +
          (animateSpeedMs / 100) + ", bezier = \"easeOutQuint\" })")
      writeAnimSpeedState(animateSpeedMs)
    } catch (_) {}
  } else if (animSpeedState() > 0) {
    revertWindowsMoveLeaf()
    writeAnimSpeedState(0)
  }
  const initial = snapshot()
  const previousWindow = previousAddress ? initial[previousAddress] : null
  const targetWindow = initial[requestedAddress]
  // The Omarchy screensaver is a transient overlay that steals focus on a
  // special workspace. Letting it emit managed state would orphan the real
  // managed window's tracking, so skip it without emitting.
  if (targetWindow && String(targetWindow.cls || "").indexOf("omarchy.screensaver") !== -1) process.exit(0)
  const sameWorkspace = !!(previousWindow && targetWindow &&
    String(previousWindow.workspaceId) === String(targetWindow.workspaceId))
  foreignManaged = !!(previousWindow && !sameWorkspace)
  // Past the cheap early exits: from here a kill mid-run would strand
  // half-applied work, so the exit handler must re-arm the repair chain.
  repairOnKill = true
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
  let postClear = snapshot()
  if (targetWindow && !targetWindow.floating && layoutName(initial) === "dwindle") {
    if (healDegenerate(targetWindow, postClear)) postClear = snapshot()
  }

  const current = postClear[requestedAddress]
  if (!Model.isActionable(current, includeFloating)) {
    // A target crushed non-positive (a togglesplit landing on a degenerate
    // tree) fails isActionable on size alone — rescue it directly so the
    // next apply sees an actionable window. rescueNegatives skips the
    // target, so nothing else ever grows a negative focused window back.
    if (current && !current.floating && current.mapped !== false && !current.pinned &&
        (current.w <= 0 || current.h <= 0) && !healedRecently(requestedAddress)) {
      markHealed([requestedAddress])
      try {
        lua('hl.dispatch(' + Model.resizeCommand(requestedAddress,
          Math.max(current.w, options.collapseSize),
          Math.max(current.h, options.collapseSize), false) + ')')
      } catch (_) {}
    }
    if (previousAddress === requestedAddress) restoreRectangle(previousAddress, Model.parseManagedFloating(previousMode))
    emit("", computeRepairPending())
    process.exit(0)
  }

  if (current.floating) {
    const savedRectangle = previousAddress === requestedAddress ? Model.parseManagedFloating(previousMode) : null
    const applied = applyFloatingMode(current)
    emit(savedRectangle ? previousMode : (applied ? Model.managedFloatingMode(current) : ""))
    process.exit(0)
  }

  if (layoutName(postClear) === "scrolling") {
    applyScrollingMode()
    emit("")
    process.exit(0)
  }

  if (onlyWindow(postClear)) {
    // lua:columns already stretches a lone column across the area via flex,
    // so managed maximize adds real fullscreen (and its take-over churn when
    // the next window opens) for zero visual difference.
    if (!isFlatLuaLayout(layoutName(postClear))) {
      lua(Model.setManagedMaximizedEval(requestedAddress))
      // The eval re-verifies the sibling count atomically; if a new window
      // arrived between the snapshot and the dispatch it skips the maximize.
      // Only record managed state when the window actually reached fs=1 — a
      // vetoed maximize falls through to the normal layout apply below.
      const settled = snapshot()
      const now = settled[requestedAddress]
      if (now && (now.fullscreenMode || 0) === 1) {
        emit("maximized")
        process.exit(0)
      }
      postClear = settled
    } else {
      // Clear a stale managed fullscreen so a window pinned at fs=1 from an
      // older apply (or a dwindle workspace) tiles normally under columns.
      lua(Model.clearManagedFullscreenEval(requestedAddress, "maximized"))
      applyLuaColumns(postClear, layoutName(postClear))
      emit("")
      process.exit(0)
    }
  }

  if (isFlatLuaLayout(layoutName(postClear))) {
    applyLuaColumns(postClear, layoutName(postClear))
    emit("")
    process.exit(0)
  }

  trace("APPLY " + requestedAddress.slice(-6))
  if (!applyExactDwindle(postClear)) {
    const fingerprints = new Set()
    for (let pass = 0; pass < 20; pass++) {
      const clients = pass === 0 ? postClear : snapshot()
      const fingerprint = workspaceFingerprint(clients)
      if (fingerprints.has(fingerprint)) break
      fingerprints.add(fingerprint)
      if (!applyOneLayoutPass(clients)) break
    }
  }
  let sliverCheck = snapshot()
  let sliverTarget = sliverCheck[requestedAddress]
  // Repairs chain across applies only when a focus event fires — a wedged
  // tree with no further events stays broken. Loop the repair block so deep
  // damage converges within this run; per-window cooldowns keep each rung
  // from re-firing inside the loop, so later rounds wait out the heal
  // cooldown to retry windows the ladder could not fix on its first pass.
  const testEnv = !!process.env.FOCUS_NOW_STATE
  const repairDeadline = Math.min(Date.now() + 60000, RUN_DEADLINE_MS)
  let lastWedgeKey = ""
  let stallRounds = 0
  for (let round = 0; sliverTarget && !sliverTarget.floating &&
       layoutName(sliverCheck) === "dwindle"; round++) {
    if (round > 0) {
      if (Date.now() > repairDeadline || stallRounds >= 3) break
      if (testEnv && round >= 4) break
    }
    // A round that changes nothing is waiting on per-window cooldowns —
    // sleep them out. A round still making progress can run the next pass
    // immediately; cooled tools simply stay skipped until they matter.
    const roundFp = workspaceFingerprint(sliverCheck)
    // The apply itself can leave siblings outside the collapse range —
    // squeezed under the damage floor or pinned above it. Reorienting flips
    // them to the axis that has room; healDegenerate stays as the fallback
    // for damage reorient could not reach; healedRecently rate-limits repeat
    // attempts so unrepairable nodes cannot loop it.
    if (rescueNegatives(sliverTarget, sliverCheck)) sliverCheck = snapshot()
    if (reorientCrampedRegions(sliverTarget, sliverCheck)) sliverCheck = snapshot()
    if (reorientOversizedSlivers(sliverTarget, sliverCheck, postClear)) sliverCheck = snapshot()
    const healed = healDegenerate(sliverTarget, sliverCheck)
    if (healed === 2) {
      // The workspace was rebuilt — converge the fresh tree now rather than
      // leaving it for the next apply.
      for (let pass = 0; pass < 6; pass++) {
        if (!applyOneLayoutPass(snapshot())) break
      }
    }
    if (healed) sliverCheck = snapshot()
    equalizeCollapsedSlivers(sliverTarget)
    // A focused window that still cannot expand past the damage floor means
    // the tree is wedged in a shape the seam ops cannot reach — rebuild it
    // and converge now. Over-limit siblings are convergence, not damage:
    // they resolve through seam and equalize passes, so they never trigger.
    const settled = snapshot()
    const settledTarget = settled[requestedAddress]
    if (!(settledTarget && !settledTarget.floating && layoutName(settled) === "dwindle")) break
      const want = (Model.layoutTargets(settledTarget, settled, monitors(), options) || {})[requestedAddress]
      const gapX = want && want.w > 0 ? want.w - settledTarget.w : 0
      const gapY = want && want.h > 0 ? want.h - settledTarget.h : 0
      const gap = Math.max(gapX, gapY)
      // Buried = a sibling holds a bigger span on the axis the focused window
      // needs. A merely under-target window gets no reorder — that is a
      // non-converging layout, not a buried one.
      const gapAxis = gapX >= gapY ? "w" : "h"
      const focusedSpan = gapAxis === "w" ? settledTarget.w : settledTarget.h
      const buried = gap > 160 && Object.keys(settled).some(a => {
        const w = settled[a]
        return a !== requestedAddress && w && !w.floating &&
          String(w.workspaceId) === String(settledTarget.workspaceId) &&
          (gapAxis === "w" ? w.w : w.h) >= focusedSpan - 16
      })
      // A sibling with both dims over the collapse floor is wedged inside a
      // nested region the seams cannot shrink — same flatten escape applies.
      const plump = Object.keys(settled).some(a => {
        const w = settled[a]
        return a !== requestedAddress && w && !w.floating &&
          String(w.workspaceId) === String(settledTarget.workspaceId) &&
          Math.min(w.w, w.h) > 90
      })
      if (Math.min(settledTarget.w, settledTarget.h) < 120 &&
          rebuildWorkspaceTree(sliverTarget, "focused-stuck")) {
        for (let pass = 0; pass < 6; pass++) {
          if (!applyOneLayoutPass(snapshot())) break
        }
      } else if (buried && !combGeom(settled, settledTarget.workspaceId) &&
          flattenWorkspaceTree(settledTarget, "buried gap=" + Math.round(gap))) {
        // A focused window far under its target after the converge passes is
        // buried inside a multi-member region — seams around it have no leaf
        // controller on the axis it needs. movetoroot on just the focused
        // window collapses its ex-mates into degenerate nodes, so flatten the
        // whole workspace to a root-level comb, then re-converge.
        for (let pass = 0; pass < 8; pass++) {
          if (!applyOneLayoutPass(snapshot())) break
        }
      } else if (plump && gap > 160) {
        // Plump siblings are collapse-feasible everywhere — shrink them
        // straight to their model targets with absolute resizes rather than
        // scrambling the tree or waiting on escalation cooldowns.
        const targets2 = Model.layoutTargets(settledTarget, settled, monitors(), options) || {}
        let shrank = false
        for (const a in targets2) {
          if (a === requestedAddress) continue
          const w = settled[a], tw = targets2[a]
          if (!w || !tw || w.floating || String(w.workspaceId) !== String(settledTarget.workspaceId)) continue
          const sx = Math.max(0, w.w - (tw.w || 0))
          const sy = Math.max(0, w.h - (tw.h || 0))
          if (Math.max(sx, sy) > 120) {
            // Absolute resize lands the sibling on its model target in one
            // op — a clamped tree settles it at the region floor instead.
            // Pin only the excess axis so shared-column members don't race.
            lua('hl.dispatch(' + Model.resizeCommand(a,
              sx > 120 && tw.w > 0 ? tw.w : w.w,
              sy > 120 && tw.h > 0 ? tw.h : w.h, false) + ')')
            shrank = true
          }
        }
        if (shrank) {
          for (let pass = 0; pass < 4; pass++) {
            if (!applyOneLayoutPass(snapshot())) break
          }
        }
      }
      // Chain into another repair round while damage or a buried/stuck
      // focused window remains — no event will arrive to retrigger one.
      sliverCheck = snapshot()
      sliverTarget = sliverCheck[requestedAddress]
      let needsRound = false
      if (sliverTarget && !sliverTarget.floating) {
        for (const a in sliverCheck) {
          const w = sliverCheck[a]
          if (w && !w.floating && String(w.workspaceId) === String(sliverTarget.workspaceId) &&
              (w.w < DAMAGE_SIZE || w.h < DAMAGE_SIZE)) { needsRound = true; break }
        }
        if (!needsRound) {
          const t3 = Model.layoutTargets(sliverTarget, sliverCheck, monitors(), options) || {}
          const w2 = t3[requestedAddress]
          const g = Math.max(w2 && w2.w > 0 ? w2.w - sliverTarget.w : 0,
                             w2 && w2.h > 0 ? w2.h - sliverTarget.h : 0)
          // Takeable surplus: a sibling sits more than 120px above its own
          // target. Both wedge shapes respond to this — non-comb via
          // flatten, comb via the direct sibling-shrink rung.
          const sibSurplus = g > 160 && Object.keys(sliverCheck).some(a => {
            const w = sliverCheck[a], t = t3[a]
            return a !== requestedAddress && w && t && !w.floating &&
              String(w.workspaceId) === String(sliverTarget.workspaceId) &&
              (w.w - (t.w || 0) > 120 || w.h - (t.h || 0) > 120)
          })
          needsRound = Math.min(sliverTarget.w, sliverTarget.h) < 120 ||
            sibSurplus ||
            (!combGeom(sliverCheck, sliverTarget.workspaceId) &&
              Object.keys(sliverCheck).some(a => {
                const w = sliverCheck[a]
                return a !== requestedAddress && w && !w.floating &&
                  String(w.workspaceId) === String(sliverTarget.workspaceId) &&
                  Math.min(w.w, w.h) > 90
              }))
        }
      }
      if (!needsRound) break
      // Stall detection: an identical damage+wedge set surviving consecutive
      // rounds means no progress — but keep waiting while a needed tool is
      // still cooling, since it can fire in a later round.
      const wedgeKey = Object.keys(sliverCheck).filter(a => {
        const w = sliverCheck[a]
        return w && !w.floating && String(w.workspaceId) === String(sliverTarget.workspaceId) &&
          (w.w < DAMAGE_SIZE || w.h < DAMAGE_SIZE || Math.min(w.w, w.h) > 90)
      }).sort().join(",")
      const flattenCooled = cooledRecently(FLATTEN_COOLDOWN_PATH, String(sliverTarget.workspaceId), FLATTEN_COOLDOWN_MS)
      if (wedgeKey === lastWedgeKey && !flattenCooled) stallRounds++
      else { stallRounds = 0; lastWedgeKey = wedgeKey }
      // Only a no-change round waits on cooldowns — progress keeps going.
      if (!testEnv && workspaceFingerprint(sliverCheck) === roundFp)
        spawnSync("sleep", [String(HEAL_COOLDOWN_MS / 1000 + 0.2)])
    }
  emit("", computeRepairPending())
} catch (_) {
  process.exit(0)
}
