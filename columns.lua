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
--   "columns": { "2": {"enabled":true,"open":"vertical","mode":"rows"},
--                "special:x": {...} }
-- "mode" picks the provider: "columns" (default) or "rows".
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
  if not S[name] then S[name] = { cols = {}, colW = {}, h = {}, missing = {}, rw = {}, rh = {}, geom = {} } end
  return S[name]
end

local function col_anchor(col) return col[1] end

local function col_w(st, i) return st.colW[col_anchor(st.cols[i])] or 0 end
local function set_col_w(st, i, v) st.colW[col_anchor(st.cols[i])] = v end

-- ---------- persistence ----------

local function save_state()
  local f = io.open(STATE_PATH, "w")
  if not f then return end
  for ws, st in pairs(S) do
    f:write("ws\t" .. ws .. "\n")
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

-- The last `hl.animation({ ... leaf = "name" ... })` literal in the config
-- sources — Omarchy defaults first, user files last so their definitions
-- win. Runtime leaf overrides can't be undefined, so reverting re-emits the
-- declared definition.
local function anim_leaf_source(leaf)
  local pattern = "hl%.animation%(%s*{[^}]*leaf%s*=%s*\"" .. leaf .. "\"[^}]*}"
  local found = nil
  local function scan(path)
    local f = io.open(path, "r")
    if not f then return end
    local text = f:read("a") or ""
    f:close()
    for m in text:gmatch(pattern) do found = m end
  end
  local hypr_dir = os.getenv("HOME") .. "/.config/hypr"
  local listing = io.popen and io.popen(
    "ls -1 /usr/share/omarchy/default/hypr/*.lua " ..
    "/usr/share/omarchy/default/hypr/*/*.lua " .. hypr_dir .. "/*.lua 2>/dev/null")
  if listing then
    for path in listing:lines() do scan(path) end
    listing:close()
  else
    scan("/usr/share/omarchy/default/hypr/looknfeel.lua")
    scan(hypr_dir .. "/looknfeel.lua")
    scan(hypr_dir .. "/hyprland.lua")
  end
  return found
end

local function revert_windows_move()
  local src = anim_leaf_source("windowsMove")
  if not src then
    local parent = anim_leaf_source("windows")
    if parent then
      src = (parent:gsub('leaf%s*=%s*"windows"', 'leaf = "windowsMove"', 1))
    end
  end
  local chunk = src and load(src)
  if chunk then pcall(chunk) end
end

local function column_opts()
  local f = io.open(CONFIG_PATH, "r")
  if not f then return {} end
  local text = f:read("a")
  f:close()
  opts_enabled = text:match('"enabled"%s*:%s*false') == nil
  opts_collapse = tonumber(text:match('"collapseSize"%s*:%s*(%d+)')) or 32
  opts_animate = text:match('"animate"%s*:%s*false') == nil
  opts_anim_speed = tonumber(text:match('"animateSpeed"%s*:%s*(%d+)')) or 0
  local block = text:match('"columns"%s*:%s*(%b{})')
  local out = {}
  if block then
    for name, entry in block:gmatch('"([^"]+)"%s*:%s*(%b{})') do
      out[name] = {
        enabled = entry:match('"enabled"%s*:%s*true') ~= nil,
        open = entry:match('"open"%s*:%s*"vertical"') and "vertical" or "horizontal",
        mode = entry:match('"mode"%s*:%s*"rows"') and "rows" or "columns",
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
  return { enabled = false, open = "horizontal", mode = "columns" }
end

config_cache = column_opts()

-- Columns are the default tiled layout; per-workspace rules can still pin
-- specific workspaces (and the panel's off-toggle writes a dwindle rule, its
-- mode toggle a lua:rows rule). When the plugin is disabled the providers
-- stay registered but dormant: nothing claims general.layout or any
-- workspace, so the compositor falls back to the user's layouts.
if opts_enabled then
  hl.config({ general = { layout = "lua:columns" } })

  -- Emit workspace rules for every enabled workspace.
  for name, o in pairs(config_cache) do
    if o.enabled then
      hl.workspace_rule({ workspace = name, layout = "lua:" .. (o.mode or "columns") })
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
      local opts = key and ws_opts(key) or { enabled = true, open = "horizontal", mode = "columns" }
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
      if opts_animate and opts_anim_speed > 0 then
        if anim_speed_written ~= opts_anim_speed then
          if pcall(hl.animation, { leaf = "windowsMove", enabled = true,
                                   speed = opts_anim_speed / 100, bezier = "easeOutQuint" }) then
            anim_speed_written = opts_anim_speed
            write_anim_speed_state(opts_anim_speed)
          end
        end
      elseif anim_speed_state() > 0 then
        revert_windows_move()
        write_anim_speed_state(0)
        anim_speed_written = 0
      end

      local x, y = area.x, area.y
      for i, vcol in ipairs(cols) do
        local cw = widths[i]
        st.rw[col_anchor(st.cols[vcol.idx])] = cw
        local before = i == 1 and EDGE or SEAM
        local after = i == n and EDGE or SEAM
        local bw = math.max(1, cw + before + after)

        -- stack member inner sizes. Inside the focused slot the contract
        -- applies on the inner axis too: the focused member takes the rest
        -- and the others sit at collapseSize. Other slots flex or keep
        -- explicit sizes as before.
        local m = #vcol.members
        local vInner = 2 * SEAM * (m - 1)
        local vAvail = (horizontal and area.h or area.w) - 2 * EDGE - vInner
        local heights = {}
        if vcol.idx == fci then
          local bj, bfid = 0, math.huge
          for j, a in ipairs(vcol.members) do
            local w = live[a] and live[a].window
            local fid = w and w.focus_history_id or math.huge
            if fid < bfid then bfid, bj = fid, j end
          end
          local vAssigned = 0
          for j, a in ipairs(vcol.members) do
            if j ~= bj then
              local h = st.h[a]
              heights[j] = is_flex(h) and opts_collapse or h
              vAssigned = vAssigned + heights[j]
            end
          end
          -- Over-claimed explicit member sizes must not crush the focused
          -- member's leftover below the floor — scale them to fit.
          if vAssigned > vAvail - 1 and vAssigned > 0 then
            local scale = (vAvail - 1) / vAssigned
            vAssigned = 0
            for j = 1, m do
              if j ~= (bj > 0 and bj or m) then
                heights[j] = math.max(1, heights[j] * scale)
                vAssigned = vAssigned + heights[j]
              end
            end
          end
          heights[bj > 0 and bj or m] = math.max(1, vAvail - vAssigned)
        else
          local vAssigned, vFlex = 0, 0
          for _, a in ipairs(vcol.members) do
            local h = st.h[a]
            if is_flex(h) then vFlex = vFlex + 1 else vAssigned = vAssigned + h end
          end
          -- Stale or over-claimed explicit sizes must not overflow the slot:
          -- scale them down so every member keeps at least the floor.
          if vAssigned + vFlex > vAvail and vAssigned > 0 then
            local scale = math.max(0, vAvail - vFlex) / vAssigned
            vAssigned = 0
            for _, a in ipairs(vcol.members) do
              if not is_flex(st.h[a]) then
                st.h[a] = math.max(1, st.h[a] * scale)
                vAssigned = vAssigned + st.h[a]
              end
            end
          end
          local vShare = vFlex > 0 and math.max(1, (vAvail - vAssigned) / vFlex) or 0
          for j, a in ipairs(vcol.members) do
            heights[j] = is_flex(st.h[a]) and vShare or st.h[a]
          end
          if vFlex == 0 then
            local bj, bfid = 1, math.huge
            for j, a in ipairs(vcol.members) do
              local w = live[a] and live[a].window
              local fid = w and w.focus_history_id or math.huge
              if fid < bfid then bfid, bj = fid, j end
            end
            heights[bj] = math.max(1, heights[bj] + vAvail - vAssigned)
          end
        end

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
      local live = live_addrs(ctx)
      reconcile(ctx, st, ws_opts(key), ws_opts(key).open == stackOpenValue)
      local cols = visible_cols(st, live)

      local verb, rest = msg:match("^(%S+)%s*(.*)$")

      if verb == "geom" then
        -- "geom a:x,y,w,h b:x,y,w,h ...": exact client rects for every listed
        -- window, overriding slot placement. Lets a mixed arrangement of
        -- columns and rows collapse on each window's own axis.
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

-- A config reload re-applies file-defined animations and drops the runtime
-- windowsMove leaf — let the next recalculate re-write it.
hl.on("config.reloaded", function()
  anim_speed_written = 0
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
  return layout == "lua:columns" or layout == "lua:rows"
end

-- Swap keys are rebound (not added): compositor swap already reorders stack
-- members on flat layouts, so leaving the stock bind would double-move.
for _, dir in ipairs(opts_enabled and { "l", "r", "u", "d" } or {}) do
  local keys = "SUPER + SHIFT + " .. ({ l = "LEFT", r = "RIGHT", u = "UP", d = "DOWN" })[dir]
  pcall(hl.unbind, keys)
  pcall(hl.bind, keys, function()
    pcall(function()
      if flat_layout_active() then
        hl.dispatch(hl.dsp.layout("move " .. dir))
      else
        hl.dispatch(hl.dsp.window.swap({ direction = dir }))
      end
    end)
  end, { description = "Swap window " .. dir })
end

-- Resize keys are added alongside the stock binds: window.resize is a no-op
-- on flat layouts, so nothing doubles, and any user customization keeps its
-- own key. On flat layouts the "l"/"u" verb directions map onto the x/y axes
-- under both providers.
local function flat_resize(px, axis)
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
