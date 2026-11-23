// Pure Hyprland state parsing and layout planning for Focus Now. The planner
// uses rectangle intervals and axis allocations rather than remembered
// per-window base sizes.
var MULTIPLIERS = [0.25, 0.33, 0.4, 0.5, 0.6, 0.67, 0.75, 0.8, 0.85, 0.9, 0.95]
var EXPAND_MODES = ["off", "fullscreen", "near"]
var EDGE_TOLERANCE = 24
var MINIMUM_SIZE = 80
var HOVER_DELAY_DEFAULT = 120
var HOVER_DELAY_MAX = 2000
var HOVER_DELAY_STEP = 50
var FULLSCREEN_DELAY_DEFAULT = 5000
var FULLSCREEN_DELAY_MIN = 1000
var FULLSCREEN_DELAY_MAX = 60000
var FULLSCREEN_DELAY_STEP = 500

function parseJson(raw, fallback) {
  var decoded = fallback
  if (raw !== undefined && raw !== null && raw !== "") {
    try {
      decoded = JSON.parse(raw)
    } catch (error) {
      decoded = fallback
    }
  }
  return decoded === undefined ? fallback : decoded
}

function numberOr(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  var parsed = Number(value)
  if (parsed !== parsed || parsed === Infinity || parsed === -Infinity) return fallback
  return parsed
}

function clamp(value, lower, upper) {
  return value < lower ? lower : (value > upper ? upper : value)
}

function absolutePath(value) {
  var path = String(value || "").trim()
  return /^\//.test(path) ? path : ""
}

function nearestMultiplier(value, fallback) {
  var wanted = numberOr(value, fallback)
  var result = MULTIPLIERS[0]
  var distance = Math.abs(wanted - result)
  for (var i = 1; i < MULTIPLIERS.length; i++) {
    var nextDistance = Math.abs(wanted - MULTIPLIERS[i])
    if (nextDistance < distance) {
      result = MULTIPLIERS[i]
      distance = nextDistance
    }
  }
  return result
}

function stepMultiplier(value, direction) {
  var index = MULTIPLIERS.indexOf(nearestMultiplier(value, 0.85))
  return MULTIPLIERS[clamp(index + (direction < 0 ? -1 : 1), 0, MULTIPLIERS.length - 1)]
}

function normalizeHoverDelay(value) {
  return clamp(Math.round(numberOr(value, HOVER_DELAY_DEFAULT)), 0, HOVER_DELAY_MAX)
}

function stepHoverDelay(value, direction) {
  return clamp(normalizeHoverDelay(value) + (direction < 0 ? -1 : 1) * HOVER_DELAY_STEP, 0, HOVER_DELAY_MAX)
}

function normalizeFullscreenDelay(value) {
  return clamp(Math.round(numberOr(value, FULLSCREEN_DELAY_DEFAULT)), FULLSCREEN_DELAY_MIN, FULLSCREEN_DELAY_MAX)
}

function stepFullscreenDelay(value, direction) {
  return clamp(normalizeFullscreenDelay(value) + (direction < 0 ? -1 : 1) * FULLSCREEN_DELAY_STEP, FULLSCREEN_DELAY_MIN, FULLSCREEN_DELAY_MAX)
}

function normalizeConfig(raw) {
  var source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  var expandMode = EXPAND_MODES.indexOf(source.expandMode) >= 0 ? source.expandMode : "near"
  return {
    enabled: source.enabled !== false,
    hoverFocus: source.hoverFocus !== false,
    expandMode: expandMode,
    widthMultiplier: nearestMultiplier(source.widthMultiplier, 0.85),
    heightMultiplier: nearestMultiplier(source.heightMultiplier, 0.85),
    hoverDelay: normalizeHoverDelay(source.hoverDelay),
    fullscreenDelay: normalizeFullscreenDelay(source.fullscreenDelay),
    includeFloating: !!source.includeFloating,
    stickyFullscreen: !!source.stickyFullscreen,
    mouseRefocus: !!source.mouseRefocus,
    bins: {
      node: absolutePath(source.nodePath),
      hyprctl: absolutePath(source.hyprctlPath),
      timeout: absolutePath(source.timeoutPath)
    }
  }
}

function workspaceKey(workspace) {
  if (!workspace || typeof workspace !== "object") return workspace
  return workspace.id !== undefined ? workspace.id : workspace.name
}

function windowMeta(client) {
  if (!client || typeof client !== "object") return null
  var at = Array.isArray(client.at) ? client.at : []
  var size = Array.isArray(client.size) ? client.size : []
  var internalFullscreen = numberOr(client.fullscreen, 0)
  var clientFullscreen = numberOr(client.fullscreenClient, 0)
  return {
    address: String(client.address || ""),
    cls: String(client.class || client.initialClass || ""),
    title: String(client.title || ""),
    x: numberOr(at[0], 0),
    y: numberOr(at[1], 0),
    w: numberOr(size[0], 0),
    h: numberOr(size[1], 0),
    workspaceId: workspaceKey(client.workspace),
    floating: !!client.floating,
    fullscreenMode: internalFullscreen,
    fullscreenClientMode: clientFullscreen,
    // Only the compositor state means the window actually covers the screen;
    // fullscreenClient is what the app is told and stays set after unfullscreen.
    fullscreen: internalFullscreen > 0,
    pinned: !!client.pinned,
    mapped: client.mapped !== false,
    monitor: numberOr(client.monitor, -1),
    tags: Array.isArray(client.tags) ? client.tags.map(String) : []
  }
}

function parseClients(raw) {
  var clients = parseJson(raw, [])
  var result = {}
  if (!Array.isArray(clients)) return result
  for (var i = 0; i < clients.length; i++) {
    var win = windowMeta(clients[i])
    if (win && win.address) result[win.address] = win
  }
  return result
}

function parseActiveWindow(raw) {
  var meta = null
  var client = parseJson(raw, null)
  if (client) meta = windowMeta(client)
  return meta
}

function monitorMeta(monitor) {
  if (!monitor || typeof monitor !== "object") return null
  var scale = numberOr(monitor.scale, 1)
  if (!(scale > 0)) scale = 1
  var reserved = Array.isArray(monitor.reserved) ? monitor.reserved : []
  var inset = {
    x1: numberOr(reserved[0], 0),
    y1: numberOr(reserved[1], 0),
    x2: numberOr(reserved[2], 0),
    y2: numberOr(reserved[3], 0)
  }
  var area = {
    x: numberOr(monitor.x, 0) + inset.x1,
    y: numberOr(monitor.y, 0) + inset.y1,
    w: numberOr(monitor.width, 0) - inset.x1 - inset.x2,
    h: numberOr(monitor.height, 0) - inset.y1 - inset.y2
  }
  return {
    id: numberOr(monitor.id, -1),
    focused: !!monitor.focused,
    wa: { x: area.x / scale, y: area.y / scale, w: area.w / scale, h: area.h / scale }
  }
}

function parseMonitors(raw) {
  var monitors = parseJson(raw, [])
  var result = {}
  if (!Array.isArray(monitors)) return result
  for (var i = 0; i < monitors.length; i++) {
    var monitor = monitorMeta(monitors[i])
    if (monitor) result[monitor.id] = monitor
  }
  return result
}

var monitorForWindow = function(win, monitors) {
  if (!win || !monitors) return null
  var id = numberOr(win.monitor, -1)
  return Object.prototype.hasOwnProperty.call(monitors, id) ? monitors[id] : null
}

function hasTag(win, wanted) {
  if (!win || !Array.isArray(win.tags)) return false
  return win.tags.indexOf(String(wanted || "")) >= 0
}

function pointInsideWindow(win, cursor, topInset, margin) {
  if (!win || !cursor) return false
  var inset = Math.max(0, numberOr(topInset, 0))
  var border = Math.max(0, numberOr(margin, 0))
  return cursor.x >= win.x + border && cursor.x < win.x + win.w - border &&
    cursor.y >= win.y + inset + border && cursor.y < win.y + win.h - border
}

function isActionable(win, includeFloating) {
  return !!win && !!win.address && win.mapped !== false && !win.pinned &&
    !hasTag(win, "pop") && win.w > 0 && win.h > 0 && (!!includeFloating || !win.floating)
}

function clientsList(byAddress) {
  return Object.getOwnPropertyNames(byAddress || {}).reduce(function(list, address) {
    list.push(byAddress[address])
    return list
  }, [])
}

function workspaceWindows(byAddress, focused, includeFloating) {
  var result = []
  for (var address in byAddress) {
    if (!Object.prototype.hasOwnProperty.call(byAddress, address)) continue
    var win = byAddress[address]
    if (!isActionable(win, includeFloating)) continue
    if (String(win.workspaceId) === String(focused.workspaceId) &&
        numberOr(win.monitor, -1) === numberOr(focused.monitor, -1)) result.push(win)
  }
  return result
}

var overlapAmount = function(a1, a2, b1, b2) {
  var lowerEdge = a1 > b1 ? a1 : b1
  var upperEdge = a2 < b2 ? a2 : b2
  return upperEdge - lowerEdge
}

function intervalFor(win, axis) {
  return axis === "x" ? [win.x, win.x + win.w] : [win.y, win.y + win.h]
}

function clusterStrips(windows, axis) {
  var visited = new Array(windows.length).fill(false)
  var strips = []
  for (var start = 0; start < windows.length; start++) {
    if (visited[start]) continue
    var queue = [start]
    var members = []
    visited[start] = true
    var left = Infinity
    var right = -Infinity
    while (queue.length) {
      var index = queue.shift()
      var win = windows[index]
      var range = intervalFor(win, axis)
      members.push(win)
      left = Math.min(left, range[0])
      right = Math.max(right, range[1])
      for (var other = 0; other < windows.length; other++) {
        if (visited[other]) continue
        var otherRange = intervalFor(windows[other], axis)
        if (overlapAmount(range[0], range[1], otherRange[0], otherRange[1]) > EDGE_TOLERANCE) {
          visited[other] = true
          queue.push(other)
        }
      }
    }
    strips.push({ a1: left, a2: right, windows: members })
  }
  strips.sort(function(a, b) { return a.a1 - b.a1 })
  return strips
}

function axisPool(focused, windows, axis) {
  var result = []
  var focusedRange = axis === "x" ? [focused.y, focused.y + focused.h] : [focused.x, focused.x + focused.w]
  for (var i = 0; i < windows.length; i++) {
    var range = intervalFor(windows[i], axis === "x" ? "y" : "x")
    if (overlapAmount(focusedRange[0], focusedRange[1], range[0], range[1]) > EDGE_TOLERANCE) result.push(windows[i])
  }
  return result
}

function minDim(mon, axis) {
  var area = mon ? mon.wa : null
  var basis = axis === "x"
    ? (area && area.w > 0 ? area.w : 1920)
    : (area && area.h > 0 ? area.h : 1080)
  var floor = Math.round(basis / 20)
  return floor < MINIMUM_SIZE ? MINIMUM_SIZE : floor
}

function workAreaDim(mon, axis, fallback) {
  if (!mon || !mon.wa) return fallback
  if (axis === "x") return mon.wa.w > 0 ? mon.wa.w : fallback
  return mon.wa.h > 0 ? mon.wa.h : fallback
}

function distributeRemaining(strips, remainder, minimum) {
  var result = new Array(strips.length).fill(minimum)
  var spare = remainder - minimum * strips.length
  if (!(spare > 0)) return result
  var weights = strips.map(function(strip) { return Math.max(1, strip.a2 - strip.a1) })
  var totalWeight = weights.reduce(function(sum, value) { return sum + value }, 0)
  var assigned = 0
  for (var i = 0; i < strips.length; i++) {
    var share = i === strips.length - 1 ? spare - assigned : Math.round(spare * weights[i] / totalWeight)
    result[i] += share
    assigned += share
  }
  return result
}

function axisTargets(focused, windows, mon, axis, multiplier) {
  var pool = axisPool(focused, windows, axis)
  var strips = clusterStrips(pool, axis)
  if (!strips.length) return {}
  var focusedIndex = -1
  for (var i = 0; i < strips.length && focusedIndex < 0; i++) {
    if (strips[i].windows.some(function(win) { return win.address === focused.address })) focusedIndex = i
  }
  if (focusedIndex < 0) return {}

  var currentSpan = strips.reduce(function(sum, strip) { return sum + strip.a2 - strip.a1 }, 0)
  var workArea = workAreaDim(mon, axis, currentSpan)
  var minimum = minDim(mon, axis)
  var total = strips.length === 1 ? workArea : Math.max(currentSpan, strips.length * minimum)
  var focusedTarget = strips.length === 1
    ? Math.round(total)
    : Math.round(clamp(total * multiplier, minimum, Math.max(minimum, total - (strips.length - 1) * minimum)))
  var shares = strips.length === 1 ? [] : distributeRemaining(
    strips.filter(function(_, index) { return index !== focusedIndex }),
    total - focusedTarget,
    minimum
  )
  var result = {}
  var shareIndex = 0
  for (i = 0; i < strips.length; i++) {
    var target = i === focusedIndex ? focusedTarget : shares[shareIndex++]
    for (var j = 0; j < strips[i].windows.length; j++) {
      var address = strips[i].windows[j].address
      if (!result[address]) result[address] = {}
      if (axis === "x") result[address].w = target
      else result[address].h = target
    }
  }
  return result
}

function mergeTargets(xTargets, yTargets) {
  var result = {}
  var address
  for (address in xTargets) result[address] = { w: xTargets[address].w, h: xTargets[address].h }
  for (address in yTargets) {
    if (!result[address]) result[address] = {}
    if (yTargets[address].w > 0) result[address].w = yTargets[address].w
    if (yTargets[address].h > 0) result[address].h = yTargets[address].h
  }
  return result
}

function layoutTargets(focused, byAddress, monitors, cfg) {
  if (!isActionable(focused, cfg.includeFloating)) return {}
  var windows = workspaceWindows(byAddress, focused, cfg.includeFloating)
  if (!windows.length) return {}
  var monitor = monitorForWindow(focused, monitors)
  return mergeTargets(
    axisTargets(focused, windows, monitor, "x", cfg.widthMultiplier),
    axisTargets(focused, windows, monitor, "y", cfg.heightMultiplier)
  )
}

function resizeDirection(index, last) {
  if (index === 0) return 1
  if (index === last) return -1
  return index % 2 === 0 ? 1 : -1
}

function largestSpanFirst(windows, axis) {
  return windows.slice().sort(function(a, b) {
    return (axis === "x" ? b.h - a.h : b.w - a.w)
  })
}

function axisResizeOps(focused, windows, axis, targets) {
  var strips = clusterStrips(axisPool(focused, windows, axis), axis)
  var ops = []
  var focusedIndex = -1
  for (var i = 0; i < strips.length && focusedIndex < 0; i++) {
    if (strips[i].windows.some(function(win) { return win.address === focused.address })) focusedIndex = i
  }
  if (focusedIndex < 0) return ops

  var focusedTarget = targets[focused.address]
  if (strips.length > 1 && focusedTarget) {
    var wanted = axis === "x" ? focusedTarget.w : focusedTarget.h
    var current = axis === "x" ? focused.w : focused.h
    var delta = ((wanted || current) - current) * resizeDirection(focusedIndex, strips.length - 1)
    if (Math.abs(delta) > 2) ops.push(axis === "x"
      ? { address: focused.address, dx: delta, dy: 0, candidate: 0 }
      : { address: focused.address, dx: 0, dy: delta, candidate: 0 })
  }

  var candidate = ops.length
  for (i = 0; i < strips.length; i++) {
    if (i === focusedIndex) continue
    var direction = resizeDirection(i, strips.length - 1)
    var candidates = largestSpanFirst(strips[i].windows, axis)
    for (var j = 0; j < candidates.length; j++) {
      var win = candidates[j]
      var target = targets[win.address]
      if (!target) continue
      wanted = axis === "x" ? target.w : target.h
      current = axis === "x" ? win.w : win.h
      delta = ((wanted || current) - current) * direction
      if (Math.abs(delta) <= 2) continue
      ops.push(axis === "x"
        ? { address: win.address, dx: delta, dy: 0, candidate: candidate + j }
        : { address: win.address, dx: 0, dy: delta, candidate: candidate + j })
    }
    candidate += candidates.length
  }
  return ops
}

function layoutOps(focused, byAddress, monitors, cfg) {
  var targets = layoutTargets(focused, byAddress, monitors, cfg)
  var windows = workspaceWindows(byAddress, focused, cfg.includeFloating)
  return {
    targets: targets,
    ops: axisResizeOps(focused, windows, "x", targets)
      .concat(axisResizeOps(focused, windows, "y", targets))
  }
}

function sameSize(a, b, tolerance) {
  var limit = tolerance === undefined ? 4 : tolerance
  var widthDelta = a && b ? Math.abs(a.w - b.w) : Infinity
  var heightDelta = a && b ? Math.abs(a.h - b.h) : Infinity
  return widthDelta <= limit && heightDelta <= limit
}

function targetReached(win, target, tolerance) {
  if (!win || !target) return false
  var limit = tolerance === undefined ? 32 : tolerance
  var closeEnough = function(actual, wanted) {
    return !(wanted > 0) || Math.abs(actual - wanted) <= limit
  }
  return closeEnough(win.w, target.w) && closeEnough(win.h, target.h)
}

function floatingTarget(focused, monitors, cfg) {
  var monitor = monitorForWindow(focused, monitors)
  var area = monitor && monitor.wa
  if (!focused || !area || area.w <= 0 || area.h <= 0) return null
  return {
    x: area.x,
    y: area.y,
    w: Math.max(MINIMUM_SIZE, Math.round(area.w * cfg.widthMultiplier)),
    h: Math.max(MINIMUM_SIZE, Math.round(area.h * cfg.heightMultiplier)),
    wa: area
  }
}

function floatingPlacement(focused, target, cursor) {
  if (!focused || !target) return null
  var area = target.wa
  var minX = area.x
  var minY = area.y
  var maxX = area.x + area.w - target.w
  var maxY = area.y + area.h - target.h
  var x = clamp(focused.x, minX, maxX)
  var y = clamp(focused.y, minY, maxY)
  var pointerInside = cursor && cursor.x >= focused.x && cursor.x < focused.x + focused.w &&
    cursor.y >= focused.y && cursor.y < focused.y + focused.h
  if (pointerInside) {
    if (cursor.x < x || cursor.x >= x + target.w) x = clamp(cursor.x - target.w / 2, minX, maxX)
    if (cursor.y < y || cursor.y >= y + target.h) y = clamp(cursor.y - target.h / 2, minY, maxY)
  }
  return { x: Math.round(x), y: Math.round(y), w: target.w, h: target.h }
}

function resizeCommand(address, dx, dy, relative) {
  var parts = [
    'hl.dsp.window.resize({ window = "address:', String(address),
    '", x = ', String(Math.round(dx)),
    ', y = ', String(Math.round(dy)),
    ', relative = ', relative === false ? 'false' : 'true',
    ' })'
  ]
  return parts.join("")
}

function resizeEval(ops) {
  var commands = []
  for (var i = 0; i < ops.length; i++) {
    commands.push('hl.dispatch(' + resizeCommand(ops[i].address, ops[i].dx, ops[i].dy, ops[i].relative) + ')')
  }
  return commands.join('; ')
}

function floatingResizeEval(address, box) {
  var selector = 'window = "address:' + String(address) + '"'
  return 'hl.dispatch(hl.dsp.window.resize({ ' + selector + ', x = ' + Math.round(box.w) +
    ', y = ' + Math.round(box.h) + ', relative = false })); ' +
    'hl.dispatch(hl.dsp.window.move({ ' + selector + ', x = ' + Math.round(box.x) +
    ', y = ' + Math.round(box.y) + ', relative = false })); ' +
    'hl.dispatch(hl.dsp.window.bring_to_top({ ' + selector + ' }))'
}

function moveToRootEval() {
  return 'hl.dispatch(hl.dsp.layout("movetoroot"))'
}

function mouseConfigEval(followMouse, refocus) {
  var follow = typeof followMouse === "string" ? followMouse : String(Number(followMouse))
  return 'hl.config({ input = { follow_mouse = ' + follow +
    ', mouse_refocus = ' + (refocus ? 'true' : 'false') + ' } })'
}

function activeWorkspaceFloatsEval() {
  return 'local function active_workspace_floats() local workspace = hl.get_active_workspace(); if not workspace then return false end; for _, window in ipairs(hl.get_workspace_windows(tostring(workspace.id))) do for _, tag in ipairs(window.tags or {}) do if tag == "omarchy-floating-workspace" then return true end end end; local state_home = os.getenv("XDG_STATE_HOME"); if not state_home or state_home == "" then state_home = (os.getenv("HOME") or "") .. "/.local/state" end; local file = io.open(state_home .. "/omarchy/workspace-layouts/" .. tostring(workspace.id) .. ".lua", "r"); if file then local text = file:read("*a") or ""; file:close(); return text:match([[mode%s*=%s*"floating"]]) ~= nil end; file = io.open(state_home .. "/omarchy/workspace-layouts/default.lua", "r"); if file then local text = file:read("*a") or ""; file:close(); return text:match([[default%s*=%s*"floating"]]) ~= nil end; return false end'
}

function installHoverBridgeEval(includeFloating, refocus) {
  var appliedFollow = includeFloating ? 1 : '(active_workspace_floats() and 0 or 1)'
  return [
    'local bridge = rawget(_G, "focus_now_hover_bridge") or {}',
    'local function remove(subscription) if subscription then pcall(function() subscription:remove() end) end end',
    'remove(bridge.workspace_subscription); remove(bridge.monitor_subscription)',
    'if type(o) == "table" and bridge.workspace_mode and o.workspace_mode == bridge.wrapped_workspace_mode then o.workspace_mode = bridge.workspace_mode end',
    'bridge.workspace_subscription = nil; bridge.monitor_subscription = nil; bridge.wrapped_workspace_mode = nil',
    'bridge.workspace_mode = type(o) == "table" and o.workspace_mode or nil',
    activeWorkspaceFloatsEval(),
    'local function apply_hover_focus() hl.timer(function() bridge.restore_follow_mouse = active_workspace_floats() and 0 or hl.get_config("input.follow_mouse"); bridge.restore_mouse_refocus = hl.get_config("input.mouse_refocus"); ' + mouseConfigEval(appliedFollow, refocus) + ' end, { type = "oneshot", timeout = 1 }) end',
    'if bridge.workspace_mode then bridge.wrapped_workspace_mode = function(spec) local result = bridge.workspace_mode(spec); apply_hover_focus(); return result end; o.workspace_mode = bridge.wrapped_workspace_mode end',
    'bridge.workspace_subscription = hl.on("workspace.active", apply_hover_focus)',
    'bridge.monitor_subscription = hl.on("monitor.focused", apply_hover_focus)',
    'rawset(_G, "focus_now_hover_bridge", bridge)',
    mouseConfigEval(appliedFollow, refocus)
  ].join('; ')
}

function uninstallHoverBridgeEval(followMouse, refocus) {
  return [
    'local bridge = rawget(_G, "focus_now_hover_bridge")',
    'if bridge then if bridge.workspace_subscription then pcall(function() bridge.workspace_subscription:remove() end) end; if bridge.monitor_subscription then pcall(function() bridge.monitor_subscription:remove() end) end; if type(o) == "table" and bridge.workspace_mode and o.workspace_mode == bridge.wrapped_workspace_mode then o.workspace_mode = bridge.workspace_mode end end',
    activeWorkspaceFloatsEval(),
    'local restore_follow = ' + Number(followMouse),
    'if bridge and tonumber(bridge.restore_follow_mouse) ~= nil then restore_follow = tonumber(bridge.restore_follow_mouse) elseif active_workspace_floats() then restore_follow = 0 end',
    'local restore_refocus = ' + (refocus ? 'true' : 'false'),
    'if bridge and bridge.restore_mouse_refocus ~= nil then restore_refocus = bridge.restore_mouse_refocus end',
    'rawset(_G, "focus_now_hover_bridge", nil)',
    'hl.config({ input = { follow_mouse = restore_follow, mouse_refocus = restore_refocus } })'
  ].join('; ')
}


function luaString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function installStateBridgeEval(quickshellPath, shellPath, expandEnabled, widthMultiplier, heightMultiplier) {
  var command = shellQuote(quickshellPath) + ' -p ' + shellQuote(shellPath) +
    ' ipc call focus-now refresh'
  return [
    'local bridge = rawget(_G, "focus_now_state_bridge") or {}',
    'if bridge.subscription then pcall(function() bridge.subscription:remove() end) end',
    'bridge.floating_states = {}',
    'bridge.expand_enabled = ' + (expandEnabled ? 'true' : 'false'),
    'bridge.width_multiplier = ' + (Number.isFinite(widthMultiplier) ? widthMultiplier : 0.85),
    'bridge.height_multiplier = ' + (Number.isFinite(heightMultiplier) ? heightMultiplier : 0.85),
    'for _, window in ipairs(hl.get_windows()) do if window.address then bridge.floating_states[window.address] = window.floating and true or false end end',
    'local refresh_command = ' + luaString(command),
    'local function refresh_if_active(address)',
    'local suppress = rawget(_G, "focus_now_pop_restore"); local active = hl.get_active_window(); if (suppress and suppress[address]) or not active or active.address ~= address or active.floating then return end; hl.exec_cmd(refresh_command) end',
    'local function deferred_refresh(address, timeout)',
    'hl.timer(function() refresh_if_active(address) end, { timeout = timeout or 350, type = "oneshot" }) end',
    'bridge.deferred_refresh = deferred_refresh',
    'bridge.refresh_if_active = refresh_if_active',
    'bridge.subscription = hl.on("window.update_rules", function(window) if not window or not window.address then return end; local previous = bridge.floating_states[window.address]; local current = window.floating and true or false; bridge.floating_states[window.address] = current; local active = hl.get_active_window(); local suppress = rawget(_G, "focus_now_pop_restore"); if previous == current or not active or active.address ~= window.address then return end; if suppress and suppress[window.address] then deferred_refresh(window.address); return end; refresh_if_active(window.address) end)',
    'rawset(_G, "focus_now_state_bridge", bridge)'
  ].join('; ')
}

function uninstallStateBridgeEval() {
  return [
    'local bridge = rawget(_G, "focus_now_state_bridge")',
    'if bridge and bridge.subscription then pcall(function() bridge.subscription:remove() end) end',
    'rawset(_G, "focus_now_state_bridge", nil)'
  ].join('; ')
}

function managedFloatingMode(win) {
  if (!win) return ""
  return "floating:" + Math.round(win.x) + ":" + Math.round(win.y) + ":" +
    Math.round(win.w) + ":" + Math.round(win.h)
}

function parseManagedFloating(mode) {
  var parts = String(mode || "").split(":")
  if (parts.length !== 5 || parts[0] !== "floating") return null
  var rect = {
    x: numberOr(parts[1], NaN),
    y: numberOr(parts[2], NaN),
    w: numberOr(parts[3], NaN),
    h: numberOr(parts[4], NaN)
  }
  return isFinite(rect.x) && isFinite(rect.y) && isFinite(rect.w) && isFinite(rect.h) ? rect : null
}

function restoreFloatingEval(address, rect) {
  var window = 'window = "address:' + String(address) + '"'
  return 'hl.dispatch(hl.dsp.window.resize({ ' + window + ', x = ' + Math.round(rect.w) +
    ', y = ' + Math.round(rect.h) + ', relative = false })); ' +
    'hl.dispatch(hl.dsp.window.move({ ' + window + ', x = ' + Math.round(rect.x) +
    ', y = ' + Math.round(rect.y) + ', relative = false }))'
}

function isManagedFullscreen(win, address, mode) {
  if (!win || String(win.address || "") !== String(address || "")) return false
  var internal = numberOr(win.fullscreenMode, 0)
  var client = numberOr(win.fullscreenClientMode, 0)
  if (mode === "maximized") return internal === 1 && client === 1
  if (mode === "fullscreen") return internal === 2 && client === 1
  return false
}

function managedFullscreenApplies(win, address, mode, expandMode, onlyWorkspaceWindow) {
  if (!isManagedFullscreen(win, address, mode)) return false
  if (expandMode === "fullscreen") return mode === "fullscreen"
  if (expandMode === "near") return mode === "maximized" && !!onlyWorkspaceWindow
  return false
}

function managedFullscreenCondition(mode) {
  if (mode === "maximized") return 'target.fullscreen == 1 and target.fullscreen_client == 1'
  if (mode === "fullscreen") return 'target.fullscreen == 2 and target.fullscreen_client == 1'
  return 'false'
}

function clearManagedFullscreenEval(address, mode) {
  return 'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
    'if w.address == "' + String(address) + '" then target = w break end end; ' +
    'if target and ' + managedFullscreenCondition(mode) + ' then ' +
    'hl.dispatch(hl.dsp.window.fullscreen_state({ internal = 0, client = 0, window = "address:" .. target.address })) end'
}

function clearOtherFullscreenEval(address) {
  return 'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
    'if w.address == "' + String(address) + '" then target = w break end end; ' +
    'if target and target.workspace then for _, other in ipairs(hl.get_windows()) do ' +
    'if other.address ~= target.address and other.fullscreen ~= 0 and other.fullscreen_client == 1 ' +
    'and other.workspace and other.workspace.id == target.workspace.id then ' +
    'hl.dispatch(hl.dsp.window.fullscreen_state({ internal = 0, client = 0, window = "address:" .. other.address })) end ' +
    'end end'
}

function clearAllManagedFullscreenEval() {
  return 'for _, other in ipairs(hl.get_windows()) do ' +
    'if other.fullscreen ~= 0 and other.fullscreen_client == 1 then ' +
    'hl.dispatch(hl.dsp.window.fullscreen_state({ internal = 0, client = 0, window = "address:" .. other.address })) end ' +
    'end'
}

function setManagedMaximizedEval(address) {
  return 'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
    'if w.address == "' + String(address) + '" then target = w break end end; ' +
    'if target then hl.dispatch(hl.dsp.window.fullscreen_state({ internal = 1, client = 1, window = "address:" .. target.address })) end'
}

function setManagedFullscreenEval(address) {
  return 'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
    'if w.address == "' + String(address) + '" then target = w break end end; ' +
    'if target then hl.dispatch(hl.dsp.window.fullscreen_state({ internal = 2, client = 1, window = "address:" .. target.address })) end'
}

function clearManagedWindowEval(address, mode) {
  var floating = parseManagedFloating(mode)
  return floating ? restoreFloatingEval(address, floating) : clearManagedFullscreenEval(address, mode)
}

if (typeof module !== "undefined") {
  module.exports = {
    MULTIPLIERS: MULTIPLIERS,
    EXPAND_MODES: EXPAND_MODES,
    parseJson: parseJson,
    numberOr: numberOr,
    nearestMultiplier: nearestMultiplier,
    stepMultiplier: stepMultiplier,
    normalizeHoverDelay: normalizeHoverDelay,
    stepHoverDelay: stepHoverDelay,
    normalizeFullscreenDelay: normalizeFullscreenDelay,
    stepFullscreenDelay: stepFullscreenDelay,
    normalizeConfig: normalizeConfig,
    windowMeta: windowMeta,
    parseClients: parseClients,
    parseActiveWindow: parseActiveWindow,
    parseMonitors: parseMonitors,
    monitorForWindow: monitorForWindow,
    hasTag: hasTag,
    pointInsideWindow: pointInsideWindow,
    isActionable: isActionable,
    clientsList: clientsList,
    workspaceWindows: workspaceWindows,
    overlapAmount: overlapAmount,
    clusterStrips: clusterStrips,
    axisPool: axisPool,
    axisTargets: axisTargets,
    layoutTargets: layoutTargets,
    layoutOps: layoutOps,
    sameSize: sameSize,
    targetReached: targetReached,
    floatingTarget: floatingTarget,
    floatingPlacement: floatingPlacement,
    managedFloatingMode: managedFloatingMode,
    parseManagedFloating: parseManagedFloating,
    restoreFloatingEval: restoreFloatingEval,
    resizeCommand: resizeCommand,
    resizeEval: resizeEval,
    floatingResizeEval: floatingResizeEval,
    moveToRootEval: moveToRootEval,
    mouseConfigEval: mouseConfigEval,
    activeWorkspaceFloatsEval: activeWorkspaceFloatsEval,
    installHoverBridgeEval: installHoverBridgeEval,
    uninstallHoverBridgeEval: uninstallHoverBridgeEval,
    installStateBridgeEval: installStateBridgeEval,
    uninstallStateBridgeEval: uninstallStateBridgeEval,
    isManagedFullscreen: isManagedFullscreen,
    managedFullscreenApplies: managedFullscreenApplies,
    managedFullscreenCondition: managedFullscreenCondition,
    setManagedMaximizedEval: setManagedMaximizedEval,
    clearManagedFullscreenEval: clearManagedFullscreenEval,
    clearAllManagedFullscreenEval: clearAllManagedFullscreenEval,
    clearManagedWindowEval: clearManagedWindowEval,
    clearOtherFullscreenEval: clearOtherFullscreenEval,
    setManagedFullscreenEval: setManagedFullscreenEval
  }
}
