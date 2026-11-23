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

  assert.equal(manifest.id, "zumico.focus-now")
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.keepLoaded, false)
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
    "hoverDelay", "hoverDelayUp", "hoverDelayDown",
    "fullscreenDelay", "fullscreenDelayUp", "fullscreenDelayDown"
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
