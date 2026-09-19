// デモトレード 管理画面（素のJS）。ログイン中のセッション(session Cookie)をそのまま利用する。
// role='ADMIN'かつstatus='ACTIVE'でなければAPI側で403になるので、その場合は権限なし表示にする。

const state = { tab: 'users', users: [], symbols: [], openHistoryFor: null, historyData: null };

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function csrfHeaders() {
  const token = getCookie('csrf_token');
  return token ? { 'X-CSRF-Token': token } : {};
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders(), ...(options.headers || {}) },
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

const root = document.getElementById('admin-app');

async function init() {
  if (!getCookie('csrf_token')) {
    root.innerHTML = `<div class="admin-denied">ログインしていません。<a href="/">トップページ</a>からログインしてください。</div>`;
    return;
  }
  try {
    await api('/admin/users'); // 権限チェックを兼ねる
  } catch (e) {
    if (e.status === 403) {
      root.innerHTML = `<div class="admin-denied">管理者権限がありません。</div>`;
    } else if (e.status === 401) {
      root.innerHTML = `<div class="admin-denied">ログインしていません。<a href="/">トップページ</a>からログインしてください。</div>`;
    } else {
      root.innerHTML = `<div class="admin-denied">読み込みに失敗しました: ${e.message}</div>`;
    }
    return;
  }
  render();
}

function render() {
  root.innerHTML = `
    <div class="admin-header">
      <h1>🛠 デモトレード管理画面</h1>
      <a href="/" class="btn-link">アプリへ戻る</a>
    </div>
    <div class="admin-tabs">
      <button data-t="users" class="${state.tab === 'users' ? 'active' : ''}">ユーザー管理</button>
      <button data-t="symbols" class="${state.tab === 'symbols' ? 'active' : ''}">銘柄管理</button>
    </div>
    <div class="admin-panel" id="admin-panel"><div class="empty-hint">読み込み中...</div></div>
  `;
  document.querySelectorAll('.admin-tabs button').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.t; render(); }));

  if (state.tab === 'users') renderUsers();
  if (state.tab === 'symbols') renderSymbols();
}

// ---------- ユーザー管理 ----------
async function renderUsers() {
  const panel = document.getElementById('admin-panel');
  try {
    const { users } = await api('/admin/users');
    state.users = users;
  } catch (e) {
    panel.innerHTML = `<div class="empty-hint">読み込みに失敗しました: ${e.message}</div>`;
    return;
  }

  panel.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>ユーザー名</th><th>メール</th><th>権限</th><th>状態</th>
          <th>JPY残高</th><th>USD残高</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${state.users.map((u) => `
          <tr data-user-id="${u.id}">
            <td>${u.username}</td>
            <td>${u.email || '<span style="color:var(--text-sub)">未登録</span>'}</td>
            <td>${u.role}</td>
            <td><span class="status-pill ${u.status}">${u.status}</span></td>
            <td>¥${Math.floor(u.cash_balance_jpy_c / 100).toLocaleString()}</td>
            <td>$${(u.cash_balance_usd_c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td class="actions">
              ${u.status !== 'FROZEN' ? `<button data-act="freeze">凍結</button>` : `<button data-act="activate" class="primary">解除</button>`}
              ${u.status !== 'DELETED' ? `<button data-act="delete" class="danger">抹消</button>` : ''}
              <button data-act="balance">残高調整</button>
              <button data-act="password">PW変更</button>
              <button data-act="history">履歴</button>
            </td>
          </tr>
          <tr class="history-row" data-history-row="${u.id}" style="display:none"><td colspan="7"><div class="history-panel"></div></td></tr>
        `).join('')}
      </tbody>
    </table>
  `;

  panel.querySelectorAll('[data-act]').forEach((btn) => {
    const userId = btn.closest('tr').dataset.userId;
    const user = state.users.find((u) => u.id === userId);
    btn.addEventListener('click', () => handleUserAction(btn.dataset.act, user));
  });
}

async function handleUserAction(action, user) {
  try {
    if (action === 'freeze' || action === 'activate' || action === 'delete') {
      const status = action === 'freeze' ? 'FROZEN' : action === 'activate' ? 'ACTIVE' : 'DELETED';
      if (action === 'delete' && !confirm(`${user.username} を抹消しますか？`)) return;
      await api(`/admin/users/${user.id}/status`, { method: 'PATCH', body: { status } });
      toast('ステータスを変更しました');
      renderUsers();
    } else if (action === 'balance') {
      const jpy = prompt(`新しいJPY残高（銭単位、空欄で変更なし）\n現在: ${user.cash_balance_jpy_c}`, '');
      const usd = prompt(`新しいUSD残高（セント単位、空欄で変更なし）\n現在: ${user.cash_balance_usd_c}`, '');
      const body = {};
      if (jpy !== null && jpy !== '') body.cash_balance_jpy_c = Number(jpy);
      if (usd !== null && usd !== '') body.cash_balance_usd_c = Number(usd);
      if (Object.keys(body).length === 0) return;
      await api(`/admin/users/${user.id}/balance`, { method: 'PATCH', body });
      toast('残高を更新しました');
      renderUsers();
    } else if (action === 'password') {
      const newPassword = prompt(`${user.username} の新しいパスワードを入力してください`);
      if (!newPassword) return;
      const res = await api(`/admin/users/${user.id}/password`, { method: 'PATCH', body: { newPassword } });
      if (res.has_email) {
        toast(res.email_sent ? 'パスワードを変更し、通知メールを送信しました' : 'パスワードは変更しましたが、通知メール送信に失敗しました');
      } else {
        toast('パスワードを変更しました（メール未登録のため通知は送信されていません）');
      }
    } else if (action === 'history') {
      toggleHistory(user.id);
    }
  } catch (e) {
    toast(`操作に失敗しました: ${e.message}`);
  }
}

async function toggleHistory(userId) {
  const row = document.querySelector(`[data-history-row="${userId}"]`);
  if (!row) return;
  if (row.style.display !== 'none') {
    row.style.display = 'none';
    return;
  }
  document.querySelectorAll('.history-row').forEach((r) => { r.style.display = 'none'; });
  row.style.display = '';
  const panel = row.querySelector('.history-panel');
  panel.innerHTML = '読み込み中...';
  try {
    const [{ trades }, { orders }, { transactions }] = await Promise.all([
      api(`/admin/users/${userId}/trades`),
      api(`/admin/users/${userId}/orders`),
      api(`/admin/users/${userId}/fx-transactions`),
    ]);
    panel.innerHTML = `
      <strong>取引 (${trades.length})</strong>
      <ul>${trades.slice(0, 10).map((t) => `<li>${t.name} ${t.quantity}株 ${t.status} 買${t.buy_price}${t.sell_price ? ' 売' + t.sell_price : ''}</li>`).join('') || '<li>なし</li>'}</ul>
      <strong>注文 (${orders.length})</strong>
      <ul>${orders.slice(0, 10).map((o) => `<li>${o.symbol} ${o.order_type} ${o.quantity}株 ${o.status}</li>`).join('') || '<li>なし</li>'}</ul>
      <strong>両替 (${transactions.length})</strong>
      <ul>${transactions.slice(0, 10).map((f) => `<li>${f.direction} レート${f.fx_rate}</li>`).join('') || '<li>なし</li>'}</ul>
      <div style="color:var(--text-sub);font-size:11px;margin-top:6px">※直近10件まで表示</div>
    `;
  } catch (e) {
    panel.innerHTML = `読み込みに失敗しました: ${e.message}`;
  }
}

// ---------- 銘柄管理 ----------
async function renderSymbols() {
  const panel = document.getElementById('admin-panel');
  try {
    const { symbols } = await api('/admin/symbols');
    state.symbols = symbols;
  } catch (e) {
    panel.innerHTML = `<div class="empty-hint">読み込みに失敗しました: ${e.message}</div>`;
    return;
  }

  panel.innerHTML = `
    <div class="admin-form-row" id="symbol-add-form">
      <div class="field"><label>市場</label>
        <select id="new-market"><option value="JP">JP</option><option value="US">US</option></select>
      </div>
      <div class="field"><label>コード</label><input type="text" id="new-code" placeholder="7203 / MSFT"></div>
      <div class="field"><label>Yahooシンボル</label><input type="text" id="new-symbol" placeholder="7203.T / MSFT"></div>
      <div class="field"><label>銘柄名</label><input type="text" id="new-name" placeholder="トヨタ自動車"></div>
      <div class="field"><label>通貨</label>
        <select id="new-currency"><option value="JPY">JPY</option><option value="USD">USD</option></select>
      </div>
      <div class="field"><label>単元</label><input type="number" id="new-unit" value="100" style="width:70px"></div>
      <button id="symbol-add-btn">追加</button>
    </div>
    <table class="admin-table">
      <thead>
        <tr><th>市場</th><th>コード</th><th>シンボル</th><th>銘柄名</th><th>通貨</th><th>単元</th><th>有効</th><th>操作</th></tr>
      </thead>
      <tbody>
        ${state.symbols.map((s) => `
          <tr data-code="${s.code}" data-market="${s.market}">
            <td>${s.market}</td><td>${s.code}</td><td>${s.symbol}</td><td>${s.name}</td>
            <td>${s.currency}</td><td>${s.unit_size}</td>
            <td><span class="status-pill ${s.active ? 'ACTIVE' : 'DELETED'}">${s.active ? '有効' : '無効'}</span></td>
            <td class="actions">
              <button data-act="toggle" class="${s.active ? 'danger' : 'primary'}">${s.active ? '無効化' : '有効化'}</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  document.getElementById('symbol-add-btn').addEventListener('click', addSymbol);
  panel.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
    const tr = btn.closest('tr');
    const sym = state.symbols.find((s) => s.code === tr.dataset.code && s.market === tr.dataset.market);
    btn.addEventListener('click', () => toggleSymbolActive(sym));
  });
}

async function addSymbol() {
  const body = {
    market: document.getElementById('new-market').value,
    code: document.getElementById('new-code').value.trim(),
    symbol: document.getElementById('new-symbol').value.trim(),
    name: document.getElementById('new-name').value.trim(),
    currency: document.getElementById('new-currency').value,
    unit_size: Number(document.getElementById('new-unit').value),
    active: true,
  };
  if (!body.code || !body.symbol || !body.name) { toast('必須項目を入力してください'); return; }
  try {
    await api('/admin/symbols', { method: 'POST', body });
    toast('銘柄を追加しました');
    renderSymbols();
  } catch (e) {
    toast(`追加に失敗しました: ${e.message}`);
  }
}

async function toggleSymbolActive(sym) {
  try {
    await api(`/admin/symbols/${sym.market}/${sym.code}`, { method: 'PATCH', body: { active: !sym.active } });
    toast(sym.active ? '無効化しました' : '有効化しました');
    renderSymbols();
  } catch (e) {
    toast(`更新に失敗しました: ${e.message}`);
  }
}

init();
