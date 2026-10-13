(function () {
  const B = Budget;
  const KEY = 'envelo.budget.v1';

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

  let budget = load();
  let month = thisMonth();

  // Storage. Every read and write is guarded: private windows and blocked
  // storage must not break the app, they just mean nothing persists.
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? B.fromJSON(JSON.parse(raw)) : B.create();
    } catch (err) {
      showError('Saved data could not be read, starting fresh. ' + err.message);
      return B.create();
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(budget));
    } catch (err) {
      showError('Could not save to this browser: ' + err.message);
    }
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
      save();
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

    const ready = $('#ready');
    ready.classList.toggle('warn', view.readyToAssign < 0);
    ready.innerHTML = `<div class="label">Ready to assign</div>
      <div class="amount">${esc(money(view.readyToAssign))}</div>`;

    const rows = [];
    view.groups.forEach((g, gi) => {
      const tone = `tone-${gi % 3}`;
      rows.push(`<tr class="group ${tone}"><td colspan="5">${esc(g.name)}</td></tr>`);
      for (const e of g.envelopes) {
        const availClass = e.available < 0 ? 'neg' : e.available === 0 ? 'zero' : '';
        const goal = e.goal == null ? '' : e.needed > 0
          ? `<div class="goal">Goal ${esc(money(e.goal))} · needs ${esc(money(e.needed))}</div>`
          : `<div class="goal done">Goal ${esc(money(e.goal))} · reached</div>`;
        const fund = e.needed > 0
          ? `<button type="button" class="fund" data-action="fund" data-id="${e.id}" data-amount="${e.needed}">Fund goal</button>`
          : '';
        rows.push(`<tr class="${tone}">
          <td><div class="env-name">${esc(e.name)}${e.overspent ? '<span class="badge">Overspent</span>' : ''}</div>${goal}</td>
          <td class="num"><input type="text" inputmode="decimal" aria-label="Assigned to ${esc(e.name)}"
              value="${B.toInput(e.assigned)}" data-env="${e.id}"></td>
          <td class="num">${esc(money(e.activity))}</td>
          <td class="num"><span class="avail ${availClass}">${esc(money(e.available))}</span></td>
          <td class="num">${fund}</td>
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
      case 'export': exportBackup(); break;
      case 'import': $('#import-file').click(); break;
      case 'reset':
        if (confirm('Erase every envelope and transaction in this browser? Export a backup first if unsure.')) {
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
    } else if (t.id === 'import-file') {
      importBackup(t.files[0]);
      t.value = '';
    }
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
      if (!confirm(`Replace current data with ${next.envelopes.length} envelopes and ${next.transactions.length} transactions?`)) return;
      budget = next;
      showError('');
      save();
      render();
    } catch (err) {
      showError('Import failed: ' + err.message);
    }
  }

  render();
})();
