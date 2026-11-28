-- focus-now flat layouts: columns of vertical stacks, or rows of horizontal
-- stacks ("lua:columns" / "lua:rows").
--
-- No split tree: outer-axis slot sizes are a flat vector and each slot's
-- member sizes are a flat vector, so every collapsed window can be exactly
-- collapseSize on either axis regardless of its neighbors. Nothing in the
-- structure can reorder itself, lock, or go negative.
--
-- focus-now drives geometry through layoutmsg:
--   "w 32,-,32 [h 0xA:57,0xB:-]"   (columns: column client widths; optional h
--     section = per-window client heights in the focused stack)
--   "h 32,-,32 [w 0xA:57,0xB:-]"   (rows: row client heights; optional w
--     section = per-window client widths in the focused stack)
-- "-" = flex share of leftover.
--   "geom a:x,y,w,h b:x,y,w,h ..."  exact client rects per window; apply.js
--     computes these from the persisted slot structure so mixtures of rows
--     and columns survive verbatim. Structural verbs clear the override.
-- verbs (columns / rows):
--   "stack l|r"  / "stack u|d"   focused window joins the adjacent slot's stack
--   "unstack"                    focused window leaves its stack into its own slot
--   "togglestack"                toggles the focused window between stack and slot
--   "move l|r" / "move u|d"      reorder focused slot; inner dir = within stack
--   "resize l|r|u|d <px>"        adjust focused slot size / member size
--   "dump"                       write structure to /tmp/focus-now-dump.txt
--
-- Members that vanish from ctx.targets (window closed, moved away, or a
-- transient during `hyprctl reload`) keep their slots and simply don't
-- render; a slot with no live members for GC_SECONDS is dropped. That is
-- what lets stacks and ordering survive config reloads.
--
-- Per-workspace options live in focus-now.json:
--   "columns": { "2": {"enabled":true,"open":"vertical","base":"dwindle","mode":"rows"},
--                "special:x": {...} }
-- "base" is the omarchy layout under the preset: "dwindle" (default),
-- "scrolling", or "floating". A lua provider is only claimed while base is
-- dwindle and "mode" picks it: "columns", "rows", or "mix" (focus
-- expansion over tiling — claims lua:tree, the dwindle emulator).
-- For columns:  "open":"horizontal" → new windows open as new columns;
--               "open":"vertical"   → new windows stack under the focused column.
-- For rows:     "open":"vertical"   → new windows open as new rows;
--               "open":"horizontal" → new windows stack into the focused row.
-- State persists in ~/.local/state/focus-now-columns.txt across reloads.
-- apply.js reads the "ws"/"col" lines as the authoritative slot structure.

local SEAM, EDGE = 7, 2
local GC_SECONDS = 5
local CONFIG_PATH = os.getenv("HOME") .. "/.config/omarchy/focus-now.json"
local STATE_PATH = os.getenv("HOME") .. "/.local/state/focus-now-columns.txt"

-- ws name -> {
--   cols  = { {addr,...}, ... }   member addrs; absent-from-live kept as ghosts
--   colW  = { anchor=px|0 }       keyed by col[1]; 0/nil = flex
--   h     = { addr=px|0 }         per-member inner size; 0/nil = flex
--   missing = { addr=os.time() }  first-absent stamps; ghosts GC'd after 5s
--   rw/rh = { anchor|addr=px }    last rendered client sizes (for resize deltas)
-- }
local S = {}

local function ws_state(name)
  if not S[name] then S[name] = { cols = {}, colW = {}, h = {}, missing = {}, rw = {}, rh = {}, geom = {}, sizes = {}, tree = nil, rects = {}, pseudo = {} } end
  return S[name]
end

-- Slot stacks belong to one provider's shape: a member stacked under
-- columns renders as a vertical sliver inside a row once the workspace
-- switches to rows. Switching providers resets the structure so every
-- window lands in a slot of its own, and the saved exact-rect overrides go
-- too — a rect measured for the other axis renders as the wrong shape
-- until the next apply re-emits it.
local function reset_on_layout_change(st, name)
  if st.layout == name then return end
  st.layout = name
  st.cols = {}
  st.colW = {}
  st.h = {}
  st.geom = {}
  st.sizes = {}
  st.tree = nil
  st.rects = {}
  st.pseudo = {}
end

local function col_anchor(col) return col[1] end

local function col_w(st, i) return st.colW[col_anchor(st.cols[i])] or 0 end
local function set_col_w(st, i, v) st.colW[col_anchor(st.cols[i])] = v end

-- ---------- persistence ----------
-- Tree node constructors + (de)serialization live here so load_state below
-- can restore lua:tree structures; the layout section is further down.
local function tleaf(a) return { leaf = a } end
local function tnode(dir, k0, k1, ratio)
  -- Clamp restored ratios: a deformed persisted comb must not resurrect
  -- unreachable slivers on reload.
  ratio = math.max(0.05, math.min(0.95, tonumber(ratio) or 0.5))
  return { dir = dir, kids = { k0, k1 }, ratio = ratio }
end

local function tree_ser(n)
  if not n then return "-" end
  if n.leaf then return n.leaf end
  return "( " .. (n.dir or "h") .. " " .. tostring(n.ratio or 0.5)
    .. " " .. tree_ser(n.kids[1]) .. " " .. tree_ser(n.kids[2]) .. " )"
end

local function tree_parse(tokens, i)
  local t = tokens[i]
  if t == nil or t == "-" or t == ")" then return nil, i + 1 end
  if t:sub(1, 1) == "(" then
    local dir = tokens[i + 1]
    local ratio = tonumber(tokens[i + 2]) or 0.5
    local k0, j = tree_parse(tokens, i + 3)
    local k1, j2 = tree_parse(tokens, j)
    return tnode(dir, k0, k1, ratio), j2 + 1
  end
  return tleaf(t), i + 1
end

local function tree_load(line)
  local tokens = {}
  for tok in line:gmatch("%S+") do tokens[#tokens + 1] = tok end
  return (tree_parse(tokens, 1))
end

local function save_state()
  local f = io.open(STATE_PATH, "w")
  if not f then return end
  for ws, st in pairs(S) do
    f:write("ws\t" .. ws .. "\t" .. (st.layout or "") .. "\n")
    for i, col in ipairs(st.cols) do
      f:write("col\t" .. i .. "\t" .. table.concat(col, " ") .. "\n")
    end
    for anchor, w in pairs(st.colW) do
      f:write("w\t" .. anchor .. "\t" .. tostring(w) .. "\n")
    end
    for a, h in pairs(st.h) do
      f:write("h\t" .. a .. "\t" .. tostring(h) .. "\n")
    end
    for a, r in pairs(st.geom) do
      f:write("g\t" .. a .. "\t" .. tostring(r.x) .. "\t" .. tostring(r.y)
        .. "\t" .. tostring(r.w) .. "\t" .. tostring(r.h) .. "\n")
    end
    if st.tree then
      f:write("t\t" .. tree_ser(st.tree) .. "\n")
    end
    for a, sz in pairs(st.pseudo or {}) do
      f:write("p\t" .. a .. "\t" .. tostring(sz.w) .. "\t" .. tostring(sz.h) .. "\n")
    end
  end
  f:close()
end

local function load_state()
  local f = io.open(STATE_PATH, "r")
  if not f then return end
  local st
  for line in f:lines() do
    local parts = {}
    for p in line:gmatch("[^\t]+") do parts[#parts + 1] = p end
    if parts[1] == "ws" then
      st = ws_state(parts[2])
      st.layout = parts[3] ~= "" and parts[3] or nil
    elseif parts[1] == "col" and st then
      local col = {}
      for a in (parts[3] or ""):gmatch("%S+") do col[#col + 1] = a end
      st.cols[tonumber(parts[2])] = col
    elseif parts[1] == "w" and st then
      st.colW[parts[2]] = tonumber(parts[3]) or 0
    elseif parts[1] == "h" and st then
      st.h[parts[2]] = tonumber(parts[3]) or 0
    elseif parts[1] == "g" and st then
      st.geom[parts[2]] = {
        x = tonumber(parts[3]) or 0, y = tonumber(parts[4]) or 0,
        w = tonumber(parts[5]) or 0, h = tonumber(parts[6]) or 0,
      }
    elseif parts[1] == "t" and st then
      st.tree = tree_load(parts[2])
    elseif parts[1] == "p" and st then
      st.pseudo[parts[2]] = { w = tonumber(parts[3]) or 0, h = tonumber(parts[4]) or 0 }
    end
  end
  f:close()
end
load_state()

-- ---------- per-workspace options ----------

local config_cache = {}
local config_next_read = 0
-- Top-level "enabled"/"collapseSize" from focus-now.json; refreshed
-- alongside column_opts.
local opts_enabled = true
local opts_expand = true
local opts_collapse = 32
local opts_animate = true
local opts_anim_speed = 0
local anim_speed_written = 0

-- The last windowsMove leaf speed (ms) the plugin wrote to the compositor,
-- shared with apply.js so either side can revert it.
local ANIM_SPEED_STATE = "/tmp/focus-now-animspeed"
local function anim_speed_state()
  local f = io.open(ANIM_SPEED_STATE, "r")
  if not f then return 0 end
  local v = tonumber(f:read("a")) or 0
  f:close()
  return v
end
local function write_anim_speed_state(v)
  local f = io.open(ANIM_SPEED_STATE, "w")
  if f then f:write(tostring(v)) f:close() end
end

-- Write-or-revert the windowsMove leaf from the current options. Called from
-- recalculate (backstop) and directly via hyprctl eval when the service saves
-- animateSpeed — config changes must not wait for the next apply.
local function apply_anim_speed_leaf()
  if opts_animate and opts_anim_speed > 0 then
    if anim_speed_written ~= opts_anim_speed then
      if pcall(hl.animation, { leaf = "windowsMove", enabled = true,
                               speed = opts_anim_speed / 100, bezier = "easeOutQuint" }) then
        anim_speed_written = opts_anim_speed
        write_anim_speed_state(opts_anim_speed)
      end
    end
  elseif anim_speed_state() > 0 then
    -- A runtime leaf override can only be truly removed by re-evaluating the
    -- config — re-emitting the parent's definition would pin the leaf at
    -- today's value instead of inheriting. State is zeroed first so the
    -- re-loaded module doesn't schedule a second reload; the timer defers it
    -- past the end of this handler.
    write_anim_speed_state(0)
    anim_speed_written = 0
    hl.timer(function()
      io.popen("hyprctl reload >/dev/null 2>&1"):close()
    end, { timeout = 100, type = "oneshot" })
  end
end

-- Service entry point: the saved value is passed in directly so the leaf
-- lands even if the config file write hasn't flushed yet.
function focus_now_apply_anim_speed(speed, animate)
  opts_anim_speed = tonumber(speed) or 0
  if animate ~= nil then opts_animate = animate and true or false end
  apply_anim_speed_leaf()
end

-- The pointer sits off every window (bar, empty desktop). Focus is sticky —
-- the last window keeps it, and the layout holds exactly as it was — so this
-- flag only freezes incoming geom verbs until the pointer re-enters.
local hover_released = false
function focus_now_set_hover_release(v)
  hover_released = v and true or false
end

local function column_opts()
  local f = io.open(CONFIG_PATH, "r")
  if not f then return {} end
  local text = f:read("a")
  f:close()
  -- Top-level options only: workspace presets under "columns" carry their
  -- own "enabled" flags, so a raw match would treat one disabled preset as
  -- the plugin being off.
  local head = text:match('^(.-)"columns"') or text
  opts_enabled = head:match('"enabled"%s*:%s*false') == nil
  opts_expand = head:match('"expandMode"%s*:%s*"off"') == nil
  opts_collapse = tonumber(head:match('"collapseSize"%s*:%s*(%d+)')) or 32
  opts_animate = head:match('"animate"%s*:%s*false') == nil
  opts_anim_speed = tonumber(head:match('"animateSpeed"%s*:%s*(%d+)')) or 0
  local block = text:match('"columns"%s*:%s*(%b{})')
  local out = {}
  if block then
    for name, entry in block:gmatch('"([^"]+)"%s*:%s*(%b{})') do
      local mode = entry:match('"mode"%s*:%s*"(%a+)"')
      out[name] = {
        enabled = entry:match('"enabled"%s*:%s*true') ~= nil,
        open = entry:match('"open"%s*:%s*"vertical"') and "vertical" or "horizontal",
        base = entry:match('"base"%s*:%s*"(%a+)"') or "dwindle",
        mode = mode == "rows" and "rows" or (mode == "columns" and "columns" or "mix"),
      }
    end
  end
  return out
end

local function ws_opts(name)
  local now = os.time()
  if now >= config_next_read then
    config_cache = column_opts()
    config_next_read = now + 1
  end
  local opts = config_cache[name]
  if opts then return opts end
  return { enabled = false, open = "horizontal", base = "dwindle", mode = "mix" }
end

config_cache = column_opts()

-- Columns are the default tiled layout; per-workspace rules can still pin
-- specific workspaces (and the panel's off-toggle writes a dwindle rule, its
-- mode toggle a lua:rows rule). When the plugin is disabled the providers
-- stay registered but dormant: nothing claims general.layout or any
-- workspace, so the compositor falls back to the user's layouts.
if opts_enabled then
  hl.config({ general = { layout = "lua:columns" } })

  -- Emit workspace rules only for entries wanting a lua provider: "mix"
  -- claims the dwindle-emulating lua:tree layout (expansion over tiling
  -- without dwindle's clamps); scrolling/floating bases claim the workspace
  -- through omarchy's own saved-mode files.
  for name, o in pairs(config_cache) do
    local layout = o.mode == "mix" and "lua:tree" or ("lua:" .. o.mode)
    if o.enabled and o.base == "dwindle"
        and (o.mode == "columns" or o.mode == "rows" or o.mode == "mix") then
      hl.workspace_rule({ workspace = name, layout = layout })
    end
  end
end

-- ---------- structure ----------

local function ws_key(ctx)
  for _, t in ipairs(ctx.targets) do
    local w = t.window
    if w and w.workspace then return w.workspace.name end
  end
  return nil
end

local function live_addrs(ctx)
  local map, order = {}, {}
  for _, t in ipairs(ctx.targets) do
    local w = t.window
    if w and w.address then
      map[w.address] = t
      order[#order + 1] = w.address
    end
  end
  return map, order
end

local function col_of(st, addr)
  for ci, col in ipairs(st.cols) do
    for j, a in ipairs(col) do
      if a == addr then return ci, j end
    end
  end
  return nil
end

-- Slots with at least one live member, in structural order.
local function visible_cols(st, live)
  local out = {}
  for i, col in ipairs(st.cols) do
    local members = {}
    for _, a in ipairs(col) do
      if live[a] then members[#members + 1] = a end
    end
    if #members > 0 then
      out[#out + 1] = { idx = i, members = members }
    end
  end
  return out
end

-- Slot index of the most recently focused live window other than `skip`.
-- focus_history_id counts down to the active window (0 = focused now).
local function focused_col(st, live, skip)
  local best, bestCi = math.huge, nil
  for addr, t in pairs(live) do
    if addr ~= skip then
      local w = t.window
      local fid = w and w.focus_history_id or math.huge
      local ci = col_of(st, addr)
      if ci and fid < best then best, bestCi = fid, ci end
    end
  end
  return bestCi
end

local function reconcile(ctx, st, opts, stackOpen)
  local live, order = live_addrs(ctx)
  local registered = {}
  local now = os.time()
  st.missing = st.missing or {}

  -- Every member in the structure counts as registered, live or ghost.
  -- An absent member keeps its slot for GC_SECONDS (config reloads briefly
  -- empty ctx.targets); only then is it pruned. An emptied column drops.
  local newCols = {}
  for i, col in ipairs(st.cols) do
    local keep = {}
    for _, a in ipairs(col) do
      registered[a] = true
      if live[a] then
        st.missing[a] = nil
        keep[#keep + 1] = a
      else
        st.missing[a] = st.missing[a] or now
        if now - st.missing[a] <= GC_SECONDS then
          keep[#keep + 1] = a
        else
          st.missing[a] = nil
          st.h[a] = nil
          st.geom[a] = nil
        end
      end
    end
    if #keep > 0 then newCols[#newCols + 1] = keep end
    if #keep == 0 then st.colW[col_anchor(col)] = nil end
  end
  st.cols = newCols

  -- Register unseen targets: stack onto the focused slot or append a slot.
  for _, addr in ipairs(order) do
    if not registered[addr] then
      if stackOpen and #st.cols > 0 then
        local ci = focused_col(st, live, addr)
        table.insert(st.cols[ci or #st.cols], addr)
      else
        st.cols[#st.cols + 1] = { addr }
      end
      registered[addr] = true
    end
  end
end

local function is_flex(v) return (v or 0) <= 0 end

-- place() takes the cell box: client rect plus the gap padding on each side,
-- EDGE at the area edge and SEAM between siblings. The padding is recovered
-- from the client's distance to the area edge so arbitrary rects can be
-- rendered exactly.
local function place_cell(t, r, area)
  local padL = math.max(0, math.min(SEAM, r.x - area.x))
  local padR = math.max(0, math.min(SEAM, area.x + area.w - (r.x + r.w)))
  local padT = math.max(0, math.min(SEAM, r.y - area.y))
  local padB = math.max(0, math.min(SEAM, area.y + area.h - (r.y + r.h)))
  t:place({ x = r.x - padL, y = r.y - padT, w = r.w + padL + padR, h = r.h + padT + padB })
end

-- Smallest cell a leaf may subdivide into: the plugin's collapse size.
-- A window must never render below this — slivers are unfocusable.
local function collapse_floor()
  return math.max(1, tonumber(opts_collapse) or 32)
end

-- A "geom" overlay rect may carry bogus values (planner edge cases,
-- interactive resize leftovers). Clamp it into the workspace area; if it
-- cannot describe a real client box, treat it as absent.
local function sane_geom(g, area)
  if not g then return nil end
  local w = tonumber(g.w) or 0
  local h = tonumber(g.h) or 0
  local x = tonumber(g.x) or area.x
  local y = tonumber(g.y) or area.y
  w = math.max(24, math.min(w, area.w))
  h = math.max(24, math.min(h, area.h))
  x = math.max(area.x, math.min(x, area.x + area.w - w))
  y = math.max(area.y, math.min(y, area.y + area.h - h))
  return { x = x, y = y, w = w, h = h }
end

-- Registers the flat layout under `name` with `outer` as the slot axis:
-- "x" gives columns of vertical stacks (lua:columns), "y" gives rows of
-- horizontal stacks (lua:rows).
local function register_flat(name, outer)
  local horizontal = outer == "x"
  -- open value that means "stack into the focused slot": the inner axis name.
  local stackOpenValue = horizontal and "vertical" or "horizontal"
  -- Slot-order verb directions and member-order verb directions.
  local slotPrev = horizontal and "l" or "u"
  local slotNext = horizontal and "r" or "d"
  local memberPrev = horizontal and "u" or "l"
  local memberNext = horizontal and "d" or "r"
  -- layoutmsg letters: outer vector and per-member sizes.
  local outerVerb = horizontal and "w" or "h"
  local innerVerb = horizontal and "h" or "w"

  hl.layout.register(name, {
    recalculate = function(ctx)
      if #ctx.targets == 0 then return end
      local key = ws_key(ctx)
      local st = key and ws_state(key) or { cols = {}, colW = {}, h = {}, missing = {}, geom = {} }
      local opts = key and ws_opts(key) or { enabled = true, open = "horizontal", base = "dwindle", mode = "columns" }
      reset_on_layout_change(st, name)
      local live = live_addrs(ctx)
      reconcile(ctx, st, opts, opts.open == stackOpenValue)

      local cols = visible_cols(st, live)
      local n = #cols
      if n == 0 then return end
      local area = ctx.area

      -- Inner sizes are only meaningful inside multi-member stacks; a slot
      -- left with a single member must flex back to full inner extent.
      for _, vcol in ipairs(cols) do
        if #vcol.members == 1 then st.h[vcol.members[1]] = nil end
      end

      -- Slot outer sizes follow the focus-now contract: the focused slot
      -- takes the leftover and every other slot sits at collapseSize (or its
      -- explicitly resized colW). Structural verbs clear st.geom and reset
      -- sizes to flex, so this contract render is what a stack/toggle/move
      -- shows immediately — no apply needed for the layout to look right.
      local fci = focused_col(st, live)
      if st.renderedFocusCol ~= fci then
        -- Explicit colW/member sizes are resize feedback while focused; once
        -- focus moves the contract render owns geometry again — siblings must
        -- collapse back to the floor instead of keeping stale sizes.
        st.renderedFocusCol = fci
        st.colW = {}
        st.h = {}
      end
      local fvi
      for i, vcol in ipairs(cols) do
        if vcol.idx == fci then fvi = i break end
      end
      local inner = 2 * SEAM * (n - 1)
      local avail = (horizontal and area.w or area.h) - 2 * EDGE - inner
      local assigned = 0
      local widths = {}
      for i, vcol in ipairs(cols) do
        if i ~= fvi then
          local w = col_w(st, vcol.idx)
          widths[i] = is_flex(w) and opts_collapse or w
          assigned = assigned + widths[i]
        end
      end
      -- Explicit sibling colW can overflow the span (stale state) and crush
      -- the focused slot to 1px — scale siblings so the focused keeps a floor.
      local floorW = math.min(math.max(240, opts_collapse), avail)
      if assigned > avail - floorW and assigned > 0 then
        local scale = (avail - floorW) / assigned
        assigned = 0
        for i in ipairs(cols) do
          if i ~= fvi then
            widths[i] = math.max(1, widths[i] * scale)
            assigned = assigned + widths[i]
          end
        end
      end
      widths[fvi or n] = math.max(1, avail - assigned)

      -- animate=off: rects commit instantly instead of interpolating — mute
      -- compositor animations while placement runs, restore right after.
      local muted_anim = false
      if not opts_animate then
        muted_anim = pcall(hl.config, { animations = { enabled = false } })
      end
      -- animateSpeed>0: the plugin owns the "windowsMove" leaf, so only
      -- move/resize transitions take the configured duration (ms→ds). Set
      -- back to 0, the config's own definition is re-emitted so the override
      -- doesn't linger.
      apply_anim_speed_leaf()

      local x, y = area.x, area.y
      for i, vcol in ipairs(cols) do
        local cw = widths[i]
        st.rw[col_anchor(st.cols[vcol.idx])] = cw
        local before = i == 1 and EDGE or SEAM
        local after = i == n and EDGE or SEAM
        local bw = math.max(1, cw + before + after)

        -- stack member inner sizes. The contract applies on the inner axis
        -- in every slot: the most recently focused member takes the rest
        -- and the others sit at collapseSize or their explicit size.
        local m = #vcol.members
        local vInner = 2 * SEAM * (m - 1)
        local vAvail = (horizontal and area.h or area.w) - 2 * EDGE - vInner
        local heights = {}
        -- Every slot renders members on the same contract: the most recently
        -- focused member claims the leftover while the rest sit at their
        -- explicit size or the collapse floor. Re-evening unfocused slots
        -- would re-plump a collapsed member on every focus move or release.
        local bj, bfid = 0, math.huge
        for j, a in ipairs(vcol.members) do
          local w = live[a] and live[a].window
          local fid = w and w.focus_history_id or math.huge
          if fid < bfid then bfid, bj = fid, j end
        end
        bj = bj > 0 and bj or m
        local vAssigned = 0
        for j, a in ipairs(vcol.members) do
          if j ~= bj then
            local h = st.h[a]
            heights[j] = is_flex(h) and opts_collapse or h
            vAssigned = vAssigned + heights[j]
          end
        end
        -- Over-claimed explicit member sizes must not crush the leftover
        -- member below the floor — scale them to fit.
        if vAssigned > vAvail - 1 and vAssigned > 0 then
          local scale = (vAvail - 1) / vAssigned
          vAssigned = 0
          for j = 1, m do
            if j ~= bj then
              heights[j] = math.max(1, heights[j] * scale)
              vAssigned = vAssigned + heights[j]
            end
          end
        end
        heights[bj] = math.max(1, vAvail - vAssigned)

        local my = y
        local mx = x
        for j, a in ipairs(vcol.members) do
          local ch = heights[j]
          st.rh[a] = ch
          local top = j == 1 and EDGE or SEAM
          local bottom = j == m and EDGE or SEAM
          local t = live[a]
          if t and not st.geom[a] then
            if horizontal then
              t:place({ x = mx, y = my, w = bw, h = math.max(1, ch + top + bottom) })
            else
              t:place({ x = mx, y = my, w = math.max(1, ch + top + bottom), h = bw })
            end
          end
          if horizontal then
            my = my + ch + top + bottom
          else
            mx = mx + ch + top + bottom
          end
        end
        if horizontal then x = x + bw else y = y + bw end
      end

      -- Exact rects from a "geom" layoutmsg override slot placement.
      for a, r in pairs(st.geom or {}) do
        local t = live[a]
        if t then place_cell(t, r, area) end
      end

      if muted_anim then pcall(hl.config, { animations = { enabled = true } }) end
    end,

    layout_msg = function(ctx, msg)
      local key = ws_key(ctx)
      if not key then return false end
      local st = ws_state(key)
      reset_on_layout_change(st, name)
      local live = live_addrs(ctx)
      reconcile(ctx, st, ws_opts(key), ws_opts(key).open == stackOpenValue)
      local cols = visible_cols(st, live)

      local verb, rest = msg:match("^(%S+)%s*(.*)$")

      if verb == "geom" then
        -- "geom a:x,y,w,h b:x,y,w,h ...": exact client rects for every listed
        -- window, overriding slot placement. Lets a mixed arrangement of
        -- columns and rows collapse on each window's own axis. While the
        -- pointer sits off every window the render stays even — a racing
        -- expand apply's geom would re-expand it, so drop the verb.
        if hover_released then return true end
        st.geom = {}
        for a, x, y, w, h in rest:gmatch("(0x%x+):(%-?%d+),(%-?%d+),(%-?%d+),(%-?%d+)") do
          st.geom[a] = { x = tonumber(x), y = tonumber(y), w = tonumber(w), h = tonumber(h) }
        end
      elseif verb == outerVerb or verb == innerVerb then
        st.geom = {}
        -- "<outerVerb> v1,v2,... [<innerVerb> a:p,...]": the outer vector
        -- applies to visible slots in order; the inner section assigns
        -- per-member client sizes by address.
        local vpart, mpart = rest:match("^(.-)%s+" .. innerVerb .. "%s*(.*)$")
        if verb == outerVerb then
          local i = 0
          for token in (vpart or rest):gmatch("[^,%s]+") do
            i = i + 1
            if cols[i] then set_col_w(st, cols[i].idx, tonumber(token) or 0) end
          end
          if mpart then
            st.h = {}
            for a, v in mpart:gmatch("(0x%x+):([%d%-]+)") do
              st.h[a] = tonumber(v) or 0
            end
          end
        else
          st.h = {}
          for a, v in rest:gmatch("(0x%x+):([%d%-]+)") do
            st.h[a] = tonumber(v) or 0
          end
        end
      elseif verb == "dump" then
        local f = io.open("/tmp/focus-now-dump.txt", "w")
        if f then
          f:write("ws=" .. tostring(key) .. "\n")
          if ctx.area then
            f:write("area=" .. tostring(ctx.area.x) .. "," .. tostring(ctx.area.y)
              .. " " .. tostring(ctx.area.w) .. "x" .. tostring(ctx.area.h) .. "\n")
          end
          for a, t in pairs(live) do f:write("live " .. a .. "\n") end
          for i, col in ipairs(st.cols) do
            f:write("col " .. i .. " w=" .. tostring(col_w(st, i))
              .. " : " .. table.concat(col, " ") .. "\n")
          end
          for a, h in pairs(st.h) do f:write("h " .. a .. " " .. tostring(h) .. "\n") end
          f:close()
        end
      else
        st.geom = {}
        local aw = hl.get_active_window()
        local a = aw and aw.address
        local ci, j
        if a then ci, j = col_of(st, a) end
        -- Returning false surfaces a compositor error notification; known
        -- verbs that cannot apply (edges, floating focus) are silent no-ops.
        if not a or not ci then return true end

        if verb == "stack" then
          local dir = rest:match("(%a+)")
          local target = dir == slotPrev and ci - 1 or dir == slotNext and ci + 1
          if not target or not st.cols[target] then return true end
          local anchor = col_anchor(st.cols[ci])
          table.remove(st.cols[ci], j)
          if #st.cols[ci] == 0 then
            table.remove(st.cols, ci)
            st.colW[anchor] = nil
            target = dir == slotPrev and ci - 1 or ci
            if target > #st.cols then target = #st.cols end
          end
          table.insert(st.cols[target], a)
          st.h[a] = 0
        elseif verb == "unstack" then
          if #st.cols[ci] < 2 then return true end
          table.remove(st.cols[ci], j)
          table.insert(st.cols, ci, { a })
          st.colW[a] = 0
        elseif verb == "togglestack" or verb == "togglesplit" then
          -- Stock SUPER + J dispatches "togglesplit" as a layoutmsg, so it
          -- reaches this provider on every user's bindings. Alias it onto
          -- togglestack: a lone window joins the neighbor's stack and a
          -- stacked window pops out into its own slot.
          -- In a stack: pop out into a slot inserted before its old slot, so
          -- toggling again stacks right back into place. Alone: join the
          -- next slot's stack (previous if there is no next).
          if #st.cols[ci] > 1 then
            table.remove(st.cols[ci], j)
            table.insert(st.cols, ci, { a })
            st.colW[a] = 0
          else
            local target = st.cols[ci + 1] and ci + 1 or (ci > 1 and ci - 1)
            if not target then return true end
            local anchor = col_anchor(st.cols[ci])
            table.remove(st.cols, ci)
            st.colW[anchor] = nil
            if target > ci then target = target - 1 end
            table.insert(st.cols[target], a)
            st.h[a] = 0
          end
        elseif verb == "move" then
          local dir = rest:match("(%a+)")
          if (dir == slotPrev or dir == slotNext) and #st.cols[ci] > 1 then
            -- Stack member moving outward: pop out and join the adjacent
            -- slot's stack (same as "stack"), keeping its inner slot.
            local target = dir == slotNext and ci + 1 or ci - 1
            if not st.cols[target] then return true end
            local anchor = col_anchor(st.cols[ci])
            table.remove(st.cols[ci], j)
            if #st.cols[ci] == 0 then
              table.remove(st.cols, ci)
              st.colW[anchor] = nil
              if target > ci then target = target - 1 end
            end
            table.insert(st.cols[target], math.min(j, #st.cols[target] + 1), a)
            st.h[a] = 0
          elseif dir == slotPrev and ci > 1 then
            st.cols[ci], st.cols[ci - 1] = st.cols[ci - 1], st.cols[ci]
          elseif dir == slotNext and ci < #st.cols then
            st.cols[ci], st.cols[ci + 1] = st.cols[ci + 1], st.cols[ci]
          elseif dir == memberPrev and j > 1 then
            st.cols[ci][j], st.cols[ci][j - 1] = st.cols[ci][j - 1], st.cols[ci][j]
          elseif dir == memberNext and j < #st.cols[ci] then
            st.cols[ci][j], st.cols[ci][j + 1] = st.cols[ci][j + 1], st.cols[ci][j]
          end
        elseif verb == "resize" then
          local dir, px = rest:match("(%a+)%s*(%-?%d*)")
          px = tonumber(px) or 0
          -- The focused slot/member always renders as the leftover, so it
          -- cannot carry an explicit size of its own — storing one is a
          -- landmine applied the moment focus moves. Instead px>0 takes px
          -- from its peers proportionally (focused grows) and px<0 gives
          -- px to them (focused shrinks).
          -- px>0 takes px from peers proportionally (focused grows); px<0
          -- gives px to them (focused shrinks). The give is capped at the
          -- focused element's current size so it can never be pushed below
          -- the render floor.
          if dir == slotPrev or dir == slotNext then
            local total = 0
            for i, slot in ipairs(st.cols) do
              if i ~= ci then total = total + (st.rw[col_anchor(slot)] or col_w(st, i)) end
            end
            if total > 0 then
              local give = px
              if give < 0 then
                local fcur = st.rw[col_anchor(st.cols[ci])] or 0
                if fcur > 1 then give = math.max(give, 1 - fcur) end
              end
              for i, slot in ipairs(st.cols) do
                if i ~= ci then
                  local cur = st.rw[col_anchor(slot)] or col_w(st, i)
                  if cur > 0 then set_col_w(st, i, math.max(1, cur - give * cur / total)) end
                end
              end
            end
          else
            local total = 0
            for _, m in ipairs(st.cols[ci]) do
              if m ~= a then total = total + (st.rh[m] or st.h[m] or 0) end
            end
            if total > 0 then
              local give = px
              if give < 0 then
                local fcur = st.rh[a] or 0
                if fcur > 1 then give = math.max(give, 1 - fcur) end
              end
              for _, m in ipairs(st.cols[ci]) do
                if m ~= a then
                  local cur = st.rh[m] or st.h[m] or 0
                  if cur > 0 then st.h[m] = math.max(1, cur - give * cur / total) end
                end
              end
            end
          end
        else
          -- Unknown msg: stock bindings can fire dwindle verbs (preselect,
          -- splitratio, movetoroot...) at a flat workspace. Returning false
          -- surfaces a compositor error notification, so accept silently.
        end
      end

      save_state()
      return true
    end,
  })
end

register_flat("columns", "x")
register_flat("rows", "y")

-- ---------- lua:tree : dwindle-emulating binary layout ----------
--
-- "mix" workspaces route here instead of real dwindle. The structure is a
-- binary split tree like dwindle's — new windows split the focused leaf's
-- compartment in the direction its aspect suggests — but rects come from
-- ratio subdivision of the work area, so a leaf can never clamp, lock, or
-- go negative. The arithmetic wall dwindle hits (focused + n×collapseSize
-- > span) cannot exist in ratio space.
--
-- focus-now drives geometry through the same "geom" layoutmsg contract as
-- the flat layouts: exact client rects per window, overriding tree
-- placement until a structural verb clears the override.
--
-- verbs:
--   "sizes a:w,h ..."      per-window client sizes (apply.js expansion plan);
--                          node ratios are solved from the demands bottom-up:
--                          an h-node needs Σkid widths, a v-node max; the
--                          ratio is kid0's share of the pair. Unlisted windows
--                          keep their last rendered size. Exact in share space
--                          and can never wedge — a 5px leaf is a real window.
--   "geom a:x,y,w,h ..."   exact client rects (rows/columns-style override)
--   "togglesplit"          flip the focused leaf's parent split direction
--   "move l|r|u|d"         swap the focused leaf with its geometric neighbor
--   "resize l|r|u|d <px>"  grow/shrink focused via the nearest ancestor split
--   "movetoroot"           promote the focused leaf to a root-level split
--   "preselect h|v"        pin the next insert's split direction
--   "dump"                 write the tree to /tmp/focus-now-dump.txt

local function tree_leaves(n, out)
  out = out or {}
  if not n then return out end
  if n.leaf then
    out[#out + 1] = n.leaf
  else
    tree_leaves(n.kids[1], out)
    tree_leaves(n.kids[2], out)
  end
  return out
end

-- Find a leaf and its ancestor chain (innermost parent first).
local function tree_find(n, addr, chain)
  if not n then return nil end
  if n.leaf then
    return n.leaf == addr and { leaf = n, chain = chain or {} } or nil
  end
  chain = chain or {}
  local depth = #chain
  chain[#chain + 1] = n
  local f = tree_find(n.kids[1], addr, chain) or tree_find(n.kids[2], addr, chain)
  if not f then for i = #chain, depth + 1, -1 do chain[i] = nil end end
  return f
end

local function tree_remove(st, addr)
  local f = st.tree and tree_find(st.tree, addr)
  if not f then return end
  if #f.chain == 0 then
    st.tree = nil
    return
  end
  local p = f.chain[#f.chain]
  local sib = p.kids[1] == f.leaf and p.kids[2] or p.kids[1]
  local gp = f.chain[#f.chain - 1]
  if not gp then
    st.tree = sib
  else
    for i = 1, 2 do
      if gp.kids[i] == p then gp.kids[i] = sib break end
    end
  end
  st.rects[addr] = nil
end

-- Split the leaf `at` into a node holding it and `addr`. Direction follows
-- the compartment's aspect like dwindle: wider than tall splits side by
-- side. A pending "preselect" overrides the aspect choice once.
local function tree_insert(st, addr, at, side)
  if not st.tree then
    st.tree = tleaf(addr)
    return
  end
  local f = at and tree_find(st.tree, at)
  if not f then
    local ls = tree_leaves(st.tree)
    f = #ls > 0 and tree_find(st.tree, ls[#ls]) or nil
  end
  if not f then return end
  -- Direction follows the leaf's resting (ratio) compartment, not its
  -- expanded overlay box — otherwise a focused leaf always reads wide and
  -- every insert degrades the tree into a right-leaning column comb.
  -- tree_stamp_boxes stamps n.box on every reconcile; st.rects is the
  -- overlay box and must never feed this choice.
  local box = f.leaf.box or {}
  local dir = (box.w or 0) >= (box.h or 0) and "h" or "v"
  if st.preselect then
    dir = st.preselect
    st.preselect = nil
  end
  -- side ("l"/"r"/"u"/"d") overrides the aspect pick: a drag-drop inserts
  -- on the side of the target compartment the cursor landed on.
  if side == "l" or side == "r" then dir = "h" end
  if side == "u" or side == "d" then dir = "v" end
  local leaf = tleaf(addr)
  local kids = (side == "l" or side == "u") and { leaf, f.leaf } or { f.leaf, leaf }
  local new = tnode(dir, kids[1], kids[2])
  local p = f.chain[#f.chain]
  if not p then
    st.tree = new
  else
    for i = 1, 2 do
      if p.kids[i] == f.leaf then p.kids[i] = new break end
    end
  end
end

-- In-tree live addr with the lowest focus_history_id (0 = focused now).
local tree_stamp_boxes

local function tree_focused(st, live, skip)
  local inTree = {}
  for _, a in ipairs(tree_leaves(st.tree)) do inTree[a] = true end
  local best, pick = math.huge, nil
  for a, t in pairs(live) do
    if a ~= skip and inTree[a] then
      local w = t.window
      local fid = w and w.focus_history_id or math.huge
      if fid < best then best, pick = fid, a end
    end
  end
  return pick
end

local function tree_reconcile(ctx, st, live)
  local now = os.time()
  st.missing = st.missing or {}
  for _, a in ipairs(tree_leaves(st.tree)) do
    if live[a] then
      st.missing[a] = nil
    else
      st.missing[a] = st.missing[a] or now
      if now - st.missing[a] > GC_SECONDS then
        st.missing[a] = nil
        st.geom[a] = nil
        if st.sizes then st.sizes[a] = nil end
        if st.pseudo then st.pseudo[a] = nil end
        tree_remove(st, a)
      end
    end
  end
  local inTree = {}
  for _, a in ipairs(tree_leaves(st.tree)) do inTree[a] = true end
  -- Stamp resting compartments before any insert: the split direction reads
  -- the leaf's resting box, and the sizes overlay never stamps n.box — only
  -- this walk does. Without it every new leaf reads the expanded overlay
  -- rect, always picks "h", and the tree degrades into a column comb.
  if st.tree then tree_stamp_boxes(st, st.tree, ctx.area, ctx.area) end
  for _, t in ipairs(ctx.targets) do
    local w = t.window
    local a = w and w.address
    if a and not inTree[a] then
      tree_insert(st, a, tree_focused(st, live, a))
      inTree[a] = true
    end
  end
end

-- Size solve for "sizes" verbs, as a pure render overlay: demands are
-- computed bottom-up (a leaf wants its target client size, or its last
-- rendered size, or an even share when brand new), then the tree is
-- walked top-down placing every leaf at its solved box. Node ratios are
-- NEVER mutated — the resting arrangement stays whatever the user and
-- inserts made it, and expansion rides on top.
--
-- An h-node demands the sum of its kids' widths and the max of their
-- heights, a v-node vice-versa; kid0's ratio is its share of the pair.
-- Oversubscribed demands scale down uniformly — every leaf still lands
-- on a positive box.
local function tree_minimum(n, area, edges)
  edges = edges or { left = true, right = true, top = true, bottom = true }
  if n.leaf then
    local gaps, border = { left = SEAM - EDGE, right = SEAM - EDGE, top = SEAM - EDGE, bottom = SEAM - EDGE }, EDGE
    if hl and hl.get_config then
      gaps = hl.get_config("general.gaps_in") or gaps
      border = tonumber(hl.get_config("general.border_size")) or border
    end
    local left = border + (edges.left and 0 or (gaps.left or 0))
    local right = border + (edges.right and 0 or (gaps.right or 0))
    local top = border + (edges.top and 0 or (gaps.top or 0))
    local bottom = border + (edges.bottom and 0 or (gaps.bottom or 0))
    return { w = collapse_floor() + left + right, h = collapse_floor() + top + bottom,
      left = left, right = right, top = top, bottom = bottom }
  end
  local box = n.box or area
  local dir = n.dir
  if dir == "auto" or not dir then dir = box.w >= box.h and "h" or "v" end
  local a = tree_minimum(n.kids[1], area, {
    left = edges.left, right = dir ~= "h" and edges.right, top = edges.top, bottom = dir ~= "v" and edges.bottom,
  })
  local b = tree_minimum(n.kids[2], area, {
    left = dir ~= "h" and edges.left, right = edges.right, top = dir ~= "v" and edges.top, bottom = edges.bottom,
  })
  return {
    w = dir == "h" and a.w + b.w or math.max(a.w, b.w),
    h = dir == "v" and a.h + b.h or math.max(a.h, b.h),
    dir = dir, kids = { a, b },
  }
end

local function tree_place_client(t, r, box, area)
  local minimum = tree_minimum({ leaf = true }, area, {})
  local w = math.min(box.w, math.max(minimum.w, r.w + minimum.left + minimum.right))
  local h = math.min(box.h, math.max(minimum.h, r.h + minimum.top + minimum.bottom))
  local x = math.max(box.x, math.min(r.x - minimum.left, box.x + box.w - w))
  local y = math.max(box.y, math.min(r.y - minimum.top, box.y + box.h - h))
  t:place({ x = x, y = y, w = w, h = h })
end

local function tree_split(span, ratio, first, second)
  assert(span >= first + second, "focus-now: subtree cannot fit collapseSize")
  return math.max(first, math.min(span - second, math.floor(span * ratio)))
end

-- Stamp n.box with the resting compartment each node would occupy without
-- the expansion overlay — same subdivision math as tree_render, no place()
-- calls. Inserts read these boxes for their aspect-based split direction.
tree_stamp_boxes = function(st, n, box, area)
  n.box = box
  if n.leaf then return end
  local minimum = tree_minimum(n, area)
  if minimum.dir == "h" then
    local w0 = tree_split(box.w, n.ratio or 0.5, minimum.kids[1].w, minimum.kids[2].w)
    tree_stamp_boxes(st, n.kids[1], { x = box.x, y = box.y, w = w0, h = box.h }, area)
    tree_stamp_boxes(st, n.kids[2], { x = box.x + w0, y = box.y, w = box.w - w0, h = box.h }, area)
  else
    local h0 = tree_split(box.h, n.ratio or 0.5, minimum.kids[1].h, minimum.kids[2].h)
    tree_stamp_boxes(st, n.kids[1], { x = box.x, y = box.y, w = box.w, h = h0 }, area)
    tree_stamp_boxes(st, n.kids[2], { x = box.x, y = box.y + h0, w = box.w, h = box.h - h0 }, area)
  end
end

local function tree_req(st, n, sizes, leafCount, area, minimum, focused)
  minimum = minimum or tree_minimum(n, area)
  if n.leaf then
    local s = sizes[n.leaf]
    local r = st.rects[n.leaf] or {}
    local w = s and s.w or r.w or (leafCount > 0 and area.w / leafCount or area.w)
    local h = s and s.h or r.h or area.h
    -- cell demand: client plus the gap pads each side eats; never demand
    -- below the collapse floor — a sliver rect must not feed back into
    -- the next solve and keep a window unreachable.
    return { w = math.max(minimum.w, w + minimum.left + minimum.right),
      h = math.max(minimum.h, h + minimum.top + minimum.bottom), minW = minimum.w, minH = minimum.h,
      focused = n.leaf == focused }
  end
  local r0 = tree_req(st, n.kids[1], sizes, leafCount, area, minimum.kids[1], focused)
  local r1 = tree_req(st, n.kids[2], sizes, leafCount, area, minimum.kids[2], focused)
  local dir = minimum.dir
  if dir == "h" then
    return { w = r0.w + r1.w, h = math.max(r0.h, r1.h), minW = r0.minW + r1.minW, minH = math.max(r0.minH, r1.minH), focused = r0.focused or r1.focused, _r0 = r0, _r1 = r1, _dir = "h" }
  end
  return { w = math.max(r0.w, r1.w), h = r0.h + r1.h, minW = math.max(r0.minW, r1.minW), minH = r0.minH + r1.minH, focused = r0.focused or r1.focused, _r0 = r0, _r1 = r1, _dir = "v" }
end

local function tree_solve_render(st, n, req, box, live, geom, area)
  if n.leaf then
    local a = n.leaf
    st.rects[a] = box
    local t = live[a]
    if t then
      local g = sane_geom(geom[a], area)
      local ps = st.pseudo and st.pseudo[a]
      if ps and ps.w > 0 and ps.h > 0 and ps.w >= collapse_floor() and ps.h >= collapse_floor() then
        -- Pseudo box: a fixed client size centered in the compartment.
        local cw = math.min(ps.w, math.max(1, box.w - 2 * SEAM))
        local ch = math.min(ps.h, math.max(1, box.h - 2 * SEAM))
        tree_place_client(t, {
          x = box.x + math.floor((box.w - cw) / 2),
          y = box.y + math.floor((box.h - ch) / 2),
          w = cw, h = ch,
        }, box, area)
      elseif g then tree_place_client(t, g, box, area) else t:place(box) end
    end
    return
  end
  if req._dir == "h" then
    local first = req._r0.focused or (not req._r1.focused and req._r0.minH >= req._r1.minH)
    local w0 = first and box.w - req._r1.minW or req._r0.minW
    assert(w0 >= req._r0.minW and box.w - w0 >= req._r1.minW, "focus-now: subtree cannot fit collapseSize")
    tree_solve_render(st, n.kids[1], req._r0, { x = box.x, y = box.y, w = w0, h = box.h }, live, geom, area)
    tree_solve_render(st, n.kids[2], req._r1, { x = box.x + w0, y = box.y, w = math.max(1, box.w - w0), h = box.h }, live, geom, area)
  else
    local first = req._r0.focused or (not req._r1.focused and req._r0.minW >= req._r1.minW)
    local h0 = first and box.h - req._r1.minH or req._r0.minH
    assert(h0 >= req._r0.minH and box.h - h0 >= req._r1.minH, "focus-now: subtree cannot fit collapseSize")
    tree_solve_render(st, n.kids[1], req._r0, { x = box.x, y = box.y, w = box.w, h = h0 }, live, geom, area)
    tree_solve_render(st, n.kids[2], req._r1, { x = box.x, y = box.y + h0, w = box.w, h = math.max(1, box.h - h0) }, live, geom, area)
  end
end

-- Snapshot the nearest ancestor split on each axis into st.dragbase —
-- the absolute baseline a pointer resize applies deltas against.
local function tree_grab(st, chain, addr)
  local base = {}
  for i = #chain, 1, -1 do
    local p = chain[i]
    local pdir = p.dir == "auto" and (p.box and (p.box.w >= p.box.h and "h" or "v") or "h") or p.dir
    local span = (pdir == "h" and p.box and p.box.w) or (pdir == "v" and p.box and p.box.h) or 0
    if span > 0 then
      local first = tree_find(p.kids[1], addr) ~= nil
      if pdir == "h" and not base.h then
        base.h = { node = p, ratio = p.ratio or 0.5, span = span, sign = first and 1 or -1 }
      elseif pdir == "v" and not base.v then
        base.v = { node = p, ratio = p.ratio or 0.5, span = span, sign = first and 1 or -1 }
      end
    end
    if base.h and base.v then break end
  end
  st.dragbase = base
end

local function tree_drag_apply(base, dx, dy)
  if base.h then
    base.h.node.ratio = math.max(0.02, math.min(0.98, base.h.ratio + base.h.sign * dx / base.h.span))
  end
  if base.v then
    base.v.node.ratio = math.max(0.02, math.min(0.98, base.v.ratio + base.v.sign * dy / base.v.span))
  end
end

-- Grow a leaf by px on the given split axis through the nearest ancestor
-- of that direction; px<0 gives size back to the sibling. Returns early at
-- the first matching ancestor — mirrors how dwindle's resizewindowpixel
-- climbs to the split that affects the window on that axis.
local function tree_axis_grow(inTree, addr, want, px)
  for i = #inTree.chain, 1, -1 do
    local p = inTree.chain[i]
    local pdir = p.dir == "auto" and (p.box and (p.box.w >= p.box.h and "h" or "v") or "h") or p.dir
    if pdir == want then
      local span = (want == "h" and (p.box and p.box.w) or (p.box and p.box.h)) or 0
      if span > 0 then
        local delta = px / span
        if tree_find(p.kids[1], addr) == nil then delta = -delta end
        p.ratio = math.max(0.02, math.min(0.98, (p.ratio or 0.5) + delta))
      end
      return
    end
  end
end

-- Recursive subdivision: each node hands its cell to its children by ratio.
-- Cell boxes tile the area contiguously — place() derives the client rect
-- from the cell the same way the flat layouts render it. A node's rendered
-- box is cached for insert-direction and resize-ratio math.
local function tree_render(st, n, box, live, geom, area, minimum)
  minimum = minimum or tree_minimum(n, area)
  n.box = box
  if n.leaf then
    local a = n.leaf
    st.rects[a] = box
    local t = live[a]
    if t then
      local g = sane_geom(geom[a], area)
      local ps = st.pseudo and st.pseudo[a]
      if ps and ps.w > 0 and ps.h > 0 and ps.w >= collapse_floor() and ps.h >= collapse_floor() then
        -- Pseudo box: a fixed client size centered in the compartment.
        local cw = math.min(ps.w, math.max(1, box.w - 2 * SEAM))
        local ch = math.min(ps.h, math.max(1, box.h - 2 * SEAM))
        tree_place_client(t, {
          x = box.x + math.floor((box.w - cw) / 2),
          y = box.y + math.floor((box.h - ch) / 2),
          w = cw, h = ch,
        }, box, area)
      elseif g then tree_place_client(t, g, box, area) else t:place(box) end
    end
    return
  end
  local dir = minimum.dir
  if dir == "h" then
    local w0 = tree_split(box.w, n.ratio or 0.5, minimum.kids[1].w, minimum.kids[2].w)
    tree_render(st, n.kids[1], { x = box.x, y = box.y, w = w0, h = box.h }, live, geom, area, minimum.kids[1])
    tree_render(st, n.kids[2], { x = box.x + w0, y = box.y, w = box.w - w0, h = box.h }, live, geom, area, minimum.kids[2])
  else
    local h0 = tree_split(box.h, n.ratio or 0.5, minimum.kids[1].h, minimum.kids[2].h)
    tree_render(st, n.kids[1], { x = box.x, y = box.y, w = box.w, h = h0 }, live, geom, area, minimum.kids[1])
    tree_render(st, n.kids[2], { x = box.x, y = box.y + h0, w = box.w, h = box.h - h0 }, live, geom, area, minimum.kids[2])
  end
end

local function tree_grid_render(st, live, geom, area, focused)
  local leaves = tree_leaves(st.tree)
  local minimum = tree_minimum({ leaf = true }, area, {})
  local maxCols, maxRows = math.floor(area.w / minimum.w), math.floor(area.h / minimum.h)
  assert(maxCols > 0 and maxRows > 0 and #leaves <= maxCols * maxRows,
    "focus-now: screen cannot fit all windows at collapseSize")
  if focused and tree_find(st.tree, focused) then
    local others = {}
    for _, a in ipairs(leaves) do if a ~= focused then others[#others + 1] = a end end
    local edge = tree_minimum({ leaf = true }, area)
    local cols = math.ceil(#leaves / maxRows)
    local leftRows = math.max(0, #others - (cols - 1) * maxRows)
    local right, index = area.x + area.w, 1
    for col = 1, cols - 1 do
      local w = minimum.w - (col == 1 and minimum.right - edge.right or 0)
      right = right - w
      local rows = math.min(maxRows, #others - index + 1 - leftRows)
      for row = 0, rows - 1 do
        local y = math.floor(row * area.h / rows)
        local bottom = math.floor((row + 1) * area.h / rows)
        tree_render(st, tree_find(st.tree, others[index]).leaf,
          { x = right, y = area.y + y, w = w, h = bottom - y }, live, geom, area)
        index = index + 1
      end
    end
    local bottom = area.y + area.h
    while index <= #others do
      local h = minimum.h - (index == (cols - 1) * maxRows + 1 and minimum.bottom - edge.bottom or 0)
      bottom = bottom - h
      tree_render(st, tree_find(st.tree, others[index]).leaf,
        { x = area.x, y = bottom, w = right - area.x, h = h }, live, geom, area)
      index = index + 1
    end
    tree_render(st, tree_find(st.tree, focused).leaf,
      { x = area.x, y = area.y, w = right - area.x, h = bottom - area.y }, live, geom, area)
    return
  end
  local cols = math.min(maxCols, math.max(math.ceil(#leaves / maxRows), math.ceil(math.sqrt(#leaves * area.w / area.h))))
  local rows = math.ceil(#leaves / cols)
  for i, a in ipairs(leaves) do
    local col, row = (i - 1) % cols, math.floor((i - 1) / cols)
    local x, y = math.floor(col * area.w / cols), math.floor(row * area.h / rows)
    local right, bottom = math.floor((col + 1) * area.w / cols), math.floor((row + 1) * area.h / rows)
    tree_render(st, tree_find(st.tree, a).leaf,
      { x = area.x + x, y = area.y + y, w = right - x, h = bottom - y }, live, geom, area)
  end
end

local function tree_swap_neighbor(st, addr, dir)
  local f = st.tree and tree_find(st.tree, addr)
  if not f then return end
  local mine = f.leaf.box or st.rects[addr]
  if not mine then return end
  local cx, cy = mine.x + mine.w / 2, mine.y + mine.h / 2
  local pick, pickA = math.huge, nil
  for _, a in ipairs(tree_leaves(st.tree)) do
    if a ~= addr then
      local r = st.rects[a]
      if r then
        local rx, ry = r.x + r.w / 2, r.y + r.h / 2
        local ok = (dir == "l" and rx < cx) or (dir == "r" and rx > cx)
          or (dir == "u" and ry < cy) or (dir == "d" and ry > cy)
        if ok then
          -- distance along the move axis dominates; cross-axis distance is
          -- a tiebreaker so stacked neighbors pick the closest overlap.
          local d = (dir == "l" or dir == "r")
            and math.abs(rx - cx) + math.abs(ry - cy) * 4
            or math.abs(ry - cy) + math.abs(rx - cx) * 4
          if d < pick then pick, pickA = d, a end
        end
      end
    end
  end
  if not pickA then return end
  local other = tree_find(st.tree, pickA)
  if other then f.leaf.leaf, other.leaf.leaf = other.leaf.leaf, f.leaf.leaf end
end

-- ---------- pointer drag engine ----------
-- resize_on_border has no bind to rebind and input.mouse events are not
-- marshaled to lua, but the compositor still calls the algorithm's
-- resizeTarget on every drag move — and resizeTarget triggers
-- recalculate. So the interception point is recalculate itself: while a
-- mouse button is held with the cursor near a leaf edge, an interactive
-- border resize is in progress; grab the split baseline on the first
-- sighting and apply cursor deltas on every recalc after.
local EDGE_ZONE = 8

local function tree_leaf_at(st, x, y)
  for a, r in pairs(st.rects or {}) do
    if r.w and r.w > 0 and x >= r.x and x < r.x + r.w and y >= r.y and y < r.y + r.h then
      return a, r
    end
  end
end

local function drag_log(line)
  local f = io.open("/tmp/focus-now-drag.log", "a")
  if f then f:write(os.date("%H:%M:%S") .. ". " .. line .. "\n") f:close() end
end

-- Re-insert `da` as a split on the side of the compartment under (x,y)
-- — dwindle's drag-drop semantics. Shared by the dropat verb and the
-- movedTarget drop detection in the pointer engine.
local function tree_drop_at(st, da, x, y)
  local target, side = nil, nil
  for a2, r in pairs(st.rects) do
    if a2 ~= da and r.w and r.w > 0 and x >= r.x and x < r.x + r.w
       and y >= r.y and y < r.y + r.h then
      target = a2
      if r.w >= r.h then
        side = ((x - r.x) / r.w) < 0.5 and "l" or "r"
      else
        side = ((y - r.y) / r.h) < 0.5 and "u" or "d"
      end
    end
  end
  if not target then return false end
  if tree_find(st.tree, da) then tree_remove(st, da) end
  tree_insert(st, da, target, side)
  st.sizes = st.sizes or {}
  st.sizes[da] = nil
  st.geom = st.geom or {}
  st.geom[da] = nil
  return true
end

-- is_key_down sees keyboard keys but not mouse buttons — SUPER is the
-- only held modifier we can observe, and it's the modifier the resize
-- bind uses.
local function tree_super_held()
  local ok1, a = pcall(hl.is_key_down, 125)
  local ok2, b = pcall(hl.is_key_down, 126)
  return (ok1 and a == true) or (ok2 and b == true)
end

-- Called at the top of the tree's recalculate, before render.
--
-- Move-drag: the stock "Move window" bind runs the real compositor drag;
-- on release the compositor calls movedTarget, which for a lua layout
-- re-appends the target — ctx.targets then lists the address twice. That
-- duplicate is the drop signal: re-insert the window at the cursor.
--
-- Resize (SUPER+drag and resize_on_border): every interactive resize
-- move calls resizeTarget, which only recalculates for a lua layout —
-- so a resize drag shows up here as a burst of recalcs while the cursor
-- moves. On the first burst frame the leaf under the cursor (edge-near)
-- or the active window's leaf is grabbed; each later frame applies the
-- cursor delta against the grabbed baseline. The session expires after
-- ~0.5s of recalc silence.
local function tree_pointer_engine(st, ctx)
  local now = os.clock()

  -- Drop detection via movedTarget duplicates.
  st.seen = st.seen or {}
  local counts = {}
  for _, t in ipairs(ctx.targets) do
    local w = t.window
    local a = w and w.address
    if a then counts[a] = (counts[a] or 0) + 1 end
  end
  for a, n in pairs(counts) do
    if (st.seen[a] or 0) > 0 and n > st.seen[a] then
      local p = hl.get_cursor_pos and hl.get_cursor_pos() or nil
      drag_log("drop " .. a .. " cur=" .. tostring(p and math.floor(p.x)) .. "," .. tostring(p and math.floor(p.y)))
      if p and tree_drop_at(st, a, p.x, p.y) then save_state() end
    end
    if n > (st.seen[a] or 0) then st.seen[a] = n end
  end

  -- Resize burst detection.
  local p = hl.get_cursor_pos and hl.get_cursor_pos() or nil
  st.rz = st.rz or { t = 0, count = 0 }
  if not p then return end
  if st.rz.active then
    -- Only drag-cadence frames (resizeTarget per mouse-move, ~16ms)
    -- apply deltas and keep the session alive; sparse recalcs let the
    -- 0.5s clock run out so a released drag can't keep following.
    if st.rz.super and not tree_super_held() then
      drag_log("resize end (super released)")
      st.rz = { t = now, count = 0 }
    elseif now - (st.rz.prev or 0) < 0.1 then
      drag_log("resize end (super released)")
      st.rz = { t = now, count = 0 }
    elseif now - (st.rz.prev or 0) < 0.1 then
      tree_drag_apply(st.rz.base or {}, p.x - st.rz.x0, p.y - st.rz.y0)
      st.rz.prev = now
      st.rz.t = now
    elseif now - st.rz.t > 0.5 then
      drag_log("resize end")
      st.rz = { t = now, count = 0 }
    end
    return
  end
  if now - st.rz.t > 0.15 then
    st.rz.count = 0
    st.rz.x0, st.rz.y0 = p.x, p.y
    st.rz.a = nil
  end
  st.rz.count = st.rz.count + 1
  st.rz.t = now
  if st.rz.count < 2 then return end
  local moved = math.abs(p.x - st.rz.x0) + math.abs(p.y - st.rz.y0) >= 4
  if not moved then return end
  -- Two resize intents reach here through resizeTarget bursts:
  --   border edge-drag: cursor sits within EDGE_ZONE of a leaf edge
  --   SUPER+mouse:273:  SUPER held, target is the active window
  -- Anything else is an unrelated recalc burst and must not arm.
  local superHeld = tree_super_held()
  local a, r = st.rz.a, nil
  if not a then
    a, r = tree_leaf_at(st, st.rz.x0, st.rz.y0)
    local aw = hl.get_active_window()
    local active = aw and aw.address
    if a and r then
      local nearEdge = (st.rz.x0 - r.x < EDGE_ZONE) or (r.x + r.w - st.rz.x0 < EDGE_ZONE)
        or (st.rz.y0 - r.y < EDGE_ZONE) or (r.y + r.h - st.rz.y0 < EDGE_ZONE)
      if not nearEdge then
        if superHeld and active and tree_find(st.tree, active) then
          a = active
          st.rz.super = true
        else
          return
        end
      end
    elseif superHeld and active and tree_find(st.tree, active) then
      a = active
      st.rz.super = true
    else
      return
    end
    st.rz.a = a
  end
  local it = tree_find(st.tree, a)
  if not it then return end
  tree_grab(st, it.chain, a)
  -- A resize is a structural op: drop the expansion overlay so the ratio
  -- deltas are visible while dragging. The apply engine re-emits sizes
  -- on the next focus/hover pass.
  st.sizes = {}
  st.geom = {}
  st.rz.active = true
  st.rz.base = st.dragbase
  st.rz.prev = now
  st.rz.t = now
  drag_log("resize arm " .. a)
end

hl.layout.register("tree", {
  recalculate = function(ctx)
    if #ctx.targets == 0 then return end
    local key = ws_key(ctx)
    local st = key and ws_state(key)
      or { cols = {}, colW = {}, h = {}, missing = {}, geom = {}, rects = {} }
    reset_on_layout_change(st, "tree")
    st.rects = st.rects or {}
    st.pseudo = st.pseudo or {}
    if key then ws_opts(key) end
    local live = live_addrs(ctx)
    tree_reconcile(ctx, st, live)
    -- Pointer interception: movedTarget duplicates = drag drops; recalc
    -- bursts + cursor motion = interactive resizes (SUPER+drag and
    -- resize_on_border both reach here through resizeTarget).
    tree_pointer_engine(st, ctx)
    if st.tree then
      local muted_anim = false
      if not opts_animate then
        muted_anim = pcall(hl.config, { animations = { enabled = false } })
      end
      apply_anim_speed_leaf()
      -- A "sizes" plan renders as an overlay: demands are solved and every
      -- leaf lands at its solved box, but node ratios are never mutated —
      -- the resting tree stays balanced and expansion rides on top.
      if opts_enabled and opts_expand then
        local leafCount = #tree_leaves(st.tree)
        local req = tree_req(st, st.tree, st.sizes or {}, leafCount, ctx.area, nil, tree_focused(st, live))
        if req.minW > ctx.area.w or req.minH > ctx.area.h then
          tree_grid_render(st, live, st.geom or {}, ctx.area, tree_focused(st, live))
        else
          tree_solve_render(st, st.tree, req, ctx.area, live, st.geom or {}, ctx.area)
        end
      else
        local minimum = tree_minimum(st.tree, ctx.area)
        if minimum.w > ctx.area.w or minimum.h > ctx.area.h then
          tree_grid_render(st, live, st.geom or {}, ctx.area)
        else
          tree_render(st, st.tree, ctx.area, live, st.geom or {}, ctx.area, minimum)
        end
      end
      if muted_anim then pcall(hl.config, { animations = { enabled = true } }) end
    end
  end,

  layout_msg = function(ctx, msg)
    local key = ws_key(ctx)
    -- A layoutmsg with no tiled targets (all windows floated mid-arrange) has
    -- nothing to apply to — accept it silently. Returning false surfaces a
    -- "rejected layoutmsg" error that aborts the caller (o.workspace_mode
    -- dies halfway through floating a workspace).
    if not key then return true end
    local st = ws_state(key)
    reset_on_layout_change(st, "tree")
    st.rects = st.rects or {}
    st.pseudo = st.pseudo or {}
    local live = live_addrs(ctx)
    tree_reconcile(ctx, st, live)

    local verb, rest = msg:match("^(%S+)%s*(.*)$")

    -- "noop": dispatchers wrapped for parity need a harmless landing spot
    -- (e.g. interactive window.drag) — must not touch overlay state.
    if verb == "noop" then return true end

    if verb == "sizes" then
      -- Per-window client sizes from apply.js: "sizes a:w,h b:w,h ...".
      -- The tree solves node ratios from the demands — exact shares, no
      -- clamps. Freeze while the pointer sits off every window.
      if hover_released then return true end
      st.sizes = {}
      for a, w, h in rest:gmatch("(0x%x+):(%-?%d+),(%-?%d+)") do
        -- Never accept a sub-collapse demand: a 0/1px request renders a
        -- window unreachable and feeds back into the next apply.
        st.sizes[a] = { w = math.max(collapse_floor(), tonumber(w) or 0), h = math.max(collapse_floor(), tonumber(h) or 0) }
      end
      st.geom = {}
    elseif verb == "geom" then
      -- Exact client rects from apply.js, same contract as the flat
      -- layouts: they override tree placement and a structural verb clears
      -- them. Freeze while the pointer sits off every window.
      if hover_released then return true end
      st.geom = {}
      st.sizes = {}
      for a, x, y, w, h in rest:gmatch("(0x%x+):(%-?%d+),(%-?%d+),(%-?%d+),(%-?%d+)") do
        st.geom[a] = { x = tonumber(x), y = tonumber(y), w = tonumber(w), h = tonumber(h) }
      end
    elseif verb == "dump" then
      local f = io.open("/tmp/focus-now-dump.txt", "w")
      if f then
        f:write("ws=" .. tostring(key) .. "\ntree=" .. tree_ser(st.tree) .. "\n")
        for _, t in ipairs(ctx.targets) do
          local w = t.window
          f:write("target " .. tostring(w and w.address) .. " wref=" .. tostring(w ~= nil) .. "\n")
        end
        for a, r in pairs(st.rects or {}) do
          f:write("rect " .. a .. " " .. tostring(r.x) .. "," .. tostring(r.y)
            .. " " .. tostring(r.w) .. "x" .. tostring(r.h) .. "\n")
        end
        f:close()
      end
    else
      st.geom = {}
      if verb == "resize" or verb == "resizepixel" or verb == "grabsplit" or verb == "dragresize" then
        st.sizes = {}
      end

      if verb == "dropat" then
        -- Mouse drag drop: "dropat addr x y". Re-insert addr on the side
        -- of the leaf compartment under the cursor — dwindle's drop split.
        -- Self-addressed like sizes/geom: the dragged window need not be
        -- the focused one.
        local da, x, y = rest:match("(0x%x+)%s+(%-?%d+)%s+(%-?%d+)")
        x, y = tonumber(x), tonumber(y)
        if da and x then tree_drop_at(st, da, x, y) end
        save_state()
        return true
      end

      local aw = hl.get_active_window()
      local a = aw and aw.address
      local inTree = a and tree_find(st.tree, a)
      -- Silent no-ops keep compositor error notifications away for verbs
      -- that cannot apply (unfocused ghosts, floating focus).
      if not inTree then
        if verb == "preselect" then
          local d = rest:match("(%a+)")
          if d == "h" or d == "v" then st.preselect = d end
        end
        save_state()
        return true
      end

      -- Verbs that carry their own window address (mouse binds drag on the
      -- pressed window, which is not necessarily the focused one).
      local ra = rest:match("(0x%x+)")
      local ta = ra or a
      local tInTree = ra and tree_find(st.tree, ta) or inTree

      if verb == "grabsplit" and tInTree then
        -- Mouse-resize start: snapshot the nearest ancestor split on each
        -- axis so dragresize applies absolute deltas from drag origin.
        tree_grab(st, tInTree.chain, ta)
      elseif verb == "dragresize" and tInTree then
        local dx, dy = rest:match("0x%x+%s+(%-?%d+)%s+(%-?%d+)")
        if not dx then dx, dy = rest:match("(%-?%d+)%s+(%-?%d+)") end
        tree_drag_apply(st.dragbase or {}, tonumber(dx) or 0, tonumber(dy) or 0)
      elseif verb == "pseudo" and tInTree then
        -- Pseudo box: the leaf renders at a fixed client size centered in
        -- its compartment, like dwindle's pseudo tile.
        if st.pseudo[ta] then
          st.pseudo[ta] = nil
        else
          local r = st.rects[ta] or {}
          st.pseudo[ta] = { w = math.max(collapse_floor(), math.floor((r.w or 0) * 0.6)), h = math.max(collapse_floor(), math.floor((r.h or 0) * 0.6)) }
        end
      elseif verb == "togglesplit" or verb == "togglestack" then
        -- Flip the focused leaf's parent split; alias togglestack so the
        -- stock SUPER+J key behaves like dwindle's togglesplit.
        local p = inTree.chain[#inTree.chain]
        if p then p.dir = (p.dir == "auto" or p.dir == "h") and "v" or "h" end
      elseif verb == "move" or verb == "swap" then
        local dir = rest:match("(%a+)")
        if dir == "l" or dir == "r" or dir == "u" or dir == "d" then
          tree_swap_neighbor(st, a, dir)
        end
      elseif verb == "movetoroot" then
        -- Promote: the leaf becomes a direct child of a fresh root split.
        tree_remove(st, a)
        local dir = st.tree and st.tree.box and (st.tree.box.w >= st.tree.box.h and "h" or "v") or "h"
        st.tree = tnode(dir, st.tree, tleaf(a), 0.5)
      elseif verb == "resize" then
        local dir, px = rest:match("(%a+)%s*(%-?%d*)")
        -- Grow focused by px on the chosen axis; px<0 gives it back.
        tree_axis_grow(inTree, a,
          (dir == "l" or dir == "r") and "h" or "v", tonumber(px) or 0)
      elseif verb == "resizepixel" then
        -- resizewindowpixel semantics: negative x widens (extends left),
        -- positive y tallens (extends down). Optional leading address.
        local dx, dy = rest:match("(%-?%d+)%s+(%-?%d+)%s*$")
        if tInTree then
          tree_axis_grow(tInTree, ta, "h", -(tonumber(dx) or 0))
          tree_axis_grow(tInTree, ta, "v", tonumber(dy) or 0)
        end
      elseif verb == "preselect" then
        local d = rest:match("(%a+)")
        if d == "h" or d == "v" then st.preselect = d end
      else
        -- stack/unstack/preselect etc. have no tree analog (or are already
        -- handled): accept silently like the flat layouts do.
      end
    end

    save_state()
    return true
  end,
})

-- A config reload re-applies file-defined animations and drops the runtime
-- windowsMove leaf — let the next recalculate re-write it.
local register_management_binds
hl.on("config.reloaded", function()
  anim_speed_written = 0
  -- hyprctl reload drops every lua bind, and this module stays in
  -- package.loaded so its top level never re-runs. Re-register the
  -- window-management binds after the stock ones land.
  hl.timer(function()
    if register_management_binds then register_management_binds() end
  end, { timeout = 100, type = "oneshot" })
end)

-- ---------- standard key translation ----------
-- Only while the plugin is enabled.
-- The compositor's window.swap and window.resize dispatches never reach a lua
-- layout's layout_msg, so stock Omarchy bindings do nothing (or only half the
-- job, for member swaps) on flat workspaces. Rebind the window-management keys
-- so they emit layoutmsg verbs on lua:columns/lua:rows and behave exactly as
-- before everywhere else. This block runs on every config load, so the binds
-- survive hyprctl reload.

local function flat_layout_active()
  local ok, ws = pcall(hl.get_active_workspace)
  local layout = ok and ws and ws.tiled_layout or ""
  return layout == "lua:columns" or layout == "lua:rows" or layout == "lua:tree"
end

-- Defined before register_management_binds so its closures see it.
local function tree_layout_active()
  local ok, ws = pcall(hl.get_active_workspace)
  return ok and ws and ws.tiled_layout == "lua:tree"
end

-- Swap keys are rebound (not added): compositor swap already reorders stack
-- members on flat layouts, so leaving the stock bind would double-move.
register_management_binds = function()
  for _, cycle in ipairs({ { key = "SUPER + L", back = false }, { key = "SUPER + ALT + L", back = true } }) do
    local back = cycle.back
    -- pcall like every other bind below: an unbind failure (key unbound on
    -- a fresh state) must not abort the whole management-bind block.
    pcall(hl.unbind, cycle.key)
    pcall(hl.bind, cycle.key, function()
      if not opts_enabled then
        hl.exec_cmd("omarchy-hyprland-workspace-layout-toggle" .. (back and " back" or ""))
        return
      end
      local ws = hl.get_active_workspace()
      if not ws or not ws.id or ws.id < 1 then return end
      local script = 'current=$(omarchy-hyprland-workspace-layout-current ' .. tostring(ws.id) .. '); '
        .. 'case "$current" in lua:*) current=dwindle;; esac; '
        .. (back
          and 'case "$current" in dwindle) next=floating;; floating) next=scrolling;; *) next=dwindle;; esac; '
          or 'case "$current" in dwindle) next=scrolling;; scrolling) next=floating;; *) next=dwindle;; esac; ')
        .. 'qs -p /usr/share/omarchy/shell ipc call focus-now workspaceBase ' .. tostring(ws.id) .. ' "$next"'
      hl.exec_cmd(script)
    end, { description = back and "Cycle workspace layout back" or "Cycle workspace layout" })
  end
  for _, dir in ipairs(opts_enabled and { "l", "r", "u", "d" } or {}) do
    local keys = "SUPER + SHIFT + " .. ({ l = "LEFT", r = "RIGHT", u = "UP", d = "DOWN" })[dir]
    pcall(hl.unbind, keys)
    pcall(hl.bind, keys, function()
      pcall(function()
        if flat_layout_active() then
          hl.dispatch(hl.dsp.layout("move " .. dir))
        else
          hl.dispatch(hl.dsp.window.swap({ direction = dir }))
          -- window.swap emits no socket2 event, so the expansion service never
          -- learns the tree changed. Re-focusing the (still focused) window
          -- emits activewindowv2 and triggers the re-apply.
          local active = hl.get_active_window()
          if active and active.address then
            hl.dispatch(hl.dsp.focus({ window = "address:" .. active.address }))
          end
        end
      end)
    end, { description = "Swap window " .. dir })
  end

  -- Resize keys are added alongside the stock binds: window.resize is a no-op
  -- on flat layouts, so nothing doubles, and any user customization keeps its
  -- own key. On flat layouts the "l"/"u" verb directions map onto the x/y axes
  -- under both providers.
  local function flat_resize(px, axis)
    -- Unbind first: hl.bind stacks handlers, so a config.reloaded
    -- re-register would otherwise fire the resize once per past reload.
    pcall(hl.unbind, "SUPER + " .. px.mod .. "code:" .. px.code)
    pcall(hl.bind, "SUPER + " .. px.mod .. "code:" .. px.code, function()
      pcall(function()
        if flat_layout_active() then
          hl.dispatch(hl.dsp.layout("resize " .. axis .. " " .. tostring(px.delta)))
        end
      end)
    end, { description = px.desc })
  end

  for _, tier in ipairs(opts_enabled and { { mod = "", mag = 100 }, { mod = "ALT + ", mag = 25 }, { mod = "CTRL + ", mag = 300 } } or {}) do
    local m = tier.mag
    flat_resize({ mod = tier.mod, code = 20, delta = m,  desc = "Expand window left" }, "l")
    flat_resize({ mod = tier.mod, code = 21, delta = -m, desc = "Shrink window left" }, "l")
    flat_resize({ mod = "SHIFT + " .. tier.mod, code = 20, delta = -m, desc = "Shrink window up" }, "u")
    flat_resize({ mod = "SHIFT + " .. tier.mod, code = 21, delta = m,  desc = "Expand window down" }, "u")
  end

  -- SUPER+J parity: the stock rebind dispatches togglesplit only for
  -- dwindle and the flat lua layouts, silently returning on lua:tree. The
  -- tree has real splits, so own the bind here (this module loads after
  -- bindings.lua and re-registers on reload) with the same guards as the
  -- stock rebind for every other layout.
  pcall(hl.unbind, "SUPER + J")
  pcall(hl.bind, "SUPER + J", function()
    pcall(function()
      local window = hl.get_active_window()
      if not window then return end
      if (window.fullscreen or 0) ~= 0 then return end
      local workspace = window.workspace
      if not workspace then return end
      local layout = workspace.tiled_layout
      if layout == "lua:columns" or layout == "lua:rows" or layout == "lua:tree" then
        -- Flat layouts alias togglesplit to togglestack; lua:tree has a
        -- real split and flips the focused leaf's parent.
        hl.dispatch(hl.dsp.layout("togglesplit"))
        return
      end
      if layout ~= "dwindle" then return end
      local siblings = 0
      for _, candidate in ipairs(hl.get_workspace_windows(tostring(workspace.id)) or {}) do
        if not candidate.floating and (candidate.fullscreen or 0) == 0 then
          siblings = siblings + 1
        end
      end
      if siblings < 2 then return end
      hl.dispatch(hl.dsp.layout("togglesplit"))
    end)
  end, { description = "Toggle window split" })

  -- SUPER+mouse:272/273 need no custom binds: the stock "Move window" /
  -- "Resize window" handlers dispatch window.drag()/window.resize()
  -- through lua, where the dsp wrapper passes the no-arg interactive
  -- forms straight to the compositor. The tree's pointer engine (inside
  -- recalculate) then sees the interaction: movedTarget re-appends the
  -- dragged target — the drop signal — and every resizeTarget produces a
  -- recalc burst that applies cursor deltas to the grabbed ancestor
  -- splits. resize_on_border edge-drags travel the same resizeTarget
  -- path, so they are covered by the identical mechanism.

end

-- ---------- dispatch wrapper: parity for every caller ----------
-- The compositor's window.swap / window.move / window.resize /
-- window.pseudo dispatchers never reach a lua layout (they hit internal
-- C++ algorithm methods that only reorder the target list). Wrap the dsp
-- factories so that while the active workspace runs lua:tree they return
-- the equivalent layoutmsg dispatcher instead — transparent to every
-- caller: stock binds, user rebinds, scripts, other lua modules. On any
-- other layout the original dispatcher is produced unchanged.
local function tree_layout_active()
  local ok, ws = pcall(hl.get_active_workspace)
  return ok and ws and ws.tiled_layout == "lua:tree"
end

local function wrap_window_dsp(name, to_msg)
  local orig = hl.dsp.window[name]
  if not orig or hl.dsp.window["__tree_wrapped_" .. name] then return end
  hl.dsp.window["__tree_wrapped_" .. name] = orig
  hl.dsp.window[name] = function(args)
    -- A floating target (omarchy's floating-mode arrange resizes every
    -- window it just floated) keeps the real dispatcher — tree verbs on a
    -- floating window would act on whatever leaf the active window is.
    local w = args and args.window
    if tree_layout_active() and not (w and w.floating) then
      local msg = to_msg(args)
      if msg then return hl.dsp.layout(msg) end
    end
    return orig(args)
  end
end

-- swapwindow/movewindow <dir> = move to the geometric neighbor's slot.
wrap_window_dsp("swap", function(args)
  local d = args and args.direction
  if d == "l" or d == "r" or d == "u" or d == "d" then return "move " .. d end
end)
wrap_window_dsp("move", function(args)
  -- Only the directional form maps to the tree; workspace/group moves
  -- must keep the real dispatcher.
  if args and args.workspace == nil and args.direction then
    local d = tostring(args.direction)
    if d == "l" or d == "r" or d == "u" or d == "d" then return "move " .. d end
  end
end)

-- resizewindowpixel {x, y} = grow/shrink by pixel delta on each axis.
-- The no-arg interactive form (SUPER+mouse:273 "Resize window") passes
-- through untouched: the compositor runs the real resize session and the
-- pointer engine inside recalculate applies each resizeTarget's cursor
-- delta to the grabbed ancestor splits.
wrap_window_dsp("resize", function(args)
  if args and (args.x or args.y) then
    return "resizepixel " .. tostring(args.x or 0) .. " " .. tostring(args.y or 0)
  end
end)

-- pseudo = the tree's fixed-size centered box.
wrap_window_dsp("pseudo", function() return "pseudo" end)
register_management_binds()

-- Minimize watchdog: windows must not land on special:minimized on their
-- own. The only valid path is omarchy-hyprland-window-minimize (SUPER + M /
-- the hyprbars button), which tags the window with omarchy-minimized-from-N
-- before moving it. Any other move there — a client's own xdg minimize
-- request, a stray dispatch — gets bounced back to the workspace it left.
local fn_last_ws = {}
hl.on("window.open", function(window)
  if window and window.address then
    local ws = window.workspace
    fn_last_ws[window.address] = ws and ws.name or nil
  end
end)
hl.on("window.move_to_workspace", function(window, workspace)
  if not window or not window.address then return end
  local previous = fn_last_ws[window.address]
  fn_last_ws[window.address] = workspace and workspace.name or
    (window.workspace and window.workspace.name)
  if not (workspace and workspace.name == "special:minimized") then return end
  local tagged = false
  for _, tag in ipairs(window.tags or {}) do
    if tostring(tag):match("^omarchy%-minimized%-from%-%d+$") then
      tagged = true
      break
    end
  end
  if tagged then return end
  hl.timer(function()
    local back = previous
    if not back or back == "" or back == "special:minimized" then
      local active = hl.get_active_workspace()
      back = active and tostring(active.id) or "1"
    end
    hl.dispatch(hl.dsp.window.move({
      workspace = back,
      window = "address:" .. tostring(window.address),
      follow = false,
    }))
  end, { timeout = 1, type = "oneshot" })
end)
