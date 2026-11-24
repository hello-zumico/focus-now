const test = require("node:test")
const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const APPLY = path.join(__dirname, "..", "apply.js")

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

const monitor = {
  id: 0,
  x: 0,
  y: 0,
  width: 1000,
  height: 800,
  scale: 1,
  reserved: [0, 40, 0, 0],
  focused: true
}

function fakeHyprctlSource() {
  return `#!/usr/bin/env node
const fs = require("node:fs")
const statePath = process.env.FOCUS_NOW_STATE
const logPath = process.env.FOCUS_NOW_LOG
const args = process.argv.slice(2)
function state() { return JSON.parse(fs.readFileSync(statePath, "utf8")) }
function save(next) { fs.writeFileSync(statePath, JSON.stringify(next)) }
function log(line) { fs.appendFileSync(logPath, line + "\\n") }
function targetAddress(code) {
  let match = String(code).match(/w\\.address == "([^"]+)"/)
  if (match) return match[1]
  match = String(code).match(/window = "address:([^"]+)"/)
  return match ? match[1] : ""
}
function resizeClients(code) {
  const next = state()
  for (const match of String(code).matchAll(/window\\.resize\\(\\{ window = "address:([^"]+)", x = (-?\\d+), y = (-?\\d+), relative = (true|false) \\}\\)/g)) {
    if (next.ignoreResize) continue
    const client = next.clients.find(w => w.address === match[1])
    if (!client) continue
    const dx = Number(match[2])
    const dy = Number(match[3])
    if (match[4] === "true") {
      client.size = [Math.max(1, client.size[0] + dx), Math.max(1, client.size[1] + dy)]
    } else {
      client.size = [Math.max(1, dx), Math.max(1, dy)]
    }
  }
  save(next)
}
function moveClients(code) {
  const next = state()
  for (const match of String(code).matchAll(/window\\.move\\(\\{ window = "address:([^"]+)", x = (-?\\d+), y = (-?\\d+), relative = false \\}\\)/g)) {
    const client = next.clients.find(w => w.address === match[1])
    if (client) client.at = [Number(match[2]), Number(match[3])]
  }
  save(next)
}
function fullscreenStates(code) {
  const next = state()
  const target = targetAddress(code)
  if (/target\\.fullscreen == 1|target\\.fullscreen == 2/.test(code)) {
    const client = next.clients.find(w => w.address === target)
    if (client) {
      client.fullscreen = 0
      client.fullscreenClient = 0
    }
  }
  if (/other\\.address ~= target\\.address/.test(code)) {
    const wsScoped = /other\\.workspace\\.id == target\\.workspace\\.id/.test(code)
    const targetWin = next.clients.find(w => w.address === target)
    const targetWs = targetWin && targetWin.workspace ? targetWin.workspace.id : undefined
    for (const client of next.clients) {
      if (client.address === target) continue
      if (!(client.fullscreen && client.fullscreenClient === 1)) continue
      if (wsScoped) {
        const clientWs = client.workspace ? client.workspace.id : undefined
        if (targetWs === undefined || clientWs !== targetWs) continue
      }
      client.fullscreen = 0
      client.fullscreenClient = 0
    }
  }
  if (/internal = 1, client = 1/.test(code)) {
    const client = next.clients.find(w => w.address === target)
    if (client) {
      client.fullscreen = 1
      client.fullscreenClient = 1
    }
  }
  if (/internal = 2, client = 1/.test(code)) {
    const client = next.clients.find(w => w.address === target)
    if (client) {
      client.fullscreen = 2
      client.fullscreenClient = 1
    }
  }
  save(next)
}
if (args[0] === "-j") {
  const next = state()
  const key = args[1]
  if (key === "activewindow") console.log(JSON.stringify(next.activewindow || {}))
  else if (key === "clients") console.log(JSON.stringify(next.clients || []))
  else if (key === "activeworkspace") console.log(JSON.stringify(next.activeworkspace || {}))
  else if (key === "workspaces") console.log(JSON.stringify(next.workspaces || []))
  else if (key === "monitors") console.log(JSON.stringify(next.monitors || []))
  else if (key === "cursorpos") {
    if (Array.isArray(next.cursorSequence) && next.cursorSequence.length) {
      const cursor = next.cursorSequence.shift()
      save(next)
      console.log(JSON.stringify(cursor))
    } else {
      console.log(JSON.stringify(next.cursor || { x: 0, y: 0 }))
    }
  }
  process.exit(0)
}
if (args[0] === "getoption" && args[1] === "plugin:hyprbars:bar_height") {
  console.log(JSON.stringify({ int: state().barHeight === undefined ? 30 : state().barHeight }))
  process.exit(0)
}
if (args[0] === "eval" || args[0] === "dispatch") {
  const code = args[1]
  log(args[0] + " " + code)
  fullscreenStates(code)
  resizeClients(code)
  moveClients(code)
  if (/bring_to_top/.test(code)) {
    const next = state()
    next.top = targetAddress(code)
    save(next)
  }
  if (/layout\\("colresize ([^)]+)"\\)/.test(code)) {
    const next = state()
    next.colresize = code.match(/layout\\("colresize ([^)]+)"\\)/)[1]
    save(next)
  }
  if (/layout\\("center"\\)/.test(code)) {
    const next = state()
    next.centered = true
    save(next)
  }
  if (/layout\\("movetoroot"\\)/.test(code)) {
    const next = state()
    next.movedToRoot = true
    save(next)
  }
  process.exit(0)
}
process.exit(1)
`
}

function fixture(t, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-now-apply-"))
  const statePath = path.join(dir, "state.json")
  const logPath = path.join(dir, "calls.log")
  const hyprctl = path.join(dir, "hyprctl")
  fs.writeFileSync(statePath, JSON.stringify(state))
  fs.writeFileSync(logPath, "")
  fs.writeFileSync(hyprctl, fakeHyprctlSource())
  fs.chmodSync(hyprctl, 0o755)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { statePath, logPath, hyprctl }
}

function runApply(fixture, args) {
  const result = spawnSync(process.execPath, [APPLY, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      FOCUS_NOW_STATE: fixture.statePath,
      FOCUS_NOW_LOG: fixture.logPath,
      FOCUS_NOW_DEBUG: ""
    }
  })
  assert.equal(result.status, 0, result.stderr)
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    log: fs.readFileSync(fixture.logPath, "utf8"),
    state: JSON.parse(fs.readFileSync(fixture.statePath, "utf8"))
  }
}

function applyArgs(fx, focused, managedAddress = "", managedMode = "", mode = "near", includeFloating = false, sticky = false) {
  return [focused, "0.85", "0.85", includeFloating ? "1" : "0", "1", fx.hyprctl, managedAddress, managedMode, mode, sticky ? "1" : "0"]
}

function workspaceState(clients, extra = {}) {
  const active = extra.activewindow || clients[0] || {}
  const layouts = { "1": "dwindle" }
  for (const client of clients) {
    const ws = client.workspace
    if (ws && ws.tiledLayout) layouts[String(ws.id)] = ws.tiledLayout
  }
  if (extra.activeworkspace && extra.activeworkspace.tiledLayout) {
    layouts[String(extra.activeworkspace.id || 1)] = extra.activeworkspace.tiledLayout
  }
  const workspaces = Object.entries(layouts).map(([id, tiledLayout]) => ({
    id: Number(id),
    name: String(id),
    tiledLayout
  }))
  return {
    activewindow: active,
    activeworkspace: { id: 1, name: "1", tiledLayout: "dwindle", ...extra.activeworkspace },
    workspaces: extra.workspaces || workspaces,
    clients,
    monitors: [monitor],
    cursor: { x: 0, y: 0 },
    ...extra
  }
}

test("a stale focused address exits without compositor side effects", t => {
  const a = win("a", 0, 40, 500, 760)
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b], { activewindow: b }))
  const result = runApply(fx, applyArgs(fx, "a"))
  assert.equal(result.stdout, "")
  assert.equal(result.log, "")
})

test("a pop-tagged restored window is skipped until the wrapper finishes", t => {
  const restoring = win("restoring", 0, 40, 500, 760, { tags: ["pop"] })
  const sibling = win("sibling", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([restoring, sibling], { activewindow: restoring }))
  const result = runApply(fx, applyArgs(fx, "restoring", "", "", "near", true))
  assert.deepEqual(JSON.parse(result.stdout), { address: "restoring", managed: "" })
  assert.match(result.log, /other\.fullscreen_client == 1/)
  assert.doesNotMatch(result.log, /window\.resize|window\.move|movetoroot/)
  assert.deepEqual(result.state.clients.find(w => w.address === "restoring").size, [500, 760])
})

test("a user-owned fullscreen state is preserved", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 2 })
  const fx = fixture(t, workspaceState([a]))
  const result = runApply(fx, applyArgs(fx, "a", "a", "fullscreen", "fullscreen"))
  assert.equal(result.stdout, '{"address":"a","managed":""}')
  assert.equal(result.log, "")
})

test("a managed maximized single window is idempotent in near mode", t => {
  const a = win("a", 0, 0, 1000, 760, { fullscreen: 1, fullscreenClient: 1 })
  const fx = fixture(t, workspaceState([a]))
  const result = runApply(fx, applyArgs(fx, "a", "a", "maximized", "near"))
  assert.equal(result.stdout, '{"address":"a","managed":"maximized"}')
  assert.match(result.log, /internal = 1, client = 1/)
  assert.doesNotMatch(result.log, /target\.fullscreen == 1/)
  assert.equal(result.state.clients[0].fullscreen, 1)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
})

test("a managed maximized window clears before tiled expansion when siblings appear", t => {
  const a = win("a", 0, 40, 800, 760, { fullscreen: 1, fullscreenClient: 1 })
  const b = win("b", 800, 40, 200, 760)
  const fx = fixture(t, workspaceState([a, b]))
  const result = runApply(fx, applyArgs(fx, "a", "a", "maximized", "near"))
  assert.equal(result.stdout, '{"address":"a","managed":""}')
  assert.match(result.log, /target\.fullscreen == 1 and target\.fullscreen_client == 1/)
  assert.equal(result.state.clients[0].fullscreen, 0)
  assert.equal(result.state.clients[0].fullscreenClient, 0)
  assert.match(result.log, /window\.resize/)
})

test("a managed fullscreen window is idempotent in fullscreen mode", t => {
  const a = win("a", 0, 0, 1000, 800, { fullscreen: 2, fullscreenClient: 1 })
  const fx = fixture(t, workspaceState([a]))
  const result = runApply(fx, applyArgs(fx, "a", "a", "fullscreen", "fullscreen"))
  assert.equal(result.stdout, '{"address":"a","managed":"fullscreen"}')
  assert.match(result.log, /internal = 2, client = 1/)
  assert.doesNotMatch(result.log, /target\.fullscreen == 2 and target\.fullscreen_client == 1/)
  assert.equal(result.state.clients[0].fullscreen, 2)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
})

test("fullscreen mode upgrades a managed maximized window without toggling", t => {
  const a = win("a", 0, 0, 1000, 760, { fullscreen: 1, fullscreenClient: 1 })
  const fx = fixture(t, workspaceState([a]))
  const result = runApply(fx, applyArgs(fx, "a", "a", "maximized", "fullscreen"))
  assert.equal(result.stdout, '{"address":"a","managed":"fullscreen"}')
  assert.match(result.log, /target\.fullscreen == 1 and target\.fullscreen_client == 1/)
  assert.match(result.log, /internal = 2, client = 1/)
  assert.equal(result.state.clients[0].fullscreen, 2)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
})

test("near mode clears managed fullscreen before proportional expansion", t => {
  const a = win("a", 0, 0, 1000, 800, { fullscreen: 2, fullscreenClient: 1 })
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b]))
  const result = runApply(fx, applyArgs(fx, "a", "a", "fullscreen", "near"))
  assert.equal(result.stdout, '{"address":"a","managed":""}')
  assert.match(result.log, /target\.fullscreen == 2 and target\.fullscreen_client == 1/)
  assert.equal(result.state.clients[0].fullscreen, 0)
  assert.equal(result.state.clients[0].fullscreenClient, 0)
})

test("the only tiled workspace window is maximized through fullscreen state", t => {
  const a = win("a", 200, 200, 500, 500)
  const fx = fixture(t, workspaceState([a]))
  const result = runApply(fx, applyArgs(fx, "a"))
  assert.equal(result.stdout, '{"address":"a","managed":"maximized"}')
  assert.match(result.log, /internal = 1, client = 1/)
  assert.doesNotMatch(result.log, /hl\.dsp\.window\.fullscreen\(/)
  assert.equal(result.state.clients[0].fullscreen, 1)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
})

test("a tiled window is still treated as alone when floating windows are excluded", t => {
  const a = win("a", 0, 40, 500, 760)
  const floating = win("float", 200, 200, 200, 100, { floating: true })
  const fx = fixture(t, workspaceState([a, floating]))
  const result = runApply(fx, applyArgs(fx, "a"))
  assert.equal(result.stdout, '{"address":"a","managed":"maximized"}')
  assert.match(result.log, /internal = 1, client = 1/)
})

test("scrolling layout applies the column share without a redundant center", t => {
  const a = win("a", 0, 40, 500, 760)
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b], {
    activeworkspace: { tiledLayout: "scrolling" }
  }))
  const result = runApply(fx, applyArgs(fx, "a"))
  assert.equal(result.stdout, '{"address":"a","managed":""}')
  assert.equal(result.state.colresize, "0.85")
  assert.equal(result.state.centered, undefined)
})

test("a special workspace's layout wins over the reported active workspace", t => {
  const scratch = { id: -98, name: "special:scratchpad" }
  const a = win("a", 27, 12, 734, 814, { workspace: scratch })
  const b = win("b", 775, 12, 734, 814, { workspace: scratch })
  const fx = fixture(t, workspaceState([a, b], {
    activewindow: a,
    workspaces: [
      { id: 1, name: "1", tiledLayout: "dwindle" },
      { id: -98, name: "special:scratchpad", tiledLayout: "scrolling" }
    ]
  }))
  const result = runApply(fx, applyArgs(fx, "a"))
  assert.equal(result.stdout, '{"address":"a","managed":""}')
  assert.equal(result.state.colresize, "0.85")
  assert.equal(result.state.centered, undefined)
})

test("the screensaver overlay exits without emitting or touching managed state", t => {
  const saver = win("saver", 0, 0, 1000, 800, {
    class: "org.omarchy.screensaver",
    workspace: { id: -97, name: "special:screensaver-eDP-1" }
  })
  const managed = win("managed", 0, 0, 1000, 760, { fullscreen: 1, fullscreenClient: 1 })
  const fx = fixture(t, workspaceState([saver, managed], {
    activewindow: saver,
    workspaces: [
      { id: 1, name: "1", tiledLayout: "dwindle" },
      { id: -97, name: "special:screensaver-eDP-1", tiledLayout: "dwindle" }
    ]
  }))
  const result = runApply(fx, applyArgs(fx, "saver", "managed", "maximized", "near"))
  assert.equal(result.stdout, "")
  assert.equal(result.log, "")
  const kept = result.state.clients.find(w => w.address === "managed")
  assert.equal(kept.fullscreen, 1)
  assert.equal(kept.fullscreenClient, 1)
})

test("floating windows are skipped when includeFloating is off", t => {
  const a = win("a", 100, 100, 200, 100, { floating: true })
  const fx = fixture(t, workspaceState([a], { cursor: { x: 150, y: 150 } }))
  const result = runApply(fx, applyArgs(fx, "a", "", "", "near", false))
  assert.equal(result.stdout, '{"address":"a","managed":""}')
  assert.match(result.log, /other\.fullscreen_client == 1/)
  assert.doesNotMatch(result.log, /window\.resize|window\.move|movetoroot/)
})

test("hovered floating windows expand, move into the work area, and raise", t => {
  const a = win("a", 900, 650, 200, 100, { floating: true })
  const fx = fixture(t, workspaceState([a], { cursor: { x: 950, y: 700 } }))
  const result = runApply(fx, applyArgs(fx, "a", "", "", "near", true))
  assert.equal(result.stdout, '{"address":"a","managed":"floating:900:650:200:100"}')
  assert.match(result.log, /window\.resize/)
  assert.match(result.log, /window\.move/)
  assert.match(result.log, /bring_to_top/)
  assert.equal(result.state.top, "a")
  assert.deepEqual(result.state.clients[0].size, [850, 646])
  assert.deepEqual(result.state.clients[0].at, [150, 154])
})

test("a previously managed floating window restores before the new one expands", t => {
  const previous = win("previous", 900, 650, 850, 646, { floating: true })
  const current = win("current", 100, 100, 200, 100, { floating: true })
  const fx = fixture(t, workspaceState([previous, current], {
    activewindow: current,
    cursor: { x: 150, y: 120 }
  }))
  const result = runApply(fx, applyArgs(
    fx,
    "current",
    "previous",
    "floating:900:650:200:100",
    "near",
    true
  ))
  assert.equal(result.stdout, '{"address":"current","managed":"floating:100:100:200:100"}')
  const previousCall = result.log.indexOf('address:previous')
  const currentCall = result.log.indexOf('address:current')
  assert.ok(previousCall >= 0)
  assert.ok(currentCall > previousCall)
  assert.match(result.log, /address:previous", x = 200, y = 100/)
  assert.match(result.log, /address:current", x = 850, y = 646/)
  assert.deepEqual(result.state.clients[0].size, [200, 100])
  assert.deepEqual(result.state.clients[0].at, [900, 650])
})

test("a skipped floating reapply preserves its saved original rectangle", t => {
  const a = win("a", 100, 100, 850, 646, { floating: true })
  const fx = fixture(t, workspaceState([a], { cursor: { x: 20, y: 20 } }))
  const result = runApply(fx, applyArgs(
    fx,
    "a",
    "a",
    "floating:100:100:200:100",
    "near",
    true
  ))
  assert.equal(result.stdout, '{"address":"a","managed":"floating:100:100:200:100"}')
  assert.match(result.log, /other\.fullscreen_client == 1/)
  assert.doesNotMatch(result.log, /window\.resize|window\.move|movetoroot/)
})

test("a floating window expands when the pointer enters during the hover grace", t => {
  const a = win("a", 100, 100, 200, 100, { floating: true })
  const fx = fixture(t, workspaceState([a], {
    cursorSequence: [
      { x: 20, y: 20 },
      { x: 150, y: 150 }
    ]
  }))
  const result = runApply(fx, applyArgs(fx, "a", "", "", "near", true))
  assert.equal(result.stdout, '{"address":"a","managed":"floating:100:100:200:100"}')
  assert.match(result.log, /address:a", x = 850, y = 646/)
})

test("fullscreen mode clears other fullscreen windows but keeps the target managed", t => {
  const a = win("a", 0, 40, 500, 760)
  const b = win("b", 500, 40, 500, 760, { fullscreen: 2, fullscreenClient: 1 })
  const fx = fixture(t, workspaceState([a, b]))
  const result = runApply(fx, applyArgs(fx, "a", "", "", "fullscreen"))
  assert.equal(result.stdout, '{"address":"a","managed":"fullscreen"}')
  assert.match(result.log, /other\.address ~= target\.address/)
  assert.equal(result.state.clients[0].fullscreen, 2)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
  assert.equal(result.state.clients[1].fullscreen, 0)
  assert.equal(result.state.clients[1].fullscreenClient, 0)
})

test("sticky fullscreen keeps the previous managed fullscreen window", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 1 })
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b], { activewindow: b }))
  const result = runApply(fx, applyArgs(fx, "b", "a", "fullscreen", "fullscreen", false, true))
  assert.equal(result.stdout, '{"address":"b","managed":"fullscreen"}')
  assert.doesNotMatch(result.log, /other\.address ~= target\.address/)
  assert.doesNotMatch(result.log, /target\.fullscreen == 2 and target\.fullscreen_client == 1/)
  assert.equal(result.state.clients[0].fullscreen, 2)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
  assert.equal(result.state.clients[1].fullscreen, 2)
  assert.equal(result.state.clients[1].fullscreenClient, 1)
})

test("non-sticky fullscreen clears the previous managed fullscreen window", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 1 })
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b], { activewindow: b }))
  const result = runApply(fx, applyArgs(fx, "b", "a", "fullscreen", "fullscreen"))
  assert.equal(result.stdout, '{"address":"b","managed":"fullscreen"}')
  assert.match(result.log, /target\.fullscreen == 2 and target\.fullscreen_client == 1/)
  assert.equal(result.state.clients[0].fullscreen, 0)
  assert.equal(result.state.clients[0].fullscreenClient, 0)
  assert.equal(result.state.clients[1].fullscreen, 2)
  assert.equal(result.state.clients[1].fullscreenClient, 1)
})

test("sticky fullscreen preserves user-owned fullscreen windows", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 2 })
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b], { activewindow: b }))
  const result = runApply(fx, applyArgs(fx, "b", "", "", "fullscreen", false, true))
  assert.equal(result.stdout, '{"address":"b","managed":"fullscreen"}')
  assert.equal(result.state.clients[0].fullscreen, 2)
  assert.equal(result.state.clients[0].fullscreenClient, 2)
  assert.equal(result.state.clients[1].fullscreen, 2)
})

test("sticky fullscreen does not preserve managed fullscreen in near mode", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 1 })
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b], { activewindow: b }))
  const result = runApply(fx, applyArgs(fx, "b", "a", "fullscreen", "near", false, true))
  assert.match(result.log, /target\.fullscreen == 2 and target\.fullscreen_client == 1/)
  assert.equal(result.state.clients[0].fullscreen, 0)
  assert.equal(result.state.clients[0].fullscreenClient, 0)
})

test("refocusing a sticky fullscreen window re-tracks it as managed", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 1 })
  const b = win("b", 500, 40, 500, 760, { fullscreen: 2, fullscreenClient: 1 })
  const fx = fixture(t, workspaceState([a, b], { activewindow: a }))
  const result = runApply(fx, applyArgs(fx, "a", "b", "fullscreen", "fullscreen", false, true))
  assert.equal(result.stdout, '{"address":"a","managed":"fullscreen"}')
  assert.equal(result.state.clients[0].fullscreen, 2)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
  assert.equal(result.state.clients[1].fullscreen, 2)
  assert.equal(result.state.clients[1].fullscreenClient, 1)
})

test("near mode leaves managed fullscreen on other workspaces alone", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 2, fullscreenClient: 1 })
  const b = win("b", 0, 40, 500, 760, { workspace: { id: 2, name: "2" } })
  const fx = fixture(t, workspaceState([a, b], {
    activewindow: b,
    activeworkspace: { id: 2, name: "2" }
  }))
  const result = runApply(fx, applyArgs(fx, "b"))
  assert.equal(result.state.clients[0].fullscreen, 2)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
})

test("a managed window on another workspace keeps its state", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 1, fullscreenClient: 1 })
  const b = win("b", 0, 40, 500, 760, { workspace: { id: 2, name: "2" } })
  const fx = fixture(t, workspaceState([a, b], {
    activewindow: b,
    activeworkspace: { id: 2, name: "2" }
  }))
  const result = runApply(fx, applyArgs(fx, "b", "a", "maximized", "near"))
  assert.doesNotMatch(result.log, /target\.fullscreen == 1 and target\.fullscreen_client == 1/)
  assert.equal(result.state.clients[0].fullscreen, 1)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
})

test("a managed window on the same workspace is still cleared", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 1, fullscreenClient: 1 })
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b], { activewindow: b }))
  const result = runApply(fx, applyArgs(fx, "b", "a", "maximized", "near"))
  assert.match(result.log, /target\.fullscreen == 1 and target\.fullscreen_client == 1/)
  assert.equal(result.state.clients[0].fullscreen, 0)
  assert.equal(result.state.clients[0].fullscreenClient, 0)
})

test("a cross-workspace apply stays silent so managed tracking survives", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 1, fullscreenClient: 1 })
  const b = win("b", 0, 40, 500, 760, { workspace: { id: 2, name: "2" } })
  const fx = fixture(t, workspaceState([a, b], {
    activewindow: b,
    activeworkspace: { id: 2, name: "2" }
  }))
  const result = runApply(fx, applyArgs(fx, "b", "a", "maximized", "near"))
  assert.equal(result.stdout, "")
  assert.equal(result.state.clients[0].fullscreen, 1)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
  assert.equal(result.state.clients[1].fullscreen, 1)
  assert.equal(result.state.clients[1].fullscreenClient, 1)
})

test("a cross-workspace multi-window apply also stays silent", t => {
  const a = win("a", 0, 40, 500, 760, { fullscreen: 1, fullscreenClient: 1 })
  const scratch = { id: -98, name: "special:scratchpad" }
  const b = win("b", 0, 40, 400, 760, { workspace: scratch })
  const c = win("c", 400, 40, 400, 760, { workspace: scratch })
  const fx = fixture(t, workspaceState([a, b, c], {
    activewindow: b,
    workspaces: [
      { id: 1, name: "1", tiledLayout: "dwindle" },
      { id: -98, name: "special:scratchpad", tiledLayout: "dwindle" }
    ]
  }))
  const result = runApply(fx, applyArgs(fx, "b", "a", "maximized", "near"))
  assert.equal(result.stdout, "")
  assert.equal(result.state.clients[0].fullscreen, 1)
  assert.equal(result.state.clients[0].fullscreenClient, 1)
})

test("a repeated nested layout falls back to movetoroot only once", t => {
  const a = win("a", 0, 40, 500, 760)
  const b = win("b", 500, 40, 500, 760)
  const fx = fixture(t, workspaceState([a, b], { ignoreResize: true }))
  const result = runApply(fx, applyArgs(fx, "a"))
  assert.equal(result.stdout, '{"address":"a","managed":""}')
  assert.equal(result.state.movedToRoot, true)
  assert.equal((result.log.match(/movetoroot/g) || []).length, 1)
})
