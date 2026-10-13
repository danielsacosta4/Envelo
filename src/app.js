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
  let revision = 0; // server revision this copy is based on
  let currentView = 'budget';
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
    syncKind();
    renderTransactions();
    renderAccounts();
    renderRecurring();
    renderReport();
    for (const v of ['budget', 'accounts', 'reports']) $(`#view-${v}`).hidden = v !== currentView;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === currentView));
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
        <div><div class="env-name">${esc(a.name)}${a.offBudget ? '<span class="badge off">Off budget</span>' : ''}</div><div class="goal">${rec}</div></div>
        <div class="acct-bal ${bal < 0 ? 'neg' : ''}">${esc(money(bal))}</div>
        <div class="row acct-actions">
          <button type="button" data-action="reconcile" data-id="${a.id}">Reconcile</button>
          <button type="button" data-action="rename-account" data-id="${a.id}">Rename</button>
          <button type="button" class="danger" data-action="delete-account" data-id="${a.id}">Delete</button>
        </div>
      </div>`;
    }).join('') : '<p class="empty">No accounts yet. Add the bank accounts and cash you budget with.</p>';
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

  function renderReport() {
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
    sel.innerHTML = budget.envelopes.length
      ? budget.envelopes.map((e) => `<option value="${e.id}">${esc(e.group)} · ${esc(e.name)}</option>`).join('')
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
      case 'edit-tx': editTransaction(btn.dataset.id); break;
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
    alert(diff === 0
      ? 'Reconciled. Envelo matches your bank.'
      : `Reconciled. Envelo added an adjustment of ${money(diff)} to match your bank. It counts toward Ready to Assign.`);
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
      if (Number.isNaN(cents) || cents < 0) {
        showError('Assigned amount must be zero or more.');
        render();
        return;
      }
      attempt(() => B.setAssigned(budget, month, t.dataset.env, cents));
    } else if (t.id === 'currency') {
      budget.currency = t.value;
      attempt(() => {});
    } else if (t.id === 'report-months') {
      renderReport();
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
      B.updateEnvelope(budget, editingTarget, { name: f.envName.value, group: f.envGroup.value });
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
