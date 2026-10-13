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

  let budget = B.create();
  let month = thisMonth();
  let account = null;

  // API

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status}).`);
      err.status = res.status;
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
      const { savedAt } = await api('PUT', '/api/budget', budget);
      setSync(`Saved ${new Date(savedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
    } catch (err) {
      if (err.status === 401) {
        inFlight = false;
        showAuth('Your session ended. Sign in again. Unsaved changes are kept on this screen until you do.');
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

  function render() {
    const view = B.monthView(budget, month);
    const [y, m] = month.split('-').map(Number);
    $('#month-label').textContent = new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
    $('#currency').value = budget.currency;
    $('#theme').value = readTheme();
    $('#account').textContent = account ? account.email : '';

    const ready = $('#ready');
    ready.classList.toggle('warn', view.readyToAssign < 0);
    ready.innerHTML = `<div class="label">Ready to assign</div>
      <div class="amount">${esc(money(view.readyToAssign))}</div>
      ${view.underfunded > 0 ? `<div class="under-line">Targets need ${esc(money(view.underfunded))} this month
        <button type="button" data-action="fund-all">Fund all targets</button></div>` : ''}`;

    const rows = [];
    view.groups.forEach((g, gi) => {
      const tone = `tone-${gi % 3}`;
      rows.push(`<tr class="group ${tone}"><td colspan="5">${esc(g.name)}</td></tr>`);
      for (const e of g.envelopes) {
        const availClass = e.available < 0 || e.underfunded ? 'neg' : e.available === 0 ? 'zero' : '';
        const goal = e.target ? `<div class="goal ${e.underfunded ? 'short' : 'done'}">${esc(describeTarget(e))}
            · ${e.underfunded ? `needs ${esc(money(e.needed))} this month` : 'funded'}</div>
          <div class="tbar"><i style="width:${Math.round((e.progress || 0) * 100)}%"></i></div>` : '';
        const fund = e.underfunded
          ? `<button type="button" class="fund" data-action="fund" data-id="${e.id}" data-amount="${e.needed}">Assign ${esc(money(e.needed))}</button>`
          : '';
        rows.push(`<tr class="${tone}">
          <td class="env-cell"><div class="env-name"><button type="button" class="env-link" data-action="edit-target" data-id="${e.id}" title="Set a target">${esc(e.name)}</button>${e.overspent ? '<span class="badge">Overspent</span>' : ''}</div>${goal}</td>
          <td class="num" data-label="Assigned"><input type="text" inputmode="decimal" aria-label="Assigned to ${esc(e.name)}"
              value="${B.toInput(e.assigned)}" data-env="${e.id}"></td>
          <td class="num" data-label="Spent">${esc(money(e.activity))}</td>
          <td class="num" data-label="Available"><span class="avail ${availClass}">${esc(money(e.available))}</span></td>
          <td class="num fund-cell">${fund}</td>
        </tr>`);
      }
    });
    $('#envelope-rows').innerHTML = rows.join('');
    $('#empty').hidden = budget.envelopes.length > 0;

    renderEnvelopeOptions();
    renderTransactions();
  }

  function renderEnvelopeOptions() {
    const sel = $('#tx-envelope');
    const current = sel.value;
    sel.innerHTML = budget.envelopes.length
      ? budget.envelopes.map((e) => `<option value="${e.id}">${esc(e.group)} · ${esc(e.name)}</option>`).join('')
      : '<option value="">Add an envelope first</option>';
    if (budget.envelopes.some((e) => e.id === current)) sel.value = current;

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
      const where = t.envelopeId ? names[t.envelopeId] || 'Deleted envelope' : 'Income';
      const label = t.payee || (t.envelopeId ? 'Spending' : 'Income');
      return `<li>
        <div class="tx-meta">${esc(t.date)} · ${esc(where)}${t.note ? ' · ' + esc(t.note) : ''}</div>
        <div><strong>${esc(label)}</strong></div>
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
    const { budget: saved } = await api('GET', '/api/budget');
    budget = saved ? B.fromJSON(saved) : B.create();
    setSync('');
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
        attempt(() => B.setAssigned(budget, month, btn.dataset.id, cur + Number(btn.dataset.amount)));
        break;
      }
      case 'delete-tx':
        if (confirm('Delete this transaction?')) attempt(() => B.removeTransaction(budget, btn.dataset.id));
        break;
      case 'fund-all': {
        let total = 0;
        const ok = attempt(() => { total = B.fundAllTargets(budget, month); });
        if (ok && total === 0) showError('There is no money in Ready to Assign to fund targets.');
        break;
      }
      case 'edit-target': openTarget(btn.dataset.id); break;
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

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('input[data-env]')) {
      const cents = B.parseMoney(t.value);
      if (Number.isNaN(cents) || cents < 0) {
        showError('Assigned amount must be zero or more.');
        render();
        return;
      }
      attempt(() => B.setAssigned(budget, month, t.dataset.env, cents));
    } else if (t.id === 'currency') {
      budget.currency = t.value;
      attempt(() => {});
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

  // Flush pending changes when the tab is hidden, e.g. before the browser closes it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', syncKind));
  function syncKind() {
    const spend = document.querySelector('input[name="kind"]:checked').value === 'spend';
    $('#tx-envelope-field').hidden = !spend;
    $('#tx-envelope').required = spend;
  }

  $('#tx-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const kind = f.kind.value;
    const cents = B.parseMoney(f.amount.value);
    const ok = attempt(() => {
      if (Number.isNaN(cents)) throw new Error('Enter an amount like 12.50.');
      B.addTransaction(budget, {
        kind,
        date: f.date.value,
        payee: f.payee.value,
        note: f.note.value,
        amount: Math.abs(cents),
        envelopeId: kind === 'spend' ? f.envelopeId.value : null,
      });
    });
    if (ok) {
      f.amount.value = '';
      f.payee.value = '';
      f.note.value = '';
      f.amount.focus();
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
    $('#target-title').textContent = `Target for ${env.name}`;
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
