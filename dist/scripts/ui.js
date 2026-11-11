/**
 * UI automation through System Events (JXA). One program, one JSON argument:
 * {cmd, target: {bundleId?, path?, name?}, ...}. Prints JSON.
 * Works for any app, including features that have no scripting dictionary.
 */
export const UI_JXA = String.raw `
function run(argv) {
  var req = JSON.parse(argv[0]);
  var se = Application('System Events');

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/…|\.\.\.$/g, '').replace(/\s+/g, ' ').trim();
  }
  function pick(names, want, what) {
    var w = norm(want), i;
    for (i = 0; i < names.length; i++) if (norm(names[i]) === w) return i;
    var hits = [];
    for (i = 0; i < names.length; i++) if (names[i] && norm(names[i]).indexOf(w) === 0) hits.push(i);
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) for (i = 0; i < names.length; i++) if (names[i] && norm(names[i]).indexOf(w) >= 0) hits.push(i);
    if (hits.length === 1) return hits[0];
    var avail = names.filter(function (n) { return n; }).join(' | ');
    if (hits.length > 1) throw new Error('"' + want + '" matches several ' + what + ': ' + hits.map(function (j) { return names[j]; }).join(' | '));
    throw new Error('No ' + what + ' "' + want + '". Available: ' + avail);
  }
  function str(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v) && v.every(function (x) { return typeof x !== 'object'; })) return v.join(', ');
    return '';
  }
  function cut(s, n) { s = str(s); return s.length > n ? s.slice(0, n) + '…' : s; }

  // Apps stay in the background unless the caller passes front: true.
  function proc(bringFront) {
    var t = req.target;
    var app = Application(t.path || t.bundleId || t.name);
    var launched = false;
    if (!app.running()) { app.launch(); launched = true; }
    if (bringFront === true) app.activate();
    for (var tries = 0; tries < 60; tries++) {
      var ps = [];
      if (t.bundleId) ps = se.applicationProcesses.whose({ bundleIdentifier: t.bundleId })();
      if (!ps.length && t.name) ps = se.applicationProcesses.whose({ name: t.name })();
      if (ps.length) {
        if (bringFront === true) { try { ps[0].frontmost = true; } catch (e) {} }
        else if (launched) { try { ps[0].visible = false; } catch (e) {} }
        // A freshly launched app has a process before it has a menu bar.
        for (var w = 0; w < 40; w++) {
          try { if (ps[0].menuBars.length > 0 && ps[0].menuBars[0].menuBarItems.length > 1) break; } catch (e) {}
          delay(0.5);
        }
        return ps[0];
      }
      delay(0.5);
    }
    throw new Error('The app did not start: ' + (t.name || t.bundleId));
  }

  // ---------- menus
  function menuItems(menu, prefix, depth, out, limit) {
    var items = menu.menuItems;
    var names = items.name();
    var enabled; try { enabled = items.enabled(); } catch (e) { enabled = names.map(function () { return true; }); }
    var subs; try { subs = items.menus.name(); } catch (e) { subs = null; }
    for (var i = 0; i < names.length && out.length < limit; i++) {
      if (!names[i] || names[i] === 'missing value') continue;
      var path = prefix.concat([names[i]]);
      var hasSub = subs ? (subs[i] && subs[i].length > 0) : false;
      if (!subs) { try { hasSub = items[i].menus.length > 0; } catch (e) {} }
      out.push((enabled[i] ? '' : '(disabled) ') + path.join(' > ') + (hasSub ? ' >' : ''));
      if (hasSub && depth > 0) menuItems(items[i].menus[0], path, depth - 1, out, limit);
    }
  }
  function cmdMenus() {
    var p = proc(req.front === true);
    var bar = p.menuBars[0];
    var tops = bar.menuBarItems.name();
    var out = [];
    for (var i = 1; i < tops.length; i++) {
      if (req.menu && norm(tops[i]) !== norm(req.menu)) continue;
      out.push(tops[i] + ' >');
      // Apps rebuild some menus (e.g. Undo) while we read them; retry once, then report.
      for (var attempt = 0; attempt < 2; attempt++) {
        var mark = out.length;
        try { menuItems(bar.menuBarItems[i].menus[0], [tops[i]], req.depth == null ? 2 : req.depth, out, req.limit || 1500); break; }
        catch (e) {
          out.length = mark;
          if (attempt === 1) out.push(tops[i] + ' > (could not read this menu: ' + e.message + ')');
          else delay(0.5);
        }
      }
    }
    if (req.menu && out.length === 0) throw new Error('No menu "' + req.menu + '". Menus: ' + tops.slice(1).join(' | '));
    return { menus: out, truncated: out.length >= (req.limit || 1500) };
  }
  var DISABLED_HINT = 'is disabled right now. It may need a selection or an open document. A hidden app that has never been in front keeps some document commands disabled (Save, Export): use a direct tool for those.';
  function cmdClickMenu() {
    var p = proc(req.front === true);
    var path = req.path;
    var bar = p.menuBars[0];
    var tops = bar.menuBarItems.name();
    var top = bar.menuBarItems[pick(tops.slice(1), path[0], 'menu') + 1];
    var menu = top.menus[0];
    var resolved = [top.name()];
    for (var i = 1; i < path.length; i++) {
      var names = menu.menuItems.name();
      var idx = pick(names, path[i], 'item in ' + resolved.join(' > '));
      var item = menu.menuItems[idx];
      resolved.push(names[idx]);
      if (i === path.length - 1) {
        if (!item.enabled()) throw new Error('"' + resolved.join(' > ') + '" ' + DISABLED_HINT);
        item.click();
        return { clicked: resolved };
      }
      menu = item.menus[0];
    }
    throw new Error('Give at least a menu and an item, e.g. ["File", "Export To", "PDF"]');
  }

  // ---------- accessibility tree
  function bulk(els, prop, n) {
    try { var v = els[prop](); if (v && v.length === n) return v; } catch (e) {}
    var out = [];
    for (var i = 0; i < n; i++) { try { out.push(els[i][prop]()); } catch (e) { out.push(null); } }
    return out;
  }
  function walk(roots, ids, depth, visit, budget) {
    var n = roots.length;
    if (n === 0 || budget.left <= 0) return;
    // Some apps (Final Cut Pro) answer a few elements a second: stop before the caller's timeout instead of failing.
    if (budget.until && Date.now() > budget.until) { budget.left = 0; budget.outOfTime = true; return; }
    var roles = bulk(roots, 'role', n), names = bulk(roots, 'name', n), descs = bulk(roots, 'description', n);
    var values = bulk(roots, 'value', n), enabled = bulk(roots, 'enabled', n);
    for (var i = 0; i < n && budget.left > 0; i++) {
      var id = ids + (ids ? '.' : '') + i;
      var node = { id: id, role: roles[i] || '', name: str(names[i]), description: str(descs[i]), value: str(values[i]), enabled: enabled[i] !== false, depth: depth };
      budget.left--;
      var stop = visit(node);
      if (stop === 'stop') { budget.left = 0; return; }
      if (depth < budget.maxDepth && stop !== 'skip') {
        var kids; try { kids = roots[i].uiElements; if (kids.length > 0) walk(kids, id, depth + 1, visit, budget); } catch (e) {}
      }
    }
  }
  function windowsOf(p) {
    var wins = p.windows;
    return wins;
  }
  function resolveId(p, id) {
    var parts = String(id).split('.').map(Number);
    var el = p.windows[parts[0]];
    for (var i = 1; i < parts.length; i++) el = el.uiElements[parts[i]];
    el.role();
    return el;
  }
  function cmdSnapshot() {
    var p = proc(req.front === true);
    var lines = [];
    var budget = { left: req.maxNodes || 400, maxDepth: req.depth || 10, until: Date.now() + (req.searchSeconds || 90) * 1000 };
    var root = req.within ? resolveId(p, req.within).uiElements : windowsOf(p);
    var base = req.within || '';
    walk(root, base, 0, function (n) {
      var label = [n.name, n.description].filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(' — ');
      var boring = !label && !n.value && (n.role === 'AXGroup' || n.role === 'AXLayoutArea' || n.role === 'AXSplitGroup' || n.role === 'AXScrollArea' || n.role === 'AXUnknown');
      if (!boring) lines.push(new Array(n.depth + 1).join('  ') + '[' + n.id + '] ' + n.role.replace(/^AX/, '') + (label ? ' "' + cut(label, 100) + '"' : '') + (n.value ? ' = ' + cut(n.value, 120) : '') + (n.enabled ? '' : ' (disabled)'));
    }, budget);
    var titles = []; try { titles = p.windows.name(); } catch (e) {}
    return { windows: titles, elements: lines, truncated: budget.left <= 0, outOfTime: budget.outOfTime || undefined };
  }
  function matches(n) {
    if (req.role && norm(n.role.replace(/^AX/, '')) !== norm(String(req.role).replace(/^AX/, ''))) return false;
    if (!req.text) return true;
    var w = norm(req.text);
    var fields = [n.name, n.description, n.value];
    for (var i = 0; i < fields.length; i++) {
      var f = norm(fields[i]);
      if (req.exact ? f === w : f.indexOf(w) >= 0) return true;
    }
    return false;
  }
  var searchCut = null;
  function find(p, max) {
    var hits = [];
    var budget = { left: req.maxNodes || 3000, maxDepth: req.depth || 14, until: Date.now() + (req.searchSeconds || 90) * 1000 };
    var root = req.within ? resolveId(p, req.within).uiElements : windowsOf(p);
    var stopped = false;
    walk(root, req.within || '', 0, function (n) {
      if (matches(n)) { hits.push(n); if (hits.length >= max) { stopped = true; return 'stop'; } }
    }, budget);
    searchCut = !stopped && budget.left <= 0 ? (budget.outOfTime ? 'ran out of time' : 'reached ' + (req.maxNodes || 3000) + ' elements') : null;
    return hits;
  }
  var NARROW = ' Pass within with the id of the part to search (from ui_snapshot) to narrow it.';
  function target(p) {
    if (req.id != null) return { el: resolveId(p, req.id), id: String(req.id) };
    var hits = find(p, 2 + (req.index || 0));
    if (!hits.length) throw new Error('No element matches ' + JSON.stringify({ role: req.role, text: req.text }) + (searchCut ? ': the search ' + searchCut + ' first.' + NARROW : '. Take a ui_snapshot to see what is on screen.'));
    var h = hits[req.index || 0] || hits[0];
    return { el: resolveId(p, h.id), id: h.id, node: h, more: hits.length > 1 };
  }
  function cmdFind() {
    var p = proc(req.front === true);
    var hits = find(p, req.max || 20);
    return searchCut ? { matches: hits, truncated: true, note: 'The search ' + searchCut + ' before it covered the whole window.' + NARROW } : { matches: hits };
  }
  // The list row that holds an element, or null. AXPress on a row or its text field reports
  // success without selecting anything (Final Cut Pro's library sidebar).
  function rowOf(p, id) {
    var parts = String(id).split('.');
    for (var n = parts.length; n > 1; n--) {
      var el = resolveId(p, parts.slice(0, n).join('.'));
      var r = '';
      try { r = el.role(); } catch (e) {}
      if (r === 'AXRow') return el;
      if (r === 'AXOutline' || r === 'AXTable' || r === 'AXList' || r === 'AXBrowser') return null;
    }
    return null;
  }
  function cmdClick() {
    var p = proc(req.front === true);
    var t = target(p);
    var row = rowOf(p, t.id);
    if (row) {
      if (req.front === true) { t.el.click(); return { clicked: t.id, element: t.node || null, method: 'click' }; }
      var selected = false;
      try { row.attributes.byName('AXSelected').value = true; selected = row.attributes.byName('AXSelected').value() === true; } catch (e) {}
      return { clicked: t.id, element: t.node || null, method: 'select', selected: selected,
        note: 'This is a list row, so it was selected through Accessibility. Some apps (the Final Cut Pro sidebar) ignore that selection: if the app does not react, call again with front: true for a real click.' };
    }
    var how = 'AXPress';
    try { t.el.actions.byName('AXPress').perform(); }
    catch (e) { how = 'click'; t.el.click(); }
    return { clicked: t.id, element: t.node || null, method: how };
  }
  function cmdSetValue() {
    var p = proc(req.front === true);
    var t = target(p);
    try { t.el.focused = true; } catch (e) {}
    var method = 'value';
    try { t.el.value = req.value; if (str(t.el.value()) !== req.value) throw new Error('not set'); }
    catch (e) {
      method = 'typed';
      try { t.el.focused = true; } catch (e2) {}
      se.keystroke('a', { using: 'command down' });
      se.keystroke(req.value);
    }
    return { set: t.id, method: method };
  }
  var KEYCODES = { 'return': 36, 'enter': 76, 'tab': 48, 'space': 49, 'delete': 51, 'forwarddelete': 117, 'escape': 53, 'esc': 53,
    'left': 123, 'right': 124, 'down': 125, 'up': 126, 'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
    'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111 };
  // US layout key codes, so shortcuts can be posted straight to a background app.
  var CHARCODES = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
    '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32,
    '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '\u0060': 50 };
  var FLAGS = { command: 0x100000, shift: 0x20000, control: 0x40000, option: 0x80000 };
  // text is one UTF-16 code unit. A JS string doesn't bridge to UniChar*, which left every event as key code 0 ("a").
  function postKey(pid, code, flags, unit) {
    ObjC.import('Cocoa');
    [true, false].forEach(function (down) {
      var ev = $.CGEventCreateKeyboardEvent($(), code, down);
      $.CGEventSetFlags(ev, flags);
      if (unit !== undefined && unit !== null) {
        var buf = Ref('unsigned short');
        buf[0] = unit;
        $.CGEventKeyboardSetUnicodeString(ev, 1, buf);
      }
      $.CGEventPostToPid(pid, ev);
      delay(0.01);
    });
  }
  // A shortcut posted to a hidden app reaches no menu: it has no key window. Find the menu item
  // that has this shortcut and press it instead. Searches the menus and one level of submenus.
  function menuItemForShortcut(p, key, flags) {
    var want = (flags & FLAGS.shift ? 1 : 0) | (flags & FLAGS.option ? 2 : 0) | (flags & FLAGS.control ? 4 : 0) | (flags & FLAGS.command ? 0 : 8);
    var k = key.toLowerCase(), found = null;
    function scan(menuItems, path, depth) {
      var items, chars, mods, names;
      try {
        items = menuItems();
        chars = menuItems.attributes.byName('AXMenuItemCmdChar').value();
        mods = menuItems.attributes.byName('AXMenuItemCmdModifiers').value();
        names = menuItems.name();
      } catch (e) { return; }
      for (var i = 0; i < items.length; i++) {
        if (chars[i] && String(chars[i]).toLowerCase() === k && mods[i] === want) { found = { item: items[i], path: path.concat([names[i]]) }; return; }
      }
      if (depth > 0) for (var j = 0; j < items.length && !found; j++) {
        try { if (items[j].menus.length) scan(items[j].menus[0].menuItems, path.concat([names[j]]), depth - 1); } catch (e) {}
      }
    }
    var bar = p.menuBars[0].menuBarItems, tops = bar.name();
    for (var t = 1; t < tops.length && !found; t++) scan(bar[t].menus[0].menuItems, [tops[t]], 1);
    return found;
  }
  function cmdKeys() {
    var front = req.front === true;
    var p = proc(front);
    var k = String(req.key);
    var mods = req.modifiers || [];
    if (front) {
      var opts = mods.length ? { using: mods.map(function (m) { return m + ' down'; }) } : {};
      var c0 = KEYCODES[k.toLowerCase()];
      if (c0 !== undefined) se.keyCode(c0, opts); else se.keystroke(k, opts);
      return { pressed: mods.concat([k]).join('+'), mode: 'foreground' };
    }
    var code = KEYCODES[k.toLowerCase()];
    if (code === undefined) code = CHARCODES[k.toLowerCase()];
    var flags = 0;
    mods.forEach(function (m) { flags |= FLAGS[m]; });
    if (k.length === 1 && k !== k.toLowerCase()) flags |= FLAGS.shift;
    if (flags & (FLAGS.command | FLAGS.control | FLAGS.option)) {
      var hit = menuItemForShortcut(p, k, flags);
      if (hit) {
        if (!hit.item.enabled()) throw new Error('"' + hit.path.join(' > ') + '" (' + mods.concat([k]).join('+') + ') ' + DISABLED_HINT);
        hit.item.actions.byName('AXPress').perform();
        return { pressed: mods.concat([k]).join('+'), mode: 'background', menu: hit.path.join(' > ') };
      }
    }
    if (code === undefined) throw new Error('Key "' + k + '" cannot be sent in the background. Pass front: true.');
    postKey(p.unixId(), code, flags, null);
    return { pressed: mods.concat([k]).join('+'), mode: 'background' };
  }
  function cmdType() {
    var front = req.front === true;
    var p = proc(front);
    if (front) { se.keystroke(req.text); return { typed: req.text.length, mode: 'foreground' }; }
    var pid = p.unixId();
    // One event per UTF-16 code unit: a surrogate pair split over two events still arrives as one character.
    for (var i = 0; i < req.text.length; i++) {
      var ch = req.text[i];
      if (ch === '\n' || ch === '\r') postKey(pid, KEYCODES['return'], 0, null);
      else if (ch === '\t') postKey(pid, KEYCODES.tab, 0, null);
      else postKey(pid, 0, 0, req.text.charCodeAt(i));
    }
    return { typed: req.text.length, mode: 'background' };
  }
  function cmdWindowId() {
    var p = proc(false);
    // macOS draws no image for a hidden app's windows, and showing one would put it on screen.
    if (!p.visible()) throw new Error(p.name() + ' is hidden, so its window can\'t be captured. Check the result through output files or read-back tools (ui_snapshot, ui_find) instead.');
    var pid = p.unixId();
    ObjC.import('Cocoa');
    var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))) || [];
    var best = null, bestArea = 0;
    list.forEach(function (w) {
      if (w.kCGWindowOwnerPID !== pid || w.kCGWindowLayer !== 0) return;
      var b = w.kCGWindowBounds || {};
      var area = (b.Width || 0) * (b.Height || 0);
      if (area > bestArea) { best = w; bestArea = area; }
    });
    if (!best) throw new Error('No window found for this app. Is a document open?');
    return { windowId: best.kCGWindowNumber, bounds: best.kCGWindowBounds };
  }
  function cmdBounds() {
    var p = proc(req.front === true);
    var w = req.id != null ? resolveId(p, req.id) : p.windows[0];
    return { position: w.position(), size: w.size() };
  }

  function cmdHide() {
    var p = proc(false);
    try { p.visible = false; } catch (e) {}
    return { hidden: true };
  }
  // ---------- batch: many steps in one run, so pop-ups stay open and the app is hidden once, at the end.
  function sameValue(a, b) {
    var x = String(a).trim(), y = String(b).trim();
    if (x !== '' && y !== '' && !isNaN(Number(x)) && !isNaN(Number(y))) return Math.abs(Number(x) - Number(y)) < 0.001;
    return norm(x) === norm(y);
  }
  function readValue(el) { try { return str(el.value()); } catch (e) { return ''; } }
  function until(seconds, poll, test, what) {
    var limit = Date.now() + seconds * 1000;
    for (;;) {
      var hit = test();
      if (hit) return hit;
      if (Date.now() > limit) throw new Error('Timed out after ' + seconds + ' s waiting for ' + what);
      delay(poll);
    }
  }
  function wanted() { return JSON.stringify({ id: req.id, role: req.role, text: req.text, within: req.within }); }
  function tryTarget(p) { try { return target(p); } catch (e) { return null; } }
  var base = req;
  function runStep(s) {
    req = {};
    for (var k in s) req[k] = s[k];
    req.target = base.target;
    req.front = false;
    return ops[s.op]();
  }
  function runSteps(steps) { for (var i = 0; i < steps.length; i++) { if (!(steps[i].optional === true)) runStep(steps[i]); else { try { runStep(steps[i]); } catch (e) {} } } }
  var ops = {
    clickMenu: cmdClickMenu,
    keys: cmdKeys,
    snapshot: cmdSnapshot,
    hide: cmdHide,
    sleep: function () { delay(Number(req.seconds)); return {}; },
    click: function () {
      var p = proc(false);
      var t = req.waitSeconds ? until(Number(req.waitSeconds), 0.25, function () { return tryTarget(p); }, wanted()) : target(p);
      if (req.requireEnabled === true && t.el.enabled() !== true) throw new Error('Disabled: ' + wanted());
      try { t.el.actions.byName('AXPress').perform(); } catch (e) { t.el.click(); }
      return { clicked: t.id };
    },
    // Unlike the ui_set_value tool, this never falls back to typing. Typed keys go to whatever app is in front.
    setValue: function () {
      var t = target(proc(false));
      t.el.value = String(req.value);
      var got = readValue(t.el);
      if (!sameValue(got, req.value)) throw new Error('Value did not stick at ' + t.id + ': wanted ' + req.value + ', read ' + got);
      return { set: t.id, value: got };
    },
    // Some sliders only take small moves, such as Logic's tempo at one BPM a time.
    stepValue: function () {
      var t = target(proc(false));
      var to = Number(req.to), size = Math.abs(Number(req.delta || 1)), moves = 0;
      var now = Number(readValue(t.el));
      if (isNaN(now) || isNaN(to)) throw new Error('Not a number at ' + t.id + ': ' + readValue(t.el) + ' to ' + req.to);
      while (Math.abs(now - to) > 0.001) {
        if (++moves > Number(req.maxSteps || 300)) throw new Error('Too many steps to reach ' + to + ' at ' + t.id);
        var next = now < to ? Math.min(now + size, to) : Math.max(now - size, to);
        t.el.value = String(next);
        delay(Number(req.pause || 0.2));
        var got = Number(readValue(t.el));
        if (Math.abs(got - next) > 0.001) throw new Error('Value did not stick at ' + t.id + ': wanted ' + next + ', read ' + got);
        now = got;
      }
      return { reached: now, moves: moves };
    },
    waitFor: function () {
      var p = proc(false);
      return until(req.timeoutSeconds == null ? 120 : Number(req.timeoutSeconds), Number(req.poll || 0.5), function () {
        var hit = tryTarget(p);
        if (req.gone === true) return hit ? null : { gone: true };
        if (!hit || (req.enabled === true && hit.el.enabled() !== true)) return null;
        return { found: hit.id };
      }, wanted());
    },
    assert: function () {
      var t = target(proc(false));
      var got = readValue(t.el);
      if (!sameValue(got, req.value)) throw new Error('Expected ' + req.value + ' at ' + t.id + ', read ' + got);
      return { value: got };
    },
    // Run the steps again after a failure, with onFail steps between tries to get back to the start.
    retry: function () {
      var spec = req, last = null, times = Number(spec.times || 2);
      for (var t = 1; t <= times; t++) {
        try { runSteps(spec.steps); return { attempts: t }; }
        catch (e) { last = e; if (t < times && spec.onFail) runSteps(spec.onFail); }
      }
      throw last;
    }
  };
  function cmdBatch() {
    var completed = [];
    for (var i = 0; i < base.steps.length; i++) {
      var s = base.steps[i], entry = { i: s.i, op: s.op, ok: true };
      if (s.label) entry.label = s.label;
      try {
        var r = runStep(s);
        for (var k in r) entry[k] = r[k];
      } catch (e) {
        if (s.optional !== true) {
          var failure = { i: s.i, op: s.op, error: e.message };
          if (s.label) failure.label = s.label;
          req = { target: base.target, front: false, maxNodes: 150, depth: 6 };
          try { failure.snapshot = cmdSnapshot(); } catch (e2) { failure.snapshot = 'Could not read the windows: ' + e2.message; }
          req = base;
          return { completed: completed, failed: failure };
        }
        entry.ok = false;
        entry.skipped = e.message;
      }
      completed.push(entry);
    }
    req = base;
    return { completed: completed };
  }
  var cmds = { batch: cmdBatch, hide: cmdHide, windowId: cmdWindowId, menus: cmdMenus, clickMenu: cmdClickMenu, snapshot: cmdSnapshot, find: cmdFind, click: cmdClick, setValue: cmdSetValue, keys: cmdKeys, type: cmdType, bounds: cmdBounds };
  if (!cmds[req.cmd]) throw new Error('unknown cmd ' + req.cmd);
  // Keep the app off screen: hide it again after every action unless asked to show it.
  function rehide() {
    if (req.front === true || req.keepVisible === true) return;
    try {
      var t = req.target, ps = [];
      if (t.bundleId) ps = se.applicationProcesses.whose({ bundleIdentifier: t.bundleId })();
      if (!ps.length && t.name) ps = se.applicationProcesses.whose({ name: t.name })();
      if (ps.length && ps[0].visible()) ps[0].visible = false;
    } catch (e) {}
  }
  try { return JSON.stringify(cmds[req.cmd]()); }
  finally { rehide(); }
}
`;
