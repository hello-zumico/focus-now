const { spawnSync } = require("node:child_process")
const path = require("node:path")
const M = require(path.join(__dirname, "FocusNowModel.js"))

const hyprctl = String(process.argv[2] || "/usr/bin/hyprctl")
// Pointer must sit off every window this long before the expansion releases —
// keeps gap/seam crossings and quick bar trips from flickering the layout.
const GRACE_MS = Math.max(150, Number(process.argv[3]) || 350)

function run(argumentsList) {
  const result = spawnSync(hyprctl, argumentsList, { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || "hyprctl failed")
  return result.stdout || ""
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n")
}

let released = false
let outsideSince = 0
let hoveredAddress = ""
let lastCursor = null

// The expansion owner on the active workspace is its largest tiled window —
// the pointer may have swept highlight across siblings on the way out, so
// release reports who actually holds the share. A tie means nothing is
// expanded, so the active window stands in and no refocus is needed.
function expandedOnActiveWorkspace(clients, active) {
  const ws = active && active.workspaceId
  let best = "", bestArea = 0, tied = false
  for (const address of Object.keys(clients)) {
    const window = clients[address]
    if (!window || window.floating || String(window.workspaceId) !== String(ws)) continue
    const area = (window.w || 0) * (window.h || 0)
    if (area > bestArea) { best = address; bestArea = area; tied = false }
    else if (area === bestArea) tied = true
  }
  return tied || !best ? (active && active.address || "") : best
}

function tick() {
  let cursor, clients, active
  try {
    const rawCursor = run(["-j", "cursorpos"])
    const rawClients = run(["-j", "clients"])
    const rawActive = run(["-j", "activewindow"])
    // A failed or malformed poll must never read as "pointer off every
    // window" — only a well-formed clients list can release the layout.
    if (rawClients.trim()[0] !== "[") return
    cursor = M.parseJson(rawCursor, null)
    clients = M.parseClients(rawClients)
    active = M.parseActiveWindow(rawActive)
  } catch (e) {
    // hyprctl itself is gone — nothing left to poll.
    if (e && e.code === "ENOENT") process.exit(0)
    return
  }
  if (!cursor) return
  // Windows on workspaces no monitor shows (e.g. a closed scratchpad) are
  // stale boxes in the clients list, not hoverable surface — including them
  // makes "off every window" unreachable across whatever they cover, so
  // pending-expansion cancellation and the release grace never run.
  const monitors = M.parseJson(run(["-j", "monitors"]), [])
  const visible = {}
  for (const mon of Array.isArray(monitors) ? monitors : []) {
    if (mon && mon.activeWorkspace && mon.activeWorkspace.id !== undefined)
      visible[String(mon.activeWorkspace.id)] = true
    if (mon && mon.specialWorkspace && mon.specialWorkspace.id !== undefined && mon.specialWorkspace.id !== 0)
      visible[String(mon.specialWorkspace.id)] = true
  }
  // A failed monitors poll leaves the set empty — fall back to counting every
  // window rather than reporting "off every window" forever.
  const hasVisible = Object.keys(visible).length > 0
  const moved = !lastCursor || cursor.x !== lastCursor.x || cursor.y !== lastCursor.y
  lastCursor = cursor
  const over = Object.keys(clients).filter(function(address) {
    const window = clients[address]
    return window && window.mapped !== false && (!hasVisible || visible[String(window.workspaceId)] === true) &&
      M.pointInsideWindow(window, cursor, 0, 0)
  })
  if (over.length) {
    outsideSince = 0
    const address = active && over.includes(active.address) ? active.address : over[0]
    if (released || (moved && address !== hoveredAddress)) {
      released = false
      hoveredAddress = address
      emit({ release: false, hover: true, address })
    }
    return
  }
  hoveredAddress = ""
  // Report the instant the pointer leaves every window — before the release
  // grace. A debounced expansion armed by the last swept-through window must
  // be cancelled now, or it fires while the pointer is already gone.
  if (!outsideSince) {
    outsideSince = Date.now()
    emit({ outside: true, expanded: expandedOnActiveWorkspace(clients, active) })
  }
  if (!released && Date.now() - outsideSince >= GRACE_MS) {
    released = true
    emit({ release: true, address: active && active.address || "",
      expanded: expandedOnActiveWorkspace(clients, active) })
  }
}

setInterval(tick, 120)
tick()
