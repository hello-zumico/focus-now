import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const rootDir = fileURLToPath(new URL("../", import.meta.url))
const read = name => readFileSync(join(rootDir, name), "utf8")

test("plugin metadata and packaged entry points agree", () => {
  const manifest = JSON.parse(read("manifest.json"))
  const pkg = JSON.parse(read("package.json"))

  assert.equal(manifest.id, "eb.focus-now")
  assert.equal(manifest.version, pkg.version)
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
    "config.expandMode"
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
  assert.match(source, /onExited:\s*root\.hoverMonitorAddress = ""/)
  assert.doesNotMatch(read("hover-monitor.js"), /setInterval[\s\S]*while/)
})

test("service unload restores managed windows and removes the hover bridge", () => {
  const source = read("Service.qml")
  const destruction = source.slice(source.indexOf("Component.onDestruction"))

  assert.match(destruction, /clearManagedWindow\(true\)/)
  assert.match(destruction, /uninstallHoverBridgeEval\(/)
  assert.match(destruction, /hoverBridgeProc\.startDetached\(\)/)
})

test("all public IPC controls map to normalized service settings", () => {
  const source = read("Service.qml")
  const ipc = source.slice(source.indexOf('target: "focus-now"'))

  for (const method of [
    "status", "ping", "enable", "disable", "toggle",
    "hoverOn", "hoverOff", "hoverToggle",
    "fullscreen", "near", "noExpand",
    "width", "height", "widthUp", "widthDown",
    "heightUp", "heightDown", "refresh"
  ]) {
    assert.match(ipc, new RegExp(`function ${method}\\(`))
  }
  assert.match(source, /setWidthMultiplier\(value\).*nearestMultiplier/)
  assert.match(source, /setHeightMultiplier\(value\).*nearestMultiplier/)
  assert.match(source, /stepWidth\(direction\).*stepMultiplier/)
  assert.match(source, /stepHeight\(direction\).*stepMultiplier/)
})

test("panel strings all exist in the packaged locale", () => {
  const panel = read("Panel.qml")
  const locale = JSON.parse(read("i18n/en.json"))
  const keys = [...panel.matchAll(/strings\.t\("([^"]+)"\)/g)].map(match => match[1])

  assert.ok(keys.length >= 15)
  for (const key of keys) assert.ok(Object.hasOwn(locale, key), `missing locale key ${key}`)
})
