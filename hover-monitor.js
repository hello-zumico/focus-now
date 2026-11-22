const { spawnSync } = require("node:child_process")
const path = require("node:path")
const M = require(path.join(__dirname, "FocusNowModel.js"))

const address = String(process.argv[2] || "")
const hyprctl = String(process.argv[3] || "/usr/bin/hyprctl")
const managedMode = String(process.argv[4] || "")
const original = M.parseManagedFloating(managedMode)
if (!address || !original) process.exit(0)

let outside = false
let outsideSince = 0
let lastGeometry = ""

function run(argumentsList) {
  const result = spawnSync(hyprctl, argumentsList, { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || "hyprctl failed")
  return result.stdout || ""
}

function emit(reason) {
  process.stdout.write(JSON.stringify({ address, reason }) + "\n")
}

function finish(reason) {
  emit(reason)
  process.exit(0)
}

function restore() {
  run(["eval", M.restoreFloatingEval(address, original)])
}

function tick() {
  try {
    const focused = M.parseActiveWindow(run(["-j", "activewindow"]))
    const cursor = M.parseJson(run(["-j", "cursorpos"]), null)
    if (!focused || focused.address !== address || !focused.floating) finish("inactive")

    const geometry = [focused.x, focused.y, focused.w, focused.h].join(":")
    if (geometry !== lastGeometry) {
      lastGeometry = geometry
      outsideSince = 0
      return
    }

    if (M.pointInsideWindow(focused, cursor, 0, 0)) {
      if (outside) {
        outside = false
        emit("entered")
      }
      outsideSince = 0
      return
    }

    if (!outsideSince) outsideSince = Date.now()
    if (!outside && Date.now() - outsideSince >= 150) {
      try { restore() } catch (e) { finish("restore-failed") }
      outside = true
      emit("left")
    }
  } catch (e) {
    finish("lost")
  }
}

setInterval(tick, 100)
tick()
