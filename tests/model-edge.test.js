const test = require("node:test")
const assert = require("node:assert/strict")
const M = require("../FocusNowModel.js")

function win(address, x, y, w, h, extra = {}) {
  return {
    address,
    class: "app",
    title: address,
    at: [x, y],
    size: [w, h],
    workspace: { id: 1, name: "1" },
    floating: false,
    pinned: false,
    mapped: true,
    monitor: 0,
    fullscreen: 0,
    fullscreenClient: 0,
    ...extra
  }
}

function meta(w) {
  return M.windowMeta(w)
}

function clientMap(...windows) {
  const out = {}
  for (const w of windows) out[w.address] = meta(w)
  return out
}

test("config normalization covers every supported option", () => {
  const normalized = M.normalizeConfig({
    enabled: false,
    hoverFocus: false,
    expandMode: "fullscreen",
    widthMultiplier: 0.86,
    heightMultiplier: "bad",
    hoverDelay: "250.6",
    fullscreenDelay: "4500.4",
    includeFloating: 1,
    stickyFullscreen: 1,
    nodePath: "relative/node",
    hyprctlPath: "/usr/bin/hyprctl",
    timeoutPath: "/usr/bin/timeout"
  })
  assert.equal(normalized.enabled, false)
  assert.equal(normalized.hoverFocus, false)
  assert.equal(normalized.expandMode, "fullscreen")
  assert.equal(normalized.widthMultiplier, 0.85)
  assert.equal(normalized.heightMultiplier, 0.85)
  assert.equal(normalized.hoverDelay, 251)
  assert.equal(normalized.fullscreenDelay, 4500)
  assert.equal(normalized.includeFloating, true)
  assert.equal(normalized.stickyFullscreen, true)
  assert.deepEqual(normalized.bins, {
    node: "",
    hyprctl: "/usr/bin/hyprctl",
    timeout: "/usr/bin/timeout"
  })
})

test("fullscreen delay clamps to the 1s floor so the release hold cannot loop", () => {
  assert.equal(M.normalizeFullscreenDelay(0), 1000)
  assert.equal(M.normalizeFullscreenDelay(250), 1000)
  assert.equal(M.normalizeFullscreenDelay(999), 1000)
  assert.equal(M.normalizeFullscreenDelay(1500.4), 1500)
  assert.equal(M.normalizeFullscreenDelay(99999), 60000)
  assert.equal(M.normalizeFullscreenDelay("bad"), 5000)
  assert.equal(M.stepFullscreenDelay(1000, -1), 1000)
  assert.equal(M.stepFullscreenDelay(1000, 1), 1500)
})

test("window and client parsing tolerates Hyprland variants and malformed input", () => {
  const parsed = M.parseClients(JSON.stringify([
    { address: "a", initialClass: "initial", workspace: { name: "special:scratchpad" }, at: [1, 2], size: [3, 4], fullscreenClient: 1, tags: ["tag"] },
    { address: "" },
    null
  ]))
  assert.equal(parsed.a.cls, "initial")
  assert.equal(parsed.a.workspaceId, "special:scratchpad")
  assert.equal(parsed.a.fullscreen, false)
  assert.deepEqual(parsed.a.tags, ["tag"])
  assert.equal(Object.keys(parsed).length, 1)
  assert.deepEqual(M.parseClients("not json"), {})
  assert.equal(M.parseActiveWindow("not json"), null)
})

test("monitor parsing applies scale and reserved work-area edges", () => {
  const monitors = M.parseMonitors(JSON.stringify([
    { id: 0, x: 100, y: 50, width: 2000, height: 1200, scale: 2, reserved: [20, 40, 60, 80], focused: true },
    { id: 1, x: 0, y: 0, width: 100, height: 100, scale: 0, reserved: [] }
  ]))
  assert.deepEqual(monitors[0].wa, { x: 60, y: 45, w: 960, h: 540 })
  assert.deepEqual(monitors[1].wa, { x: 0, y: 0, w: 100, h: 100 })
  assert.deepEqual(M.parseMonitors("bad"), {})
})

test("workspace windows exclude unrelated and unmanaged clients", () => {
  const focused = win("focused", 0, 40, 500, 760)
  const same = win("same", 500, 40, 500, 760)
  const otherWorkspace = win("other-ws", 0, 40, 500, 760, { workspace: { id: 2, name: "2" } })
  const otherMonitor = win("other-monitor", 0, 40, 500, 760, { monitor: 1 })
  const floating = win("float", 0, 40, 500, 760, { floating: true })
  const popped = win("popped", 0, 40, 500, 760, { floating: true, tags: ["pop"] })
  const restoring = win("restoring", 500, 40, 500, 760, { tags: ["pop"] })
  const pinned = win("pinned", 0, 40, 500, 760, { pinned: true })
  const unmapped = win("unmapped", 0, 40, 500, 760, { mapped: false })
  const zero = win("zero", 0, 40, 0, 760)
  const clients = clientMap(focused, same, otherWorkspace, otherMonitor, floating, popped, restoring, pinned, unmapped, zero)
  assert.equal(M.isActionable(clients.popped, true), false)
  assert.equal(M.isActionable(clients.restoring, true), false)
  assert.deepEqual(
    M.workspaceWindows(clients, clients.focused, false).map(w => w.address).sort(),
    ["focused", "same"]
  )
  assert.deepEqual(
    M.workspaceWindows(clients, clients.focused, true).map(w => w.address).sort(),
    ["float", "focused", "same"]
  )
})

test("strip clustering only merges ranges that overlap past the boundary threshold", () => {
  const a = meta(win("a", 0, 0, 100, 100))
  const overlapping = meta(win("overlapping", 75, 0, 100, 100))
  const separate = meta(win("separate", 200, 0, 100, 100))
  const strips = M.clusterStrips([a, overlapping, separate], "x")
  assert.equal(strips.length, 2)
  assert.deepEqual(strips[0].windows.map(w => w.address), ["a", "overlapping"])
  assert.deepEqual(strips[1].windows.map(w => w.address), ["separate"])
})

test("multi-monitor windows do not share layout targets", () => {
  const focused = win("focused", 0, 40, 500, 760)
  const sameMonitor = win("same-monitor", 500, 40, 500, 760)
  const otherMonitor = win("other-monitor", 0, 40, 500, 760, { monitor: 1 })
  const clients = clientMap(focused, sameMonitor, otherMonitor)
  const monitors = M.parseMonitors(JSON.stringify([
    { id: 0, x: 0, y: 0, width: 1000, height: 800, scale: 1, reserved: [0, 40, 0, 0], focused: true },
    { id: 1, x: 1000, y: 0, width: 1000, height: 800, scale: 1, reserved: [0, 40, 0, 0] }
  ]))
  const targets = M.layoutTargets(clients.focused, clients, monitors, { widthMultiplier: 0.8, heightMultiplier: 0.8, includeFloating: false })
  assert.equal(targets.focused.w, 800)
  assert.equal(targets["same-monitor"].w, 200)
  assert.equal(targets["other-monitor"], undefined)
})

test("same-size and target completion use explicit tolerances", () => {
  assert.equal(M.sameSize({ w: 100, h: 100 }, { w: 104, h: 96 }), true)
  assert.equal(M.sameSize({ w: 100, h: 100 }, { w: 105, h: 100 }), false)
  assert.equal(M.targetReached({ w: 800, h: 600 }, { w: 830, h: 630 }), true)
  assert.equal(M.targetReached({ w: 800, h: 600 }, { w: 833, h: 600 }), false)
  assert.equal(M.targetReached({ w: 800, h: 600 }, { w: 0, h: 630 }), true)
  assert.equal(M.targetReached({ w: 800, h: 600 }, null), false)
})

test("floating targets need a monitor work area and obey the minimum size", () => {
  const focused = meta(win("float", 0, 0, 100, 100, { floating: true }))
  const monitors = M.parseMonitors(JSON.stringify([
    { id: 0, x: 0, y: 0, width: 100, height: 90, scale: 1, reserved: [0, 10, 0, 10], focused: true }
  ]))
  const target = M.floatingTarget(focused, monitors, { widthMultiplier: 0.5, heightMultiplier: 0.5 })
  assert.equal(target.w, 80)
  assert.equal(target.h, 80)
  assert.equal(M.floatingTarget(focused, {}, { widthMultiplier: 0.5, heightMultiplier: 0.5 }), null)
})

test("floating placement clamps to the work area while keeping the pointer inside", () => {
  const focused = meta(win("float", 900, 650, 200, 100, { floating: true }))
  const target = { wa: { x: 0, y: 40, w: 1000, h: 760 }, w: 850, h: 646 }
  const placement = M.floatingPlacement(focused, target, { x: 950, y: 700 })
  assert.deepEqual(placement, { x: 150, y: 154, w: 850, h: 646 })
  const outside = M.floatingPlacement(focused, target, { x: 1200, y: 700 })
  assert.deepEqual(outside, { x: 150, y: 154, w: 850, h: 646 })
  assert.equal(M.floatingPlacement(focused, null, { x: 0, y: 0 }), null)
})

test("point-in-window accounts for titlebar insets and border margins", () => {
  const focused = meta(win("float", 100, 100, 200, 100))
  assert.equal(M.pointInsideWindow(focused, { x: 150, y: 150 }, 0, 0), true)
  assert.equal(M.pointInsideWindow(focused, { x: 101, y: 150 }, 0, 2), false)
  assert.equal(M.pointInsideWindow(focused, { x: 150, y: 120 }, 30, 0), false)
  assert.equal(M.pointInsideWindow(focused, { x: 150, y: 132 }, 30, 0), true)
})

test("managed floating state round-trips and rejects malformed modes", () => {
  const focused = meta(win("float", 100.4, 200.6, 300.5, 400.5, { floating: true }))
  const mode = M.managedFloatingMode(focused)
  assert.equal(mode, "floating:100:201:301:401")
  assert.deepEqual(M.parseManagedFloating(mode), { x: 100, y: 201, w: 301, h: 401 })
  assert.equal(M.parseManagedFloating("floating:1:2:3"), null)
  assert.equal(M.parseManagedFloating("maximized"), null)
  assert.equal(M.parseManagedFloating("floating:a:2:3:4"), null)
})

test("compositor command generators carry the intended operation", () => {
  assert.match(M.resizeCommand("a", -10, 20, false), /address:a/)
  assert.match(M.resizeCommand("a", -10, 20, false), /x = -10, y = 20, relative = false/)
  const batch = M.resizeEval([
    { address: "a", dx: 10, dy: 0 },
    { address: "b", dx: 0, dy: -10 }
  ])
  assert.match(batch, /address:a/)
  assert.match(batch, /address:b/)
  assert.match(M.floatingResizeEval("a", { x: 1, y: 2, w: 3, h: 4 }), /bring_to_top/)
  assert.match(M.restoreFloatingEval("a", { x: 1, y: 2, w: 3, h: 4 }), /x = 3, y = 4, relative = false/)
  assert.match(M.mouseConfigEval(0, false), /follow_mouse = 0, mouse_refocus = false/)
})

test("fullscreen cleanup commands distinguish target and other windows", () => {
  const clearTarget = M.clearManagedFullscreenEval("a", "fullscreen")
  assert.match(clearTarget, /w\.address == "a"/)
  assert.match(clearTarget, /target\.fullscreen == 2/)
  assert.match(clearTarget, /internal = 0, client = 0/)
  const clearOthers = M.clearOtherFullscreenEval("a")
  assert.match(clearOthers, /other\.address ~= target\.address/)
  assert.match(clearOthers, /other\.fullscreen ~= 0 and other\.fullscreen_client == 1/)
})

test("unknown managed fullscreen modes are never treated as owned", () => {
  const managed = meta(win("a", 0, 0, 100, 100, { fullscreen: 1, fullscreenClient: 1 }))
  assert.equal(M.isManagedFullscreen(managed, "a", "unknown"), false)
  assert.equal(M.managedFullscreenApplies(managed, "a", "unknown", "near", true), false)
  assert.match(M.managedFullscreenCondition("unknown"), /false/)
})

test("active floating workspace detection checks tags and saved layout modes", () => {
  const code = M.activeWorkspaceFloatsEval()
  assert.match(code, /omarchy-floating-workspace/)
  assert.match(code, /workspace-layouts/)
  assert.match(code, /mode%s\*=%s\*"floating"/)
  assert.match(code, /default%s\*=%s\*"floating"/)
})
