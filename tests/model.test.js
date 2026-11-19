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

const monitorJson = [{ id: 0, x: 0, y: 0, width: 1000, height: 800, scale: 1, reserved: [0, 40, 0, 0], focused: true }]
const monitors = M.parseMonitors(JSON.stringify(monitorJson))
const cfg = { widthMultiplier: 0.8, heightMultiplier: 0.8, includeFloating: false }

function meta(w) {
  return M.windowMeta(w)
}

function clientMap(...windows) {
  const out = {}
  for (const w of windows) out[w.address] = meta(w)
  return out
}

test("normalizes and steps multiplier selectors", () => {
  const normalized = M.normalizeConfig({ widthMultiplier: 0.84, heightMultiplier: 2, expandMode: "bad" })
  assert.equal(normalized.widthMultiplier, 0.85)
  assert.equal(normalized.heightMultiplier, 1.0)
  assert.equal(normalized.expandMode, "near")
  assert.equal(M.stepMultiplier(0.85, 1), 0.9)
  assert.equal(M.stepMultiplier(0.5, -1), 0.5)
})

test("side-by-side focus gets multiplier and neighbors share remainder", () => {
  const a = win("a", 0, 40, 500, 760)
  const b = win("b", 500, 40, 500, 760)
  const clients = clientMap(a, b)
  const targets = M.layoutTargets(clients.a, clients, monitors, cfg)
  assert.equal(targets.a.w, 800)
  assert.equal(targets.b.w, 200)
  assert.equal(targets.a.h, 760)
  assert.equal(targets.b.h, undefined)
})

test("three columns shrink unfocused strips proportionally", () => {
  const a = win("a", 0, 40, 250, 760)
  const b = win("b", 250, 40, 250, 760)
  const c = win("c", 500, 40, 500, 760)
  const clients = clientMap(a, b, c)
  const targets = M.layoutTargets(clients.c, clients, monitors, cfg)
  assert.equal(targets.c.w, 800)
  assert.equal(targets.a.w + targets.b.w, 200)
  assert.ok(targets.a.w >= 80)
  assert.ok(targets.b.w >= 80)
})

test("vertical neighbor shares height only when it overlaps horizontally", () => {
  const a = win("a", 0, 40, 500, 380)
  const b = win("b", 0, 420, 500, 380)
  const c = win("c", 500, 40, 500, 760)
  const clients = clientMap(a, b, c)
  const targets = M.layoutTargets(clients.a, clients, monitors, cfg)
  assert.equal(targets.a.h, 608)
  assert.equal(targets.b.h, 152)
  assert.equal(targets.c.h, undefined)
})


test("bottom window in an L-shaped layout expands only vertically", () => {
  const bottom = win("bottom", 0, 500, 1000, 300)
  const topLeft = win("top-left", 0, 40, 500, 460)
  const topRight = win("top-right", 500, 40, 500, 460)
  const clients = clientMap(bottom, topLeft, topRight)
  const targets = M.layoutTargets(clients.bottom, clients, monitors, cfg)
  assert.equal(targets.bottom.w, 1000)
  assert.equal(targets.bottom.h, 608)
  assert.equal(targets["top-left"].h, 152)
  assert.equal(targets["top-right"].h, 152)
  assert.equal(targets["top-left"].w, undefined)
  assert.equal(targets["top-right"].w, undefined)
})

test("no neighbors claim the full work-area dimensions", () => {
  const a = win("a", 200, 200, 300, 200)
  const targets = M.layoutTargets(clientMap(a).a, clientMap(a), monitors, { ...cfg, widthMultiplier: 0.5 })
  assert.equal(targets.a.w, 1000)
  assert.equal(targets.a.h, 760)
})

test("layout ops resize the focused split edge", () => {
  const a = win("a", 0, 40, 500, 760)
  const b = win("b", 500, 40, 500, 760)
  const plan = M.layoutOps(clientMap(a, b).a, clientMap(a, b), monitors, cfg)
  assert.ok(plan.ops.some(op => op.address === "a" && op.dx > 0 && op.dy === 0 && op.candidate === 0))
  assert.ok(plan.ops.some(op => op.address === "b" && op.candidate > 0))
  assert.match(M.resizeCommand("a", 10, 0), /window = "address:a"/)
  assert.match(M.resizeCommand("a", 10, 0), /relative = true/)
})

test("every unfocused strip is held to its minimum width", () => {
  const scaled = M.parseMonitors(JSON.stringify([
    { id: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1.25, reserved: [0, 0, 0, 26], focused: true }
  ]))
  const focused = win("focused", 965, 12, 422, 814)
  const left = win("left", 12, 12, 939, 814)
  const topRight = win("top-right", 1401, 12, 123, 120)
  const bottomRight = win("bottom-right", 1401, 146, 123, 680)
  const clients = clientMap(focused, left, topRight, bottomRight)
  const targets = M.layoutTargets(clients.focused, clients, scaled, { ...cfg, widthMultiplier: 0.85 })
  assert.equal(targets.focused.w, 1238)
  assert.equal(targets.left.w, 123)
  assert.equal(targets["top-right"].w, 123)
  assert.equal(targets["bottom-right"].w, 123)
  const plan = M.layoutOps(clients.focused, clients, scaled, { ...cfg, widthMultiplier: 0.85 })
  assert.ok(plan.ops.some(op => op.address === "focused" && op.dx < 0 && op.candidate === 0))
  assert.ok(plan.ops.some(op => op.address === "left" && op.dx < 0 && op.candidate > 0))
})

test("floating windows are ignored unless requested", () => {
  const a = win("a", 0, 40, 500, 760, { floating: true })
  const b = win("b", 500, 40, 500, 760)
  const clients = clientMap(a, b)
  assert.equal(M.isActionable(clients.a, false), false)
  assert.equal(M.isActionable(clients.a, true), true)
  assert.deepEqual(M.workspaceWindows(clients, clients.b, false).map(w => w.address), ["b"])
})

test("managed fullscreen ownership is distinguished from user state", () => {
  const userFullscreen = meta(win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 2 }))
  const userMaximized = meta(win("a", 0, 40, 500, 760, { fullscreen: 1, fullscreenClient: 1 }))
  const pluginFullscreen = meta(win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 1 }))
  assert.equal(M.isManagedFullscreen(userFullscreen, "a", "fullscreen"), false)
  assert.equal(M.isManagedFullscreen(userFullscreen, "a", "maximized"), false)
  assert.equal(M.isManagedFullscreen(userMaximized, "a", "maximized"), true)
  assert.equal(M.isManagedFullscreen(pluginFullscreen, "a", "fullscreen"), true)
  assert.equal(M.isManagedFullscreen(pluginFullscreen, "a", "maximized"), false)
  assert.equal(M.isManagedFullscreen(pluginFullscreen, "b", "fullscreen"), false)
})

test("managed fullscreen cleanup only matches the owned state", () => {
  assert.match(M.clearManagedFullscreenEval("a", "maximized"), /fullscreen == 1 and target\.fullscreen_client == 1/)
  assert.match(M.clearManagedFullscreenEval("a", "fullscreen"), /fullscreen == 2 and target\.fullscreen_client == 1/)
  assert.match(M.clearManagedFullscreenEval("a", "unknown"), /target and false then/)
})

test("a focused window in a shared edge column resizes its own boundary", () => {
  const scaled = M.parseMonitors(JSON.stringify([
    { id: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1.25, reserved: [0, 0, 0, 26], focused: true }
  ]))
  const devin = win("devin", 12, 12, 123, 814)
  const zen = win("zen", 149, 12, 1238, 814)
  const om = win("om", 1401, 12, 123, 120)
  const foot = win("foot", 1401, 146, 123, 680)
  const clients = clientMap(devin, zen, om, foot)
  const cfg85 = { ...cfg, widthMultiplier: 0.85, heightMultiplier: 0.85 }
  const footPlan = M.layoutOps(clients.foot, clients, scaled, cfg85)
  const omPlan = M.layoutOps(clients.om, clients, scaled, cfg85)
  assert.ok(footPlan.ops.some(op => op.address === "foot" && op.dx < 0 && op.candidate === 0))
  assert.ok(omPlan.ops.some(op => op.address === "om" && op.dx < 0 && op.candidate === 0))
  assert.ok(omPlan.ops.some(op => op.address === "om" && op.dy > 0 && op.candidate === 0))
})

test("stacked rows resize the focused row's own boundary", () => {
  const top = win("top", 12, 12, 1512, 80)
  const upper = win("upper", 12, 106, 1512, 80)
  const middle = win("middle", 12, 200, 1512, 532)
  const bottom = win("bottom", 12, 746, 1512, 80)
  const clients = clientMap(top, upper, middle, bottom)
  const stackedMonitors = M.parseMonitors(JSON.stringify([
    { id: 0, x: 0, y: 0, width: 1536, height: 864, scale: 1, reserved: [0, 38, 0, 38], focused: true }
  ]))
  const cfg85 = { ...cfg, widthMultiplier: 0.85, heightMultiplier: 0.85 }
  const topPlan = M.layoutOps(clients.top, clients, stackedMonitors, cfg85)
  const upperPlan = M.layoutOps(clients.upper, clients, stackedMonitors, cfg85)
  const bottomPlan = M.layoutOps(clients.bottom, clients, stackedMonitors, cfg85)
  assert.ok(topPlan.ops.some(op => op.address === "top" && op.dy > 0 && op.candidate === 0))
  assert.ok(upperPlan.ops.some(op => op.address === "upper" && op.dy < 0 && op.candidate === 0))
  assert.ok(bottomPlan.ops.some(op => op.address === "bottom" && op.dy < 0 && op.candidate === 0))
  assert.ok(topPlan.ops.some(op => op.address === "middle" && op.dy < 0 && op.candidate > 0))
  assert.equal(M.layoutOps(clients.middle, clients, stackedMonitors, cfg85).ops.length, 0)
})

test("target completion tolerates compositor borders and gaps", () => {
  assert.equal(M.targetReached({ w: 1512, h: 532 }, { w: 1536, h: 532 }), true)
  assert.equal(M.targetReached({ w: 1200, h: 532 }, { w: 1536, h: 532 }), false)
})

test("nested splits can promote the focused window to the root", () => {
  assert.match(M.moveToRootEval(), /hl\.dsp\.layout\("movetoroot"\)/)
})

test("hover bridge handles floating-mode input changes without polling", () => {
  const install = M.installHoverBridgeEval()
  assert.match(install, /o\.workspace_mode = bridge\.wrapped_workspace_mode/)
  assert.match(install, /hl\.on\("workspace\.active"/)
  assert.match(install, /hl\.on\("monitor\.focused"/)
  assert.match(install, /omarchy-floating-workspace/)
  assert.match(install, /restore_follow_mouse = active_workspace_floats\(\) and 0/)
  assert.match(install, /follow_mouse = 1/)
  assert.match(install, /mouse_refocus = true/)
  const uninstall = M.uninstallHoverBridgeEval(0, false)
  assert.match(uninstall, /subscription:remove/)
  assert.match(uninstall, /o\.workspace_mode = bridge\.workspace_mode/)
  assert.match(uninstall, /restore_follow = 0/)
  assert.match(uninstall, /elseif active_workspace_floats\(\) then restore_follow = 0/)
  assert.match(uninstall, /restore_refocus = false/)
  assert.match(uninstall, /restore_mouse_refocus ~= nil/)
})
