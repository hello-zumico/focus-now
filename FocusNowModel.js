// Pure Hyprland state parsing and layout planning for Focus Now. No QML and
// no process I/O live here, so node --test can exercise the same decisions the
// service applies.
var MULTIPLIERS = [0.5, 0.6, 0.67, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]
var EXPAND_MODES = ["off", "fullscreen", "near"]

function parseJson(raw, fallback) {
  try {
    return JSON.parse(String(raw || ""))
  } catch (e) {
    return fallback
  }
}

function numberOr(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : fallback
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function absolutePath(value) {
  var s = String(value || "").trim()
  return s.charAt(0) === "/" ? s : ""
}

function nearestMultiplier(value, fallback) {
  var n = numberOr(value, fallback)
  var best = MULTIPLIERS[0]
  var bestDistance = Math.abs(n - best)
  for (var i = 1; i < MULTIPLIERS.length; i++) {
    var distance = Math.abs(n - MULTIPLIERS[i])
    if (distance < bestDistance) {
      best = MULTIPLIERS[i]
      bestDistance = distance
    }
  }
  return best
}

function stepMultiplier(value, direction) {
  var current = nearestMultiplier(value, 0.85)
  var index = MULTIPLIERS.indexOf(current)
  var next = clamp(index + (direction < 0 ? -1 : 1), 0, MULTIPLIERS.length - 1)
  return MULTIPLIERS[next]
}

function normalizeConfig(raw) {
  var c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  var mode = EXPAND_MODES.indexOf(c.expandMode) >= 0 ? c.expandMode : "near"
  return {
    enabled: c.enabled !== false,
    hoverFocus: c.hoverFocus !== false,
    expandMode: mode,
    widthMultiplier: nearestMultiplier(c.widthMultiplier, 0.85),
    heightMultiplier: nearestMultiplier(c.heightMultiplier, 0.85),
    includeFloating: !!c.includeFloating,
    bins: {
      node: absolutePath(c.nodePath),
      hyprctl: absolutePath(c.hyprctlPath),
      timeout: absolutePath(c.timeoutPath)
    }
  }
}

function windowMeta(c) {
  if (!c || typeof c !== "object") return null
  var size = Array.isArray(c.size) ? c.size : []
  var at = Array.isArray(c.at) ? c.at : []
  var ws = c.workspace
  var workspaceId = ws && typeof ws === "object" ? (ws.id !== undefined ? ws.id : ws.name) : undefined
  return {
    address: String(c.address || ""),
    cls: String(c.class || c.initialClass || ""),
    title: String(c.title || ""),
    x: numberOr(at[0], 0),
    y: numberOr(at[1], 0),
    w: numberOr(size[0], 0),
    h: numberOr(size[1], 0),
    workspaceId: workspaceId,
    floating: !!c.floating,
    fullscreenMode: numberOr(c.fullscreen, 0),
    fullscreenClientMode: numberOr(c.fullscreenClient, 0),
    fullscreen: numberOr(c.fullscreen, 0) > 0 || numberOr(c.fullscreenClient, 0) > 0,
    pinned: !!c.pinned,
    mapped: c.mapped !== false,
    monitor: numberOr(c.monitor, -1)
  }
}

function parseClients(raw) {
  var arr = parseJson(raw, [])
  if (!Array.isArray(arr)) arr = []
  var byAddress = {}
  for (var i = 0; i < arr.length; i++) {
    var meta = windowMeta(arr[i])
    if (meta && meta.address) byAddress[meta.address] = meta
  }
  return byAddress
}

function parseActiveWindow(raw) {
  return windowMeta(parseJson(raw, null))
}

function monitorMeta(m) {
  if (!m || typeof m !== "object") return null
  var scale = numberOr(m.scale, 1)
  if (!(scale > 0)) scale = 1
  var reserved = Array.isArray(m.reserved) ? m.reserved : []
  var left = numberOr(reserved[0], 0)
  var top = numberOr(reserved[1], 0)
  var right = numberOr(reserved[2], 0)
  var bottom = numberOr(reserved[3], 0)
  return {
    id: numberOr(m.id, -1),
    focused: !!m.focused,
    wa: {
      x: (numberOr(m.x, 0) + left) / scale,
      y: (numberOr(m.y, 0) + top) / scale,
      w: (numberOr(m.width, 0) - left - right) / scale,
      h: (numberOr(m.height, 0) - top - bottom) / scale
    }
  }
}

function parseMonitors(raw) {
  var arr = parseJson(raw, [])
  if (!Array.isArray(arr)) arr = []
  var out = {}
  for (var i = 0; i < arr.length; i++) {
    var meta = monitorMeta(arr[i])
    if (meta) out[meta.id] = meta
  }
  return out
}

function monitorForWindow(win, monitors) {
  return win && monitors ? monitors[numberOr(win.monitor, -1)] || null : null
}

function isActionable(win, includeFloating) {
  return !!(win && win.address && win.mapped && !win.pinned && win.w > 0 && win.h > 0 &&
    (includeFloating || !win.floating))
}

function clientsList(byAddress) {
  var out = []
  if (!byAddress || typeof byAddress !== "object") return out
  for (var address in byAddress) if (byAddress[address]) out.push(byAddress[address])
  return out
}

function workspaceWindows(byAddress, focused, includeFloating) {
  var out = []
  var list = clientsList(byAddress)
  for (var i = 0; i < list.length; i++) {
    var w = list[i]
    if (!isActionable(w, includeFloating)) continue
    if (String(w.workspaceId) !== String(focused.workspaceId)) continue
    if (numberOr(w.monitor, -1) !== numberOr(focused.monitor, -1)) continue
    out.push(w)
  }
  return out
}

function overlapAmount(a1, a2, b1, b2) {
  return Math.min(a2, b2) - Math.max(a1, b1)
}

function clusterStrips(windows, axis) {
  var strips = []
  for (var i = 0; i < windows.length; i++) {
    var w = windows[i]
    var a1 = axis === "x" ? w.x : w.y
    var a2 = a1 + (axis === "x" ? w.w : w.h)
    var hits = []
    for (var s = 0; s < strips.length; s++) {
      if (overlapAmount(a1, a2, strips[s].a1, strips[s].a2) > 24) hits.push(s)
    }
    if (!hits.length) {
      strips.push({ a1: a1, a2: a2, windows: [w] })
      continue
    }
    var keep = hits[0]
    strips[keep].windows.push(w)
    strips[keep].a1 = Math.min(strips[keep].a1, a1)
    strips[keep].a2 = Math.max(strips[keep].a2, a2)
    for (var h = hits.length - 1; h >= 1; h--) {
      var other = strips[hits[h]]
      strips[keep].windows = strips[keep].windows.concat(other.windows)
      strips[keep].a1 = Math.min(strips[keep].a1, other.a1)
      strips[keep].a2 = Math.max(strips[keep].a2, other.a2)
      strips.splice(hits[h], 1)
    }
  }
  strips.sort(function(a, b) { return a.a1 - b.a1 })
  return strips
}

function axisPool(focused, windows, axis) {
  var out = []
  for (var i = 0; i < windows.length; i++) {
    var w = windows[i]
    var overlaps = axis === "x"
      ? overlapAmount(focused.y, focused.y + focused.h, w.y, w.y + w.h) > 24
      : overlapAmount(focused.x, focused.x + focused.w, w.x, w.x + w.w) > 24
    if (overlaps) out.push(w)
  }
  return out
}

function minDim(mon, axis) {
  var wa = mon && mon.wa ? (axis === "x" ? mon.wa.w : mon.wa.h) : 0
  if (!(wa > 0)) wa = axis === "x" ? 1920 : 1080
  return Math.max(80, Math.round(wa * 0.08))
}

function workAreaDim(mon, axis, fallback) {
  var wa = mon && mon.wa ? (axis === "x" ? mon.wa.w : mon.wa.h) : 0
  return wa > 0 ? wa : fallback
}

function shareRemainder(windows, remainder, minSize) {
  var out = []
  var weights = []
  var sum = 0
  for (var i = 0; i < windows.length; i++) {
    var weight = Math.max(1, windows[i])
    weights.push(weight)
    sum += weight
  }
  var used = 0
  for (i = 0; i < weights.length; i++) {
    var share = Math.round(remainder * weights[i] / sum)
    out.push(share)
    used += share
  }
  if (out.length) out[out.length - 1] += remainder - used
  for (i = 0; i < out.length; i++) {
    if (out[i] >= minSize) continue
    var need = minSize - out[i]
    out[i] = minSize
    for (var t = 0; t < out.length && need > 0; t++) {
      if (t === i) continue
      var give = out[t] - minSize
      var take = Math.min(give, need)
      out[t] -= take
      need -= take
    }
  }
  return out
}

function axisTargets(focused, windows, mon, axis, multiplier) {
  var pool = axisPool(focused, windows, axis)
  var strips = clusterStrips(pool, axis)
  var focusedIndex = -1
  for (var i = 0; i < strips.length; i++) {
    for (var j = 0; j < strips[i].windows.length; j++) {
      if (strips[i].windows[j].address === focused.address) focusedIndex = i
    }
  }
  if (focusedIndex < 0) return {}

  var currentTotal = 0
  for (i = 0; i < strips.length; i++) currentTotal += strips[i].a2 - strips[i].a1
  var full = workAreaDim(mon, axis, currentTotal)
  var total = strips.length === 1 ? full : Math.max(currentTotal, strips.length * minDim(mon, axis))
  var minSize = minDim(mon, axis)
  var focusedTarget = strips.length === 1
    ? Math.round(total)
    : Math.round(clamp(total * multiplier, minSize, Math.max(minSize, total - (strips.length - 1) * minSize)))

  var otherCurrent = []
  var otherIndexes = []
  for (i = 0; i < strips.length; i++) {
    if (i === focusedIndex) continue
    otherIndexes.push(i)
    otherCurrent.push(strips[i].a2 - strips[i].a1)
  }
  var shares = strips.length === 1 ? [] : shareRemainder(otherCurrent, total - focusedTarget, minSize)
  var out = {}
  for (i = 0; i < strips.length; i++) {
    var target = i === focusedIndex ? focusedTarget : shares[otherIndexes.indexOf(i)]
    for (j = 0; j < strips[i].windows.length; j++) {
      var address = strips[i].windows[j].address
      if (!out[address]) out[address] = {}
      if (axis === "x") out[address].w = target
      else out[address].h = target
    }
  }
  return out
}

function mergeTargets(a, b) {
  var out = {}
  var key
  for (key in a) out[key] = { w: a[key].w, h: a[key].h }
  for (key in b) {
    if (!out[key]) out[key] = {}
    if (b[key].w > 0) out[key].w = b[key].w
    if (b[key].h > 0) out[key].h = b[key].h
  }
  return out
}

function layoutTargets(focused, byAddress, monitors, cfg) {
  if (!isActionable(focused, cfg.includeFloating)) return {}
  var windows = workspaceWindows(byAddress, focused, cfg.includeFloating)
  if (!windows.length) return {}
  var mon = monitorForWindow(focused, monitors)
  return mergeTargets(
    axisTargets(focused, windows, mon, "x", cfg.widthMultiplier),
    axisTargets(focused, windows, mon, "y", cfg.heightMultiplier)
  )
}

function edgeSigns(win, mon) {
  var tolerance = 20
  var wa = mon && mon.wa && mon.wa.w > 0 && mon.wa.h > 0 ? mon.wa : null
  var left = false, right = false, top = false, bottom = false
  if (wa) {
    left = win.x <= wa.x + tolerance
    right = win.x + win.w >= wa.x + wa.w - tolerance
    top = win.y <= wa.y + tolerance
    bottom = win.y + win.h >= wa.y + wa.h - tolerance
  }
  return {
    sx: left && right ? 0 : (right && !left ? -1 : 1),
    sy: top && bottom ? 0 : (bottom && !top ? -1 : 1)
  }
}

function deltaToTarget(win, mon, target) {
  var signs = edgeSigns(win, mon)
  return {
    x: signs.sx === 0 ? 0 : ((target.w || win.w) - win.w) * signs.sx,
    y: signs.sy === 0 ? 0 : ((target.h || win.h) - win.h) * signs.sy
  }
}

function representativeFirst(windows, axis) {
  return windows.slice().sort(function(a, b) {
    var spanA = axis === "x" ? a.h : a.w
    var spanB = axis === "x" ? b.h : b.w
    return spanB - spanA
  })
}

function axisResizeOps(focused, windows, axis, targets) {
  var pool = axisPool(focused, windows, axis)
  var strips = clusterStrips(pool, axis)
  var focusedIndex = -1
  var focusedCenter = axis === "x"
    ? focused.x + focused.w / 2
    : focused.y + focused.h / 2
  for (var i = 0; i < strips.length; i++) {
    for (var j = 0; j < strips[i].windows.length; j++) {
      if (strips[i].windows[j].address === focused.address) focusedIndex = i
    }
  }
  if (focusedIndex < 0) return []
  var ops = []
  var focusedStrip = strips[focusedIndex]
  var focusedTarget = targets[focused.address]
  var focusedDirection = focusedIndex === 0 ? 1 : (focusedIndex === strips.length - 1 ? -1 : 0)
  var axisSiblings = []
  var focusedA1 = axis === "x" ? focused.x : focused.y
  var focusedA2 = focusedA1 + (axis === "x" ? focused.w : focused.h)
  for (i = 0; i < windows.length; i++) {
    var sibling = windows[i]
    var siblingA1 = axis === "x" ? sibling.x : sibling.y
    var siblingA2 = siblingA1 + (axis === "x" ? sibling.w : sibling.h)
    var overlap = overlapAmount(focusedA1, focusedA2, siblingA1, siblingA2)
    var focusedSpan = focusedA2 - focusedA1
    var siblingSpan = siblingA2 - siblingA1
    var sharedRange = overlap / Math.max(1, Math.min(focusedSpan, siblingSpan))
    var sameSpan = Math.min(focusedSpan, siblingSpan) / Math.max(1, Math.max(focusedSpan, siblingSpan))
    if (sharedRange > 0.75 && sameSpan > 0.75) axisSiblings.push(sibling)
  }
  if (axisSiblings.length > 1 && strips.length > 1 && focusedDirection !== 0 && focusedTarget) {
    var current = axis === "x" ? focused.w : focused.h
    var wanted = axis === "x" ? focusedTarget.w : focusedTarget.h
    var delta = ((wanted || current) - current) * focusedDirection
    if (Math.abs(delta) > 2) {
      ops.push(axis === "x"
        ? { address: focused.address, dx: delta, dy: 0, candidate: 0 }
        : { address: focused.address, dx: 0, dy: delta, candidate: 0 })
    }
  }
  var candidateOffset = ops.length
  for (i = 0; i < strips.length; i++) {
    if (i === focusedIndex) continue
    var strip = strips[i]
    var stripCenter = (strip.a1 + strip.a2) / 2
    var direction = stripCenter < focusedCenter ? 1 : -1
    var candidates = representativeFirst(strip.windows, axis)
    for (j = 0; j < candidates.length; j++) {
      var win = candidates[j]
      var target = targets[win.address]
      if (!target) continue
      var current = axis === "x" ? win.w : win.h
      var wanted = axis === "x" ? target.w : target.h
      var delta = ((wanted || current) - current) * direction
      if (Math.abs(delta) <= 2) continue
      ops.push(axis === "x"
        ? { address: win.address, dx: delta, dy: 0, candidate: candidateOffset + j }
        : { address: win.address, dx: 0, dy: delta, candidate: candidateOffset + j })
    }
  }
  return ops
}

function layoutOps(focused, byAddress, monitors, cfg) {
  var targets = layoutTargets(focused, byAddress, monitors, cfg)
  var windows = workspaceWindows(byAddress, focused, cfg.includeFloating)
  var ops = axisResizeOps(focused, windows, "x", targets)
    .concat(axisResizeOps(focused, windows, "y", targets))
  return { targets: targets, ops: ops }
}

function pickOp(ops) {
  var best = null
  var bestAmount = 0
  for (var i = 0; i < ops.length; i++) {
    var amount = Math.abs(ops[i].dx) + Math.abs(ops[i].dy)
    if (amount > bestAmount) {
      best = ops[i]
      bestAmount = amount
    }
  }
  return best
}

function sameSize(a, b, tolerance) {
  tolerance = tolerance === undefined ? 4 : tolerance
  return !!a && !!b && Math.abs(a.w - b.w) <= tolerance && Math.abs(a.h - b.h) <= tolerance
}

function resizeCommand(address, dx, dy) {
  return 'hl.dsp.window.resize({ window = "address:' + String(address) + '", x = ' +
    Math.round(dx) + ', y = ' + Math.round(dy) + ', relative = true })'
}

function resizeEval(ops) {
  var out = []
  for (var i = 0; i < ops.length; i++) {
    out.push('hl.dispatch(' + resizeCommand(ops[i].address, ops[i].dx, ops[i].dy) + ')')
  }
  return out.join('; ')
}

function isManagedFullscreen(win, address, mode) {
  if (!win || String(win.address || "") !== String(address || "")) return false
  var internal = numberOr(win.fullscreenMode, 0)
  var client = numberOr(win.fullscreenClientMode, 0)
  if (mode === "maximized") return internal === 1 && client === 1
  if (mode === "fullscreen") return internal === 2 && client === 1
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
    'hl.dispatch(hl.dsp.window.fullscreen_state({ internal = 0, client = 0, window = target })) end'
}

function clearOtherFullscreenEval(address) {
  return 'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
    'if w.address == "' + String(address) + '" then target = w break end end; ' +
    'if target then for _, other in ipairs(hl.get_windows({ workspace = target.workspace })) do ' +
    'if other.address ~= target.address and (other.fullscreen ~= 0 or other.fullscreen_client ~= 0) then ' +
    'hl.dispatch(hl.dsp.window.fullscreen_state({ internal = 0, client = 0, window = other })) end ' +
    'end end'
}

function setManagedFullscreenEval(address) {
  return 'local target = nil; for _, w in ipairs(hl.get_windows()) do ' +
    'if w.address == "' + String(address) + '" then target = w break end end; ' +
    'if target then hl.dispatch(hl.dsp.window.fullscreen_state({ internal = 2, client = 1, window = target })) end'
}

if (typeof module !== "undefined") {
  module.exports = {
    MULTIPLIERS: MULTIPLIERS,
    EXPAND_MODES: EXPAND_MODES,
    parseJson: parseJson,
    numberOr: numberOr,
    nearestMultiplier: nearestMultiplier,
    stepMultiplier: stepMultiplier,
    normalizeConfig: normalizeConfig,
    windowMeta: windowMeta,
    parseClients: parseClients,
    parseActiveWindow: parseActiveWindow,
    parseMonitors: parseMonitors,
    monitorForWindow: monitorForWindow,
    isActionable: isActionable,
    clientsList: clientsList,
    workspaceWindows: workspaceWindows,
    overlapAmount: overlapAmount,
    clusterStrips: clusterStrips,
    axisPool: axisPool,
    axisTargets: axisTargets,
    layoutTargets: layoutTargets,
    edgeSigns: edgeSigns,
    deltaToTarget: deltaToTarget,
    representativeFirst: representativeFirst,
    axisResizeOps: axisResizeOps,
    layoutOps: layoutOps,
    pickOp: pickOp,
    sameSize: sameSize,
    resizeCommand: resizeCommand,
    resizeEval: resizeEval,
    isManagedFullscreen: isManagedFullscreen,
    managedFullscreenCondition: managedFullscreenCondition,
    clearManagedFullscreenEval: clearManagedFullscreenEval,
    clearOtherFullscreenEval: clearOtherFullscreenEval,
    setManagedFullscreenEval: setManagedFullscreenEval
  }
}
