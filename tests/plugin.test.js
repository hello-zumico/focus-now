import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { spawnSync } from "node:child_process"

const rootDir = fileURLToPath(new URL("../", import.meta.url))
const read = name => readFileSync(join(rootDir, name), "utf8")

test("a saved omarchy mode file syncs the base instead of disabling the preset", () => {
  const source = read("Service.qml")
  const signature = "  function reconcileLayouts(text) {"
  const start = source.indexOf(signature) + signature.length
  const end = source.indexOf("\n  }\n", start)
  const calls = []
  const root = {
    rawConfig: { columns: { "1": { enabled: true, open: "vertical", base: "dwindle", mode: "mix" } } },
    ruleReassertedAt: {},
    log: msg => calls.push(["log", msg]),
    saveConfig: cfg => calls.push(["save", cfg]),
    workspaceRuleEval: (name, desired) => calls.push(["rule", name, desired])
  }
  // Probe output: ws1 live on dwindle with a saved floating mode file.
  const fn = new Function("text", "root", "rawConfig", "saveConfig", "workspaceRuleEval", source.slice(start, end))
  fn("error: [string]:1: 1=dwindle=floating", root, root.rawConfig, cfg => root.saveConfig(cfg), (n, d) => calls.push(["rule", n, d]))
  const saved = calls.find(c => c[0] === "save")
  assert.ok(saved, "expected a config save")
  assert.equal(saved[1].columns["1"].enabled, true, "preset must stay enabled")
  assert.equal(saved[1].columns["1"].base, "floating", "base follows the saved file")
  assert.ok(!calls.some(c => c[0] === "rule"), "floating cannot be re-asserted")
  // The file cycles back to dwindle: base syncs back and lua:tree re-asserts.
  calls.length = 0
  root.rawConfig = saved[1]
  fn("error: [string]:1: 1=dwindle=dwindle", root, root.rawConfig, cfg => root.saveConfig(cfg), (n, d) => calls.push(["rule", n, d]))
  const resynced = calls.find(c => c[0] === "save")
  assert.equal(resynced[1].columns["1"].base, "dwindle")
  assert.deepEqual(calls.find(c => c[0] === "rule"), ["rule", "1", "lua:tree"])
})

test("a file toggle under a flat overlay is a base override, not a stranded mode", () => {
  const source = read("Service.qml")
  const signature = "  function reconcileLayouts(text) {"
  const start = source.indexOf(signature) + signature.length
  const end = source.indexOf("\n  }\n", start)
  const calls = []
  const root = {
    rawConfig: { columns: { "1": { enabled: true, open: "vertical", base: "dwindle", mode: "rows" } } },
    ruleReassertedAt: {},
    log: () => {},
    saveConfig: cfg => calls.push(["save", cfg]),
    workspaceRuleEval: (name, desired) => calls.push(["rule", name, desired])
  }
  const fn = new Function("text", "root", "rawConfig", "saveConfig", "workspaceRuleEval", source.slice(start, end))
  // A deliberate omarchy toggle to scrolling while mode=rows: the entry must
  // become base=scrolling + mode=mix so the rows mode is not left stranded
  // under an unreachable base.
  fn("error: [string]:1: 1=scrolling=scrolling", root, root.rawConfig, cfg => root.saveConfig(cfg), (n, d) => calls.push(["rule", n, d]))
  const saved = calls.find(c => c[0] === "save")
  assert.ok(saved, "expected a config save")
  assert.equal(saved[1].columns["1"].base, "scrolling")
  assert.equal(saved[1].columns["1"].mode, "mix", "non-dwindle base clears the overlay to mix")
  assert.ok(!calls.some(c => c[0] === "rule"), "scrolling cannot be re-asserted")
})

test("enabled tree expansion does not depend on a transient sizes overlay", () => {
  const source = read("columns.lua")
  const start = source.indexOf('hl.layout.register("tree"')
  const end = source.indexOf("  layout_msg:", start)
  const render = source.slice(start, end)
  assert.ok(render.includes("if opts_enabled and opts_expand then"))
  assert.ok(render.includes("st.sizes or {}"))
  assert.ok(!render.includes("if st.sizes and next(st.sizes) then"))
})

test("config reload reinstalls hover ownership even after a failed installation", () => {
  const source = read("Service.qml")
  const start = source.indexOf("    function onRawEvent(event) {")
  const end = source.indexOf("\n    }\n  }", start)
  const body = source.slice(start + "    function onRawEvent(event) {".length, end)
  let installs = 0
  const root = { ipcOwner: true, config: { enabled: true, hoverFocus: true }, hoverBridgeInstalled: false }
  new Function("root", "event", "hoverBridgeReload", body)(root,
    { name: "configreloaded" }, { restart() { installs++ } })
  assert.equal(installs, 1)
})

test("hover bridge failures retry within a bound and success restores installed state", () => {
  const source = read("Service.qml")
  const start = source.indexOf("    id: hoverBridgeProc")
  const signature = "    onExited: function(code) {"
  const bodyStart = source.indexOf(signature, start) + signature.length
  const end = source.indexOf("\n    }\n  }", bodyStart)
  const callback = new Function("root", "code", "hoverBridgeReload", source.slice(bodyStart, end))
  let retries = 0
  const root = {
    ipcOwner: true, hoverHeld: true, hoverBridgeInstalled: true, hoverBridgeRetries: 0,
    config: { enabled: true, hoverFocus: true }, log() {}
  }
  const timer = { restart() { retries++ } }
  for (let i = 0; i < 4; i++) callback(root, 124, timer)
  assert.equal(root.hoverBridgeInstalled, false)
  assert.equal(retries, 3)
  callback(root, 0, timer)
  assert.equal(root.hoverBridgeInstalled, true)
  assert.equal(root.hoverBridgeRetries, 0)
  root.hoverHeld = false
  root.hoverBridgeInstalled = false
  callback(root, 0, timer)
  assert.equal(root.hoverBridgeInstalled, false)
})

test("tree renders preserve the configured client floor through nested splits", () => {
  const source = read("columns.lua")
  const helpers = source.includes("local function tree_minimum")
    ? source.slice(source.indexOf("local function tree_minimum"), source.indexOf("local function tree_req")) : ""
  const solve = source.slice(source.indexOf("local function tree_req"), source.indexOf("local function tree_grab"))
  const render = source.slice(source.indexOf("local function tree_render"), source.indexOf("local function tree_swap_neighbor"))
  const result = spawnSync("lua", ["-"], { encoding: "utf8", input: `
local SEAM, EDGE, MINCELL, opts_collapse = 7, 2, 32, 64
local gap = 5
hl = {get_config=function(key)
  if key == "general.border_size" then return EDGE end
  return {left=gap,right=gap,top=gap,bottom=gap}
end}
local function collapse_floor() return opts_collapse end
local function sane_geom(g) return g end
local function place_cell(t, box) t:place(box) end
local function tree_leaves(n, out)
  out = out or {}
  if n.leaf then out[#out+1] = n.leaf else for _, k in ipairs(n.kids) do tree_leaves(k,out) end end
  return out
end
local function tree_find(n,a)
  if n.leaf then if n.leaf == a then return {leaf=n} end return end
  return tree_find(n.kids[1],a) or tree_find(n.kids[2],a)
end
${helpers}
${solve}
${render}
local function leaf(a) return {leaf=a} end
local function node(d,a,b) return {dir=d, ratio=0.98, kids={a,b}} end
local tree = node("h", node("h", leaf("a"), node("v",leaf("b"),leaf("c"))), leaf("d"))
local area = {x=0,y=0,w=1200,h=800}
local live, placed = {}, {}
local focused, exact = nil, false
for _, a in ipairs({"a","b","c","d"}) do
  live[a] = {place=function(_,r)
    local padding = gap + EDGE
    local w = r.w - (r.x == 0 and EDGE or padding) - (r.x+r.w == area.w and EDGE or padding)
    local h = r.h - (r.y == 0 and EDGE or padding) - (r.y+r.h == area.h and EDGE or padding)
    assert(w >= opts_collapse and h >= opts_collapse, a.." below floor: "..w.."x"..h)
    if exact and a ~= focused then
      assert(w == opts_collapse or h == opts_collapse, a.." not collapsed exactly: "..w.."x"..h)
    end
    assert(r.x >= 0 and r.y >= 0 and r.x+r.w <= area.w and r.y+r.h <= area.h)
    placed[a] = true
  end}
end
for _, floor in ipairs({32,64,96}) do
  opts_collapse = floor
  for _, padding in ipairs({0,5,11}) do
    gap = padding
    local st = {rects={},pseudo={}}
    tree_render(st,tree,area,live,{},area)
    local sizes = {a={w=1,h=1}, b={w=100000,h=100000}, c={w=1,h=1}, d={w=1,h=1}}
    local req = tree_req(st,tree,sizes,4,area)
    tree_solve_render(st,tree,req,area,live,{},area)
    st.pseudo.b = {w=floor,h=floor}
    local geom = {d={x=-1000,y=-1000,w=-10,h=-10}}
    tree_render(st,tree,area,live,geom,area)
    tree_solve_render(st,tree,req,area,live,geom,area)
    assert(tree.ratio == 0.98)
  end
end
for _, floor in ipairs({32,64,96}) do
  opts_collapse = floor
  for _, padding in ipairs({0,5,11}) do
    gap = padding
    for _, rootDir in ipairs({"h","v"}) do
      for _, innerDir in ipairs({"h","v"}) do
        tree.dir, tree.kids[1].dir = rootDir, innerDir
        for _, a in ipairs({"a","b","c","d"}) do
          focused, exact = a, true
          local st = {rects={},pseudo={}}
          local sizes = {a={w=1000,h=750},b={w=1000,h=750},c={w=1000,h=750},d={w=1000,h=750}}
          local req = tree_req(st,tree,sizes,4,area,nil,focused)
          tree_solve_render(st,tree,req,area,live,{},area)
        end
      end
    end
  end
end
exact = false
opts_collapse = 96
area.w, gap = 180, 5
tree_grid_render({tree=tree,rects={},pseudo={}},live,{},area)
focused, exact = "b", true
tree_grid_render({tree=tree,rects={},pseudo={}},live,{},area,focused)
area.w, area.h = 300, 250
tree_grid_render({tree=tree,rects={},pseudo={}},live,{},area,focused)
for _, a in ipairs({"a","b","c","d"}) do assert(placed[a]) end
` })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})

test("successful layout switches refresh actual focus after the transition hold", () => {
  const source = read("Service.qml")
  const start = source.indexOf("    id: workspaceRuleProc")
  const timerStart = source.indexOf("    id: transitionExpandTimer", start)
  assert.ok(source.slice(start, timerStart).includes("if (code === 0) transitionExpandTimer.restart()"))
  const timerEnd = source.indexOf("\n  }", timerStart)
  const timer = source.slice(timerStart, timerEnd)
  assert.ok(timer.includes("root.expandHoldUntil - Date.now() + 50"))
  const body = timer.slice(timer.indexOf("onTriggered: {") + "onTriggered: {".length, timer.lastIndexOf("}"))
  const values = []
  const probe = { set running(value) { values.push(value) } }
  new Function("root", "snapshotProbe", body)({ ipcOwner: true, config: { enabled: true } }, probe)
  assert.deepEqual(values, [false, true])
})

test("switching to a Lua provider exits Omarchy floating mode first", () => {
  const source = read("Service.qml")
  const start = source.indexOf('} else if (desired === "lua:columns"')
  const end = source.indexOf("\n    } else {", start)
  const branch = source.slice(start, end)
  assert.ok(branch.includes('mode = "dwindle"'))
  assert.ok(branch.indexOf("o.workspace_mode(") < branch.indexOf("hl.workspace_rule("))
})

test("hover ownership suppresses native scrolling and restores it on unload", () => {
  const model = read("FocusNowModel.js")
  assert.ok(model.includes('bridge.restore_scrolling_follow_focus = hl.get_config("scrolling.follow_focus")'))
  assert.ok(model.includes('hl.config({ scrolling = { follow_focus = false } })'))
  assert.ok(model.includes('follow_focus = bridge.restore_scrolling_follow_focus'))
  const apply = read("apply.js")
  const start = apply.indexOf("function applyScrollingMode()")
  const body = apply.slice(start, apply.indexOf("function workspaceFingerprint", start))
  assert.ok(body.indexOf('colresize \' + share') < body.indexOf('const expanded = snapshot()'))
  assert.ok(body.indexOf('const expanded = snapshot()') < body.indexOf('hl.dsp.layout("center")'))
})

test("scrolling viewport gaps do not cancel a pending hover expansion", () => {
  const source = read("Service.qml")
  const signature = "  function onHoverReleaseLine(line) {"
  const start = source.indexOf(signature)
  const end = source.indexOf("\n  }\n\n  function refocusExpandedWindow", start)
  const handler = new Function("root", "Model", "line", "debounce", "hyprAddress", source.slice(start + signature.length, end))
  const root = {
    pendingAddress: "right", heldAddress: "right", focusedWorkspaceId: 1,
    workspaceDesiredLayout: () => "scrolling"
  }
  handler(root, { parseJson: JSON.parse }, JSON.stringify({ outside: true, expanded: "left" }), { stop() {} }, value => value)
  assert.equal(root.pendingAddress, "right")
  assert.equal(root.heldAddress, "right")
  handler(root, { parseJson: JSON.parse }, JSON.stringify({ release: true, expanded: "left" }))
  assert.equal(root.pendingAddress, "right")
})

test("hover monitor reports direct window crossings even when focus stays behind", () => {
  let x = 10, poll
  const output = []
  const clients = {
    left: { address: "left", workspaceId: 1, x: 0, y: 0, w: 100, h: 100 },
    right: { address: "right", workspaceId: 1, x: 100, y: 0, w: 100, h: 100 }
  }
  const model = {
    parseJson: JSON.parse, parseClients: () => clients, parseActiveWindow: JSON.parse,
    pointInsideWindow: (w, p) => p.x >= w.x && p.x < w.x + w.w && p.y >= w.y && p.y < w.y + w.h
  }
  const requireMock = name => name === "node:child_process" ? {
    spawnSync: (_, args) => ({ status: 0, stdout: JSON.stringify({
      cursorpos: { x, y: 10 }, clients: [],
      activewindow: clients.left, monitors: [{ activeWorkspace: { id: 1 } }]
    }[args[1]]) })
  } : name === "node:path" ? { join: () => "model" } : model
  new Function("require", "process", "setInterval", "__dirname", read("hover-release.js"))(
    requireMock, { argv: [], stdout: { write: text => output.push(JSON.parse(text)) } },
    callback => { poll = callback }, "."
  )
  x = 150
  poll()
  assert.equal(output.at(-1).address, "right")
  assert.equal(output.at(-1).hover, true)
  const count = output.length
  poll()
  assert.equal(output.length, count)
})

test("legacy focus events cannot overwrite the pending window address", () => {
  const source = read("Service.qml")
  const start = source.indexOf("    function onRawEvent(event) {")
  const end = source.indexOf("\n    }\n  }", start)
  const body = source.slice(start + "    function onRawEvent(event) {".length, end)
  const requests = []
  const root = { ipcOwner: true, requestRefresh: address => requests.push(address) }
  const probe = { running: false }
  const dispatch = new Function("root", "event", "snapshotProbe", body)
  dispatch(root, { name: "activewindowv2", parse: () => ["abc123"] }, probe)
  dispatch(root, { name: "activewindow", parse: () => ["foot", "Terminal"] }, probe)
  assert.deepEqual(requests, ["abc123"])
})

test("workspace cycling normalizes Lua tiling and persists through the service", () => {
  const source = read("columns.lua")
  const start = source.indexOf("register_management_binds = function()")
  const cycle = source.slice(start, source.indexOf("for _, dir", start))
  assert.ok(cycle.includes('key = "SUPER + L", back = false'))
  assert.ok(cycle.includes('key = "SUPER + ALT + L", back = true'))
  assert.ok(cycle.includes('lua:*) current=dwindle'))
  assert.ok(cycle.includes('ipc call focus-now workspaceBase'))
  assert.ok(cycle.includes('pcall(hl.unbind, cycle.key)'))
  assert.ok(cycle.includes('pcall(hl.bind, cycle.key,'))
  assert.ok(cycle.includes('if not opts_enabled then'))
})

test("plugin metadata and packaged entry points agree", () => {
  const manifest = JSON.parse(read("manifest.json"))
  const pkg = JSON.parse(read("package.json"))

  assert.equal(manifest.id, "zumico.focus-now")
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.keepLoaded, true)
  assert.equal(manifest.entryPoints.service, "Service.qml")
  assert.equal(manifest.entryPoints.barWidget, "Panel.qml")
  read(manifest.entryPoints.service)
  read(manifest.entryPoints.barWidget)
})

test("the service passes all managed state needed by apply.js", () => {
  const source = read("Service.qml")
  const actionStart = source.indexOf("actionProc.command = [", source.indexOf("function startAction"))
  const actionEnd = source.indexOf("]", actionStart)
  const command = source.slice(actionStart, actionEnd)

  for (const expected of [
    '"/apply.js"',
    "address",
    "String(config.widthMultiplier)",
    "String(config.heightMultiplier)",
    'config.includeFloating ? "1" : "0"',
    'config.hoverFocus ? "1" : "0"',
    "priorManagedAddress",
    "priorManagedMode",
    "config.expandMode",
    "String(config.collapseSize)",
    'config.animate ? "1" : "0"',
    "String(config.animateSpeed)"
  ]) {
    assert.ok(command.includes(expected), `missing ${expected}`)
  }
})

test("the scoped floating monitor covers leave and re-entry only", () => {
  const source = read("Service.qml")

  assert.match(source, /managedMode\.indexOf\("floating:"\) !== 0\) return/)
  assert.match(source, /hover-monitor\.js/)
  assert.match(source, /result\.reason === "left"/)
  assert.match(source, /result\.reason === "entered"[\s\S]*requestRefresh\(result\.address\)/)
  assert.match(source, /onExited:\s*\{\s*if \(root && !root\.destroyed\) root\.hoverMonitorAddress = ""\s*\}/)
  assert.doesNotMatch(read("hover-monitor.js"), /setInterval[\s\S]*while/)
})

test("the state bridge observes floating transitions and unloads cleanly", () => {
  const source = read("Service.qml")
  const model = read("FocusNowModel.js")

  assert.match(model, /hl\.on\("window\.update_rules"/)
  assert.match(model, /ipc call focus-now refresh/)
  assert.match(source, /property bool stateBridgeInstalled/)
  assert.match(source, /stateBridgeReload/)
  assert.match(source, /stateBridgeProc/)
  assert.match(source, /stateBridge: stateBridgeInstalled/)
  assert.match(source, /installStateBridgeEval\(root\.binQuickshell, root\.omarchyPath \+ "\/shell", config\.expandMode !== "off",\s*config\.widthMultiplier, config\.heightMultiplier\)/)
  assert.match(source, /eventName === "changefloatingmode"/)
})

test("service unload restores managed windows and removes both bridges", () => {
  const source = read("Service.qml")
  const destruction = source.slice(source.indexOf("Component.onDestruction"))

  assert.match(destruction, /destroyed = true/)
  assert.match(destruction, /clearManagedWindow\(true\)/)
  assert.match(destruction, /"\/usr\/bin\/rmdir", root\.serviceLockPath/)
  assert.match(destruction, /uninstallStateBridgeEval\(/)
  assert.match(destruction, /stateBridgeProc\.startDetached\(\)/)
  assert.match(destruction, /uninstallHoverBridgeEval\(/)
  assert.match(destruction, /hoverBridgeProc\.startDetached\(\)/)
})

test("all public IPC controls map to normalized service settings", () => {
  const source = read("Service.qml")
  const ipc = source.slice(source.indexOf("ShellIpc {"))

  assert.match(source, /import qs\.Commons/)
  assert.match(source, /property string omarchyPath:/)
  assert.match(source, /property bool ipcOwner/)
  assert.match(source, /serviceLockPath/)
  assert.match(source, /"\/usr\/bin\/mkdir", root\.serviceLockPath/)
  assert.match(ipc, /target: root\.ipcOwner \? "focus-now" : ""/)
  assert.match(ipc, /enabled: root\.ipcOwner/)

  for (const method of [
    "status", "ping", "enable", "disable", "toggle",
    "hoverOn", "hoverOff", "hoverToggle",
    "fullscreen", "stickyOn", "stickyOff", "stickyToggle", "near", "noExpand",
    "width", "height", "widthUp", "widthDown",
    "heightUp", "heightDown", "refresh",
    "collapseSize", "collapseSizeUp", "collapseSizeDown",
    "hoverDelay", "hoverDelayUp", "hoverDelayDown",
    "fullscreenDelay", "fullscreenDelayUp", "fullscreenDelayDown"
  ]) {
    assert.match(ipc, new RegExp(`function ${method}\\(`))
  }
  assert.match(source, /setWidthMultiplier\(value\).*nearestMultiplier/)
  assert.match(source, /setHeightMultiplier\(value\).*nearestMultiplier/)
  assert.match(source, /stepWidth\(direction\).*stepMultiplier/)
  assert.match(source, /stepHeight\(direction\).*stepMultiplier/)
  assert.match(source, /setCollapseSize\(value\).*normalizeCollapseSize/)
  assert.match(source, /stepCollapseSize\(direction\).*stepCollapseSize/)
})

test("panel strings all exist in the packaged locale", () => {
  const panel = read("Panel.qml")
  const locale = JSON.parse(read("i18n/en.json"))
  const keys = [...panel.matchAll(/strings\.t\("([^"]+)"\)/g)].map(match => match[1])

  assert.ok(keys.length >= 15)
  for (const key of keys) assert.ok(Object.hasOwn(locale, key), `missing locale key ${key}`)
})
