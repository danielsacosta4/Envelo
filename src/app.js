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

  let budget = B.create();
  let month = thisMonth();
  let account = null;
  let revision = 0; // server revision this copy is based on
  let currentView = 'budget';
  let openAccountId = null;
  let editingTx = null;

  // API

  async function api(method, url, body, extraHeaders = {}) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
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
        budget = err.data.budget ? B.fromJSON(err.data.budget) : B.create();
        revision = err.data.revision;
        showError('Your budget was changed on another device, so this screen now shows the latest version. Your last change here was not saved; please make it again.');
        setSync('Reloaded the latest version');
        render();
        return;
      }
      dirty = true;
      setSync(`Not saved: ${err.message} Retrying…`, true);
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
  function attempt(fn) {
    try {
      fn();
      showError('');
      scheduleSave();
      render();
      return true;
    } catch (err) {
      showError(err.message);
      render();
      return false;
    }
  }

  // Animations. Skipped entirely when the device asks for reduced motion.
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function toast(message) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.remove('show');
    void el.offsetWidth; // restart the transition
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
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

  // Euro notes fly from Ready to Assign into the envelopes that got money.
  function flyNotes(envIds) {
    if (!envIds.length || reduceMotion() || !document.body.animate) return;
    const from = $('#ready .amount');
    if (!from) return;
    const src = from.getBoundingClientRect();
    envIds.slice(0, 6).forEach((id, k) => {
      const target = document.querySelector(`#envelope-rows input[data-env="${id}"]`);
      if (!target || !target.offsetParent) return;
      const dst = target.getBoundingClientRect();
      for (let n = 0; n < 3; n++) {
        const note = document.createElement('div');
        note.className = 'euro-note';
        note.textContent = '€';
        note.style.left = `${src.left + src.width / 2 - 20}px`;
        note.style.top = `${src.top + src.height / 2 - 12}px`;
        document.body.appendChild(note);
        const dx = dst.left + dst.width / 2 - (src.left + src.width / 2);
        const dy = dst.top + dst.height / 2 - (src.top + src.height / 2);
        const tilt = (n - 1) * 12;
        note.animate([
          { transform: `translate(0, 0) rotate(${tilt}deg) scale(1)`, opacity: 0 },
          { opacity: 1, offset: 0.1 },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 90}px) rotate(${tilt * -2}deg) scale(1.1)`, offset: 0.5 },
          { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(.6)`, opacity: 0.2 },
        ], { duration: 900, delay: k * 120 + n * 90, easing: 'ease-in-out', fill: 'forwards' })
          .finished.then(() => note.remove(), () => note.remove());
      }
      setTimeout(() => {
        target.classList.remove('pulse');
        void target.offsetWidth;
        target.classList.add('pulse');
      }, k * 120 + 900);
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

  // Funding state of an envelope with a target: full, partial or none.
  function fundState(e) {
    if (!e.target) return '';
    if (!e.underfunded) return 'fund-full';
    return e.assigned > 0 || (e.progress || 0) > 0 ? 'fund-partial' : 'fund-none';
  }

  function envelopeRow(e, tone, isCollapsed, isHiddenRow = false) {
    const availClass = e.available < 0 || e.underfunded ? 'neg' : e.available === 0 ? 'zero' : '';
    const state = fundState(e);
    const pct = Math.round((e.progress || 0) * 100);
    const goal = e.target ? `<div class="goal ${e.underfunded ? 'short' : 'done'}">${esc(describeTarget(e))}
        · ${e.underfunded ? `needs ${esc(money(e.needed))} this month` : 'funded'}</div>
      <div class="tbar ${state}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
        aria-label="${esc(e.name)} target ${pct}%"><i style="width:${pct}%"></i></div>` : '';
    const fund = isHiddenRow
      ? `<button type="button" class="fund" data-action="unhide-envelope" data-id="${e.id}">Unhide</button>`
      : e.underfunded
        ? `<button type="button" class="fund" data-action="fund" data-id="${e.id}" data-amount="${e.needed}">Assign ${esc(money(e.needed))}</button>`
        : '';
    return `<tr class="${tone}${isCollapsed ? ' is-collapsed' : ''}" data-env-row="${e.id}">
      <td class="env-cell"><div class="env-name"><button type="button" class="env-link" data-action="edit-target" data-id="${e.id}" title="Edit envelope and target">${esc(e.name)}</button>${e.overspent ? '<span class="badge">Overspent</span>' : ''}</div>${goal}</td>
      <td class="num" data-label="Assigned"><input type="text" inputmode="decimal" class="${state}" aria-label="Assigned to ${esc(e.name)}"
          value="${B.toInput(e.assigned)}" data-env="${e.id}"></td>
      <td class="num" data-label="Spent">${esc(money(e.activity))}</td>
      <td class="num" data-label="Available"><span class="avail ${availClass}">${esc(money(e.available))}</span></td>
      <td class="num fund-cell">${fund}</td>
    </tr>`;
  }

  function render() {
    const view = B.monthView(budget, month);
    const [y, m] = month.split('-').map(Number);
    $('#month-label').textContent = new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
    $('#currency').value = budget.currency;
    $('#theme').value = readTheme();
    $('#density').value = readDensity();
    $('#print-month').textContent = `${$('#month-label').textContent} · Ready to assign ${money(view.readyToAssign)}`;
    $('#account').textContent = account ? account.email : '';

    const ready = $('#ready');
    ready.classList.toggle('warn', view.readyToAssign < 0);
    ready.innerHTML = `<div class="label">Ready to assign</div>
      <div class="amount">${esc(money(view.readyToAssign))}</div>
      ${view.underfunded > 0 ? `<div class="under-line">Targets need ${esc(money(view.underfunded))} this month
        <button type="button" data-action="fund-all">Fund all targets</button></div>` : ''}`;

    const rows = [];
    const collapsed = readCollapsed();
    const hiddenRows = [];
    let gi = 0;
    for (const g of view.groups) {
      const groupHidden = (budget.hiddenGroups || []).includes(g.name);
      const visible = g.envelopes.filter((e) => !e.hidden);
      for (const e of g.envelopes) if (e.hidden) hiddenRows.push(e);
      if (groupHidden || !visible.length) continue;
      const tone = `tone-${gi++ % 3}`;
      const isCollapsed = collapsed.includes(g.name);
      const sum = (key) => visible.reduce((t, e) => t + e[key], 0);
      const availSum = sum('available');
      rows.push(`<tr class="group ${tone}">
        <td class="group-name"><button type="button" class="group-toggle" data-action="toggle-group" data-group="${esc(g.name)}"
            aria-expanded="${!isCollapsed}"><span class="chev">${isCollapsed ? '▸' : '▾'}</span>${esc(g.name)}</button></td>
        <td class="num g-sum">${esc(money(sum('assigned')))}</td>
        <td class="num g-sum">${esc(money(sum('activity')))}</td>
        <td class="num g-sum ${availSum < 0 ? 'neg' : ''}">${esc(money(availSum))}</td>
        <td class="num g-act"><button type="button" class="icon-text" data-action="hide-group" data-group="${esc(g.name)}" title="Hide this group">Hide</button></td>
      </tr>`);
      for (const e of visible) rows.push(envelopeRow(e, tone, isCollapsed));
    }
    const hiddenGroups = (budget.hiddenGroups || []).filter((name) => budget.envelopes.some((e) => e.group === name));
    if (hiddenRows.length) {
      const showing = showHidden;
      rows.push(`<tr class="group hidden-head">
        <td colspan="5"><button type="button" class="group-toggle" data-action="toggle-hidden" aria-expanded="${showing}">
          <span class="chev">${showing ? '▾' : '▸'}</span>Hidden (${hiddenRows.length})</button>
          ${showing ? hiddenGroups.map((name) => `<button type="button" class="icon-text" data-action="show-group" data-group="${esc(name)}">Show group "${esc(name)}"</button>`).join(' ') : ''}
        </td></tr>`);
      if (showing) for (const e of hiddenRows) rows.push(envelopeRow(e, 'tone-hidden', false, true));
    }
    $('#envelope-rows').innerHTML = rows.join('');
    $('#empty').hidden = budget.envelopes.length > 0;

    renderEnvelopeOptions();
    syncKind();
    renderTransactions();
    renderAccounts();
    renderRecurring();
    if (currentView === 'account' && !budget.accounts.some((a) => a.id === openAccountId)) currentView = 'accounts';
    for (const v of ['budget', 'accounts', 'account', 'reports']) $(`#view-${v}`).hidden = v !== currentView;
    const tab = currentView === 'account' ? 'accounts' : currentView;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === tab));
    // The transaction form lives on the budget page and on an account page.
    const formHome = currentView === 'account' ? $('#account-side') : $('#budget-side');
    if ($('#tx-panel').parentElement !== formHome) formHome.prepend($('#tx-panel'));
    if (currentView === 'account') renderAccountPage();
    if (currentView === 'reports') renderReport();
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
        <div><div class="env-name"><button type="button" class="env-link" data-action="open-account" data-id="${a.id}">${esc(a.name)}</button>${a.offBudget ? '<span class="badge off">Off budget</span>' : ''}</div><div class="goal">${rec}</div></div>
        <div class="acct-bal ${bal < 0 ? 'neg' : ''}">${esc(money(bal))}</div>
        <div class="row acct-actions">
          <button type="button" data-action="reconcile" data-id="${a.id}">Reconcile</button>
          <button type="button" data-action="rename-account" data-id="${a.id}">Rename</button>
          <button type="button" class="danger" data-action="delete-account" data-id="${a.id}">Delete</button>
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
    $('#acct-title').innerHTML = `${esc(acct.name)}${acct.offBudget ? '<span class="badge off">Off budget</span>' : ''}`;
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
        <td><button type="button" class="env-link" data-action="edit-tx" data-id="${t.id}">${esc(t.payee || (t.amount > 0 ? 'Income' : 'Spending'))}</button>
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
  function renderRecurring() {
    const rules = budget.recurring || [];
    const names = Object.fromEntries(budget.envelopes.map((e) => [e.id, e.name]));
    $('#recurring-list').innerHTML = rules.length ? rules.map((r) => {
      const every = r.every === 1 ? `Every ${FREQ_LABEL[r.freq]}` : `Every ${r.every} ${FREQ_LABEL[r.freq]}s`;
      const where = r.kind === 'spend' ? names[r.envelopeId] || 'Deleted envelope' : 'Income';
      return `<li>
        <div class="tx-meta">${esc(every)} · next ${esc(r.next)} · ${esc(where)}</div>
        <div><strong>${esc(r.payee || (r.kind === 'spend' ? 'Spending' : 'Income'))}</strong></div>
        <div class="tx-amt ${r.kind === 'income' ? 'in' : ''}">${r.kind === 'income' ? '+' : '-'}${esc(money(r.amount))}</div>
        <button type="button" class="icon tx-del" data-action="remove-recurring" data-id="${r.id}" aria-label="Stop repeating">&times;</button>
      </li>`;
    }).join('') : '<li class="tx-meta">Nothing repeats yet.</li>';
  }

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
    resizeTimer = setTimeout(() => { if (currentView === 'reports') renderReport(); }, 150);
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

    const groups = [...new Set(budget.envelopes.map((e) => e.group))];
    $('#group-list').innerHTML = groups.map((g) => `<option value="${esc(g)}">`).join('');
  }

  function renderTransactions() {
    const txs = budget.transactions
      .filter((t) => t.date.slice(0, 7) === month)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const names = Object.fromEntries(budget.envelopes.map((e) => [e.id, e.name]));
    $('#tx-count').textContent = txs.length ? `${txs.length} this month` : '';
    $('#tx-list').innerHTML = txs.length ? txs.map((t) => {
      const where = t.envelopeId ? names[t.envelopeId] || 'Deleted envelope'
        : t.transferId ? 'Transfer'
        : B.isOnBudget(budget, t.accountId) ? 'Income' : 'Off budget';
      const label = t.payee || (t.envelopeId ? 'Spending' : 'Income');
      const acct = budget.accounts.length > 1 ? ` · ${esc(accountName(t.accountId))}` : '';
      return `<li>
        <div class="tx-meta">${esc(t.date)} · ${esc(where)}${acct}${t.note ? ' · ' + esc(t.note) : ''}${t.reconciled ? ' · ✓' : ''}</div>
        <div><button type="button" class="env-link" data-action="edit-tx" data-id="${t.id}">${esc(label)}</button></div>
        <div class="tx-amt ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${esc(money(t.amount))}</div>
        <button type="button" class="icon tx-del" data-action="delete-tx" data-id="${t.id}" aria-label="Delete transaction">&times;</button>
      </li>`;
    }).join('') : '<li class="tx-meta">No transactions this month.</li>';
  }

  // Auth

  function showAuth(message = '') {
    account = null;
    budget = B.create();
    $('#app').hidden = true;
    $('#auth').hidden = false;
    $('#auth-message').textContent = message;
    $('#auth-message').hidden = !message;
    $('#auth-password').value = '';
  }

  function showApp() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    render();
  }

  let authMode = 'login';
  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      authMode = btn.dataset.authMode;
      document.querySelectorAll('[data-auth-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      $('#auth-submit').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
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
      const { user } = await api('POST', path, { email: f.email.value, password: f.password.value });
      account = user;
      await loadBudget();
      showApp();
    } catch (err) {
      $('#auth-message').textContent = err.message;
      $('#auth-message').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  async function loadBudget() {
    const res = await api('GET', '/api/budget');
    budget = res.budget ? B.fromJSON(res.budget) : B.create();
    revision = res.revision || 0;
    setSync('');
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
    showAuth();
  }

  // Events

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'prev-month': month = B.shiftMonth(month, -1); render(); break;
      case 'next-month': month = B.shiftMonth(month, 1); render(); break;
      case 'this-month': month = thisMonth(); render(); break;
      case 'fund': {
        const cur = B.assignedIn(budget, month, btn.dataset.id);
        if (attempt(() => B.setAssigned(budget, month, btn.dataset.id, cur + Number(btn.dataset.amount)))) {
          flyNotes([btn.dataset.id]);
        }
        break;
      }
      case 'delete-tx':
        if (confirm('Delete this transaction?')) attempt(() => B.removeTransaction(budget, btn.dataset.id));
        break;
      case 'fund-all': {
        let total = 0;
        const before = Object.fromEntries(budget.envelopes.map((e) => [e.id, B.assignedIn(budget, month, e.id)]));
        const ok = attempt(() => { total = B.fundAllTargets(budget, month); });
        if (ok && total === 0) showError('There is no money in Ready to Assign to fund targets.');
        if (ok && total > 0) {
          flyNotes(budget.envelopes.filter((e) => B.assignedIn(budget, month, e.id) > before[e.id]).map((e) => e.id));
        }
        break;
      }
      case 'edit-target': openTarget(btn.dataset.id); break;
      case 'edit-tx': editTransaction(btn.dataset.id); break;
      case 'toggle-group': toggleCollapsed(btn.dataset.group); render(); break;
      case 'toggle-hidden': showHidden = !showHidden; render(); break;
      case 'hide-group':
        if (confirm(`Hide the group "${btn.dataset.group}"? Its envelopes keep their money and still count in totals.`)) {
          attempt(() => B.setGroupHidden(budget, btn.dataset.group, true));
        }
        break;
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
      case 'cancel-edit': stopEditing(); break;
      case 'delete-envelope': {
        const f = $('#target-form');
        const env = budget.envelopes.find((e) => e.id === editingTarget);
        if (!env || !confirm(`Delete the envelope "${env.name}"? Money assigned to it goes back to Ready to Assign.`)) break;
        try {
          B.deleteEnvelope(budget, editingTarget, f.moveTo.value || null);
        } catch (err) {
          $('#target-error').textContent = err.message;
          $('#target-error').hidden = false;
          break;
        }
        $('#target-dialog').close();
        attempt(() => {});
        break;
      }
      case 'remove-recurring':
        if (confirm('Stop this recurring transaction? Transactions already created stay.')) {
          attempt(() => B.removeRecurring(budget, btn.dataset.id));
        }
        break;
      case 'rename-account': {
        const acct = budget.accounts.find((a) => a.id === btn.dataset.id);
        const name = acct && prompt('New name for this account', acct.name);
        if (name) attempt(() => B.updateAccount(budget, acct.id, { name }));
        break;
      }
      case 'delete-account':
        if (confirm('Delete this account?')) attempt(() => B.deleteAccount(budget, btn.dataset.id));
        break;
      case 'reconcile': openReconcile(btn.dataset.id); break;
      case 'open-account':
        openAccountId = btn.dataset.id;
        currentView = 'account';
        $('#acct-search').value = '';
        if (!editingTx) $('#tx-account').value = openAccountId;
        render();
        window.scrollTo(0, 0);
        break;
      case 'back-to-accounts': currentView = 'accounts'; render(); break;
      case 'close-reconcile': $('#reconcile-dialog').close(); break;
      case 'close-target': $('#target-dialog').close(); break;
      case 'export': exportBackup(); break;
      case 'import': $('#import-file').click(); break;
      case 'import-actual': $('#import-actual-file').click(); break;
      case 'logout': logout(); break;
      case 'reset':
        if (confirm('Erase every envelope and transaction on your account? Export a backup first if unsure.')) {
          budget = B.create();
          attempt(() => {});
        }
        break;
    }
  });

  document.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', () => {
    currentView = btn.dataset.view;
    render();
  }));

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
    try {
      if (Number.isNaN(bank)) throw new Error('Enter the balance your bank shows.');
      diff = B.reconcileAccount(budget, reconcilingAccount, bank, f.date.value);
    } catch (err) {
      $('#reconcile-error').textContent = err.message;
      $('#reconcile-error').hidden = false;
      return;
    }
    $('#reconcile-dialog').close();
    attempt(() => {});
    const acct = budget.accounts.find((a) => a.id === reconcilingAccount);
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
    });
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
      if (attempt(() => B.setAssigned(budget, month, t.dataset.env, cents)) && cents > before) {
        flyNotes([t.dataset.env]);
      }
    } else if (t.id === 'currency') {
      budget.currency = t.value;
      attempt(() => {});
    } else if (t.id === 'acct-period') {
      renderAccountPage();
    } else if (t.id === 'report-months') {
      renderReport();
    } else if (t.id === 'density') {
      applyDensity(t.value);
    } else if (t.id === 'theme') {
      applyTheme(t.value);
    } else if (t.id === 'import-actual-file') {
      importActual(t.files[0]);
      t.value = '';
    } else if (t.id === 'import-file') {
      importBackup(t.files[0]);
      t.value = '';
    }
  });

  $('#acct-search').addEventListener('input', () => renderAccountPage());

  // Flush pending changes when the tab is hidden, e.g. before the browser closes it.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      flush();
      return;
    }
    // Coming back to the tab: pick up changes made on other devices.
    if (!account || dirty || inFlight) return;
    try {
      const res = await api('GET', '/api/budget');
      if ((res.revision || 0) !== revision) {
        budget = res.budget ? B.fromJSON(res.budget) : B.create();
        revision = res.revision || 0;
        render();
      }
    } catch {
      // Offline or signed out: keep what is on screen.
    }
  });

  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', syncKind));
  $('#tx-account').addEventListener('change', syncKind);
  $('#tx-to').addEventListener('change', syncKind);
  function syncKind() {
    const kind = document.querySelector('input[name="kind"]:checked').value;
    const from = $('#tx-account').value;
    const to = $('#tx-to').value;
    // Envelopes apply to spending in on-budget accounts, and to transfers
    // that move money out of the budget into an off-budget account.
    const needsEnvelope = kind === 'spend'
      ? B.isOnBudget(budget, from)
      : kind === 'transfer' && !!to && B.transferNeedsEnvelope(budget, from, to);
    $('#tx-envelope-field').hidden = !needsEnvelope;
    $('#tx-envelope').required = needsEnvelope;
    $('#tx-to-field').hidden = kind !== 'transfer';
    $('#tx-account-label').textContent = kind === 'transfer' ? 'From account' : 'Account';
    $('#tx-repeat-field').hidden = kind === 'transfer' || !!editingTx;
  }

  function editTransaction(id) {
    const t = budget.transactions.find((x) => x.id === id);
    if (!t) return;
    // For a transfer, always edit from the sending side.
    const main = t.transferId && t.amount > 0
      ? budget.transactions.find((x) => x.transferId === t.transferId && x.amount < 0) || t
      : t;
    editingTx = main.id;
    const f = $('#tx-form');
    const kind = B.transactionKind(main);
    f.querySelector(`input[name="kind"][value="${kind}"]`).checked = true;
    f.date.value = main.date;
    f.payee.value = main.payee || '';
    f.amount.value = B.toInput(Math.abs(main.amount));
    f.note.value = main.note || '';
    if (main.envelopeId) f.envelopeId.value = main.envelopeId;
    f.accountId.value = main.accountId;
    if (main.toAccountId) f.toAccountId.value = main.toAccountId;
    f.repeat.value = '';
    $('#tx-heading').textContent = 'Edit transaction';
    $('#tx-submit').textContent = 'Update transaction';
    $('#tx-cancel').hidden = false;
    syncKind();
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function stopEditing() {
    editingTx = null;
    const f = $('#tx-form');
    f.payee.value = '';
    f.amount.value = '';
    f.note.value = '';
    f.repeat.value = '';
    $('#tx-heading').textContent = 'Add transaction';
    $('#tx-submit').textContent = 'Save transaction';
    $('#tx-cancel').hidden = true;
    syncKind();
  }

  $('#tx-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const kind = f.kind.value;
    const cents = B.parseMoney(f.amount.value);
    let scheduled = false;
    const ok = attempt(() => {
      if (Number.isNaN(cents)) throw new Error('Enter an amount like 12.50.');
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
      if (editingTx) {
        B.updateTransaction(budget, editingTx, fields);
      } else if (f.repeat.value && kind !== 'transfer') {
        const freq = f.repeat.value === 'biweekly' ? 'weekly' : f.repeat.value;
        const every = f.repeat.value === 'biweekly' ? 2 : 1;
        B.addRecurring(budget, { ...fields, freq, every, next: fields.date });
        scheduled = B.applyRecurring(budget, todayISO()) === 0;
      } else {
        B.addTransaction(budget, fields);
      }
    });
    if (ok) {
      const wasEditing = !!editingTx;
      stopEditing();
      if (scheduled) setSync(`Scheduled: it will be added on ${f.date.value}`);
      if (!wasEditing) f.amount.focus();
    }
  });

  $('#env-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const goalText = f.goal.value.trim();
    const goal = goalText ? B.parseMoney(goalText) : null;
    const ok = attempt(() => {
      if (goal !== null && Number.isNaN(goal)) throw new Error('Goal must be an amount like 500.00.');
      B.addEnvelope(budget, { name: f.name.value, group: f.group.value, goal });
    });
    if (ok) f.reset();
  });

  // Default the date field to today and sync the type toggle on load.
  $('#tx-form').date.value = todayISO();
  syncKind();

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

  let editingTarget = null;
  function openTarget(envId) {
    const env = budget.envelopes.find((e) => e.id === envId);
    if (!env) return;
    editingTarget = envId;
    const t = env.target || (env.goal ? { type: 'balance', amount: env.goal } : null);
    const f = $('#target-form');
    $('#target-title').textContent = env.name;
    $('#target-error').hidden = true;
    f.envName.value = env.name;
    f.envGroup.value = env.group;
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
        name: f.envName.value, group: f.envGroup.value, carryOverspending: f.carryOverspending.checked,
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
