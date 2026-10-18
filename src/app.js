(function () {
  const B = Budget;

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const thisMonth = () => todayISO().slice(0, 7);
  const money = (c) => B.formatMoney(c, budget.currency);

  // Theme: a per-device preference, so it lives in this browser only.
  const THEME_KEY = 'envelo.theme';
  function readTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
  }
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked: theme still applies now */ }
  }
  applyTheme(readTheme());

  // Row size: a per-device preference, like the theme.
  const DENSITY_KEY = 'envelo.density';
  function readDensity() {
    try { return localStorage.getItem(DENSITY_KEY) || 'normal'; } catch { return 'normal'; }
  }
  function applyDensity(d) {
    document.documentElement.dataset.density = d;
    try { localStorage.setItem(DENSITY_KEY, d); } catch { /* applies until reload */ }
  }
  applyDensity(readDensity());

  // Font for numbers and titles: Poster (default), Classic or Modern. Per device.
  const FONT_KEY = 'envelo.font';
  function readFont() {
    try { return localStorage.getItem(FONT_KEY) || 'poster'; } catch { return 'poster'; }
  }
  function applyFont(f) {
    document.documentElement.dataset.font = f;
    try { localStorage.setItem(FONT_KEY, f); } catch { /* applies until reload */ }
  }
  applyFont(readFont());

  let budget = B.create();
  let month = thisMonth();
  let account = null;
  let revision = 0; // server revision this copy is based on
  let currentView = 'budget';
  let openAccountId = null;
  let editingTx = null;

  // API

  // Identifies this tab, so it can ignore live updates about its own saves.
  const clientId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

  async function api(method, url, body, extraHeaders = {}) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Client-Id': clientId, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status}).`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Saving. Changes are sent to the server a moment after the last edit.
  // If a save fails, the data stays on screen and we retry.

  let saveTimer = null;
  let inFlight = false;
  let dirty = false;

  function setSync(text, isError = false) {
    const el = $('#sync');
    el.textContent = text;
    el.classList.toggle('sync-error', isError);
  }

  function scheduleSave() {
    dirty = true;
    setSync('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
  }

  async function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (inFlight || !dirty || !account) return;
    inFlight = true;
    dirty = false;
    try {
      const res = await api('PUT', '/api/budget', budget, { 'If-Match': String(revision) });
      revision = res.revision;
      dropPending();
      const { savedAt } = res;
      setSync(`Saved ${new Date(savedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
    } catch (err) {
      if (err.status === 401) {
        inFlight = false;
        showAuth('Your session ended. Sign in again. Unsaved changes are kept on this screen until you do.');
        return;
      }
      if (err.status === 409) {
        // Another device saved first. Show its version rather than overwrite it.
        inFlight = false;
        dropPending();
        budget = err.data.budget ? B.fromJSON(err.data.budget) : B.create();
        revision = err.data.revision;
        showError('Your budget was changed on another device, so this screen now shows the latest version. Your last change here was not saved; please make it again.');
        setSync('Reloaded the latest version');
        render();
        return;
      }
      dirty = true;
      keepPending();
      setSync(navigator.onLine === false ? 'Offline: changes are kept on this device and sent when you are back online.' : `Not saved: ${err.message} Retrying…`, true);
      saveTimer = setTimeout(flush, 5000);
    } finally {
      inFlight = false;
    }
    if (dirty && !saveTimer) scheduleSave();
  }

  function showError(msg) {
    const el = $('#error');
    el.textContent = msg;
    el.hidden = !msg;
  }

  // Run a change, surface any validation error, then re-render and save.
  // With `undoLabel`, the budget before the change is kept so the change can
  // be undone from the toast or with Ctrl+Z.
  const undoStack = [];
  function attempt(fn, undoLabel = null) {
    const snapshot = undoLabel ? JSON.stringify(budget) : null;
    try {
      fn();
      showError('');
      if (snapshot) {
        undoStack.push({ label: undoLabel, snapshot });
        if (undoStack.length > 25) undoStack.shift();
        toast(undoLabel, { action: 'Undo', onAction: undo });
      }
      scheduleSave();
      render();
      return true;
    } catch (err) {
      showError(err.message);
      render();
      return false;
    }
  }

  function undo() {
    const last = undoStack.pop();
    if (!last) {
      toast('Nothing to undo');
      return;
    }
    budget = B.fromJSON(JSON.parse(last.snapshot));
    showError('');
    scheduleSave();
    render();
    Sounds.play('undo');
    toast(`Undone: ${last.label}`);
  }

  // Animations. Skipped entirely when the device asks for reduced motion.
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function toast(message, { action = null, onAction = null, ms = 5000 } = {}) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
    if (action) {
      el.querySelector('button').addEventListener('click', () => {
        el.classList.remove('show');
        onAction();
      });
    }
    el.classList.remove('show');
    void el.offsetWidth; // restart the transition
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), action ? ms + 2000 : 3200);
  }

  function celebrate(message) {
    toast(message);
    if (reduceMotion() || !document.body.animate) return;
    const colors = ['#ff5a3c', '#1f8a5b', '#ffd23f', '#2d5bff', '#ff8fb1', '#f4efe4'];
    const layer = document.createElement('div');
    layer.className = 'confetti';
    document.body.appendChild(layer);
    const w = window.innerWidth;
    for (let i = 0; i < 70; i++) {
      const piece = document.createElement('i');
      piece.style.background = colors[i % colors.length];
      piece.style.left = `${Math.random() * w}px`;
      layer.appendChild(piece);
      const drift = (Math.random() - 0.5) * 240;
      const spin = (Math.random() - 0.5) * 1080;
      piece.animate([
        { transform: 'translate(0, -20px) rotate(0deg)', opacity: 1 },
        { transform: `translate(${drift}px, ${window.innerHeight + 40}px) rotate(${spin}deg)`, opacity: 0.9 },
      ], { duration: 1600 + Math.random() * 1200, delay: Math.random() * 300, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' });
    }
    setTimeout(() => layer.remove(), 3400);
  }

  // Money moving into envelopes. `prev` is the month view from before the
  // change; the page has already been re-rendered with the new numbers.
  // Banknotes arc from Ready to Assign into each envelope, the totals count
  // to their new values, progress bars grow, and the row shows what it got.
  function tweenMoney(el, from, to, duration) {
    if (!el || from === to) return;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = money(Math.round(from + (to - from) * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    el.textContent = money(from);
    requestAnimationFrame(step);
  }

  function burst(x, y, colors) {
    for (let i = 0; i < 12; i++) {
      const s = document.createElement('i');
      s.className = 'spark';
      s.style.left = `${x}px`;
      s.style.top = `${y}px`;
      s.style.background = colors[i % colors.length];
      document.body.appendChild(s);
      const a = (i / 12) * Math.PI * 2;
      const r = 34 + Math.random() * 22;
      s.animate([
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * r}px), calc(-50% + ${Math.sin(a) * r}px)) rotate(${a}rad) scale(.3)`, opacity: 0 },
      ], { duration: 650, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' })
        .finished.then(() => s.remove(), () => s.remove());
    }
  }

  function fundFx(prev, envIds) {
    const before = new Map(prev.groups.flatMap((g) => g.envelopes).map((e) => [e.id, e]));
    const after = B.monthView(budget, month);
    const now = new Map(after.groups.flatMap((g) => g.envelopes).map((e) => [e.id, e]));
    const changed = envIds.filter((id) => before.has(id) && now.has(id) && now.get(id).assigned > before.get(id).assigned);
    if (!changed.length) return;
    // A target that became fully funded gets a stamp sound; otherwise coins.
    const funded = changed.some((id) => before.get(id).underfunded && !now.get(id).underfunded);
    if (reduceMotion() || !document.body.animate) {
      Sounds.play(funded ? 'stamp' : 'coin');
      return;
    }
    changed.slice(0, 6).forEach((_, i) => setTimeout(() => Sounds.play('coin', 0), 950 + i * 90));
    if (funded) setTimeout(() => Sounds.play('stamp'), 1150);

    const readyAmount = $('#ready .amount');
    const FLIGHT = 950;
    tweenMoney(readyAmount, prev.readyToAssign, after.readyToAssign, FLIGHT + changed.length * 90);
    if (readyAmount) {
      readyAmount.animate([
        { transform: 'scale(1)' }, { transform: 'scale(.94) rotate(-1deg)', offset: 0.25 }, { transform: 'scale(1)' },
      ], { duration: 420, easing: 'ease-out' });
    }
    const src = (readyAmount || $('#ready')).getBoundingClientRect();
    // When Ready to Assign is scrolled away, the notes enter from the top edge.
    const sx = src.left + src.width / 2;
    const sy = Math.max(-20, Math.min(window.innerHeight, src.top + src.height / 2));

    changed.slice(0, 8).forEach((id, k) => {
      const old = before.get(id);
      const env = now.get(id);
      const row = document.querySelector(`[data-env-row="${id}"]`);
      const input = row && row.querySelector('input[data-env]');
      if (!row || !input || !input.offsetParent) return;
      const delay = k * 90;
      const landAt = delay + FLIGHT;

      // Numbers and the progress bar start from their old values.
      const avail = row.querySelector('.chip');
      const bar = row.querySelector('.tbar > i');
      if (avail) avail.textContent = money(old.available);
      if (bar) {
        bar.style.transition = 'none';
        bar.style.width = `${Math.round((old.progress || 0) * 100)}%`;
        void bar.offsetWidth;
        bar.style.transition = '';
      }

      // More notes for bigger amounts.
      const added = env.assigned - old.assigned;
      const count = changed.length > 1 ? 3 : Math.max(4, Math.min(9, Math.ceil(Math.log10(Math.max(100, added)) * 2)));
      const dst = input.getBoundingClientRect();
      const dx = dst.left + dst.width / 2 - sx;
      const dy = dst.top + dst.height / 2 - sy;
      for (let n = 0; n < count; n++) {
        const note = document.createElement('div');
        note.className = 'bill';
        note.innerHTML = '<span>€</span>';
        note.style.left = `${sx - 27}px`;
        note.style.top = `${sy - 16}px`;
        document.body.appendChild(note);
        // A curved path through a random point above the line between the two.
        const cx = dx * (0.3 + Math.random() * 0.3) + (Math.random() - 0.5) * 160;
        const cy = Math.min(0, dy) * 0.5 - 80 - Math.random() * 90;
        const spin = (Math.random() - 0.5) * 50;
        const frames = [];
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const x = 2 * (1 - t) * t * cx + t * t * dx;
          const y = 2 * (1 - t) * t * cy + t * t * dy;
          const flutter = Math.cos(t * Math.PI * 3 + n);
          frames.push({
            transform: `translate(${x}px, ${y}px) rotate(${spin * Math.sin(t * Math.PI * 2) + t * 8}deg) scale(${(1.15 - t * 0.6).toFixed(3)}, ${((1.15 - t * 0.6) * (0.55 + 0.45 * Math.abs(flutter))).toFixed(3)})`,
            opacity: t < 0.08 ? t / 0.08 : t > 0.9 ? (1 - t) * 10 : 1,
            offset: t,
          });
        }
        note.animate(frames, { duration: FLIGHT, delay: delay + n * 55, easing: 'cubic-bezier(.45,0,.4,1)', fill: 'both' })
          .finished.then(() => note.remove(), () => note.remove());
      }

      setTimeout(() => {
        if (!row.isConnected) return;
        input.classList.remove('pulse');
        void input.offsetWidth;
        input.classList.add('pulse');
        row.classList.remove('got-money');
        void row.offsetWidth;
        row.classList.add('got-money');
        setTimeout(() => row.classList.remove('got-money'), 1200);
        if (avail) tweenMoney(avail, old.available, env.available, 600);
        if (bar) bar.style.width = `${Math.round((env.progress || 0) * 100)}%`;

        // "+€50.00" rises from the envelope.
        const box = (avail || input).getBoundingClientRect();
        const plus = document.createElement('div');
        plus.className = 'plus-money';
        plus.textContent = `+${money(added)}`;
        plus.style.left = `${box.left + box.width / 2}px`;
        plus.style.top = `${box.top}px`;
        document.body.appendChild(plus);
        plus.animate([
          { transform: 'translate(-50%, 6px) scale(.6)', opacity: 0 },
          { transform: 'translate(-50%, -14px) scale(1.15)', opacity: 1, offset: 0.25 },
          { transform: 'translate(-50%, -46px) scale(1)', opacity: 0 },
        ], { duration: 1300, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' })
          .finished.then(() => plus.remove(), () => plus.remove());

        // A target that is now fully funded gets a burst on its badge.
        const done = row.querySelector('.stamp.done');
        if (done && old.underfunded && !env.underfunded) {
          done.animate([
            { transform: 'scale(0)' }, { transform: 'scale(1.25)', offset: 0.6 }, { transform: 'scale(1)' },
          ], { duration: 450, easing: 'cubic-bezier(.3,1.6,.5,1)' });
          const d = done.getBoundingClientRect();
          burst(d.left + d.width / 2, d.top + d.height / 2, ['#ffd23f', '#1f8a5b', '#ff5a3c', '#2d5bff']);
        }
      }, landAt);
    });
  }

  // Collapsed groups are a per-device preference.
  const COLLAPSED_KEY = 'envelo.collapsed';
  function readCollapsed() {
    try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'); } catch { return []; }
  }
  function toggleCollapsed(name) {
    const list = new Set(readCollapsed());
    if (list.has(name)) list.delete(name); else list.add(name);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...list])); } catch { /* still toggles until reload */ }
  }
  let showHidden = false;
  let reordering = false; // Reorder mode: arrows on groups and envelopes

  // Funding state of an envelope with a target: full, partial or none.
  function fundState(e) {
    if (!e.target) return '';
    if (!e.underfunded) return 'fund-full';
    return e.assigned > 0 || (e.progress || 0) > 0 ? 'fund-partial' : 'fund-none';
  }

  // The leading emoji of a name becomes its sticker; otherwise its first letter.
  const EMOJI_RE = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*|[\u{1F1E6}-\u{1F1FF}]{2})\s*/u;
  function splitEmoji(name) {
    const m = String(name || '').match(EMOJI_RE);
    return m ? { icon: m[1], text: name.slice(m[0].length) || name } : { icon: null, text: name };
  }
  function tile(name) {
    const { icon, text } = splitEmoji(name);
    return icon ? `<span class="tile" aria-hidden="true">${esc(icon)}</span>`
      : `<span class="tile letter" aria-hidden="true">${esc((text || '?').trim().charAt(0).toUpperCase())}</span>`;
  }

  // Available as a chip: green with money, yellow while a target still needs
  // money, red (and clickable, to cover it) when overspent, grey at zero.
  function chip(e) {
    if (e.available < 0) {
      return `<button type="button" class="chip neg" data-action="cover" data-id="${e.id}" title="Cover this overspending">${esc(money(e.available))}</button>`;
    }
    const cls = e.available === 0 ? 'zero' : e.underfunded ? 'low' : 'ok';
    return `<span class="chip ${cls}">${esc(money(e.available))}</span>`;
  }

  // Sub-envelopes sit right under their parent. Returns rows in display order,
  // each with `kids` (on a parent) for its summary line.
  function familyOrder(list) {
    const ids = new Set(list.map((e) => e.id));
    const out = [];
    for (const e of list) {
      if (e.parentId && ids.has(e.parentId)) continue;
      const kids = list.filter((c) => c.parentId === e.id);
      out.push({ ...e, kids, isSub: false }, ...kids.map((c) => ({ ...c, isSub: true })));
    }
    return out;
  }
  function moveButtons(action, attr, label) {
    return `<span class="mover"><button type="button" class="icon-text" data-action="${action}" ${attr} data-dir="-1" aria-label="Move ${esc(label)} up" title="Move up">▲</button><button type="button" class="icon-text" data-action="${action}" ${attr} data-dir="1" aria-label="Move ${esc(label)} down" title="Move down">▼</button></span>`;
  }

  function envelopeRow(e, isHiddenRow = false) {
    const state = fundState(e);
    const pct = Math.round((e.progress || 0) * 100);
    const shared = sharedEnvelopeIds().has(e.id);
    const goal = e.target
      ? `<div class="goal ${e.underfunded ? 'short' : ''}">${esc(describeTarget(e))}${e.underfunded ? ` · needs ${esc(money(e.needed))}` : ''}</div>
        <div class="tbar ${state}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
          aria-label="${esc(e.name)} target ${pct}%"><i style="width:${pct}%"></i></div>`
      : '';
    const fund = isHiddenRow
      ? `<button type="button" class="btn sm" data-action="unhide-envelope" data-id="${e.id}">Unhide</button>`
      : e.underfunded
        ? `<button type="button" class="btn sm fund" data-action="fund" data-id="${e.id}" data-amount="${e.needed}">Assign ${esc(money(e.needed))}</button>`
        : e.target ? '<span class="stamp done">Funded ✓</span>' : '';
    const { text } = splitEmoji(e.name);
    const kids = e.kids || [];
    const family = kids.length
      ? `<div class="family">${kids.length} inside · ${esc(money(kids.reduce((t, c) => t + c.available, e.available)))} available in all</div>`
      : '';
    const cell = reordering && !isHiddenRow ? moveButtons('move-env', `data-id="${e.id}"`, text) : fund;
    return `<div class="env${e.isSub ? ' sub' : ''}${kids.length ? ' parent' : ''}" data-env-row="${e.id}">
      <div class="env-cell">${tile(e.name)}<div class="env-text">
        <div class="env-name"><button type="button" class="env-link" data-action="edit-target" data-id="${e.id}" title="Edit envelope and target">${esc(text)}</button>${e.overspent ? '<span class="stamp over">Overspent</span>' : ''}${shared ? '<span class="stamp shared" title="Shared with someone">Shared</span>' : ''}</div>
        ${goal}${family}</div></div>
      <div class="c" data-label="Assigned"><input type="text" inputmode="decimal" class="amt ${state}" aria-label="Assigned to ${esc(e.name)}" value="${B.toInput(e.assigned)}" data-env="${e.id}"></div>
      <div class="c spent" data-label="Spent">${esc(money(e.activity))}</div>
      <div class="c" data-label="Available">${chip(e)}</div>
      <div class="c fund-cell">${cell}</div>
    </div>`;
  }

  function groupCard(g, visible, isCollapsed) {
    const color = budget.groupColors[g.name] ?? 0;
    const sum = (key) => visible.reduce((t, e) => t + e[key], 0);
    const availSum = sum('available');
    return `<section class="group gc-${color}${isCollapsed ? ' is-collapsed' : ''}">
      <div class="gh">
        <div class="gh-name">
          <button type="button" class="color-dot" data-action="group-color" data-group="${esc(g.name)}" title="Change colour" aria-label="Change the colour of ${esc(g.name)}"></button>
          <button type="button" class="group-toggle" data-action="toggle-group" data-group="${esc(g.name)}" aria-expanded="${!isCollapsed}">
            <span class="chev">${isCollapsed ? '▸' : '▾'}</span>${esc(g.name)}</button>
        </div>
        <div class="tot">${esc(money(sum('assigned')))}</div>
        <div class="tot">${esc(money(sum('activity')))}</div>
        <div class="tot tot-avail ${availSum < 0 ? 'neg' : ''}">${esc(money(availSum))}</div>
        <div class="g-act">${reordering ? moveButtons('move-group', `data-group="${esc(g.name)}"`, g.name)
          : `<button type="button" class="icon-text" data-action="new-envelope" data-group="${esc(g.name)}" title="Add an envelope to this group" aria-label="Add an envelope to ${esc(g.name)}">+</button><button type="button" class="icon-text" data-action="hide-group" data-group="${esc(g.name)}" title="Hide this group">Hide</button>`}</div>
      </div>
      ${familyOrder(visible).map((e) => envelopeRow(e)).join('')}
    </section>`;
  }

  function fmtMonthLong(m) {
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleString(undefined, { month: 'long' });
  }

  // Ready to Assign. At exactly zero, with money assigned this month, the
  // sticker turns green and gets a stamp; the first time each month it cheers.
  function renderReady(view) {
    const ready = $('#ready');
    const assignedThisMonth = Object.values(budget.assignments[month] || {}).some((v) => v !== 0);
    const allAssigned = view.readyToAssign === 0 && assignedThisMonth && budget.envelopes.length > 0;
    ready.classList.toggle('warn', view.readyToAssign < 0);
    ready.classList.toggle('zero-done', allAssigned);
    const hasTargets = budget.envelopes.some((e) => e.target && !B.isHidden(budget, e));
    ready.innerHTML = `${allAssigned ? `<div class="zero-stamp">Every ${esc(currencyWord())} has a job</div>` : ''}
      <div class="label">${view.readyToAssign < 0 ? 'Assigned too much' : 'Ready to assign'}</div>
      <div class="amount">${esc(money(view.readyToAssign))}</div>
      ${view.underfunded > 0
        ? `<div class="under-line">Targets need ${esc(money(view.underfunded))} <button type="button" class="btn sm yellow" data-action="fund-all">Fund all</button></div>`
        : hasTargets ? '<div class="under-line">✓ All targets funded</div>' : '<div class="under-line"></div>'}`;
    const key = `envelo.cheered.${account ? account.email : ''}`;
    let cheered = '';
    try { cheered = localStorage.getItem(key) || ''; } catch { /* ignore */ }
    if (allAssigned && cheered !== month && month === thisMonth()) {
      try { localStorage.setItem(key, month); } catch { /* ignore */ }
      if (celebrateZeroArmed) {
        const stamp = ready.querySelector('.zero-stamp');
        if (stamp) stamp.classList.add('fresh');
        ready.classList.remove('cheer');
        void ready.offsetWidth;
        ready.classList.add('cheer');
        setTimeout(() => {
          celebrate(`🎉 Every ${currencyWord()} has a job`);
          Sounds.play('fanfare');
        }, 350);
      }
    }
  }
  // Only cheer for a change made on this screen, not on first load.
  let celebrateZeroArmed = false;

  // "euro", "dollar", "pound"... for the stamp, from the budget's currency.
  function currencyWord() {
    const names = { EUR: 'euro', USD: 'dollar', CAD: 'dollar', AUD: 'dollar', MXN: 'peso', GBP: 'pound', BRL: 'real', CHF: 'franc', JPY: 'yen', SEK: 'krona', NOK: 'krone', DKK: 'krone', PLN: 'złoty', CZK: 'koruna' };
    return names[budget.currency] || 'coin';
  }

  function renderStats(view) {
    const envs = view.groups.flatMap((g) => g.envelopes);
    const sum = (k) => envs.reduce((t, e) => t + e[k], 0);
    const assigned = sum('assigned');
    const spent = -sum('activity') || 0;
    let paceHtml = '';
    const [y, m] = month.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const today = todayISO();
    if (month === thisMonth()) {
      const day = Number(today.slice(8, 10));
      const usedPct = assigned > 0 ? Math.round((spent / assigned) * 100) : 0;
      paceHtml = `<div class="pace"><span>Day ${day} of ${days}</span>
        <div class="pbar" title="Spent ${usedPct}% of what is assigned"><i style="width:${Math.min(100, Math.max(0, usedPct))}%"></i><b style="left:${Math.round((day / days) * 100)}%"></b></div>
        <small>spent ${usedPct}% of assigned · the line is today</small></div>`;
    } else {
      const over = envs.filter((e) => e.available < 0).reduce((t, e) => t - e.available, 0);
      paceHtml = `<div><span>Overspent</span><b class="${over ? 'neg' : ''}">${esc(money(over))}</b></div>`;
    }
    $('#stats').innerHTML = `<div><span>Assigned</span><b>${esc(money(assigned))}</b></div>
      <div><span>Spent</span><b>${esc(money(spent))}</b></div>
      <div><span>Available</span><b class="${sum('available') < 0 ? 'neg' : ''}">${esc(money(sum('available')))}</b></div>
      ${paceHtml}`;
  }

  function renderBudget(view) {
    if (B.ensureGroupColors(budget)) scheduleSave();
    const collapsed = readCollapsed();
    const parts = [];
    const hiddenRows = [];
    for (const g of view.groups) {
      const groupHidden = (budget.hiddenGroups || []).includes(g.name);
      const visible = g.envelopes.filter((e) => !e.hidden);
      for (const e of g.envelopes) if (e.hidden) hiddenRows.push(e);
      if (groupHidden || !visible.length) continue;
      parts.push(groupCard(g, visible, collapsed.includes(g.name)));
    }
    const hiddenGroups = (budget.hiddenGroups || []).filter((name) => budget.envelopes.some((e) => e.group === name));
    if (hiddenRows.length) {
      parts.push(`<section class="group hidden-group">
        <div class="gh"><div class="gh-name"><button type="button" class="group-toggle" data-action="toggle-hidden" aria-expanded="${showHidden}">
          <span class="chev">${showHidden ? '▾' : '▸'}</span>Hidden (${hiddenRows.length})</button></div>
          <div></div><div></div><div></div><div></div></div>
        ${showHidden ? `${hiddenGroups.length ? `<div class="env"><div class="row">${hiddenGroups.map((name) => `<button type="button" class="btn sm" data-action="show-group" data-group="${esc(name)}">Show group "${esc(name)}"</button>`).join(' ')}</div></div>` : ''}
          ${hiddenRows.map((e) => envelopeRow(e, true)).join('')}` : ''}
      </section>`);
    }
    $('#envelope-rows').innerHTML = parts.join('');
    $('#envelope-rows').classList.toggle('reordering', reordering);
    $('#reorder-btn').setAttribute('aria-pressed', String(reordering));
    $('#reorder-btn').textContent = reordering ? 'Done' : 'Reorder';
    $('#reorder-btn').classList.toggle('primary', reordering);
    $('#empty').hidden = budget.envelopes.length > 0;
    renderSideCards();
    renderRecapBanner();
  }

  // Latest transactions, the closest goal and the biggest loan, at a glance.
  function renderSideCards() {
    renderTransactions();
    renderUpcomingCard();
    const goals = (budget.goals || []).map((g) => [g, B.goalStatus(budget, g, month, 2)]).filter(([, st]) => st.remaining > 0)
      .sort((x, y) => y[1].progress - x[1].progress);
    $('#side-goal').innerHTML = goals.length ? (() => {
      const [g, st] = goals[0];
      const pct = Math.round(st.progress * 100);
      return `<section class="card side-card side-goal"><h2>Goal · ${esc(g.name)}</h2>
        <div class="side-big">${pct}<small>%</small></div>
        <div class="bigbar"><i style="width:${pct}%"></i><b style="left:25%"></b><b style="left:50%"></b><b style="left:75%"></b></div>
        <p>${esc(money(st.value))} of ${esc(money(g.amount))}${st.eta ? ` · around ${esc(fmtMonth(st.eta))}` : ''}</p>
        <button type="button" class="link" data-view="goals">All goals →</button></section>`;
    })() : '';
    const loans = budget.accounts.filter((a) => a.loan);
    $('#side-loan').innerHTML = loans.length ? (() => {
      const a = loans[0];
      const st = L.loanStatus(a.loan, loanTransactions(a.id), { today: todayISO() });
      return `<section class="card side-card side-loan"><h2>Loan · ${esc(a.name)}</h2>
        <div class="side-big">${esc(money(st.owed))}</div>
        <p>${st.paidOff ? 'Paid off 🎉' : st.plan.neverPaysOff ? 'The payment does not cover the interest' : `Debt free ${esc(fmtMonth(st.plan.payoffMonth))}`}${st.progress != null ? ` · ${Math.round(st.progress * 100)}% repaid` : ''}</p>
        <button type="button" class="link" data-view="loans">Loans →</button></section>`;
    })() : '';
    const sk = B.streaks(budget, B.shiftMonth(thisMonth(), -1));
    const best = [
      [sk.allAssigned, `month${sk.allAssigned === 1 ? '' : 's'} with every ${currencyWord()} assigned`],
      [sk.noOverspending, `month${sk.noOverspending === 1 ? '' : 's'} without overspending`],
      [sk.saving, `month${sk.saving === 1 ? '' : 's'} spending less than you earn`],
    ].filter(([n]) => n >= 2).sort((x, y) => y[0] - x[0]);
    $('#side-streak').innerHTML = best.length ? `<section class="card side-card side-streak"><h2>Streak 🔥</h2>
      <div class="streak-n">${best[0][0]}</div><p>${esc(best[0][1])} in a row</p>
      ${best.slice(1).map(([n, t]) => `<p class="hint">${n} ${esc(t)}</p>`).join('')}</section>` : '';
  }

  function render() {
    const view = B.monthView(budget, month);
    const [y] = month.split('-');
    $('#month-label').innerHTML = `${esc(fmtMonthLong(month))} <span class="yr">${esc(y)}</span>`;
    $('#currency').value = budget.currency;
    $('#print-month').textContent = `${fmtMonthLong(month)} ${y} · Ready to assign ${money(view.readyToAssign)}`;
    $('#account').textContent = account ? account.email : '';

    if (currentView === 'account' && !budget.accounts.some((a) => a.id === openAccountId)) currentView = 'accounts';
    if (currentView === 'shared' && !shares.incoming.length) currentView = 'budget';
    const VIEWS = ['budget', 'accounts', 'account', 'reports', 'recap', 'loans', 'goals', 'shared', 'search', 'settings'];
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== currentView;
    const tab = currentView === 'account' ? 'accounts' : currentView === 'recap' ? 'reports' : currentView;
    document.querySelectorAll('.views [data-view], .bottom-nav [data-view], .top-tools [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === tab));
    // The month header and totals belong to the budget; other pages keep the month switcher.
    $('#ready').hidden = currentView !== 'budget';
    $('#stats').hidden = currentView !== 'budget';
    $('#hero').hidden = ['settings', 'search', 'shared', 'accounts', 'loans', 'recap'].includes(currentView);
    $('.fab').hidden = !['budget', 'accounts', 'account', 'search'].includes(currentView);
    $('.bottom-nav').hidden = false;

    renderReady(view);
    renderStats(view);
    renderBudget(view);
    renderEnvelopeOptions();
    syncKind();
    renderAccounts();
    renderRecurring();
    renderShareList();
    renderSettings();
    if (currentView === 'account') renderAccountPage();
    if (currentView === 'reports') renderReport();
    if (currentView === 'loans') renderLoans();
    if (currentView === 'goals') renderGoals();
    if (currentView === 'shared') renderShared();
    if (currentView === 'search') renderSearch();
    if (currentView === 'recap') renderRecap();
  }

  const accountName = (id) => (budget.accounts.find((a) => a.id === id) || {}).name || 'Unknown account';

  function renderAccounts() {
    // On-budget accounts first, then off-budget ones.
    const list = [...budget.accounts].sort((a, c) => Number(!!a.offBudget) - Number(!!c.offBudget));
    const sumOf = (accts) => accts.reduce((sum, a) => sum + B.accountBalance(budget, a.id), 0);
    const on = list.filter((a) => !a.offBudget);
    const off = list.filter((a) => a.offBudget);
    $('#accounts-total').textContent = list.length
      ? `On budget ${money(sumOf(on))}${off.length ? ` · Off budget ${money(sumOf(off))}` : ''}`
      : '';
    $('#accounts-list').innerHTML = list.length ? list.map((a) => {
      const bal = B.accountBalance(budget, a.id);
      const rec = a.reconciledAt ? `Reconciled ${esc(a.reconciledAt)} at ${esc(money(a.reconciledBalance))}` : 'Never reconciled';
      return `<div class="account-row">
        <div><div class="env-name"><button type="button" class="env-link" data-action="open-account" data-id="${a.id}">${esc(a.name)}</button>${a.offBudget ? '<span class="stamp off">Off budget</span>' : ''}${a.loan ? '<span class="stamp shared">Loan</span>' : ''}</div><div class="goal">${rec}</div></div>
        <div class="acct-bal ${bal < 0 ? 'neg' : ''}">${esc(money(bal))}</div>
        <div class="row acct-actions">
          <button type="button" class="btn sm" data-action="reconcile" data-id="${a.id}">Reconcile</button>
          <button type="button" class="btn sm" data-action="rename-account" data-id="${a.id}">Rename</button>
          <button type="button" class="btn sm danger" data-action="delete-account" data-id="${a.id}">Delete</button>
        </div>
      </div>`;
    }).join('') : '<p class="empty">No accounts yet. Add the bank accounts and cash you budget with.</p>';
  }

  function periodStart(period) {
    const today = todayISO();
    if (period === 'month') return `${month}-01`;
    if (period === '3m') return `${B.shiftMonth(today.slice(0, 7), -2)}-01`;
    if (period === 'year') return `${today.slice(0, 4)}-01-01`;
    return null;
  }

  function renderAccountPage() {
    const acct = budget.accounts.find((a) => a.id === openAccountId);
    const bal = B.accountBalance(budget, acct.id);
    $('#acct-title').innerHTML = `${esc(acct.name)}${acct.offBudget ? '<span class="stamp off">Off budget</span>' : ''}`;
    $('#acct-balance').textContent = money(bal);
    $('#acct-balance').classList.toggle('neg', bal < 0);
    // Imported budgets have reconciled transactions but no reconcile date yet.
    const lastReconciled = budget.transactions
      .filter((t) => t.accountId === acct.id && t.reconciled)
      .reduce((d, t) => (t.date > d ? t.date : d), '');
    $('#acct-reconciled').textContent = acct.reconciledAt
      ? `${acct.reconciledAt} at ${money(acct.reconciledBalance)}`
      : lastReconciled ? `Up to ${lastReconciled}` : 'Never';
    $('#acct-reconcile').dataset.id = acct.id;
    $('#acct-loan').hidden = !acct.offBudget;
    $('#acct-loan').dataset.id = acct.id;
    $('#acct-loan').textContent = acct.loan ? 'Loan details' : 'Track as a loan';

    const names = Object.fromEntries(budget.envelopes.map((e) => [e.id, e.name]));
    const from = periodStart($('#acct-period').value);
    const to = $('#acct-period').value === 'month' ? `${month}-31` : null;
    const q = $('#acct-search').value.trim().toLowerCase();
    const rows = B.accountRegister(budget, acct.id).reverse().filter(({ t }) => {
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      if (!q) return true;
      const where = t.envelopeId ? names[t.envelopeId] || '' : '';
      return `${t.payee} ${t.note} ${where}`.toLowerCase().includes(q);
    });
    $('#acct-count').textContent = `${rows.length} transaction${rows.length === 1 ? '' : 's'}`;
    $('#register-rows').innerHTML = rows.length ? rows.map(({ t, balance }) => {
      const where = t.envelopeId ? names[t.envelopeId] || 'Deleted envelope'
        : t.transferId ? `Transfer · ${accountName(t.toAccountId)}`
        : B.countsAsIncome(budget, t) ? 'Ready to Assign' : '—';
      return `<tr>
        <td class="nowrap">${esc(t.date)}</td>
        <td><button type="button" class="env-link" data-action="edit-tx" data-id="${t.id}">${esc(t.payee || (t.amount > 0 ? 'Income' : 'Spending'))}</button>${t.splitId ? '<span class="split-mark">split</span>' : ''}${receiptBtn(t)}
          ${t.note ? `<div class="goal">${esc(t.note)}</div>` : ''}</td>
        <td>${esc(where)}</td>
        <td class="num ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${esc(money(t.amount))}</td>
        <td class="num ${balance < 0 ? 'neg' : ''}">${esc(money(balance))}</td>
        <td class="num">${t.reconciled ? '<span title="Reconciled">✓</span>' : ''}
          <button type="button" class="icon" data-action="delete-tx" data-id="${t.id}" aria-label="Delete transaction">&times;</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">No transactions match.</td></tr>';
  }

  const FREQ_LABEL = { weekly: 'week', monthly: 'month', yearly: 'year' };
  function ruleWhen(r) {
    if (r.freq === 'once') return `On ${fmtDay(r.next)}`;
    const every = r.every === 1 ? `Every ${FREQ_LABEL[r.freq]}` : `Every ${r.every} ${FREQ_LABEL[r.freq]}s`;
    return `${every} · next ${fmtDay(r.next)}`;
  }
  function ruleWhere(r) {
    if (r.kind === 'income') return 'Income';
    const acct = (id) => (budget.accounts.find((a) => a.id === id) || {}).name || 'an account';
    if (r.kind === 'transfer') return `Transfer to ${acct(r.toAccountId)}`;
    const env = budget.envelopes.find((e) => e.id === r.envelopeId);
    return env ? env.name : 'No envelope';
  }
  function ruleRow(r, date = r.next) {
    const sign = r.kind === 'income' ? '+' : '-';
    return `<li class="upcoming-row">
      <div class="tx-main"><button type="button" class="env-link" data-action="edit-rule" data-id="${r.id}">${esc(r.payee || (r.kind === 'income' ? 'Income' : r.kind === 'transfer' ? 'Transfer' : 'Spending'))}</button>${r.receiptId ? ` ${r.receiptType === 'pdf' ? '📄' : '📎'}` : ''}
        <div class="tx-meta">${esc(r.freq === 'once' || date !== r.next ? fmtDay(date) : ruleWhen(r))}${r.freq === 'once' ? '' : ' · repeats'} · ${esc(ruleWhere(r))}</div></div>
      <div class="tx-amt ${r.kind === 'income' ? 'in' : ''}">${sign}${esc(money(r.amount))}</div>
      <button type="button" class="icon tx-del" data-action="remove-recurring" data-id="${r.id}" aria-label="${r.freq === 'once' ? 'Cancel this scheduled transaction' : 'Stop repeating'}">&times;</button>
    </li>`;
  }
  function renderRecurring() {
    const rules = [...(budget.recurring || [])].sort((x, y) => (x.next < y.next ? -1 : x.next > y.next ? 1 : 0));
    $('#recurring-list').innerHTML = rules.length ? rules.map((r) => ruleRow(r)).join('') : '<li class="tx-meta">Nothing coming up.</li>';
  }
  // The next 30 days on the budget page.
  function renderUpcomingCard() {
    const from = todayISO();
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 30);
    const items = B.upcoming(budget, from, d.toISOString().slice(0, 10));
    if (!items.length) { $('#side-upcoming').innerHTML = ''; return; }
    const inSum = items.filter((u) => u.kind === 'income').reduce((t, u) => t + u.amount, 0);
    const outSum = items.filter((u) => u.kind === 'spend').reduce((t, u) => t - u.amount, 0);
    const rules = new Map((budget.recurring || []).map((r) => [r.id, r]));
    $('#side-upcoming').innerHTML = `<section class="card side-card side-upcoming">
      <div class="card-head"><h2>Coming up</h2><span class="hint">next 30 days</span></div>
      <p class="upcoming-sum">${inSum ? `<span class="in">+${esc(money(inSum))} in</span>` : ''}${outSum ? `<span>−${esc(money(outSum))} out</span>` : ''}</p>
      <ul class="tx-list">${items.slice(0, 5).map((u) => ruleRow(rules.get(u.ruleId), u.date)).join('')}</ul>
      ${items.length > 5 ? `<button type="button" class="link" data-view="accounts">All ${items.length} coming up →</button>` : ''}
    </section>`;
  }

  // The drawer, filled from a scheduled or repeating transaction.
  function editRule(id) {
    const r = (budget.recurring || []).find((x) => x.id === id);
    if (!r) return;
    openTx();
    editingRule = r.id;
    const f = $('#tx-form');
    f.querySelector(`input[name="kind"][value="${r.kind}"]`).checked = true;
    f.date.value = r.next;
    f.payee.value = r.payee || '';
    f.amount.value = B.toInput(r.amount);
    f.note.value = r.note || '';
    f.accountId.value = r.accountId;
    if (r.envelopeId) f.envelopeId.value = r.envelopeId;
    if (r.toAccountId) f.toAccountId.value = r.toAccountId;
    f.repeat.value = r.freq === 'once' ? '' : r.freq === 'weekly' && r.every === 2 ? 'biweekly' : r.freq;
    envTouched = true;
    receiptKeep = r.receiptId ? { id: r.receiptId, type: r.receiptType || null, name: r.receiptName || null } : null;
    showReceiptPreview(receiptKeep ? { url: `/api/receipts/${encodeURIComponent(receiptKeep.id)}`, kind: receiptKeep.type === 'pdf' ? 'pdf' : 'image', name: receiptKeep.name } : null);
    $('#tx-heading').textContent = r.freq === 'once' ? 'Scheduled transaction' : 'Repeating transaction';
    $('#tx-submit').textContent = 'Update';
    $('#tx-delete').textContent = r.freq === 'once' ? 'Cancel this scheduled transaction' : 'Stop repeating';
    $('#tx-delete').hidden = false;
    syncKind();
    syncFutureHint();
  }

  // Under the date: what happens with a date in the future.
  function syncFutureHint() {
    const f = $('#tx-form');
    const hint = $('#tx-future-hint');
    const future = f.date.value > todayISO();
    if (editingTx) { hint.hidden = true; return; }
    if (f.repeat.value) {
      hint.textContent = future ? `First one on ${fmtDay(f.date.value)}, then it repeats.` : 'Added now, then it repeats.';
      hint.hidden = false;
    } else if (future) {
      hint.textContent = `Scheduled: added on ${fmtDay(f.date.value)}. Until then it waits under Coming up and does not touch balances or envelopes.`;
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }
  $('#tx-form').date.addEventListener('change', syncFutureHint);
  $('#tx-form').date.addEventListener('input', syncFutureHint);
  $('#tx-form').repeat.addEventListener('change', syncFutureHint);

  // Chart colours: the validated categorical order, read from CSS so light
  // and dark themes use their own steps.
  const seriesColor = (k) => `var(--series-${(k % 7) + 1})`;
  const compact = (cents) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: budget.currency, notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);
    } catch {
      return money(cents);
    }
  };

  function renderReport() {
    renderReportTable();
    const count = Number($('#report-months').value) || 6;
    const r = B.report(budget, month, count);
    const labels = r.months.map((m) => {
      const [y, mo] = m.split('-').map(Number);
      return new Date(y, mo - 1, 1).toLocaleString(undefined, { month: 'short' });
    });
    const sum = (arr) => arr.reduce((a, v) => a + v, 0);
    const income = sum(r.income);
    const spending = sum(r.spending);
    const net = income - spending;
    const worth = B.netWorthSeries(budget, r.months);
    const now = worth[worth.length - 1];

    $('#report-kpis').innerHTML = [
      ['Average income', money(Math.round(income / count)), 'per month'],
      ['Average spending', money(Math.round(spending / count)), 'per month'],
      ['Saved', money(net), income > 0 ? `${Math.round((net / income) * 100)}% of income` : ''],
      ['Net worth', money(now.total), `on budget ${money(now.onBudget)} · off ${money(now.offBudget)}`],
    ].map(([k, v, sub]) => `<div class="kpi"><div class="kpi-label">${esc(k)}</div><div class="kpi-value">${esc(v)}</div><div class="kpi-sub">${esc(sub)}</div></div>`).join('');

    Charts.columns($('#chart-income'), {
      labels,
      series: [
        { name: 'Income', color: seriesColor(0), values: r.income.map((v) => Math.max(0, v)) },
        { name: 'Spending', color: seriesColor(1), values: r.spending.map((v) => Math.max(0, v)) },
      ],
      fmt: money, fmtAxis: compact, label: 'Income and spending per month',
    });

    const groups = B.groupSpending(budget, r.months, 6);
    if (groups.length) {
      Charts.columns($('#chart-groups'), {
        labels,
        series: groups.map((g, k) => ({ name: g.name, color: seriesColor(k), values: g.values })),
        stacked: true, fmt: money, fmtAxis: compact, label: 'Spending by group per month',
      });
    } else {
      $('#chart-groups').innerHTML = '<p class="empty">No spending in these months.</p>';
    }

    Charts.lines($('#chart-networth'), {
      labels,
      series: [
        { name: 'Total', color: seriesColor(0), values: worth.map((w) => w.total) },
        { name: 'On budget', color: seriesColor(1), values: worth.map((w) => w.onBudget) },
        { name: 'Off budget', color: seriesColor(2), values: worth.map((w) => w.offBudget) },
      ],
      fmt: money, fmtAxis: compact, label: 'Net worth at the end of each month',
    });

    const top = r.rows.slice(0, 8).map((row) => ({ label: row.name, value: row.total, note: `${money(row.average)} a month` }));
    if (top.length) {
      Charts.hbars($('#chart-top'), { items: top, color: seriesColor(0), fmt: money, label: 'Envelopes with the most spending' });
    } else {
      $('#chart-top').innerHTML = '<p class="empty">No spending in these months.</p>';
    }

    const f = B.monthForecast(budget, month, todayISO());
    $('#forecast').innerHTML = f
      ? `<p class="forecast-lead">Day ${f.day} of ${f.days}: spent <b>${esc(money(f.spent))}</b>, on pace for <b>${esc(money(f.projected))}</b> by the end of the month.</p>
        ${f.atRisk.length ? `<ul class="insight-list">${f.atRisk.slice(0, 6).map((a) => `<li><span class="status bad">⚠ At risk</span>
          <b>${esc(a.name)}</b> is on pace to be <b>${esc(money(a.short))}</b> short.</li>`).join('')}</ul>`
          : '<p class="status good">✓ Every envelope has enough at this pace.</p>'}`
      : `<p class="hint">Forecasts are for the current month. Use "Today" to jump to it.</p>`;

    const etas = B.targetForecasts(budget, month);
    $('#target-eta').innerHTML = etas.length ? `<ul class="insight-list">${etas.map((t) => {
      const when = t.remaining === 0 ? 'Reached'
        : t.eta ? `Around ${fmtMonth(t.eta)}` : 'Not yet: nothing assigned in the last 3 months';
      const status = t.onTrack === null ? ''
        : t.onTrack ? '<span class="status good">✓ On track</span>' : '<span class="status bad">⚠ Behind</span>';
      return `<li>${status} <b>${esc(t.name)}</b>: ${esc(money(t.available))} of ${esc(money(t.amount))}.
        ${esc(when)}${t.rate > 0 && t.remaining > 0 ? ` at ${esc(money(t.rate))}/month` : ''}${t.due ? ` (due ${esc(fmtMonth(t.due))})` : ''}.</li>`;
    }).join('')}</ul>` : '<p class="hint">Add a "Have a balance" target to an envelope to see when you will reach it.</p>';
  }

  // Redraw charts when the window size changes.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentView === 'reports') renderReport();
      if (currentView === 'loans') renderLoans();
      if (currentView === 'goals') renderGoals();
    }, 150);
  });

  function renderReportTable() {
    const count = Number($('#report-months').value) || 6;
    const r = B.report(budget, month, count);
    const head = r.months.map((m) => `<th class="num month-col">${esc(fmtMonth(m))}</th>`).join('');
    const cells = (arr) => arr.map((v) => `<td class="num month-col">${v ? esc(money(v)) : '—'}</td>`).join('');
    const rows = r.rows.map((row) => `<tr>
      <td><div class="env-name">${esc(row.name)}</div><div class="goal">${esc(row.group)}</div></td>
      ${cells(row.perMonth)}
      <td class="num"><strong>${esc(money(row.total))}</strong></td>
      <td class="num">${esc(money(row.average))}</td>
    </tr>`).join('');
    const net = r.income.map((v, i) => v - r.spending[i]);
    const sum = (arr) => arr.reduce((a, v) => a + v, 0);
    $('#report').innerHTML = r.rows.length || sum(r.income) ? `<table class="report-table">
      <thead><tr><th>Envelope</th>${head}<th class="num">Total</th><th class="num">Average</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td>Spending</td>${cells(r.spending)}<td class="num"><strong>${esc(money(sum(r.spending)))}</strong></td><td class="num">${esc(money(Math.round(sum(r.spending) / count)))}</td></tr>
        <tr><td>Income</td>${cells(r.income)}<td class="num"><strong>${esc(money(sum(r.income)))}</strong></td><td class="num">${esc(money(Math.round(sum(r.income) / count)))}</td></tr>
        <tr><td>Net</td>${net.map((v) => `<td class="num month-col ${v < 0 ? 'neg' : ''}">${esc(money(v))}</td>`).join('')}<td class="num ${sum(net) < 0 ? 'neg' : ''}"><strong>${esc(money(sum(net)))}</strong></td><td class="num">${esc(money(Math.round(sum(net) / count)))}</td></tr>
      </tfoot>
    </table>` : '<p class="empty">No transactions in these months yet.</p>';
  }

  function renderEnvelopeOptions() {
    const sel = $('#tx-envelope');
    const current = sel.value;
    // Hidden envelopes stay out of the picker, unless the transaction being
    // edited already uses one.
    const pickable = budget.envelopes.filter((e) => !B.isHidden(budget, e) || e.id === current);
    sel.innerHTML = pickable.length
      ? pickable.map((e) => `<option value="${e.id}">${esc(e.group)} · ${esc(e.name)}</option>`).join('')
      : '<option value="">Add an envelope first</option>';
    if (budget.envelopes.some((e) => e.id === current)) sel.value = current;

    const acctOptions = budget.accounts.length
      ? budget.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')
      : '<option value="">Main account (created automatically)</option>';
    for (const id of ['#tx-account', '#tx-to']) {
      const el = $(id);
      const keep = el.value;
      el.innerHTML = acctOptions;
      if (budget.accounts.some((a) => a.id === keep)) el.value = keep;
    }

    $('#payee-list').innerHTML = B.payees(budget).slice(0, 300).map((p) => `<option value="${esc(p)}">`).join('');
  }

  // Rows for transaction lists: split lines show as one purchase.
  function groupSplits(txs) {
    const seen = new Set();
    const out = [];
    for (const t of txs) {
      if (t.splitId) {
        if (seen.has(t.splitId)) continue;
        seen.add(t.splitId);
        const legs = txs.filter((x) => x.splitId === t.splitId);
        const withFile = legs.find((l) => l.receiptId);
        out.push({ ...t, amount: legs.reduce((sum, l) => sum + l.amount, 0), legs, receiptId: withFile ? withFile.receiptId : undefined, receiptType: withFile ? withFile.receiptType : undefined });
      } else out.push(t);
    }
    return out;
  }
  const whereText = (t, names) => (t.legs ? `Split · ${t.legs.length} envelopes`
    : t.envelopeId ? names[t.envelopeId] || 'Deleted envelope'
    : t.transferId ? 'Transfer'
    : B.isOnBudget(budget, t.accountId) ? 'Ready to Assign' : 'Off budget');
  const receiptBtn = (t) => {
    if (!t.receiptId) return '';
    const pdf = t.receiptType === 'pdf';
    return `<button type="button" class="receipt-btn" data-action="view-receipt" data-id="${esc(t.receiptId)}" data-tx="${t.id}"${pdf ? ' data-type="pdf"' : ''} title="${pdf ? 'Open the PDF' : 'See the photo'}" aria-label="${pdf ? 'Open the PDF' : 'See the photo'}">${pdf ? '📄' : '📎'}</button>`;
  };

  function renderTransactions() {
    const all = budget.transactions
      .filter((t) => t.date.slice(0, 7) === month)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const txs = groupSplits(all);
    const names = Object.fromEntries(budget.envelopes.map((e) => [e.id, e.name]));
    $('#tx-count').textContent = txs.length ? `${txs.length} this month` : '';
    $('#tx-list').innerHTML = txs.length ? txs.slice(0, 6).map((t) => {
      const label = t.payee || (t.envelopeId || t.legs ? 'Spending' : 'Income');
      const by = t.createdBy && account && t.createdBy !== account.email ? ` · by ${esc(t.createdBy)}` : '';
      return `<li>
        <div class="tx-main"><button type="button" class="env-link" data-action="edit-tx" data-id="${t.id}">${esc(label)}</button>${receiptBtn(t)}
          <div class="tx-meta">${esc(t.date.slice(8))} · ${esc(whereText(t, names))}${by}</div></div>
        <div class="tx-amt ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${esc(money(t.amount))}</div>
      </li>`;
    }).join('') : '<li class="tx-empty tx-meta">No transactions this month yet.</li>';
  }

  // Search across every transaction.
  function renderSearch() {
    const acctSel = $('#search-account');
    const envSel = $('#search-envelope');
    const keepA = acctSel.value;
    const keepE = envSel.value;
    acctSel.innerHTML = `<option value="">All</option>${budget.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}`;
    envSel.innerHTML = `<option value="">All</option>${budget.envelopes.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}`;
    acctSel.value = budget.accounts.some((a) => a.id === keepA) ? keepA : '';
    envSel.value = budget.envelopes.some((e) => e.id === keepE) ? keepE : '';
    const found = B.searchTransactions(budget, {
      q: $('#search-q').value, accountId: acctSel.value, envelopeId: envSel.value,
      from: $('#search-from').value, to: $('#search-to').value,
    });
    const names = Object.fromEntries(budget.envelopes.map((e) => [e.id, e.name]));
    const total = found.reduce((sum, t) => sum + t.amount, 0);
    $('#search-count').textContent = `${found.length} transaction${found.length === 1 ? '' : 's'} · total ${money(total)}`;
    const shown = found.slice(0, 400);
    $('#search-rows').innerHTML = shown.length ? shown.map((t) => `<tr>
      <td class="nowrap">${esc(t.date)}</td>
      <td><button type="button" class="env-link" data-action="edit-tx" data-id="${t.id}">${esc(t.payee || (t.amount > 0 ? 'Income' : 'Spending'))}</button>${t.splitId ? '<span class="split-mark">split</span>' : ''}${receiptBtn(t)}
        ${t.note ? `<div class="goal">${esc(t.note)}</div>` : ''}</td>
      <td>${esc(t.envelopeId ? names[t.envelopeId] || 'Deleted envelope' : t.transferId ? 'Transfer' : '—')}</td>
      <td>${esc(accountName(t.accountId))}</td>
      <td class="num ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${esc(money(t.amount))}</td>
      <td class="num"><button type="button" class="icon" data-action="delete-tx" data-id="${t.id}" aria-label="Delete transaction">&times;</button></td>
    </tr>`).join('') + (found.length > shown.length ? `<tr><td colspan="6" class="empty">Showing the newest ${shown.length}. Narrow the search to see the rest.</td></tr>` : '')
      : '<tr><td colspan="6" class="empty">Nothing matches.</td></tr>';
  }

  // Settings page
  function renderSettings() {
    $('#theme').value = readTheme();
    $('#density').value = readDensity();
    $('#font').value = readFont();
    $('#font-preview').textContent = money(123456);
    $('#sound-on').checked = Sounds.on;
    $('#sound-volume').value = Math.round(Sounds.volume * 100);
    $('#volume-field').hidden = !Sounds.on;
    const on = !!(account && account.twofa);
    $('#twofa-status').textContent = on
      ? `On. Signing in needs a code from your authenticator app. ${account.recoveryLeft} recovery code${account.recoveryLeft === 1 ? '' : 's'} left.`
      : 'Off. Turn it on so a stolen password is not enough to get in.';
    $('#twofa-btn').textContent = on ? 'Manage two-step sign-in' : 'Turn on two-step sign-in';
  }

  $('#password-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const msg = $('#password-msg');
    msg.classList.remove('ok');
    msg.hidden = true;
    if (f.next.value !== f.repeat.value) {
      msg.textContent = 'The two new passwords are not the same.';
      msg.hidden = false;
      return;
    }
    try {
      await api('POST', '/api/password', { current: f.current.value, next: f.next.value });
      f.reset();
      msg.textContent = 'Password changed. Your other devices were signed out.';
      msg.classList.add('ok');
      msg.hidden = false;
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
    }
  });

  // A small dialog that asks for the password before something sensitive.
  function askPassword(title, text, action, danger = false) {
    return new Promise((resolve) => {
      const d = $('#twofa-dialog');
      $('#twofa-body').innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p>
        <form class="stack" id="ask-pass-form"><label>Your password <input type="password" name="password" required autocomplete="current-password"></label>
        <div class="row"><button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(action)}</button>
        <button type="button" class="btn" data-action="close-dialog">Cancel</button></div></form>`;
      let done = false;
      $('#ask-pass-form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        done = true;
        resolve(ev.target.password.value);
      });
      d.addEventListener('close', () => { if (!done) resolve(null); }, { once: true });
      d.showModal();
      setTimeout(() => d.querySelector('input').focus(), 30);
    });
  }

  async function deleteMyAccount() {
    const pass = await askPassword('Delete your account', 'This deletes your account, your budget, your receipts and anything you share. It cannot be undone. Export a backup first if you want to keep a copy.', 'Delete my account', true);
    if (!pass) return;
    try {
      await api('POST', '/api/account/delete', { password: pass });
      $('#twofa-dialog').close();
      dropPending();
      showAuth('Your account was deleted.');
    } catch (err) {
      $('#twofa-dialog').close();
      showError(err.message);
    }
  }

  function downloadText(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showRecoveryCodes(codes) {
    const body = $('#twofa-body');
    body.innerHTML = `<h2>Recovery codes</h2>
      <p>Keep these somewhere safe, like a password manager. Each one signs you in once if you lose your phone.</p>
      <div class="codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
      <div class="row"><button type="button" class="btn" id="codes-dl">Download</button>
      <button type="button" class="btn primary" data-action="close-dialog">I saved them</button></div>`;
    $('#codes-dl').addEventListener('click', () => downloadText('envelo-recovery-codes.txt', `Envelo recovery codes for ${account.email}\n\n${codes.join('\n')}\n`));
  }

  async function twofaFlow() {
    const d = $('#twofa-dialog');
    const body = $('#twofa-body');
    if (account.twofa) {
      body.innerHTML = `<h2>Two-step sign-in</h2><p>It is on. ${account.recoveryLeft} recovery code${account.recoveryLeft === 1 ? '' : 's'} left.</p>
        <div class="row"><button type="button" class="btn" id="tf-new">New recovery codes</button>
        <button type="button" class="btn danger" id="tf-off">Turn off</button>
        <button type="button" class="btn" data-action="close-dialog">Close</button></div>`;
      d.showModal();
      $('#tf-new').addEventListener('click', async () => {
        d.close();
        const pass = await askPassword('New recovery codes', 'Your old recovery codes stop working.', 'Make new codes');
        if (!pass) return;
        try {
          const res = await api('POST', '/api/2fa/recovery', { password: pass });
          account = res.user;
          showRecoveryCodes(res.recoveryCodes);
          renderSettings();
        } catch (err) { d.close(); showError(err.message); }
      });
      $('#tf-off').addEventListener('click', async () => {
        d.close();
        const pass = await askPassword('Turn off two-step sign-in', 'Signing in will only need your password.', 'Turn off', true);
        if (!pass) return;
        try {
          const res = await api('POST', '/api/2fa/disable', { password: pass });
          account = res.user;
          d.close();
          renderSettings();
          toast('Two-step sign-in is off');
        } catch (err) { d.close(); showError(err.message); }
      });
      return;
    }
    let setup;
    try {
      setup = await api('POST', '/api/2fa/setup');
    } catch (err) {
      showError(err.message);
      return;
    }
    let qr = '';
    try {
      const q = qrcode(0, 'M');
      q.addData(setup.uri);
      q.make();
      qr = q.createSvgTag({ cellSize: 5, margin: 2, scalable: false });
    } catch { qr = ''; }
    body.innerHTML = `<h2>Two-step sign-in</h2>
      <p>1. Scan this with an authenticator app (Google Authenticator, Aegis, 1Password, Bitwarden…).</p>
      ${qr ? `<div class="qr">${qr}</div>` : ''}
      <p class="hint">Or type this key into the app:</p><div class="secret">${esc(setup.secret.replace(/(.{4})/g, '$1 ').trim())}</div>
      <form class="stack" id="tf-form"><label>2. Enter the 6-digit code it shows
        <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>
        <p class="auth-message" id="tf-err" hidden></p>
        <div class="row"><button type="submit" class="btn primary">Turn on</button><button type="button" class="btn" data-action="close-dialog">Cancel</button></div></form>`;
    d.showModal();
    $('#tf-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const res = await api('POST', '/api/2fa/enable', { code: ev.target.code.value });
        account = res.user;
        renderSettings();
        Sounds.play('stamp');
        showRecoveryCodes(res.recoveryCodes);
      } catch (err) {
        $('#tf-err').textContent = err.message;
        $('#tf-err').hidden = false;
      }
    });
  }

  // Auth

  let authMode = 'login';
  function showAuth(message = '') {
    account = null;
    stopLive();
    shares = { outgoing: [], incoming: [] };
    document.querySelectorAll('.nav-shared').forEach((el) => { el.hidden = true; });
    budget = B.create();
    $('#app').hidden = true;
    $('.fab').hidden = true;
    $('.bottom-nav').hidden = true;
    $('#auth').hidden = false;
    $('#auth-message').textContent = message;
    $('#auth-message').hidden = !message;
    $('#auth-password').value = '';
    // Always come back to "Sign in", whatever tab was used before.
    authMode = 'login';
    document.querySelectorAll('[data-auth-mode]').forEach((b) => b.classList.toggle('active', b.dataset.authMode === 'login'));
    $('#auth-hint').textContent = '';
    authStep('password');
  }

  function showApp() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    render();
    startLive();
    loadShares();
    celebrateZeroArmed = true;
    // A brand-new budget gets the setup guide.
    if (!budget.envelopes.length && !budget.accounts.length && !budget.transactions.length) openWelcome();
    // The home-screen shortcut "Add a transaction" opens the form.
    if (new URLSearchParams(location.search).get('add') === '1') openTx();
  }

  // Steps of signing in: the password, then (if needed) a code or a new password.
  function authStep(step) {
    $('#auth-fields').hidden = step !== 'password';
    $('#auth-code-field').hidden = step !== 'code';
    $('#auth-newpass-field').hidden = step !== 'newpass';
    $('#auth-code').required = step === 'code';
    $('#auth-newpass').required = step === 'newpass';
    document.querySelector('.auth-tabs').hidden = step !== 'password';
    $('#auth-submit').textContent = step === 'code' ? 'Check code' : step === 'newpass' ? 'Save and sign in'
      : authMode === 'login' ? 'Sign in' : 'Create account';
    if (step === 'code') setTimeout(() => $('#auth-code').focus(), 0);
    if (step === 'newpass') setTimeout(() => $('#auth-newpass').focus(), 0);
  }
  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      authMode = btn.dataset.authMode;
      document.querySelectorAll('[data-auth-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      authStep('password');
      $('#auth-hint').textContent = authMode === 'login'
        ? ''
        : 'Passwords must be at least 8 characters. Your budget is stored on this server, so you can use it from any device.';
      $('#auth-password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
      $('#auth-message').hidden = true;
    });
  });

  $('#auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      const path = authMode === 'login' ? '/api/login' : '/api/register';
      const body = { email: f.email.value, password: f.password.value };
      if (!$('#auth-code-field').hidden) body.code = f.code.value;
      if (!$('#auth-newpass-field').hidden) body.newPassword = f.newPassword.value;
      const { user } = await api('POST', path, body);
      account = user;
      f.code.value = '';
      f.newPassword.value = '';
      await loadBudget();
      showApp();
    } catch (err) {
      if (err.data && err.data.needCode) authStep('code');
      if (err.data && err.data.needNewPassword) authStep('newpass');
      const quiet = err.data && ((err.data.needCode && $('#auth-code').value === '') || (err.data.needNewPassword && !f.newPassword.value));
      $('#auth-message').textContent = err.message;
      $('#auth-message').hidden = !!quiet;
    } finally {
      btn.disabled = false;
    }
  });

  // Unsaved changes are also kept on this device, so closing the app while
  // offline loses nothing: they are sent the next time it opens.
  const pendingKey = () => `envelo.pending.${account ? account.email : ''}`;
  function keepPending() {
    try { localStorage.setItem(pendingKey(), JSON.stringify({ revision, budget })); } catch { /* full or blocked */ }
  }
  function dropPending() {
    try { localStorage.removeItem(pendingKey()); } catch { /* ignore */ }
  }

  async function loadBudget() {
    const res = await api('GET', '/api/budget');
    budget = res.budget ? B.fromJSON(res.budget) : B.create();
    revision = res.revision || 0;
    setSync('');
    undoStack.length = 0;
    try {
      const pending = JSON.parse(localStorage.getItem(pendingKey()) || 'null');
      if (pending && pending.revision === revision && pending.budget) {
        budget = B.fromJSON(pending.budget);
        scheduleSave();
        setSync('Sending changes made offline…');
      } else if (pending) dropPending();
    } catch { /* ignore a damaged copy */ }
    // Create any recurring transactions that came due since the last visit.
    if (B.applyRecurring(budget, todayISO()) > 0) scheduleSave();
  }

  async function logout() {
    await flush();
    try {
      await api('POST', '/api/logout');
    } catch {
      // Ignore: the local session is cleared either way.
    }
    dropPending();
    showAuth();
  }

  // Events

  function closeDialogs() {
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  }

  function goTo(view) {
    currentView = view;
    closeDialogs();
    render();
    window.scrollTo(0, 0);
    if (view === 'search') setTimeout(() => $('#search-q').focus(), 0);
  }

  const envName = (id) => (budget.envelopes.find((e) => e.id === id) || {}).name || 'envelope';

  document.addEventListener('click', (ev) => {
    const viewBtn = ev.target.closest('[data-view]');
    if (viewBtn && !viewBtn.closest('[data-action]')) {
      goTo(viewBtn.dataset.view);
      return;
    }
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'prev-month': month = B.shiftMonth(month, -1); render(); break;
      case 'next-month': month = B.shiftMonth(month, 1); render(); break;
      case 'this-month': month = thisMonth(); render(); break;
      case 'fund': {
        const cur = B.assignedIn(budget, month, btn.dataset.id);
        const prev = B.monthView(budget, month);
        const amount = Number(btn.dataset.amount);
        if (attempt(() => B.setAssigned(budget, month, btn.dataset.id, cur + amount), `Assigned ${money(amount)} to ${envName(btn.dataset.id)}`)) {
          fundFx(prev, [btn.dataset.id]);
        }
        break;
      }
      case 'delete-tx': {
        const t = budget.transactions.find((x) => x.id === btn.dataset.id);
        if (!t) break;
        if (attempt(() => B.removeTransaction(budget, t.id), `Deleted ${t.payee || 'transaction'} ${money(t.amount)}`)) Sounds.play('crumple');
        break;
      }
      case 'fund-all': {
        let total = 0;
        const prev = B.monthView(budget, month);
        const snapshot = JSON.stringify(budget);
        const ok = attempt(() => { total = B.fundAllTargets(budget, month); });
        if (ok && total === 0) showError('There is no money in Ready to Assign to fund targets.');
        if (ok && total > 0) {
          undoStack.push({ label: `Assigned ${money(total)} to your targets`, snapshot });
          fundFx(prev, budget.envelopes.map((e) => e.id));
          toast(`Assigned ${money(total)} to your targets`, { action: 'Undo', onAction: undo });
        }
        break;
      }
      case 'cover': openMove({ to: btn.dataset.id, cover: true }); break;
      case 'move-money': openMove({}); break;
      case 'edit-target': openTarget(btn.dataset.id); break;
      case 'edit-tx': editTransaction(btn.dataset.id); break;
      case 'new-tx': openTx(); break;
      case 'edit-rule': editRule(btn.dataset.id); break;
      case 'delete-editing-tx': {
        if (editingRule) {
          const r = (budget.recurring || []).find((x) => x.id === editingRule);
          $('#tx-dialog').close();
          if (r && attempt(() => B.removeRecurring(budget, r.id), `${r.freq === 'once' ? 'Cancelled' : 'Stopped'} ${r.payee || 'a scheduled transaction'}`)) Sounds.play('crumple');
          break;
        }
        const t = budget.transactions.find((x) => x.id === editingTx);
        $('#tx-dialog').close();
        if (t && attempt(() => B.removeTransaction(budget, t.id), `Deleted ${t.payee || 'transaction'}`)) Sounds.play('crumple');
        break;
      }
      case 'close-tx': $('#tx-dialog').close(); break;
      case 'split-tx': startSplit(); break;
      case 'add-split': addSplitRow('', ''); updateSplitLeft(); break;
      case 'remove-split': btn.closest('.split-row').remove(); if ($('#split-rows').children.length < 2) stopSplit(); else updateSplitLeft(); break;
      case 'remove-receipt-draft': clearReceiptDraft(); break;
      case 'view-receipt':
        if (btn.dataset.type === 'pdf') window.open(`/api/receipts/${encodeURIComponent(btn.dataset.id)}`, '_blank', 'noopener');
        else openReceipt(btn.dataset.id, btn.dataset.tx);
        break;
      case 'delete-receipt': deleteReceipt(); break;
      case 'new-envelope': openNewEnvelope({ group: btn.dataset.group || null }); break;
      case 'add-sub-envelope': {
        const parent = budget.envelopes.find((e) => e.id === editingTarget);
        $('#target-dialog').close();
        if (parent) openNewEnvelope({ parentId: parent.id });
        break;
      }
      case 'pick-sticker': toggleStickers(btn.closest('form')); break;
      case 'set-sticker': setSticker(btn.closest('form'), btn.dataset.emoji || ''); break;
      case 'reorder': reordering = !reordering; render(); break;
      case 'move-group': if (attempt(() => B.moveGroup(budget, btn.dataset.group, Number(btn.dataset.dir)))) Sounds.play('tick'); break;
      case 'move-env': if (attempt(() => B.moveEnvelope(budget, btn.dataset.id, Number(btn.dataset.dir)))) Sounds.play('tick'); break;
      case 'toggle-group': toggleCollapsed(btn.dataset.group); render(); break;
      case 'toggle-hidden': showHidden = !showHidden; render(); break;
      case 'group-color': openColor(btn.dataset.group); break;
      case 'set-color':
        if (attempt(() => B.setGroupColor(budget, colorGroup, Number(btn.dataset.color)))) $('#color-dialog').close();
        break;
      case 'hide-group': attempt(() => B.setGroupHidden(budget, btn.dataset.group, true), `Hid ${btn.dataset.group}`); break;
      case 'show-group': attempt(() => B.setGroupHidden(budget, btn.dataset.group, false)); break;
      case 'unhide-envelope': {
        const env = budget.envelopes.find((x) => x.id === btn.dataset.id);
        if (env) {
          attempt(() => {
            B.updateEnvelope(budget, env.id, { name: env.name, group: env.group, hidden: false });
            B.setGroupHidden(budget, env.group, false);
          });
        }
        break;
      }
      case 'print': window.print(); break;
      case 'delete-envelope': {
        const f = $('#target-form');
        const env = budget.envelopes.find((e) => e.id === editingTarget);
        if (!env) break;
        const snapshot = JSON.stringify(budget);
        try {
          B.deleteEnvelope(budget, editingTarget, f.moveTo.value || null);
        } catch (err) {
          $('#target-error').textContent = err.message;
          $('#target-error').hidden = false;
          break;
        }
        $('#target-dialog').close();
        undoStack.push({ label: `Deleted ${env.name}`, snapshot });
        attempt(() => {});
        toast(`Deleted ${env.name}`, { action: 'Undo', onAction: undo });
        Sounds.play('crumple');
        break;
      }
      case 'remove-recurring': {
        const r = (budget.recurring || []).find((x) => x.id === btn.dataset.id);
        if (r) attempt(() => B.removeRecurring(budget, r.id), `${r.freq === 'once' ? 'Cancelled' : 'Stopped'} ${r.payee || 'a scheduled transaction'}`);
        break;
      }
      case 'rename-account': {
        const acct = budget.accounts.find((a) => a.id === btn.dataset.id);
        const name = acct && prompt('New name for this account', acct.name);
        if (name) attempt(() => B.updateAccount(budget, acct.id, { name }), `Renamed ${acct.name}`);
        break;
      }
      case 'delete-account': {
        const acct = budget.accounts.find((a) => a.id === btn.dataset.id);
        if (acct && confirm(`Delete the account "${acct.name}"?`)) attempt(() => B.deleteAccount(budget, acct.id), `Deleted ${acct.name}`);
        break;
      }
      case 'reconcile': openReconcile(btn.dataset.id); break;
      case 'open-account':
        openAccountId = btn.dataset.id;
        $('#acct-search').value = '';
        goTo('account');
        break;
      case 'new-share': flush(); openShare(null); break;
      case 'edit-share': openShare(btn.dataset.id); break;
      case 'close-share': $('#share-dialog').close(); break;
      case 'stop-share': {
        const sh = shares.outgoing.find((x) => x.id === editingShare);
        if (sh && confirm(`Stop sharing with ${sh.member}? Spending they added stays in your budget.`)) {
          api('DELETE', `/api/shares/${sh.id}`).then(() => { $('#share-dialog').close(); loadShares(); })
            .catch((e) => { $('#share-error').textContent = e.message; $('#share-error').hidden = false; });
        }
        break;
      }
      case 'leave-share': {
        const sh = shares.incoming.find((x) => x.id === btn.dataset.id);
        if (sh && confirm(`Leave the envelopes ${sh.owner} shared with you?`)) {
          api('DELETE', `/api/shares/${sh.id}`).then(loadShares).catch((e) => showError(e.message));
        }
        break;
      }
      case 'delete-shared-tx':
        if (confirm('Delete this spending?')) {
          api('DELETE', `/api/shared/${btn.dataset.share}/transactions/${btn.dataset.id}`)
            .then((res) => { sharedData[btn.dataset.share] = { ...res, budget: B.fromJSON(res.budget) }; render(); Sounds.play('crumple'); })
            .catch((e) => showError(e.message));
        }
        break;
      case 'new-goal': openGoal(null); break;
      case 'edit-goal': openGoal(btn.dataset.id); break;
      case 'close-goal': $('#goal-dialog').close(); break;
      case 'delete-goal': {
        const g = (budget.goals || []).find((x) => x.id === editingGoal);
        if (g) {
          $('#goal-dialog').close();
          attempt(() => B.removeGoal(budget, g.id), `Deleted the goal ${g.name}`);
        }
        break;
      }
      case 'new-loan': openLoan(null); break;
      case 'edit-loan': openLoan(btn.dataset.id); break;
      case 'close-loan': $('#loan-dialog').close(); break;
      case 'remove-loan': {
        const acct = budget.accounts.find((a) => a.id === editingLoan);
        if (acct) {
          $('#loan-dialog').close();
          attempt(() => { delete acct.loan; }, `Stopped tracking ${acct.name} as a loan`);
        }
        break;
      }
      case 'loan-interest': {
        const acct = budget.accounts.find((a) => a.id === btn.dataset.id);
        const amount = Number(btn.dataset.amount);
        if (!acct || !(amount > 0)) break;
        const done = loanTransactions(acct.id).some((t) => t.payee === 'Interest' && t.date.slice(0, 7) === thisMonth());
        if (done && !confirm('Interest was already recorded this month. Record it again?')) break;
        attempt(() => B.addTransaction(budget, { kind: 'spend', date: todayISO(), payee: 'Interest', amount, accountId: acct.id }),
          `Added ${money(amount)} interest to ${acct.name}`);
        break;
      }
      case 'add-rate-change': {
        const rows = document.querySelectorAll('#rate-change-rows .rc-row').length;
        addRateChangeRow(String((rows + 1) * 5), '');
        renderCalculator();
        break;
      }
      case 'remove-rate-change': btn.closest('.rc-row').remove(); renderCalculator(); break;
      case 'calc-track':
        if (!lastCalc) break;
        openLoan(null, {
          name: '', owed: lastCalc.amount, original: lastCalc.amount, rate: lastCalc.rate,
          payment: lastCalc.payment + lastCalc.extra, startDate: `${lastCalc.start}-01`,
        });
        break;
      case 'calc-envelope': {
        if (!lastCalc) break;
        const name = prompt('Name of the envelope for the loan payment', 'Loan payment');
        if (!name) break;
        attempt(() => B.addEnvelope(budget, { name, group: 'Loans', target: { type: 'monthly', amount: lastCalc.payment + lastCalc.extra } }),
          `Created "${name}" with a target of ${money(lastCalc.payment + lastCalc.extra)} a month`);
        break;
      }
      case 'back-to-accounts': goTo('accounts'); break;
      case 'close-reconcile': $('#reconcile-dialog').close(); break;
      case 'close-target': $('#target-dialog').close(); break;
      case 'close-dialog': { const d = btn.closest('dialog'); if (d) d.close(); break; }
      case 'more': $('#more-dialog').showModal(); break;
      case 'export': exportBackup(); break;
      case 'import': $('#import-file').click(); break;
      case 'import-actual': $('#import-actual-file').click(); break;
      case 'bank-import': openBankImport(currentView === 'account' ? openAccountId : null); break;
      case 'logout': logout(); break;
      case 'reset':
        if (confirm('Erase every envelope and transaction on your account? You can undo this right after.')) {
          attempt(() => { budget = B.create(); }, 'Erased all budget data');
        }
        break;
      case 'delete-my-account': deleteMyAccount(); break;
      case 'twofa': twofaFlow(); break;
      case 'test-sound': {
        const was = Sounds.on;
        Sounds.set({ on: true });
        Sounds.play('register');
        Sounds.set({ on: was });
        break;
      }
      case 'show-keys': $('#keys-dialog').showModal(); break;
      case 'open-welcome': openWelcome(); break;
      case 'open-recap': {
        // The month shown, or (for the current month) the last one with transactions.
        let m = month === thisMonth() ? B.shiftMonth(month, -1) : month;
        for (let i = 0; i < 24 && !budget.transactions.some((t) => t.date.slice(0, 7) === m); i++) m = B.shiftMonth(m, -1);
        recapMonth = budget.transactions.some((t) => t.date.slice(0, 7) === m) ? m : B.shiftMonth(thisMonth(), -1);
        goTo('recap');
        break;
      }
      case 'recap-month': recapMonth = btn.dataset.month; renderRecap(); break;
      case 'dismiss-recap': markRecapSeen(); renderRecapBanner(); break;
      case 'see-recap': markRecapSeen(); recapMonth = B.shiftMonth(thisMonth(), -1); goTo('recap'); break;
      case 'apply-hint': {
        const amount = Number(btn.dataset.amount);
        attempt(() => B.setTarget(budget, btn.dataset.id, { type: 'monthly', amount }), `Set ${envName(btn.dataset.id)} to ${money(amount)} a month`);
        break;
      }
    }
  });

  let reconcilingAccount = null;
  function openReconcile(id) {
    const acct = budget.accounts.find((a) => a.id === id);
    if (!acct) return;
    reconcilingAccount = id;
    const f = $('#reconcile-form');
    $('#reconcile-title').textContent = `Reconcile ${acct.name}`;
    $('#reconcile-info').textContent = `Envelo shows ${money(B.accountBalance(budget, id))} in this account.`;
    $('#reconcile-error').hidden = true;
    f.bank.value = B.toInput(B.accountBalance(budget, id));
    f.date.value = todayISO();
    $('#reconcile-dialog').showModal();
  }

  $('#reconcile-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const bank = B.parseMoney(f.bank.value);
    let diff = 0;
    const snapshot = JSON.stringify(budget);
    try {
      if (Number.isNaN(bank)) throw new Error('Enter the balance your bank shows.');
      diff = B.reconcileAccount(budget, reconcilingAccount, bank, f.date.value);
    } catch (err) {
      $('#reconcile-error').textContent = err.message;
      $('#reconcile-error').hidden = false;
      return;
    }
    $('#reconcile-dialog').close();
    undoStack.push({ label: 'Reconciled', snapshot });
    attempt(() => {});
    const acct = budget.accounts.find((a) => a.id === reconcilingAccount);
    Sounds.play('register');
    celebrate(diff === 0
      ? `🎉 ${acct ? acct.name : 'Account'} matches your bank`
      : `🎉 Reconciled. Added an adjustment of ${money(diff)} to match your bank`);
  });

  $('#account-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const bal = f.balance.value.trim() ? B.parseMoney(f.balance.value) : 0;
    const ok = attempt(() => {
      if (Number.isNaN(bal)) throw new Error('Balance must be an amount like 1200.00.');
      B.addAccount(budget, { name: f.acctName.value, balance: bal, date: todayISO(), offBudget: f.offBudget.checked });
    }, `Added the account ${f.acctName.value}`);
    if (ok) f.reset();
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('input[data-env]')) {
      const cents = B.parseMoney(t.value);
      if (Number.isNaN(cents)) {
        showError('Assigned amount must be a number like 120.00.');
        render();
        return;
      }
      const before = B.assignedIn(budget, month, t.dataset.env);
      if (cents === before) return;
      const prev = B.monthView(budget, month);
      const wasOk = prev.groups.flatMap((g) => g.envelopes).find((e) => e.id === t.dataset.env);
      if (attempt(() => B.setAssigned(budget, month, t.dataset.env, cents), `${envName(t.dataset.env)}: ${money(before)} → ${money(cents)}`)) {
        fundFx(prev, [t.dataset.env]);
        const after = B.envelopeStatus(budget, t.dataset.env, month);
        if (wasOk && wasOk.available >= 0 && after.available < 0) Sounds.play('thud');
      }
    } else if (t.id === 'currency') {
      attempt(() => { budget.currency = t.value; }, `Currency set to ${t.value}`);
    } else if (t.id === 'acct-period') {
      renderAccountPage();
    } else if (t.id === 'report-months') {
      renderReport();
    } else if (t.id === 'density') {
      applyDensity(t.value);
    } else if (t.id === 'theme') {
      applyTheme(t.value);
    } else if (t.id === 'font') {
      applyFont(t.value);
      render();
    } else if (t.id === 'sound-on') {
      Sounds.set({ on: t.checked });
      if (t.checked) Sounds.play('coin');
      renderSettings();
    } else if (t.id === 'sound-volume') {
      Sounds.set({ volume: Number(t.value) / 100 });
      Sounds.play('coin');
    } else if (t.id === 'import-actual-file') {
      importActual(t.files[0]);
      t.value = '';
    } else if (t.id === 'import-file') {
      importBackup(t.files[0]);
      t.value = '';
    } else if (t.id === 'tx-receipt') {
      takeReceipt(t.files[0]);
      t.value = '';
    } else if (t.matches('#search-account, #search-envelope, #search-from, #search-to')) {
      renderSearch();
    }
  });

  $('#acct-search').addEventListener('input', () => renderAccountPage());
  $('#search-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 120); });
  let searchTimer = null;

  // Flush pending changes when the tab is hidden, e.g. before the browser closes it.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      flush();
      return;
    }
    // Coming back to the tab: add anything scheduled that came due (the app
    // may have stayed open past midnight), then pick up other devices' changes.
    if (account && B.applyRecurring(budget, todayISO()) > 0) { scheduleSave(); render(); }
    reloadFromServer();
  });
  window.addEventListener('online', () => { if (dirty) flush(); });

  // Keyboard shortcuts. Ignored while typing, except Escape (dialogs close by themselves).
  document.addEventListener('keydown', (ev) => {
    if (!account || $('#app').hidden) return;
    const typing = ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable="true"]');
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z' && !typing) {
      ev.preventDefault();
      undo();
      return;
    }
    if (typing || ev.ctrlKey || ev.metaKey || ev.altKey || document.querySelector('dialog[open]')) return;
    const views = { 1: 'budget', 2: 'accounts', 3: 'reports', 4: 'goals', 5: 'loans' };
    const k = ev.key;
    if (k === 'n' || k === 'N') { ev.preventDefault(); openTx(); }
    else if (k === 'e' || k === 'E') { ev.preventDefault(); openNewEnvelope(); }
    else if (k === 'm' || k === 'M') { ev.preventDefault(); openMove({}); }
    else if (k === '/') { ev.preventDefault(); goTo('search'); }
    else if (k === 'ArrowLeft') { month = B.shiftMonth(month, -1); render(); }
    else if (k === 'ArrowRight') { month = B.shiftMonth(month, 1); render(); }
    else if (k === 't' || k === 'T') { month = thisMonth(); render(); }
    else if (k === '?') { $('#keys-dialog').showModal(); }
    else if (views[k]) goTo(views[k]);
  });

  // Transaction drawer

  let envTouched = false;
  let splitOn = false;
  let receiptDraft = null; // { blob, url, kind: 'image'|'pdf', name } waiting to be uploaded
  let receiptKeep = null; // { id, type, name } already on the transaction being edited
  let editingRule = null; // id of the scheduled transaction being edited
  const LAST_ACCOUNT = 'envelo.lastAccount';

  function openTx({ accountId = null, envelopeId = null } = {}) {
    editingTx = null;
    editingRule = null;
    const f = $('#tx-form');
    f.reset();
    stopSplit();
    clearReceiptDraft();
    receiptKeep = null;
    envTouched = !!envelopeId;
    f.date.value = todayISO();
    renderEnvelopeOptions();
    let acct = accountId || (currentView === 'account' ? openAccountId : null);
    if (!acct) { try { acct = localStorage.getItem(LAST_ACCOUNT); } catch { acct = null; } }
    if (acct && budget.accounts.some((a) => a.id === acct)) f.accountId.value = acct;
    if (envelopeId) f.envelopeId.value = envelopeId;
    $('#tx-heading').textContent = 'Add transaction';
    $('#tx-submit').textContent = 'Save transaction';
    $('#tx-delete').hidden = true;
    $('#tx-delete').textContent = 'Delete this transaction';
    $('#tx-repeat-field').hidden = false;
    $('#tx-error').hidden = true;
    syncKind();
    syncFutureHint();
    if (!$('#tx-dialog').open) { $('#tx-dialog').showModal(); Sounds.play('whoosh'); }
    setTimeout(() => f.amount.focus(), 30);
  }

  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', () => { if (splitOn) stopSplit(); syncKind(); }));
  $('#tx-account').addEventListener('change', syncKind);
  $('#tx-to').addEventListener('change', syncKind);
  $('#tx-envelope').addEventListener('change', () => { envTouched = true; });
  function syncKind() {
    const kind = document.querySelector('input[name="kind"]:checked').value;
    const from = $('#tx-account').value;
    const to = $('#tx-to').value;
    // Envelopes apply to spending in on-budget accounts, and to transfers
    // that move money out of the budget into an off-budget account.
    const needsEnvelope = kind === 'spend'
      ? B.isOnBudget(budget, from)
      : kind === 'transfer' && !!to && B.transferNeedsEnvelope(budget, from, to);
    $('#tx-envelope-field').hidden = !needsEnvelope || splitOn;
    $('#tx-envelope').required = needsEnvelope && !splitOn;
    $('#split-toggle').hidden = !(kind === 'spend' && B.isOnBudget(budget, from)) || splitOn;
    $('#split-box').hidden = !splitOn;
    $('#tx-to-field').hidden = kind !== 'transfer';
    $('#tx-account-label').textContent = kind === 'transfer' ? 'From account' : 'Account';
    $('#tx-repeat-field').hidden = kind === 'transfer' || !!editingTx || splitOn;
  }

  // Payee memory: a known payee fills in the envelope and account used last time.
  $('#tx-form').payee.addEventListener('change', (ev) => {
    if (editingTx) return;
    const mem = B.payeeMemory(budget, ev.target.value);
    if (!mem) return;
    const f = $('#tx-form');
    if (!envTouched && !splitOn) {
      f.querySelector(`input[name="kind"][value="${mem.kind}"]`).checked = true;
      if (mem.envelopeId) f.envelopeId.value = mem.envelopeId;
    }
    if (mem.accountId && budget.accounts.some((a) => a.id === mem.accountId)) f.accountId.value = mem.accountId;
    syncKind();
  });

  // Splits
  function envelopeOptionsHtml(selected) {
    const pickable = budget.envelopes.filter((e) => !B.isHidden(budget, e) || e.id === selected);
    return `<option value="">Pick an envelope</option>${pickable.map((e) => `<option value="${e.id}" ${e.id === selected ? 'selected' : ''}>${esc(e.group)} · ${esc(e.name)}</option>`).join('')}`;
  }
  function addSplitRow(envelopeId, amount) {
    const row = document.createElement('div');
    row.className = 'split-row';
    row.innerHTML = `<select aria-label="Envelope">${envelopeOptionsHtml(envelopeId)}</select>
      <input type="text" inputmode="decimal" aria-label="Amount" placeholder="0.00" value="${esc(amount)}">
      <button type="button" class="icon" data-action="remove-split" aria-label="Remove this line">&times;</button>`;
    row.querySelector('input').addEventListener('input', updateSplitLeft);
    $('#split-rows').appendChild(row);
  }
  function startSplit(lines = null) {
    const f = $('#tx-form');
    splitOn = true;
    $('#split-rows').innerHTML = '';
    if (lines) lines.forEach((l) => addSplitRow(l.envelopeId, B.toInput(l.amount)));
    else {
      addSplitRow(f.envelopeId.value, f.amount.value);
      addSplitRow('', '');
    }
    syncKind();
    updateSplitLeft();
  }
  function stopSplit() {
    splitOn = false;
    $('#split-rows').innerHTML = '';
    syncKind();
  }
  function splitLines() {
    return [...document.querySelectorAll('#split-rows .split-row')].map((r) => ({
      envelopeId: r.querySelector('select').value,
      amount: B.parseMoney(r.querySelector('input').value || '0'),
    }));
  }
  function updateSplitLeft() {
    const total = B.parseMoney($('#tx-form').amount.value || '0');
    const used = splitLines().reduce((s, l) => s + (Number.isNaN(l.amount) ? 0 : l.amount), 0);
    const left = (Number.isNaN(total) ? 0 : total) - used;
    const el = $('#split-left');
    el.textContent = left === 0 ? '✓ Adds up' : left > 0 ? `${money(left)} left` : `${money(-left)} too much`;
    el.classList.toggle('split-left-bad', left !== 0);
  }
  $('#tx-form').amount.addEventListener('input', () => { if (splitOn) updateSplitLeft(); });

  // Attachments: photos are shrunk and turned into WebP on the device (JPEG
  // where the browser cannot make WebP) before upload; PDFs go as they are.
  const PDF_LIMIT = 10 * 1024 * 1024;
  async function takeReceipt(file) {
    if (!file) return;
    const err = $('#tx-error');
    err.hidden = true;
    try {
      let draft;
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
        if (file.size > PDF_LIMIT) throw new Error('That PDF is over 10 MB. Try a smaller one.');
        draft = { blob: new Blob([file], { type: 'application/pdf' }), kind: 'pdf', name: file.name || 'document.pdf' };
      } else {
        draft = { blob: await shrinkImage(file), kind: 'image', name: null };
      }
      clearReceiptDraft();
      draft.url = URL.createObjectURL(draft.blob);
      receiptDraft = draft;
      showReceiptPreview(draft);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }
  const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const UPLOAD_TARGET = 900 * 1024; // stays under the 1 MB some reverse proxies allow
  async function decodeImage(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* try an <img> */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }
  function encode(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }
  async function shrinkImage(file) {
    let img;
    try {
      img = await decodeImage(file);
    } catch {
      // The browser cannot open it. A normal photo can still go up as it is.
      if (PHOTO_TYPES.includes(file.type) && file.size <= 3 * 1024 * 1024) return file;
      if (/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '')) {
        throw new Error('This browser cannot open HEIC photos. Take the photo from Envelo, or choose "Most Compatible" in the iPhone camera settings.');
      }
      throw new Error('Could not open that photo. Try a JPEG or PNG.');
    }
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('Could not open that photo. Try a JPEG or PNG.');
    let best = null;
    for (const [max, quality] of [[1600, 0.8], [1280, 0.7], [1024, 0.6]]) {
      const scale = Math.min(1, max / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      let blob = await encode(canvas, 'image/webp', quality);
      if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', quality);
      if (!blob) continue;
      best = blob;
      if (blob.size <= UPLOAD_TARGET) break;
    }
    if (img.close) img.close();
    if (!best) {
      if (PHOTO_TYPES.includes(file.type) && file.size <= 3 * 1024 * 1024) return file;
      throw new Error('Could not process that photo on this device.');
    }
    return best;
  }
  // a: { url, kind, name } or null
  function showReceiptPreview(a) {
    if (!a) { $('#tx-receipt-preview').innerHTML = ''; return; }
    const what = a.kind === 'pdf'
      ? `<a class="pdf-chip" href="${esc(a.url)}" target="_blank" rel="noopener">📄 ${esc(a.name || 'PDF')}</a>`
      : `<img src="${esc(a.url)}" alt="Attached photo">`;
    $('#tx-receipt-preview').innerHTML = `${what}<button type="button" class="link" data-action="remove-receipt-draft">Remove</button>`;
  }
  function clearReceiptDraft() {
    if (receiptDraft) URL.revokeObjectURL(receiptDraft.url);
    receiptDraft = null;
    receiptKeep = null;
    showReceiptPreview(null);
  }
  async function uploadReceipt(blob) {
    let res;
    try {
      res = await fetch('/api/receipts', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type, 'X-Client-Id': clientId }, body: blob,
      });
    } catch {
      throw new Error('Could not upload the attachment: no connection to the server.');
    }
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.id) return data.id;
    if (data && data.error) throw new Error(data.error);
    // No answer from Envelo itself: something in between refused it.
    if (res.status === 413) {
      throw new Error(`The file (${Math.ceil(blob.size / 1024)} KB) was refused as too large before it reached Envelo. Raise the upload limit on your reverse proxy (for nginx: client_max_body_size 20m;).`);
    }
    throw new Error(`The attachment could not be uploaded (HTTP ${res.status}).`);
  }
  let viewingReceipt = null;
  function openReceipt(id, txId) {
    viewingReceipt = { id, txId };
    $('#receipt-img').src = `/api/receipts/${encodeURIComponent(id)}`;
    $('#receipt-dialog').showModal();
  }
  function deleteReceipt() {
    if (!viewingReceipt || !confirm('Remove this photo? This cannot be undone.')) return;
    const { id, txId } = viewingReceipt;
    api('DELETE', `/api/receipts/${encodeURIComponent(id)}`).catch(() => {});
    $('#receipt-dialog').close();
    attempt(() => {
      for (const t of budget.transactions) {
        if (t.receiptId === id && (!txId || t.id === txId || t.splitId)) { delete t.receiptId; delete t.receiptType; delete t.receiptName; }
      }
    });
  }

  function editTransaction(id) {
    const t = budget.transactions.find((x) => x.id === id);
    if (!t) return;
    // For a transfer, always edit from the sending side.
    const main = t.transferId && t.amount > 0
      ? budget.transactions.find((x) => x.transferId === t.transferId && x.amount < 0) || t
      : t;
    openTx();
    editingTx = main.id;
    const f = $('#tx-form');
    const legs = main.splitId ? B.splitLegs(budget, main.id) : [main];
    const kind = B.transactionKind(main);
    f.querySelector(`input[name="kind"][value="${kind}"]`).checked = true;
    f.date.value = main.date;
    f.payee.value = main.payee || '';
    f.amount.value = B.toInput(Math.abs(legs.reduce((s, l) => s + l.amount, 0)));
    f.note.value = main.note || '';
    f.accountId.value = main.accountId;
    if (main.envelopeId) f.envelopeId.value = main.envelopeId;
    if (main.toAccountId) f.toAccountId.value = main.toAccountId;
    envTouched = true;
    const withFile = legs.find((l) => l.receiptId);
    receiptKeep = withFile ? { id: withFile.receiptId, type: withFile.receiptType || null, name: withFile.receiptName || null } : null;
    showReceiptPreview(receiptKeep ? { url: `/api/receipts/${encodeURIComponent(receiptKeep.id)}`, kind: receiptKeep.type === 'pdf' ? 'pdf' : 'image', name: receiptKeep.name } : null);
    $('#tx-repeat-field').hidden = true;
    if (legs.length > 1) startSplit(legs.map((l) => ({ envelopeId: l.envelopeId, amount: -l.amount })));
    $('#tx-heading').textContent = 'Edit transaction';
    $('#tx-submit').textContent = 'Update transaction';
    $('#tx-delete').hidden = false;
    syncKind();
  }

  $('#tx-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const kind = f.kind.value;
    const cents = B.parseMoney(f.amount.value);
    const err = $('#tx-error');
    err.hidden = true;
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    if (Number.isNaN(cents) || cents === 0) return fail('Enter an amount like 12.50.');
    let lines = null;
    if (splitOn) {
      lines = splitLines().filter((l) => l.envelopeId || l.amount);
      if (lines.some((l) => !l.envelopeId)) return fail('Pick an envelope for every line.');
      if (lines.some((l) => Number.isNaN(l.amount) || l.amount <= 0)) return fail('Every line needs an amount.');
      if (lines.reduce((s, l) => s + l.amount, 0) !== Math.abs(cents)) return fail('The lines must add up to the total.');
    }
    const today = todayISO();
    const future = f.date.value > today;
    const repeat = f.repeat.value;
    // A new transaction with a later date waits under "Coming up" until then.
    const asRule = !!editingRule || (!editingTx && (repeat || future));
    if (asRule && lines) return fail('A split transaction cannot be scheduled. Use today or an earlier date.');
    if (asRule && repeat && kind === 'transfer') return fail('Transfers cannot repeat yet. Pick "Does not repeat".');
    let att = receiptKeep ? { ...receiptKeep } : null;
    if (receiptDraft) {
      try {
        $('#tx-submit').disabled = true;
        att = { id: await uploadReceipt(receiptDraft.blob), type: receiptDraft.kind === 'pdf' ? 'pdf' : null, name: receiptDraft.name };
      } catch (e) {
        $('#tx-submit').disabled = false;
        return fail(e.message);
      }
      $('#tx-submit').disabled = false;
    }
    const receiptId = att ? att.id : null;
    const putFile = (t) => {
      delete t.receiptId; delete t.receiptType; delete t.receiptName;
      if (!att) return;
      t.receiptId = att.id;
      if (att.type) t.receiptType = att.type;
      if (att.name) t.receiptName = att.name;
    };
    let scheduled = false;
    const fields = {
      kind,
      date: f.date.value,
      payee: f.payee.value,
      note: f.note.value,
      amount: Math.abs(cents),
      envelopeId: $('#tx-envelope-field').hidden ? null : f.envelopeId.value,
      accountId: f.accountId.value || null,
      toAccountId: kind === 'transfer' ? f.toAccountId.value : null,
    };
    const wasEditing = !!editingTx || !!editingRule;
    const what = `${fields.payee || (kind === 'income' ? 'income' : 'transaction')} ${money(kind === 'spend' ? -fields.amount : fields.amount)}`;
    const label = asRule ? `${wasEditing ? 'Updated' : 'Scheduled'} ${what}` : `${wasEditing ? 'Updated' : 'Added'} ${what}`;
    const ok = attempt(() => {
      let main;
      if (asRule) {
        const freq = repeat ? (repeat === 'biweekly' ? 'weekly' : repeat) : 'once';
        const every = repeat === 'biweekly' ? 2 : 1;
        const rule = { ...fields, freq, every, next: fields.date };
        if (att) Object.assign(rule, { receiptId: att.id, receiptType: att.type, receiptName: att.name });
        if (editingRule) B.updateRecurring(budget, editingRule, rule);
        else B.addRecurring(budget, rule);
        scheduled = B.applyRecurring(budget, today) === 0;
      } else if (editingTx) {
        const old = budget.transactions.find((x) => x.id === editingTx);
        if (lines) {
          const sid = old && old.splitId;
          B.removeTransaction(budget, editingTx);
          main = B.addSplit(budget, { ...fields, lines, splitId: sid, keepId: editingTx, receiptId });
        } else if (old && old.splitId) {
          B.removeTransaction(budget, editingTx);
          main = B.addTransaction(budget, fields);
          main.id = editingTx;
        } else {
          main = B.updateTransaction(budget, editingTx, fields);
        }
      } else if (lines) {
        main = B.addSplit(budget, { ...fields, lines, receiptId });
      } else {
        main = B.addTransaction(budget, fields);
      }
      if (main) {
        const legs = lines ? B.splitLegs(budget, main.id) : [main];
        legs.forEach((leg, i) => {
          if (i === 0) putFile(leg);
          else { delete leg.receiptId; delete leg.receiptType; delete leg.receiptName; }
        });
      }
    }, label);
    if (!ok) {
      fail($('#error').textContent);
      showError('');
      return;
    }
    try { if (fields.accountId) localStorage.setItem(LAST_ACCOUNT, fields.accountId); } catch { /* ignore */ }
    receiptDraft = null;
    receiptKeep = null;
    Sounds.play('tick');
    if (scheduled) toast(`Scheduled for ${fmtDay(fields.date)}. It shows under Coming up until then.`);
    if (wasEditing) {
      $('#tx-dialog').close();
    } else {
      // Stay open for the next one, keeping the date and account.
      const keepDate = f.date.value;
      const keepAcct = f.accountId.value;
      openTx({ accountId: keepAcct });
      f.date.value = keepDate;
    }
  });

  $('#env-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const goalText = f.goal.value.trim();
    const goal = goalText ? B.parseMoney(goalText) : null;
    let fields;
    const ok = attempt(() => {
      if (goal !== null && Number.isNaN(goal)) throw new Error('Goal must be an amount like 500.00.');
      fields = readEnvFields(f, 'name', 'group');
      B.addEnvelope(budget, { ...fields, goal });
    }, `Added the envelope ${f.name.value}`);
    if (ok) {
      f.reset();
      $('#env-dialog').close();
    }
  });

  // Move money between envelopes (or from and to Ready to Assign).
  function openMove({ to = '', from = '', cover = false }) {
    const f = $('#move-form');
    f.reset();
    $('#move-error').hidden = true;
    const view = B.monthView(budget, month);
    const envs = view.groups.flatMap((g) => g.envelopes).filter((e) => !e.hidden || e.id === to);
    const opt = (e) => `<option value="${e.id}">${esc(e.name)} (${esc(money(e.available))})</option>`;
    const rta = `<option value="">Ready to Assign (${esc(money(view.readyToAssign))})</option>`;
    f.from.innerHTML = rta + envs.map(opt).join('');
    f.to.innerHTML = rta + envs.map(opt).join('');
    $('#move-title').textContent = cover ? 'Cover overspending' : 'Move money';
    $('#move-info').textContent = '';
    if (cover) {
      const target = envs.find((e) => e.id === to);
      const need = target ? -target.available : 0;
      // Take it from the envelope with the most money, or Ready to Assign.
      const donor = envs.filter((e) => e.id !== to && e.available >= need).sort((x, y) => y.available - x.available)[0];
      f.to.value = to;
      f.from.value = view.readyToAssign >= need ? '' : donor ? donor.id : '';
      f.amount.value = B.toInput(need);
      $('#move-info').textContent = target ? `${target.name} is overspent by ${money(need)}. Pick where the money comes from.` : '';
    } else {
      if (to) f.to.value = to;
      if (from) f.from.value = from;
    }
    $('#move-dialog').showModal();
    setTimeout(() => (cover ? f.from : f.amount).focus(), 30);
  }
  $('#move-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const cents = B.parseMoney(f.amount.value);
    const from = f.from.value || null;
    const to = f.to.value || null;
    const prev = B.monthView(budget, month);
    try {
      if (Number.isNaN(cents)) throw new Error('Enter an amount like 25.00.');
      const test = B.fromJSON(JSON.parse(JSON.stringify(budget)));
      B.moveMoney(test, month, from, to, cents);
    } catch (err) {
      $('#move-error').textContent = err.message;
      $('#move-error').hidden = false;
      return;
    }
    $('#move-dialog').close();
    const label = `Moved ${money(cents)} ${from ? `from ${envName(from)}` : 'from Ready to Assign'} to ${to ? envName(to) : 'Ready to Assign'}`;
    if (attempt(() => B.moveMoney(budget, month, from, to, cents), label) && to) fundFx(prev, [to]);
  });

  let colorGroup = null;
  function openColor(group) {
    colorGroup = group;
    const current = budget.groupColors[group];
    $('#color-title').textContent = `Colour of ${group}`;
    $('#color-swatches').innerHTML = Array.from({ length: B.GROUP_COLORS }, (_, i) =>
      `<button type="button" class="sw-${i}${i === current ? ' on' : ''}" data-action="set-color" data-color="${i}" aria-label="Colour ${i + 1}"></button>`).join('');
    $('#color-dialog').showModal();
  }

  // Live updates. The server announces every save; this tab then loads the
  // new version, unless it has unsaved changes of its own (its save will be
  // refused and it reloads then) or someone is typing or has a dialog open
  // (it waits until they finish).

  let events = null;
  let reloadTimer = null;
  function busy() {
    const a = document.activeElement;
    if (a && a.closest('#app') && a.matches('input, select, textarea')) return true;
    return !!document.querySelector('dialog[open]');
  }
  async function reloadFromServer() {
    clearTimeout(reloadTimer);
    if (!account || dirty || inFlight || saveTimer) return;
    if (busy()) {
      reloadTimer = setTimeout(reloadFromServer, 1500);
      return;
    }
    try {
      const res = await api('GET', '/api/budget');
      if ((res.revision || 0) !== revision && !dirty && !inFlight) {
        budget = res.budget ? B.fromJSON(res.budget) : B.create();
        revision = res.revision || 0;
        render();
        setSync(`Updated from another device at ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
      }
    } catch {
      // Offline or signed out: keep what is on screen.
    }
  }
  function startLive() {
    if (events || !window.EventSource) return;
    events = new EventSource('/api/events');
    events.addEventListener('budget', (ev) => {
      let d = {};
      try { d = JSON.parse(ev.data); } catch { /* ignore */ }
      if (d.clientId === clientId || d.revision === revision) return;
      reloadFromServer();
    });
    events.addEventListener('shared', () => sharesSoon());
    // Reconnecting after the server restarts can miss an update.
    events.addEventListener('open', () => { if (account) reloadFromServer(); });
  }
  let sharesTimer = null;
  function sharesSoon() {
    clearTimeout(sharesTimer);
    sharesTimer = setTimeout(() => (busy() ? sharesSoon() : loadShares()), busy() ? 1500 : 0);
  }
  function stopLive() {
    if (events) events.close();
    events = null;
  }

  // Sharing

  let shares = { outgoing: [], incoming: [] };
  const sharedData = {}; // share id -> { share, budget, revision }

  async function loadShares() {
    if (!account) return;
    try {
      shares = await api('GET', '/api/shares');
    } catch {
      return;
    }
    await Promise.all(shares.incoming.map(async (sh) => {
      try {
        const res = await api('GET', `/api/shared/${sh.id}`);
        sharedData[sh.id] = { ...res, budget: B.fromJSON(res.budget) };
      } catch {
        delete sharedData[sh.id];
      }
    }));
    for (const id of Object.keys(sharedData)) if (!shares.incoming.some((sh) => sh.id === id)) delete sharedData[id];
    document.querySelectorAll('.nav-shared').forEach((el) => { el.hidden = !shares.incoming.length; });
    if (currentView === 'shared' && !shares.incoming.length) currentView = 'budget';
    render();
  }

  const sharedEnvelopeIds = () => new Set(shares.outgoing.flatMap((sh) => sh.envelopeIds));

  function renderShareList() {
    const names = Object.fromEntries(budget.envelopes.map((e) => [e.id, e.name]));
    $('#share-list').innerHTML = shares.outgoing.map((sh) => {
      const envs = sh.envelopeIds.map((id) => names[id]).filter(Boolean);
      return `<li>
        <div class="tx-meta">${sh.role === 'edit' ? 'Can add spending and money' : 'Can see'} · ${envs.length} envelope${envs.length === 1 ? '' : 's'}</div>
        <div><button type="button" class="env-link" data-action="edit-share" data-id="${sh.id}">${esc(sh.member)}</button></div>
        <div class="tx-meta share-envs">${esc(envs.join(', '))}</div>
      </li>`;
    }).join('');
  }

  let editingShare = null;
  function openShare(id) {
    const sh = id && shares.outgoing.find((x) => x.id === id);
    editingShare = sh ? sh.id : null;
    const f = $('#share-form');
    f.reset();
    $('#share-error').hidden = true;
    $('#share-title').textContent = sh ? `Shared with ${sh.member}` : 'Share envelopes';
    f.member.value = sh ? sh.member : '';
    f.member.readOnly = !!sh;
    f.role.value = sh ? sh.role : 'view';
    $('#share-stop').hidden = !sh;
    const picked = new Set(sh ? sh.envelopeIds : []);
    const groups = new Map();
    for (const e of budget.envelopes) {
      if (B.isHidden(budget, e) && !picked.has(e.id)) continue;
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e);
    }
    $('#share-picks').innerHTML = `<legend>Envelopes</legend>${[...groups].map(([group, envs]) => `<div class="pick-group">
      <label class="check pick-group-head"><input type="checkbox" data-pick-group="${esc(group)}" ${envs.every((e) => picked.has(e.id)) ? 'checked' : ''}>
        <span>${esc(group)}</span></label>
      ${envs.map((e) => `<label class="check"><input type="checkbox" name="pick" value="${e.id}" data-group="${esc(group)}" ${picked.has(e.id) ? 'checked' : ''}><span>${esc(e.name)}</span></label>`).join('')}
    </div>`).join('') || '<p class="hint">Add envelopes first.</p>'}`;
    $('#share-dialog').showModal();
  }

  $('#share-picks').addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.pickGroup !== undefined) {
      $('#share-picks').querySelectorAll('input[name=pick]').forEach((i) => {
        if (i.dataset.group === t.dataset.pickGroup) i.checked = t.checked;
      });
    } else if (t.name === 'pick') {
      const all = [...$('#share-picks').querySelectorAll('input[name=pick]')].filter((i) => i.dataset.group === t.dataset.group);
      const head = [...$('#share-picks').querySelectorAll('[data-pick-group]')].find((i) => i.dataset.pickGroup === t.dataset.group);
      if (head) head.checked = all.every((i) => i.checked);
    }
  });

  $('#share-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const envelopeIds = [...f.querySelectorAll('input[name=pick]:checked')].map((i) => i.value);
    await flush(); // the server checks the envelopes against the saved budget
    try {
      const res = await api('POST', '/api/shares', { member: f.member.value, role: f.role.value, envelopeIds });
      $('#share-dialog').close();
      toast(res.registered
        ? `Shared ${envelopeIds.length} envelope${envelopeIds.length === 1 ? '' : 's'} with ${res.share.member}`
        : `Shared. ${res.share.member} will see it after creating an account with that email.`);
      await loadShares();
    } catch (err) {
      $('#share-error').textContent = err.message;
      $('#share-error').hidden = false;
    }
  });

  function renderShared() {
    const me = account ? account.email : '';
    $('#shared-list').innerHTML = shares.incoming.map((sh) => {
      const data = sharedData[sh.id];
      if (!data) return `<section class="card"><p class="empty">Could not load what ${esc(sh.owner)} shared.</p></section>`;
      const b = data.budget;
      const view = B.monthView(b, month);
      const fmt = (c) => B.formatMoney(c, b.currency);
      const rows = view.groups.flatMap((g) => g.envelopes.map((e) => `<tr>
        <td class="env-cell"><div class="env-name">${esc(e.name)}</div><div class="goal">${esc(g.name)}</div></td>
        <td class="num" data-label="Assigned">${esc(fmt(e.assigned))}</td>
        <td class="num" data-label="In / out">${esc(fmt(e.activity))}</td>
        <td class="num" data-label="Available"><span class="chip ${e.available < 0 ? "neg" : e.available === 0 ? "zero" : "ok"}">${esc(fmt(e.available))}</span></td>
      </tr>`)).join('');
      const txs = b.transactions.filter((t) => t.date.slice(0, 7) === month).sort((x, y) => (x.date < y.date ? 1 : -1));
      const envName = Object.fromEntries(b.envelopes.map((e) => [e.id, e.name]));
      const canEdit = sh.role === 'edit';
      return `<section class="card shared-card" data-share="${sh.id}">
        <div class="card-head">
          <h2>From ${esc(sh.owner)}</h2>
          <span class="hint">${canEdit ? 'You can add spending and money' : 'You can see these envelopes'}</span>
        </div>
        <div class="table-wrap"><table class="shared-table">
          <thead><tr><th>Envelope</th><th class="num">Assigned</th><th class="num">In / out</th><th class="num">Available</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="empty">Nothing shared right now.</td></tr>'}</tbody>
        </table></div>
        ${canEdit && b.envelopes.length ? `<form class="shared-form" data-share="${sh.id}" autocomplete="off">
          <div class="segmented two" role="radiogroup" aria-label="What to add">
            <label><input type="radio" name="mode" value="spend" checked><span>Add spending</span></label>
            <label><input type="radio" name="mode" value="money"><span>Add money</span></label>
          </div>
          <p class="hint mode-hint">Spending you paid from ${esc(sh.owner)}'s account.</p>
          <div class="shared-grid">
            <label>Amount <input type="text" name="amount" inputmode="decimal" required placeholder="0.00"></label>
            <label>Envelope <select name="envelopeId">${b.envelopes.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></label>
            <label><span class="acct-label">Paid from</span> <select name="accountId">${b.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
            <label>Date <input type="date" name="date" required value="${todayISO()}"></label>
            <label class="payee-field">Payee <input type="text" name="payee" maxlength="80" placeholder="Where it went"></label>
            <label>Note <input type="text" name="note" maxlength="140" placeholder="Optional"></label>
          </div>
          <button type="submit" class="btn primary">Add spending</button>
          <p class="auth-message" hidden></p>
        </form>` : ''}
        <h3 class="sub-h">This month</h3>
        <ul class="tx-list">${txs.length ? txs.map((t) => `<li>
          <div class="tx-meta">${esc(t.date)} · ${esc(envName[t.envelopeId] || '')}${t.createdBy && t.createdBy !== me ? ` · by ${esc(t.createdBy)}` : ' · by you'}${t.note ? ` · ${esc(t.note)}` : ''}</div>
          <div><strong>${esc(t.payee || (t.amount > 0 ? 'Money added' : 'Spending'))}</strong></div>
          <div class="tx-amt ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${esc(fmt(t.amount))}</div>
          ${canEdit && t.createdBy === me ? `<button type="button" class="icon tx-del" data-action="delete-shared-tx" data-share="${sh.id}" data-id="${t.id}" aria-label="Delete">&times;</button>` : ''}
        </li>`).join('') : '<li class="tx-meta">Nothing added or spent this month.</li>'}</ul>
        <button type="button" class="icon-text" data-action="leave-share" data-id="${sh.id}">Leave this share</button>
      </section>`;
    }).join('') || '<section class="card"><p class="empty">Nobody has shared envelopes with you.</p></section>';
  }

  // Switching a shared form between adding spending and adding money.
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t.matches('.shared-form input[name=mode]')) return;
    const f = t.closest('form');
    const adding = f.mode.value === 'money';
    const sh = shares.incoming.find((x) => x.id === f.dataset.share);
    f.querySelector('.acct-label').textContent = adding ? 'Put into' : 'Paid from';
    f.querySelector('.payee-field').hidden = adding;
    f.querySelector('button[type=submit]').textContent = adding ? 'Add money' : 'Add spending';
    f.querySelector('.mode-hint').textContent = adding
      ? `Money you put into ${sh ? sh.owner : 'their'}'s account for this envelope, like a transfer to a joint account. It goes straight into the envelope.`
      : `Spending you paid from ${sh ? sh.owner : 'their'}'s account.`;
  });

  document.addEventListener('submit', async (ev) => {
    const f = ev.target;
    if (!f.matches('.shared-form')) return;
    ev.preventDefault();
    const err = f.querySelector('.auth-message');
    const cents = B.parseMoney(f.amount.value);
    if (Number.isNaN(cents) || cents <= 0) {
      err.textContent = 'Enter an amount like 12.50.';
      err.hidden = false;
      return;
    }
    const adding = f.mode.value === 'money';
    try {
      const res = await api('POST', `/api/shared/${f.dataset.share}/${adding ? 'money' : 'transactions'}`, {
        date: f.date.value, payee: adding ? undefined : f.payee.value, amount: cents, envelopeId: f.envelopeId.value,
        accountId: f.accountId.value, note: f.note.value,
      });
      sharedData[f.dataset.share] = { ...res, budget: B.fromJSON(res.budget) };
      render();
      const env = res.budget.envelopes.find((e) => e.id === f.envelopeId.value);
      toast(adding ? `Added ${B.formatMoney(cents, res.budget.currency)} to ${env ? env.name : 'the envelope'}` : `Added spending of ${B.formatMoney(cents, res.budget.currency)}`);
      Sounds.play(adding ? 'coin' : 'tick');
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  // Bank file import

  const C = BankCsv;
  let csv = null; // { accountId, layout, text }
  const ROLES = [['date', 'Date'], ['payee', 'Payee / description'], ['amount', 'Amount'], ['debit', 'Money out'], ['credit', 'Money in'], ['note', 'Note']];

  function openBankImport(accountId) {
    csv = { accountId: accountId || (budget.accounts[0] || {}).id || '', layout: null, text: '' };
    renderCsv();
    if (!$('#csv-dialog').open) $('#csv-dialog').showModal();
  }

  function csvSteps(n) {
    return `<div class="csv-steps">${['Choose the file', 'Check the columns', 'Import'].map((t, i) => `<span class="${i === n ? 'on' : ''}">${i + 1}. ${t}</span>`).join('')}</div>`;
  }

  function renderCsv() {
    const body = $('#csv-body');
    if (!budget.accounts.length) {
      body.innerHTML = `<h2>Import a bank file</h2><p>Add the account first, on the Accounts page, then import its file.</p>
        <div class="row"><button type="button" class="btn" data-action="close-dialog">Close</button></div>`;
      return;
    }
    if (!csv.layout) {
      body.innerHTML = `<h2>Import a bank file</h2>${csvSteps(0)}
        <label>Into account <select id="csv-account">${budget.accounts.map((a) => `<option value="${a.id}" ${a.id === csv.accountId ? 'selected' : ''}>${esc(a.name)}${a.csvLayout ? ' · layout remembered' : ''}</option>`).join('')}</select></label>
        <label class="btn file-btn">Choose a CSV file<input type="file" id="csv-file" accept=".csv,.txt,text/csv" hidden></label>
        <p class="hint">Download a CSV of the account from your bank's website or app. Revolut: Statement → Excel/CSV. N26: Downloads → CSV.
          Any bank works: Envelo works out the columns the first time and remembers them for this account.</p>
        <p class="auth-message" id="csv-err" hidden></p>
        <div class="row"><button type="button" class="btn" data-action="close-dialog">Cancel</button></div>`;
      $('#csv-account').addEventListener('change', (ev) => { csv.accountId = ev.target.value; });
      $('#csv-file').addEventListener('change', (ev) => readCsvFile(ev.target.files[0]));
      return;
    }
    const acct = budget.accounts.find((a) => a.id === csv.accountId);
    const onBudget = acct && !acct.offBudget;
    const L = csv.layout;
    const { transactions, errors } = C.toTransactions(L);
    const marked = C.markDuplicates(transactions, budget.transactions.filter((t) => t.accountId === csv.accountId));
    csv.rows = marked;
    const fresh = marked.filter((t) => !t.duplicate);
    const colOptions = (role) => `<option value="-1">—</option>${L.header.map((h, i) => `<option value="${i}" ${L.columns[role] === i ? 'selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('')}`;
    const how = L.preset ? `Recognised a <b>${esc(L.presetName)}</b> export.`
      : acct && acct.csvLayout && acct.csvLayout.signature === L.signature ? 'Using the layout from last time.'
      : 'Worked out the layout. Check the columns below.';
    const envOpts = (t) => {
      const mem = B.payeeMemory(budget, t.payee);
      const pick = t.envelopeId !== undefined ? t.envelopeId : mem && mem.envelopeId && (t.amount < 0) === (mem.kind === 'spend') ? mem.envelopeId : '';
      t.envelopeId = pick;
      const first = t.amount > 0 ? 'Ready to Assign' : 'To categorise';
      return `<option value="">${first}</option>${budget.envelopes.filter((e) => !B.isHidden(budget, e) || e.id === pick).map((e) => `<option value="${e.id}" ${e.id === pick ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}`;
    };
    const shown = marked.slice(0, 1000);
    $('#csv-body').innerHTML = `<h2>Import into ${esc(acct ? acct.name : '')}</h2>${csvSteps(1)}
      <p>${how} ${fresh.length} new transaction${fresh.length === 1 ? '' : 's'}${marked.length - fresh.length ? `, ${marked.length - fresh.length} already in Envelo (skipped)` : ''}${errors.length ? `, ${errors.length} row${errors.length === 1 ? '' : 's'} could not be read` : ''}.</p>
      <div class="csv-map">
        ${ROLES.map(([role, label]) => `<label>${label}<select data-csv-role="${role}">${colOptions(role)}</select></label>`).join('')}
        <label>Date format<select id="csv-datefmt">${C.DATE_FORMATS.map((f) => `<option ${f === L.dateFormat ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
        <label>Decimals<select id="csv-decimal"><option value="," ${L.decimal === ',' ? 'selected' : ''}>12,50</option><option value="." ${L.decimal === '.' ? 'selected' : ''}>12.50</option></select></label>
      </div>
      <p class="hint">Use Amount when the file has one column with minus signs, or Money out and Money in when it has two.${onBudget ? ' Envelopes come from what you used for the same payee before; anything new goes to "To categorise".' : ''}</p>
      <div class="table-wrap" style="max-height:46vh;overflow:auto"><table class="csv-preview">
        <thead><tr><th>Date</th><th>Payee</th><th class="num">Amount</th>${onBudget ? '<th>Envelope</th>' : ''}</tr></thead>
        <tbody>${shown.map((t, i) => `<tr class="${t.duplicate ? 'dup' : ''}" title="${t.duplicate ? 'Already in Envelo' : ''}">
          <td>${esc(t.date)}</td><td>${esc(t.payee)}</td><td class="num">${esc(money(t.amount))}</td>
          ${onBudget ? `<td>${t.duplicate ? '' : `<select data-csv-env="${i}">${envOpts(t)}</select>`}</td>` : ''}</tr>`).join('')}</tbody>
      </table></div>
      <div class="row">
        <button type="button" class="btn primary" id="csv-go" ${fresh.length ? '' : 'disabled'}>Import ${fresh.length} transaction${fresh.length === 1 ? '' : 's'}</button>
        <button type="button" class="btn" id="csv-back">Choose another file</button>
        <button type="button" class="btn" data-action="close-dialog">Cancel</button>
      </div>`;
    document.querySelectorAll('[data-csv-role]').forEach((sel) => sel.addEventListener('change', () => {
      L.columns[sel.dataset.csvRole] = Number(sel.value);
      if (sel.dataset.csvRole === 'amount' && Number(sel.value) >= 0) { L.columns.debit = -1; L.columns.credit = -1; }
      if (['debit', 'credit'].includes(sel.dataset.csvRole) && Number(sel.value) >= 0) L.columns.amount = -1;
      L.preset = null;
      renderCsv();
    }));
    $('#csv-datefmt').addEventListener('change', (ev) => { L.dateFormat = ev.target.value; renderCsv(); });
    $('#csv-decimal').addEventListener('change', (ev) => { L.decimal = ev.target.value; renderCsv(); });
    document.querySelectorAll('[data-csv-env]').forEach((sel) => sel.addEventListener('change', () => {
      csv.rows[Number(sel.dataset.csvEnv)].envelopeId = sel.value;
    }));
    $('#csv-back').addEventListener('click', () => { csv.layout = null; renderCsv(); });
    $('#csv-go').addEventListener('click', importCsvRows);
  }

  async function readCsvFile(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      // Older bank exports are often in Windows-1252, not UTF-8.
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
      const acct = budget.accounts.find((a) => a.id === csv.accountId);
      csv.text = text;
      csv.layout = C.analyze(text, acct && acct.csvLayout);
      renderCsv();
    } catch (err) {
      const el = $('#csv-err');
      if (el) { el.textContent = `Could not read the file: ${err.message}`; el.hidden = false; }
    }
  }

  function importCsvRows() {
    const acct = budget.accounts.find((a) => a.id === csv.accountId);
    if (!acct) return;
    const rows = csv.rows.filter((t) => !t.duplicate);
    const onBudget = !acct.offBudget;
    const newId = () => ((globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    const ok = attempt(() => {
      let bucket = null;
      const toCategorise = () => {
        if (!bucket) {
          bucket = budget.envelopes.find((e) => e.name === 'To categorise')
            || B.addEnvelope(budget, { name: '📥 To categorise', group: 'Imported' });
        }
        return bucket.id;
      };
      for (const t of rows) {
        let envelopeId = onBudget && t.envelopeId ? t.envelopeId : null;
        if (onBudget && !envelopeId && t.amount < 0) envelopeId = toCategorise();
        budget.transactions.push({
          id: newId(), date: t.date, payee: t.payee, note: t.note, amount: t.amount,
          envelopeId, accountId: acct.id, importKey: `bank:${C.dupKey(t)}`,
        });
      }
      acct.csvLayout = C.layoutToSave(csv.layout);
    }, `Imported ${rows.length} transaction${rows.length === 1 ? '' : 's'} into ${acct.name}`);
    if (ok) {
      $('#csv-dialog').close();
      Sounds.play('register');
    }
  }

  // First-run setup guide

  const TEMPLATES = [
    { group: 'Bills', blurb: 'Rent, utilities, internet, phone', envelopes: ['🏠 Rent or mortgage', '💡 Electricity', '🚰 Water', '📶 Internet', '📱 Phone'] },
    { group: 'Everyday', blurb: 'Food, eating out, getting around', envelopes: ['🛒 Groceries', '🍴 Restaurants', '⛽ Fuel', '🚌 Transport'] },
    { group: 'Fun', blurb: 'Subscriptions, gifts, hobbies', envelopes: ['🎬 Subscriptions', '🎁 Gifts', '🎨 Hobbies'] },
    { group: 'Savings', blurb: 'Emergencies, holidays, repairs', envelopes: ['🆘 Emergency fund', '✈️ Holidays', '🔧 Repairs'] },
  ];
  let welcome = null;
  function openWelcome() {
    welcome = { step: 0, currency: budget.currency || 'EUR', account: '', balance: '', templates: new Set(['Bills', 'Everyday', 'Savings']) };
    renderWelcome();
    if (!$('#welcome-dialog').open) $('#welcome-dialog').showModal();
  }
  function renderWelcome() {
    const w = welcome;
    const dots = `<div class="dots">${[0, 1, 2, 3].map((i) => `<i class="${i <= w.step ? 'on' : ''}"></i>`).join('')}</div>`;
    const body = $('#welcome-body');
    if (w.step === 0) {
      body.innerHTML = `${dots}<h2>Welcome to Envelo</h2>
        <p>Every ${esc(currencyWord())} you have gets a job: you put money into envelopes like Groceries or Holidays, and spend from them. Three quick steps and you are set.</p>
        <label>Your currency <select id="w-currency">${[...$('#currency').options].map((o) => `<option ${o.value === w.currency ? 'selected' : ''}>${o.value}</option>`).join('')}</select></label>
        <div class="row"><button type="button" class="btn primary" id="w-next">Next</button><button type="button" class="btn" data-action="close-dialog">Skip the guide</button></div>`;
      $('#w-currency').addEventListener('change', (ev) => { w.currency = ev.target.value; budget.currency = w.currency; });
    } else if (w.step === 1) {
      body.innerHTML = `${dots}<h2>Your main account</h2>
        <p>Where your money is today, like your current account. You can add more later.</p>
        <label>Name <input type="text" id="w-acct" placeholder="Current account" value="${esc(w.account)}"></label>
        <label>Balance today <input type="text" id="w-bal" inputmode="decimal" placeholder="0.00" value="${esc(w.balance)}"></label>
        <p class="auth-message" id="w-err" hidden></p>
        <div class="row"><button type="button" class="btn primary" id="w-next">Next</button><button type="button" class="btn" id="w-back">Back</button></div>`;
    } else if (w.step === 2) {
      body.innerHTML = `${dots}<h2>Pick some envelopes</h2>
        <p>Start with a few ready-made groups. Rename, delete or add envelopes any time.</p>
        <div class="templates">${TEMPLATES.map((t) => `<div class="template"><label class="check"><input type="checkbox" data-tpl="${esc(t.group)}" ${w.templates.has(t.group) ? 'checked' : ''}><span>${esc(t.group)}</span></label>
          <p>${esc(t.envelopes.join(', '))}</p></div>`).join('')}</div>
        <div class="row"><button type="button" class="btn primary" id="w-next">Create my budget</button><button type="button" class="btn" id="w-back">Back</button></div>`;
      document.querySelectorAll('[data-tpl]').forEach((c) => c.addEventListener('change', () => {
        if (c.checked) w.templates.add(c.dataset.tpl); else w.templates.delete(c.dataset.tpl);
      }));
    } else {
      body.innerHTML = `${dots}<h2>You're set 🎉</h2>
        <p>Now give your money jobs: type amounts into the <b>Assigned</b> column until Ready to Assign reaches zero.</p>
        <ul class="insight-list">
          <li>Add spending with the <b>+</b> button${matchMedia('(pointer:fine)').matches ? ' or press <kbd>N</kbd>' : ''}.</li>
          <li>Click an envelope's name to give it a target, like €300 a month.</li>
          <li>Overspent? Click the red amount to cover it from another envelope.</li>
          ${matchMedia('(pointer:fine)').matches ? '<li>Press <kbd>?</kbd> for all keyboard shortcuts.</li>' : ''}
        </ul>
        <div class="row"><button type="button" class="btn primary" data-action="close-dialog">Start budgeting</button></div>`;
    }
    const next = $('#w-next');
    const back = $('#w-back');
    if (back) back.addEventListener('click', () => { w.step--; renderWelcome(); });
    if (!next) return;
    next.addEventListener('click', () => {
      if (w.step === 1) {
        w.account = $('#w-acct').value.trim();
        w.balance = $('#w-bal').value.trim();
        if (w.balance && Number.isNaN(B.parseMoney(w.balance))) {
          $('#w-err').textContent = 'Balance must be an amount like 1200.00.';
          $('#w-err').hidden = false;
          return;
        }
      }
      if (w.step === 2) {
        const ok = attempt(() => {
          budget.currency = w.currency;
          if (w.account || w.balance) {
            B.addAccount(budget, { name: w.account || 'Current account', balance: w.balance ? B.parseMoney(w.balance) : 0, date: todayISO() });
          }
          for (const t of TEMPLATES) {
            if (!w.templates.has(t.group)) continue;
            for (const name of t.envelopes) {
              if (!budget.envelopes.some((e) => e.name === name)) B.addEnvelope(budget, { name, group: t.group });
            }
          }
        });
        if (!ok) return;
        Sounds.play('fanfare');
      }
      w.step++;
      renderWelcome();
    });
  }

  // Monthly recap

  let recapMonth = null;
  const recapSeenKey = () => `envelo.recapSeen.${account ? account.email : ''}`;
  function markRecapSeen() {
    try { localStorage.setItem(recapSeenKey(), B.shiftMonth(thisMonth(), -1)); } catch { /* ignore */ }
  }
  // In the first ten days of a month, offer last month's recap once.
  function renderRecapBanner() {
    const el = $('#recap-banner');
    const last = B.shiftMonth(thisMonth(), -1);
    let seen = '';
    try { seen = localStorage.getItem(recapSeenKey()) || ''; } catch { /* ignore */ }
    const day = Number(todayISO().slice(8, 10));
    const hasData = budget.transactions.some((t) => t.date.slice(0, 7) === last);
    if (month !== thisMonth() || day > 10 || seen === last || !hasData) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="recap-banner"><span>Your <b>${esc(fmtMonthLong(last))}</b> recap is ready</span>
      <span class="row"><button type="button" class="btn sm primary" data-action="see-recap">See it</button>
      <button type="button" class="icon" data-action="dismiss-recap" aria-label="Dismiss">&times;</button></span></div>`;
  }

  function renderRecap() {
    const m = recapMonth || B.shiftMonth(thisMonth(), -1);
    const r = B.recap(budget, m);
    const [y] = m.split('-');
    const sk = B.streaks(budget, m);
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const saveRate = pct(r.saved, r.income);
    const vsBefore = r.spendingBefore ? r.spending - r.spendingBefore : null;
    const names = Object.fromEntries(budget.envelopes.map((e) => [e.id, e.name]));
    const prevM = B.shiftMonth(m, -1);
    const nextM = B.shiftMonth(m, 1);
    $('#recap').innerHTML = `<div class="recap">
      <section class="card hero-card">
        <div class="row" style="justify-content:space-between">
          <h2>Monthly recap</h2>
          <span class="row"><button type="button" class="btn sm" data-action="recap-month" data-month="${prevM}">‹ ${esc(fmtMonth(prevM))}</button>
          ${nextM < thisMonth() ? `<button type="button" class="btn sm" data-action="recap-month" data-month="${nextM}">${esc(fmtMonth(nextM))} ›</button>` : ''}</span>
        </div>
        <div class="recap-title">${esc(fmtMonthLong(m))} ${esc(y)}</div>
        <p style="font-weight:800;font-size:18px;margin:0">${r.saved >= 0
          ? `You kept ${esc(money(r.saved))}${r.income ? `, ${saveRate}% of what came in` : ''}.`
          : `You spent ${esc(money(-r.saved))} more than came in.`}</p>
      </section>
      <section class="card recap-yellow"><h2>Came in</h2><div class="recap-big">${esc(money(r.income))}</div></section>
      <section class="card"><h2>Went out</h2><div class="recap-big">${esc(money(r.spending))}</div>
        ${vsBefore === null ? '' : `<p class="hint">${vsBefore <= 0 ? `${esc(money(-vsBefore))} less` : `${esc(money(vsBefore))} more`} than ${esc(fmtMonthLong(prevM))}</p>`}</section>
      <section class="card recap-lilac"><h2>Net worth</h2><div class="recap-big">${esc(money(r.netWorth))}</div>
        <p>${r.netWorthChange >= 0 ? '▲' : '▼'} ${esc(money(Math.abs(r.netWorthChange)))} this month</p></section>
      <section class="card wide recap-over"><h2>Overspent</h2>
        ${r.overspent.length ? `<ul class="insight-list">${r.overspent.map((o) => `<li><span><b>${esc(o.name)}</b>
          <span class="hint">${o.carried ? 'carried into next month' : 'taken from next month\'s Ready to Assign'}</span></span>
          <span class="chip neg">${esc(money(-o.amount))}</span></li>`).join('')}</ul>
          <p class="hint">Total ${esc(money(r.overspent.reduce((t, o) => t + o.amount, 0)))}.</p>`
          : '<p class="status good">✓ Nothing was overspent</p><p>Every envelope stayed within what it had. 🎉</p>'}
        ${r.hints.map((h) => `<div class="hint-box"><span><b>${esc(h.name)}</b> was overspent in ${h.months} of the last 4 months.
          Raise its target to <b>${esc(money(h.suggest))}</b> a month?</span>
          <button type="button" class="btn sm" data-action="apply-hint" data-id="${h.id}" data-amount="${h.suggest}">Set ${esc(money(h.suggest))}/month</button></div>`).join('')}
      </section>
      <section class="card wide"><h2>Where it went</h2>
        ${r.top.length ? `<ul class="insight-list">${r.top.map((t) => `<li class="row" style="justify-content:space-between"><b>${esc(t.name)}</b>
          <span>${esc(money(t.amount))}${t.before ? ` <span class="hint">(${t.amount > t.before ? '▲' : '▼'} ${esc(money(Math.abs(t.amount - t.before)))})</span>` : ''}</span></li>`).join('')}</ul>` : '<p class="hint">No spending this month.</p>'}
        ${r.biggest ? `<p class="hint">Biggest purchase: <b>${esc(r.biggest.payee || 'Unnamed')}</b>, ${esc(money(r.biggest.amount))} on ${esc(r.biggest.date)}${r.biggest.envelopeId ? ` (${esc(names[r.biggest.envelopeId] || '')})` : ''}.</p>` : ''}
      </section>
      ${r.goals.length ? `<section class="card full recap-mint"><h2>Goals</h2><ul class="insight-list">${r.goals.map((g) => `<li class="row" style="justify-content:space-between">
        <b>${esc(g.name)}</b><span>${Math.round(g.progress * 100)}% · ${g.change >= 0 ? '▲' : '▼'} ${esc(money(Math.abs(g.change)))}</span></li>`).join('')}</ul></section>` : ''}
      <section class="card full"><h2>Streaks</h2>
        <div class="row" style="gap:28px">
          <div><div class="recap-big">${sk.allAssigned}</div><p class="hint">month${sk.allAssigned === 1 ? '' : 's'} with every ${esc(currencyWord())} assigned</p></div>
          <div><div class="recap-big">${sk.noOverspending}</div><p class="hint">month${sk.noOverspending === 1 ? '' : 's'} without overspending</p></div>
          <div><div class="recap-big">${sk.saving}</div><p class="hint">month${sk.saving === 1 ? '' : 's'} spending less than you earn</p></div>
          <div><div class="recap-big">${r.transactions}</div><p class="hint">transactions recorded</p></div>
        </div>
      </section>
    </div>`;
  }

  // Goals

  function goalSourceText(g) {
    if (g.source === 'networth') return 'Net worth';
    const list = g.source === 'accounts' ? budget.accounts : budget.envelopes;
    const names = g.ids.map((id) => (list.find((x) => x.id === id) || {}).name).filter(Boolean);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  }

  function renderGoals() {
    const goals = budget.goals || [];
    const statuses = goals.map((g) => [g, B.goalStatus(budget, g, month)]);
    $('#goal-list').innerHTML = goals.length ? statuses.map(([g, st]) => {
      const pct = Math.round(st.progress * 100);
      const done = st.remaining === 0;
      const forecast = done ? '<p class="status good">🎉 Reached!</p>'
        : g.by ? `<p>${st.onTrack ? '<span class="status good">✓ On track</span>' : '<span class="status bad">⚠ Behind</span>'}
            Put aside <b>${esc(money(st.neededPerMonth))}</b> a month to reach it by ${esc(fmtMonth(g.by))}.
            ${st.eta ? `At your recent pace (${esc(money(st.rate))}/month) you get there around <b>${esc(fmtMonth(st.eta))}</b>.` : 'It has not grown in the last 3 months.'}</p>`
        : st.eta ? `<p>Growing ${esc(money(st.rate))} a month: you get there around <b>${esc(fmtMonth(st.eta))}</b>.</p>`
        : '<p>It has not grown in the last 3 months. Add money to reach it.</p>';
      const ticks = [25, 50, 75].map((m) => `<span class="tick ${pct >= m ? 'hit' : ''}" style="left:${m}%"></span>`).join('');
      const stones = st.milestones.map((m) => `<li class="${m.month ? 'hit' : ''}"><b>${m.percent}%</b>
        <span>${m.month ? esc(fmtMonth(m.month)) : esc(money(Math.round((g.amount * m.percent) / 100)))}</span></li>`).join('');
      return `<article class="card goal-card ${done ? 'done' : ''}">
        <header class="loan-head">
          <h3>${esc(g.name)}</h3>
          <button type="button" class="icon-text" data-action="edit-goal" data-id="${g.id}">Edit</button>
        </header>
        <div class="hint">${esc(goalSourceText(g))}${g.by ? ` · by ${esc(fmtMonth(g.by))}` : ''}</div>
        <div class="goal-top">
          <div class="goal-pct">${pct}<small>%</small></div>
          <div class="goal-amounts"><b>${esc(money(st.value))}</b> of ${esc(money(g.amount))}
            ${done ? '' : `<div class="hint">${esc(money(st.remaining))} to go</div>`}</div>
        </div>
        <div class="goal-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(g.name)} progress">
          <i style="width:${pct}%"></i>${ticks}</div>
        <ol class="milestones">${stones}</ol>
        <div class="goal-forecast">${forecast}</div>
        <div class="chart goal-chart" id="goal-chart-${g.id}"></div>
      </article>`;
    }).join('') : `<section class="card"><p class="empty">No goals yet. Use "New goal" to set one, such as an emergency fund
      across your savings accounts or a net worth you want to reach.</p></section>`;

    for (const [g, st] of statuses) {
      const el = document.getElementById(`goal-chart-${g.id}`);
      Charts.lines(el, {
        labels: st.history.map((h) => fmtMonth(h.month).split(' ')[0]),
        series: [
          { name: 'Saved', color: seriesColor(2), values: st.history.map((h) => h.value) },
          { name: 'Goal', color: seriesColor(6), values: st.history.map(() => g.amount) },
        ],
        fmt: money, fmtAxis: compact, label: `${g.name} over the last 12 months`, height: 170,
      });
    }

    // Celebrate each milestone once, the first time it is seen this month or later.
    if (month >= thisMonth()) {
      const fresh = statuses.filter(([g, st]) => st.milestone > (g.celebrated || 0));
      if (fresh.length) {
        const [g, st] = fresh[0];
        for (const [goal, s2] of fresh) goal.celebrated = s2.milestone;
        scheduleSave();
        celebrate(st.milestone === 100 ? `🎉 You reached ${g.name}!` : `🎉 ${g.name} is ${st.milestone}% there`);
        Sounds.play(st.milestone === 100 ? 'bigFanfare' : 'chime');
      }
    }
  }

  let editingGoal = null;
  function renderGoalPicks(selected = []) {
    const f = $('#goal-form');
    const source = f.source.value;
    const box = $('#goal-picks');
    if (source === 'networth') {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    const items = source === 'accounts'
      ? budget.accounts.map((a) => ({ id: a.id, label: a.name, sub: money(B.accountBalance(budget, a.id)) }))
      : budget.envelopes.filter((e) => !B.isHidden(budget, e) || selected.includes(e.id)).map((e) => ({ id: e.id, label: e.name, sub: e.group }));
    box.innerHTML = `<legend>${source === 'accounts' ? 'Accounts' : 'Envelopes'}</legend>${items.length ? items.map((it) => `<label class="check">
      <input type="checkbox" name="pick" value="${it.id}" ${selected.includes(it.id) ? 'checked' : ''}>
      <span>${esc(it.label)} <span class="optional">${esc(it.sub)}</span></span></label>`).join('') : '<p class="hint">None yet.</p>'}`;
  }
  $('#goal-form').source.addEventListener('change', () => renderGoalPicks());

  function openGoal(id) {
    const g = id && (budget.goals || []).find((x) => x.id === id);
    editingGoal = g ? g.id : null;
    const f = $('#goal-form');
    f.reset();
    $('#goal-error').hidden = true;
    $('#goal-title').textContent = g ? g.name : 'New goal';
    $('#goal-delete').hidden = !g;
    f.name.value = g ? g.name : '';
    f.amount.value = g ? B.toInput(g.amount) : '';
    f.by.value = g && g.by ? g.by : '';
    f.source.value = g ? g.source : 'accounts';
    renderGoalPicks(g ? g.ids : []);
    $('#goal-dialog').showModal();
  }

  $('#goal-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const fields = {
      name: f.name.value,
      amount: B.parseMoney(f.amount.value),
      by: f.by.value || null,
      source: f.source.value,
      ids: [...f.querySelectorAll('input[name=pick]:checked')].map((i) => i.value),
    };
    try {
      if (Number.isNaN(fields.amount)) throw new Error('Enter an amount like 10000.00.');
      if (editingGoal) B.updateGoal(budget, editingGoal, fields);
      else B.addGoal(budget, fields);
    } catch (err) {
      $('#goal-error').textContent = err.message;
      $('#goal-error').hidden = false;
      return;
    }
    $('#goal-dialog').close();
    attempt(() => {});
  });

  // Loans: off-budget accounts with loan details, plus a calculator.

  const L = Loans;
  const loanExtra = {}; // what-if extra payment per loan, not saved
  const parseRate = (v) => {
    const text = String(v ?? '').replace('%', '').replace(',', '.').trim();
    return text === '' ? NaN : Number(text);
  };
  function duration(months) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    const parts = [];
    if (y) parts.push(`${y} year${y === 1 ? '' : 's'}`);
    if (m || !y) parts.push(`${m} month${m === 1 ? '' : 's'}`);
    return parts.join(' ');
  }
  // Balance at the end of each year, for charts. Shorter schedules pad with 0.
  function yearlyBalances(schedules, startBalance) {
    const longest = Math.max(...schedules.map((s) => s.rows.length));
    const points = [];
    for (let i = 0; i <= longest; i += 12) points.push(i);
    if (points[points.length - 1] !== longest) points.push(longest);
    const labels = points.map((i) => {
      const row = schedules[0].rows[Math.max(0, i - 1)] || schedules.find((s) => s.rows[i - 1]).rows[i - 1];
      return i === 0 ? 'Now' : row && row.month ? row.month.slice(0, 4) : `Year ${Math.ceil(i / 12)}`;
    });
    const series = schedules.map((s) => points.map((i) => (i === 0 ? startBalance : s.rows[i - 1] ? s.rows[i - 1].balance : 0)));
    return { labels, series };
  }

  function loanTransactions(id) {
    return budget.transactions.filter((t) => t.accountId === id);
  }

  function whatIfText(a, st) {
    if (st.paidOff) return '';
    if (!loanExtra[a.id]) return 'Enter an amount to see how much sooner you would be debt free.';
    if (st.faster.neverPaysOff) return 'Still not enough to cover the interest.';
    if (st.interestSaved == null) return `Debt free in <b>${esc(fmtMonth(st.faster.payoffMonth))}</b>.`;
    return `Debt free in <b>${esc(fmtMonth(st.faster.payoffMonth))}</b>, <b>${esc(duration(st.monthsSaved))}</b> sooner, saving <b>${esc(money(st.interestSaved))}</b> in interest.`;
  }

  function drawLoanChart(a, st) {
    const el = document.getElementById(`loan-chart-${a.id}`);
    if (!el) return;
    if (st.paidOff || st.plan.neverPaysOff) { el.hidden = true; return; }
    el.hidden = false;
    const scheds = st.faster && !st.faster.neverPaysOff ? [st.plan, st.faster] : [st.plan];
    const { labels, series } = yearlyBalances(scheds, st.owed);
    Charts.lines(el, {
      labels,
      series: series.map((values, k) => ({ name: k ? 'With extra payments' : 'Owed', color: seriesColor(k ? 2 : 1), values })),
      fmt: money, fmtAxis: compact, label: `${a.name}: amount owed over time`,
    });
  }

  // Typing an extra payment updates only that loan's what-if line and chart,
  // so the page is never rebuilt under the cursor.
  let extraTimer = null;
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t.matches('[data-loan-extra]')) return;
    clearTimeout(extraTimer);
    extraTimer = setTimeout(() => {
      const a = budget.accounts.find((x) => x.id === t.dataset.loanExtra);
      if (!a || !a.loan) return;
      const text = t.value.trim();
      const cents = text ? B.parseMoney(text) : 0;
      loanExtra[a.id] = Number.isNaN(cents) || cents < 0 ? 0 : cents;
      const st = L.loanStatus(a.loan, loanTransactions(a.id), { today: todayISO(), extra: loanExtra[a.id] });
      const box = document.querySelector(`.what-if[data-loan="${a.id}"] p`);
      if (box) box.innerHTML = whatIfText(a, st);
      drawLoanChart(a, st);
    }, 200);
  });

  function renderLoans() {
    const loans = budget.accounts.filter((a) => a.loan);
    const today = todayISO();
    $('#loan-list').innerHTML = loans.length ? loans.map((a) => {
      const st = L.loanStatus(a.loan, loanTransactions(a.id), { today, extra: loanExtra[a.id] || 0 });
      const pct = st.progress == null ? null : Math.round(st.progress * 100);
      const interestThisMonth = loanTransactions(a.id).some((t) => t.payee === 'Interest' && t.date.slice(0, 7) === today.slice(0, 7));
      const payoff = st.paidOff ? 'Paid off'
        : st.plan.neverPaysOff ? 'Never at this payment: it does not cover the interest'
        : `${fmtMonth(st.plan.payoffMonth)} · in ${duration(st.plan.months)}`;
      return `<article class="card loan-card">
        <header class="loan-head">
          <h3>${esc(a.name)}</h3>
          <span class="hint">${esc(String(a.loan.rate).replace('.', ','))}% a year · ${esc(money(a.loan.payment))} a month</span>
        </header>
        <div class="loan-top">
          <div><div class="label">Owed</div><div class="loan-owed">${esc(money(st.owed))}</div></div>
          ${pct == null ? '' : `<div class="loan-progress"><div class="label">${pct}% repaid</div>
            <div class="tbar fund-full" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(a.name)} repaid"><i style="width:${pct}%"></i></div>
            <div class="hint">${esc(money(st.principalRepaid))} of ${esc(money(a.loan.original))}</div></div>`}
        </div>
        <dl class="facts">
          <div><dt>Paid off</dt><dd>${esc(payoff)}</dd></div>
          ${st.paidOff ? '' : `<div><dt>Interest this month</dt><dd>${esc(money(st.monthlyInterest))}</dd></div>`}
          ${st.interestPaid == null ? '' : `<div><dt>Interest paid so far</dt><dd>${esc(money(st.interestPaid))}</dd></div>`}
          ${st.paidOff || st.plan.neverPaysOff ? '' : `<div><dt>Interest still to pay</dt><dd>${esc(money(st.plan.totalInterest))}</dd></div>`}
        </dl>
        ${st.paidOff ? '' : `<div class="what-if" data-loan="${a.id}">
          <label class="inline-label">Pay extra each month <input type="text" inputmode="decimal" data-loan-extra="${a.id}" value="${loanExtra[a.id] ? B.toInput(loanExtra[a.id]) : ''}" placeholder="0.00"></label>
          <p>${whatIfText(a, st)}</p>
        </div>
        <div class="chart loan-chart" id="loan-chart-${a.id}"></div>`}
        <div class="row">
          ${st.paidOff ? '' : `<button type="button" class="btn sm" data-action="loan-interest" data-id="${a.id}" data-amount="${st.monthlyInterest}"
            title="Adds the interest to the amount owed">${interestThisMonth ? '✓ Interest recorded this month' : `Record interest (${esc(money(st.monthlyInterest))})`}</button>`}
          <button type="button" class="btn sm" data-action="edit-loan" data-id="${a.id}">Edit details</button>
          <button type="button" class="btn sm" data-action="open-account" data-id="${a.id}">Open account</button>
        </div>
      </article>`;
    }).join('') : `<section class="card"><p class="empty">No loans tracked yet. Use "Track a loan" to add a mortgage, car loan or personal loan,
      or try the calculator below and track the result.</p></section>`;

    for (const a of loans) drawLoanChart(a, L.loanStatus(a.loan, loanTransactions(a.id), { today, extra: loanExtra[a.id] || 0 }));
    renderCalculator();
  }

  // Calculator

  function calcInput() {
    const f = $('#calc-form');
    const amount = B.parseMoney(f.amount.value);
    const rate = parseRate(f.rate.value);
    const years = Number(f.years.value);
    const extraText = f.extra.value.trim();
    const extra = extraText ? B.parseMoney(extraText) : 0;
    if (!f.start.value) f.start.value = B.shiftMonth(thisMonth(), 1);
    const rateChanges = f.kind.value === 'variable'
      ? [...document.querySelectorAll('#rate-change-rows .rc-row')].map((row) => ({
        after: Math.round(Number(row.querySelector('[name=rcYear]').value) * 12),
        rate: parseRate(row.querySelector('[name=rcRate]').value),
      })).filter((c) => c.after > 0 && Number.isFinite(c.rate))
      : [];
    if (Number.isNaN(amount) || amount <= 0) return { error: 'Enter the amount to borrow.' };
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { error: 'Enter an interest rate between 0 and 100.' };
    if (!(years >= 1 && years <= 50)) return { error: 'Enter a term between 1 and 50 years.' };
    if (Number.isNaN(extra) || extra < 0) return { error: 'Extra payment must be an amount.' };
    return { amount, rate, months: Math.round(years * 12), extra, rateChanges, start: f.start.value };
  }

  let lastCalc = null;
  function renderCalculator() {
    $('#rate-changes').hidden = $('#calc-form').kind.value !== 'variable';
    const c = calcInput();
    if (c.error) {
      lastCalc = null;
      $('#calc-kpis').innerHTML = `<p class="status bad">${esc(c.error)}</p>`;
      $('#calc-chart').innerHTML = '';
      $('#calc-table').innerHTML = '';
      return;
    }
    const base = L.schedule({ principal: c.amount, annualRate: c.rate, months: c.months, rateChanges: c.rateChanges, startMonth: c.start });
    const fast = c.extra > 0
      ? L.schedule({ principal: c.amount, annualRate: c.rate, months: c.months, rateChanges: c.rateChanges, extra: c.extra, startMonth: c.start })
      : null;
    lastCalc = { ...c, payment: base.payment };
    const tiles = [
      ['Monthly payment', money(base.payment), c.rateChanges.length ? 'at the starting rate' : 'fixed for the whole term'],
      ['Total interest', money(base.totalInterest), `${Math.round((base.totalInterest / c.amount) * 100)}% of the amount borrowed`],
      ['Total paid', money(base.totalPaid), `over ${duration(base.months)}`],
      ['Paid off', fmtMonth(base.payoffMonth), duration(base.months)],
    ];
    if (fast) {
      tiles.push(['With extra payments', fmtMonth(fast.payoffMonth), `${duration(base.months - fast.months)} sooner`]);
      tiles.push(['Interest saved', money(base.totalInterest - fast.totalInterest), `paying ${money(base.payment + c.extra)} a month`]);
    }
    $('#calc-kpis').innerHTML = tiles.map(([k, v, sub]) => `<div class="kpi"><div class="kpi-label">${esc(k)}</div><div class="kpi-value">${esc(v)}</div><div class="kpi-sub">${esc(sub)}</div></div>`).join('');

    const { labels, series } = yearlyBalances(fast ? [base, fast] : [base], c.amount);
    Charts.lines($('#calc-chart'), {
      labels,
      series: series.map((values, k) => ({ name: k ? 'With extra payments' : 'Owed', color: seriesColor(k ? 2 : 1), values })),
      fmt: money, fmtAxis: compact, label: 'Amount owed over time',
    });

    const shown = fast || base;
    if ($('#calc-table-mode').value === 'month') {
      $('#calc-table').innerHTML = `<table class="report-table calc-table"><thead><tr><th>Month</th><th class="num">Rate</th><th class="num">Payment</th><th class="num">Interest</th><th class="num">Principal</th><th class="num">Owed after</th></tr></thead>
        <tbody>${shown.rows.map((r) => `<tr><td>${esc(fmtMonth(r.month))}</td><td class="num">${esc(String(r.rate))}%</td><td class="num">${esc(money(r.payment))}</td>
          <td class="num">${esc(money(r.interest))}</td><td class="num">${esc(money(r.principal))}</td><td class="num">${esc(money(r.balance))}</td></tr>`).join('')}</tbody></table>`;
    } else {
      $('#calc-table').innerHTML = `<table class="report-table calc-table"><thead><tr><th>Year</th><th class="num">Paid</th><th class="num">Interest</th><th class="num">Principal</th><th class="num">Owed at the end</th></tr></thead>
        <tbody>${L.byYear(shown.rows).map((y) => `<tr><td>${esc(y.year)}</td><td class="num">${esc(money(y.payment))}</td>
          <td class="num">${esc(money(y.interest))}</td><td class="num">${esc(money(y.principal))}</td><td class="num">${esc(money(y.balance))}</td></tr>`).join('')}</tbody></table>`;
    }
  }

  let calcTimer = null;
  $('#calc-form').addEventListener('input', () => {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(renderCalculator, 150);
  });
  $('#calc-form').addEventListener('submit', (ev) => ev.preventDefault());
  $('#calc-table-mode').addEventListener('change', renderCalculator);

  function addRateChangeRow(year = '', rate = '') {
    const row = document.createElement('div');
    row.className = 'rc-row';
    row.innerHTML = `<label>After year <input type="number" name="rcYear" min="1" max="50" value="${esc(year)}"></label>
      <label>New rate (%) <input type="text" name="rcRate" inputmode="decimal" value="${esc(rate)}"></label>
      <button type="button" class="icon" data-action="remove-rate-change" aria-label="Remove this rate change">&times;</button>`;
    $('#rate-change-rows').appendChild(row);
  }

  // Loan details dialog. accountId: edit that account; null: track a new one.
  let editingLoan = null;
  function openLoan(accountId, prefill = null) {
    const f = $('#loan-form');
    f.reset();
    $('#loan-error').hidden = true;
    editingLoan = accountId;
    const acct = accountId && budget.accounts.find((a) => a.id === accountId);
    const free = budget.accounts.filter((a) => a.offBudget && !a.loan);
    f.account.innerHTML = `${free.map((a) => `<option value="${a.id}">${esc(a.name)} (owes ${esc(money(-B.accountBalance(budget, a.id)))})</option>`).join('')}
      <option value="new">A new account…</option>`;
    if (prefill) f.account.value = 'new';
    $('#loan-account-field').hidden = !!acct;
    $('#loan-remove').hidden = !(acct && acct.loan);
    $('#loan-title').textContent = acct ? `${acct.name}: loan details` : 'Track a loan';
    const loan = acct && acct.loan;
    const src = prefill || loan || {};
    f.rate.value = src.rate != null ? String(src.rate) : '';
    f.payment.value = src.payment ? B.toInput(src.payment) : '';
    f.original.value = src.original ? B.toInput(src.original) : '';
    f.startDate.value = src.startDate || '';
    f.name.value = prefill ? prefill.name || '' : '';
    f.owed.value = prefill && prefill.owed ? B.toInput(prefill.owed) : '';
    syncLoanFields();
    $('#loan-dialog').showModal();
  }
  function syncLoanFields() {
    const isNew = !editingLoan && $('#loan-form').account.value === 'new';
    $('#loan-name-field').hidden = !isNew;
    $('#loan-owed-field').hidden = !isNew;
  }
  $('#loan-form').account.addEventListener('change', syncLoanFields);

  $('#loan-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const fail = (msg) => { $('#loan-error').textContent = msg; $('#loan-error').hidden = false; };
    let loan;
    try {
      const original = f.original.value.trim() ? B.parseMoney(f.original.value) : null;
      if (Number.isNaN(original)) throw new Error('Original amount must be an amount like 150000.00.');
      loan = L.normalizeLoan({ rate: parseRate(f.rate.value), payment: B.parseMoney(f.payment.value), original, startDate: f.startDate.value || null });
    } catch (err) {
      fail(err.message);
      return;
    }
    let target = editingLoan && budget.accounts.find((a) => a.id === editingLoan);
    if (!target) {
      if (f.account.value === 'new') {
        const owed = B.parseMoney(f.owed.value);
        if (!f.name.value.trim()) { fail('Give the loan a name.'); return; }
        if (Number.isNaN(owed) || owed <= 0) { fail('Enter how much is owed today.'); return; }
        target = B.addAccount(budget, { name: f.name.value, balance: -owed, date: todayISO(), offBudget: true });
      } else {
        target = budget.accounts.find((a) => a.id === f.account.value);
      }
    }
    if (!target) { fail('Pick an account.'); return; }
    target.loan = loan;
    $('#loan-dialog').close();
    attempt(() => {});
  });

  // Backup

  function exportBackup() {
    const blob = new Blob([JSON.stringify(budget, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `envelo-backup-${todayISO()}.json`,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const next = B.fromJSON(JSON.parse(await file.text()));
      if (!confirm(`Replace your current data with ${next.envelopes.length} envelopes and ${next.transactions.length} transactions?`)) return;
      budget = next;
      showError('');
      scheduleSave();
      render();
    } catch (err) {
      showError('Import failed: ' + err.message);
    }
  }

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // "Tue 20 Oct" (with the year when it is not this year).
  function fmtDay(d) {
    const [y, mo, day] = d.split('-').map(Number);
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    if (y !== new Date().getFullYear()) opts.year = 'numeric';
    return new Date(y, mo - 1, day).toLocaleDateString(undefined, opts);
  }
  function fmtMonth(m) {
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
  }

  function describeTarget(e) {
    const t = e.target;
    const amt = money(t.amount);
    switch (t.type) {
      case 'monthly': return `${amt} every month${t.until ? ` until ${fmtMonth(t.until)}` : ''}`;
      case 'weekly': return `${amt} every ${WEEKDAYS[t.weekday]} (${money(e.monthAmount)} this month)`;
      case 'refill': return `Refill up to ${amt}`;
      case 'balance': return `Have ${amt}`;
      case 'byDate': return `Have ${amt} by ${fmtMonth(t.date)}`;
      case 'repeating': return `${amt} every ${t.every === 1 ? 'month' : `${t.every} months`}, due ${fmtMonth(e.due)}`;
      default: return '';
    }
  }

  // Envelope dialogs: sticker, name, group (or a new one) and parent envelope.
  const STICKERS = ['🛒', '🍎', '🥖', '☕', '🍽️', '🍕', '🍷', '🏠', '🔑', '⚡', '💧', '🔥', '📶', '📱', '💻', '🚗', '⛽', '🚌', '🚲', '✈️',
    '🏖️', '🧳', '🎁', '🎉', '🎬', '🎮', '🎵', '📚', '🎨', '🏃', '💪', '💊', '🩺', '🦷', '👕', '👟', '💇', '🧴', '🐶', '🐱',
    '👶', '🎓', '🧸', '🛠️', '🔧', '🪴', '🧾', '💳', '🏦', '💰', '🐷', '🛟', '📈', '🎯', '❤️', '⭐'];
  function envFieldsFor(f) {
    return { sticker: f.sticker, btn: f.querySelector('.sticker-btn'), grid: f.querySelector('.sticker-grid'),
      group: f.querySelector('.group-select'), newGroup: f.newGroup, newField: f.querySelector('.new-group-field'),
      parent: f.querySelector('.parent-select') };
  }
  function setSticker(f, emoji) {
    const el = envFieldsFor(f);
    el.sticker.value = emoji;
    el.btn.textContent = emoji || '＋';
    el.btn.classList.toggle('empty', !emoji);
    el.grid.hidden = true;
    el.btn.setAttribute('aria-expanded', 'false');
  }
  function toggleStickers(f) {
    const el = envFieldsFor(f);
    if (!el.grid.innerHTML) {
      el.grid.innerHTML = `${STICKERS.map((e) => `<button type="button" data-action="set-sticker" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('')}
        <button type="button" class="none" data-action="set-sticker" data-emoji="">No sticker</button>`;
    }
    el.grid.hidden = !el.grid.hidden;
    el.btn.setAttribute('aria-expanded', String(!el.grid.hidden));
  }
  // Fill the fields. selfId: the envelope being edited (it cannot be its own parent).
  function fillEnvFields(f, nameField, { name = '', group = null, parentId = null, selfId = null } = {}) {
    const el = envFieldsFor(f);
    const { icon, text } = splitEmoji(name);
    f[nameField].value = icon ? text : name;
    setSticker(f, icon || '');
    const groups = B.groupNames(budget);
    const pick = group || groups[0] || 'General';
    const all = groups.includes(pick) ? groups : [...groups, pick];
    el.group.innerHTML = `${all.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
      <option value="__new">＋ New group…</option>`;
    el.group.value = pick;
    el.newGroup.value = '';
    el.newField.hidden = true;
    const hasChildren = !!selfId && budget.envelopes.some((e) => e.parentId === selfId);
    const parents = budget.envelopes.filter((e) => !e.parentId && e.id !== selfId);
    el.parent.innerHTML = `<option value="">No, it is a main envelope</option>
      ${groups.map((g) => {
        const list = parents.filter((e) => e.group === g);
        return list.length ? `<optgroup label="${esc(g)}">${list.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</optgroup>` : '';
      }).join('')}`;
    el.parent.value = parentId || '';
    el.parent.disabled = hasChildren;
    el.parent.title = hasChildren ? 'This envelope has sub-envelopes, so it stays a main envelope.' : '';
    syncEnvGroup(f);
  }
  function syncEnvGroup(f) {
    const el = envFieldsFor(f);
    const parent = el.parent.value && budget.envelopes.find((e) => e.id === el.parent.value);
    if (parent) el.group.value = parent.group;
    el.group.disabled = !!parent;
    el.newField.hidden = !!parent || el.group.value !== '__new';
    if (!el.newField.hidden && document.activeElement === el.group) setTimeout(() => el.newGroup.focus(), 0);
  }
  function readEnvFields(f, nameField) {
    const el = envFieldsFor(f);
    const text = f[nameField].value.trim();
    if (!text && !el.sticker.value) throw new Error('Give the envelope a name.');
    const name = el.sticker.value ? `${el.sticker.value} ${text}`.trim() : text;
    const parentId = el.parent.disabled ? undefined : el.parent.value || null;
    let group = el.group.value;
    if (group === '__new') {
      group = el.newGroup.value.trim();
      if (!group) throw new Error('Give the new group a name.');
    }
    return { name, group, parentId };
  }
  for (const f of [$('#env-form'), $('#target-form')]) {
    f.querySelector('.group-select').addEventListener('change', () => syncEnvGroup(f));
    f.querySelector('.parent-select').addEventListener('change', () => syncEnvGroup(f));
  }
  function openNewEnvelope({ group = null, parentId = null } = {}) {
    const f = $('#env-form');
    f.reset();
    fillEnvFields(f, 'name', { group, parentId });
    $('#env-dialog').showModal();
    setTimeout(() => f.name.focus(), 30);
  }

  let editingTarget = null;
  function openTarget(envId) {
    const env = budget.envelopes.find((e) => e.id === envId);
    if (!env) return;
    editingTarget = envId;
    const t = env.target || (env.goal ? { type: 'balance', amount: env.goal } : null);
    const f = $('#target-form');
    $('#target-title').textContent = env.name;
    $('#target-error').hidden = true;
    fillEnvFields(f, 'envName', { name: env.name, group: env.group, parentId: env.parentId, selfId: env.id });
    $('#add-sub-btn').hidden = !!env.parentId;
    f.carryOverspending.checked = !!env.carryOverspending;
    f.envHidden.checked = !!env.hidden;
    const others = budget.envelopes.filter((e) => e.id !== envId);
    const used = budget.transactions.some((t) => t.envelopeId === envId)
      || (budget.recurring || []).some((r) => r.envelopeId === envId);
    f.moveTo.innerHTML = others.map((e) => `<option value="${e.id}">${esc(e.group)} · ${esc(e.name)}</option>`).join('');
    $('#move-to-field').hidden = !used;
    f.querySelector('.danger-zone').open = false;
    f.type.value = t ? t.type : '';
    f.amount.value = t ? B.toInput(t.amount) : '';
    f.until.value = t && t.until ? t.until : '';
    f.date.value = t && t.date ? t.date : '';
    f.every.value = t && t.every ? t.every : 12;
    f.next.value = t && t.next ? t.next : month;
    f.weekday.value = t && t.weekday != null ? t.weekday : 1;
    syncTargetFields();
    $('#target-dialog').showModal();
  }

  function syncTargetFields() {
    const type = $('#target-form').type.value;
    document.querySelectorAll('#target-form [data-for]').forEach((el) => {
      el.hidden = !el.dataset.for.split(' ').includes(type);
    });
  }
  $('#target-form').type.addEventListener('change', syncTargetFields);

  $('#target-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const type = f.type.value;
    let target = null;
    if (type) {
      const amount = B.parseMoney(f.amount.value);
      target = { type, amount: Number.isNaN(amount) ? 0 : amount };
      if (type === 'monthly' && f.until.value) target.until = f.until.value;
      if (type === 'byDate') target.date = f.date.value;
      if (type === 'repeating') { target.every = Number(f.every.value); target.next = f.next.value; }
      if (type === 'weekly') target.weekday = Number(f.weekday.value);
    }
    try {
      B.updateEnvelope(budget, editingTarget, {
        ...readEnvFields(f, 'envName'), carryOverspending: f.carryOverspending.checked,
        hidden: f.envHidden.checked,
      });
      B.setTarget(budget, editingTarget, target);
    } catch (err) {
      $('#target-error').textContent = err.message;
      $('#target-error').hidden = false;
      return;
    }
    $('#target-error').hidden = true;
    $('#target-dialog').close();
    attempt(() => {});
  });

  async function importActual(file) {
    if (!file) return;
    if (/\.zip$/i.test(file.name) || /zip/.test(file.type)) {
      await importActualZip(file);
      return;
    }
    try {
      const text = await file.text();
      let result;
      const ok = attempt(() => { result = B.importTransactionsCsv(budget, text); });
      if (!ok) return;
      const parts = [`Imported ${result.imported} transactions (${result.income} income).`];
      if (result.envelopesCreated) parts.push(`Created ${result.envelopesCreated} envelopes.`);
      if (result.duplicates) parts.push(`Skipped ${result.duplicates} already imported.`);
      if (result.skipped) parts.push(`Skipped ${result.skipped} transfers or uncategorized rows.`);
      parts.push('Budgeted amounts are not in the export, so assign money to your envelopes now.');
      alert(parts.join('\n'));
    } catch (err) {
      showError('Import failed: ' + err.message);
    }
  }

  // Full Actual export: the server reads the zip and returns a budget, which
  // replaces the current one only after the user confirms.
  async function importActualZip(file) {
    setSync('Reading the Actual export…');
    let res;
    try {
      const r = await fetch('/api/import/actual', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.error || `Import failed (${r.status}).`);
    } catch (err) {
      setSync('');
      showError('Import failed: ' + err.message);
      return;
    }
    setSync('');
    const s = res.summary;
    const lines = [
      `Import "${s.name || 'Actual budget'}"?`,
      '',
      `${s.accounts} accounts, ${s.envelopes} envelopes, ${s.transactions} transactions (${s.transfers} transfers), budgeted amounts for ${s.months} months.`,
    ];
    if (s.offBudgetSkipped) lines.push(`${s.offBudgetSkipped} transactions in off-budget accounts are left out.`);
    if (s.uncategorized) lines.push(`${s.uncategorized} uncategorized transactions go to an "Uncategorized" envelope.`);
    if (s.negativeBudgetsSkipped) lines.push(`${s.negativeBudgetsSkipped} negative budgeted amounts are left out.`);
    lines.push('', 'This REPLACES everything currently in Envelo. Export a backup first if unsure.');
    if (!confirm(lines.join('\n'))) return;
    budget = B.fromJSON(res.budget);
    showError('');
    scheduleSave();
    render();
  }

  fetch('/api/version').then((r) => r.json()).then((v) => {
    $('#version').textContent = `Envelo ${v.version}`;
  }).catch(() => {});

  // Installable app: the service worker keeps it working offline. Browsers
  // only allow it over HTTPS (or on localhost).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Start: restore the session if there is one.
  (async function boot() {
    try {
      const { user } = await api('GET', '/api/me');
      account = user;
      await loadBudget();
      showApp();
    } catch (err) {
      if (err.status === 401) {
        showAuth();
      } else {
        showAuth('Could not reach the Envelo server. Check the connection and reload.');
      }
    }
  })();
})();
