// デモトレード 管理画面。通常アプリとは完全に独立したセッション(admin_session / admin_csrf_token)を使う。

const state = { tab: 'users', users: [], symbols: [] };
const loginState = { mode: 'password', email: '' }; // 'password' | 'passkey'

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function isAdminLoggedIn() {
  return !!getCookie('admin_csrf_token');
}
function adminCsrfHeaders() {
  const token = getCookie('admin_csrf_token');
  return token ? { 'X-Admin-CSRF-Token': token } : {};
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...adminCsrfHeaders(), ...(options.headers || {}) },
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

// ---------- base64url <-> ArrayBuffer（WebAuthnのバイナリデータ用） ----------
function base64urlToBuffer(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const root = document.getElementById('admin-app');

async function init() {
  if (!isAdminLoggedIn()) {
    renderLogin();
    return;
  }
  try {
    await api('/admin/users'); // 権限チェックを兼ねる
  } catch (e) {
    if (e.status === 401) { renderLogin(); return; }
    if (e.status === 403) {
      root.innerHTML = `<div class="admin-denied">管理者権限がありません。</div>`;
      return;
    }
    root.innerHTML = `<div class="admin-denied">読み込みに失敗しました: ${e.message}</div>`;
    return;
  }
  render();
}

// ---------- ログイン画面 ----------
function renderLogin() {
  root.innerHTML = `
    <div class="auth-screen">
      <div class="auth-logo">
        <div class="emoji">🛠</div>
        <h2>デモトレード管理画面</h2>
      </div>

      <div class="segmented" id="login-mode-seg">
        <button data-v="password" class="${loginState.mode === 'password' ? 'active' : ''}">メール+パスワード</button>
        <button data-v="passkey" class="${loginState.mode === 'passkey' ? 'active' : ''}">パスキー</button>
      </div>

      <div class="form-group">
        <label>メールアドレス</label>
        <input type="text" id="login-email" value="${loginState.email}">
      </div>

      ${loginState.mode === 'password' ? `
        <div class="form-group">
          <label>パスワード</label>
          <input type="password" id="login-password">
        </div>
        <div class="form-group">
          <div class="cf-turnstile" data-sitekey="__TURNSTILE_SITE_KEY__" data-callback="onAdminTurnstileToken"></div>
        </div>
        <button class="btn btn-primary" id="login-submit">ログイン</button>
      ` : `
        <p style="font-size:12px;color:var(--text-sub)">あらかじめパスキーを登録済みのメールアドレスを入力し、ブラウザ・端末の認証（顔認証/指紋/PINなど）でログインします。</p>
        <button class="btn btn-primary" id="login-passkey-submit">パスキーでログイン</button>
      `}
    </div>
  `;

  document.querySelectorAll('#login-mode-seg button').forEach((b) =>
    b.addEventListener('click', () => { loginState.mode = b.dataset.v; renderLogin(); }));
  document.getElementById('login-email').addEventListener('input', (e) => { loginState.email = e.target.value.trim(); });

  if (loginState.mode === 'password') {
    document.getElementById('login-submit').addEventListener('click', submitPasswordLogin);
  } else {
    document.getElementById('login-passkey-submit').addEventListener('click', submitPasskeyLogin);
  }
}

window.onAdminTurnstileToken = (token) => { window.__adminTurnstileToken = token; };

async function submitPasswordLogin() {
  const email = loginState.email;
  const password = document.getElementById('login-password').value;
  const turnstileToken = window.__adminTurnstileToken || '';
  if (!email || !password) { toast('メールアドレスとパスワードを入力してください'); return; }
  try {
    await api('/admin-auth/login', { method: 'POST', body: { email, password, turnstileToken } });
    toast('ログインしました');
    init();
  } catch (e) {
    toast(`ログインに失敗しました: ${e.message}`);
  }
}

async function submitPasskeyLogin() {
  const email = loginState.email;
  if (!email) { toast('メールアドレスを入力してください'); return; }
  if (!window.PublicKeyCredential) { toast('このブラウザはパスキーに対応していません'); return; }

  try {
    const { options, userId } = await api('/admin-auth/webauthn/login-options', { method: 'POST', body: { email } });

    const publicKey = {
      ...options,
      challenge: base64urlToBuffer(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: base64urlToBuffer(c.id) })),
    };

    const assertion = await navigator.credentials.get({ publicKey });

    const credentialJson = {
      id: assertion.id,
      rawId: bufferToBase64url(assertion.rawId),
      type: assertion.type,
      response: {
        clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
        authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
        signature: bufferToBase64url(assertion.response.signature),
        userHandle: assertion.response.userHandle ? bufferToBase64url(assertion.response.userHandle) : undefined,
      },
      clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {},
    };

    await api('/admin-auth/webauthn/login-verify', { method: 'POST', body: { userId, credential: credentialJson } });
    toast('パスキーでログインしました');
    init();
  } catch (e) {
    toast(`パスキーログインに失敗しました: ${e.message}`);
  }
}

// ---------- パスキー登録（ログイン後の操作） ----------
async function registerPasskey() {
  if (!window.PublicKeyCredential) { toast('このブラウザはパスキーに対応していません'); return; }
  try {
    const options = await api('/admin-auth/webauthn/register-options', { method: 'POST' });

    const publicKey = {
      ...options,
      challenge: base64urlToBuffer(options.challenge),
      user: { ...options.user, id: base64urlToBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: base64urlToBuffer(c.id) })),
    };

    const credential = await navigator.credentials.create({ publicKey });

    const credentialJson = {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        attestationObject: bufferToBase64url(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : undefined,
      },
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
    };

    await api('/admin-auth/webauthn/register-verify', {
      method: 'POST',
      body: { credential: credentialJson, label: navigator.userAgent.slice(0, 60) },
    });
    toast('パスキーを登録しました');
  } catch (e) {
    toast(`パスキー登録に失敗しました: ${e.message}`);
  }
}

// ---------- メイン画面 ----------
function render() {
  root.innerHTML = `
    <div class="admin-header">
      <h1>🛠 デモトレード管理画面</h1>
      <div class="actions">
        <button class="btn-link" id="register-passkey-btn">🔑 このブラウザにパスキーを登録</button>
        <button class="btn-link" id="admin-logout-btn">ログアウト</button>
        <a href="/" class="btn-link">アプリへ戻る</a>
      </div>
    </div>
    <div class="admin-tabs">
      <button data-t="users" class="${state.tab === 'users' ? 'active' : ''}">ユーザー管理</button>
      <button data-t="symbols" class="${state.tab === 'symbols' ? 'active' : ''}">銘柄管理</button>
    </div>
    <div class="admin-panel" id="admin-panel"><div class="empty-hint">読み込み中...</div></div>
  `;
  document.querySelectorAll('.admin-tabs button').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.t; render(); }));
  document.getElementById('register-passkey-btn').addEventListener('click', registerPasskey);
  document.getElementById('admin-logout-btn').addEventListener('click', async () => {
    try { await api('/admin-auth/logout', { method: 'POST' }); } catch { /* noop */ }
    init();
  });

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
    <div class="admin-form-row">
      <button id="symbol-sync-btn" class="primary">🔄 JPX/SECから自動同期（毎日08:30 JSTにも自動実行）</button>
      <span id="symbol-sync-status" style="font-size:12px;color:var(--text-sub)"></span>
    </div>
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

  document.getElementById('symbol-sync-btn').addEventListener('click', syncSymbolsNow);
  document.getElementById('symbol-add-btn').addEventListener('click', addSymbol);
  panel.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
    const tr = btn.closest('tr');
    const sym = state.symbols.find((s) => s.code === tr.dataset.code && s.market === tr.dataset.market);
    btn.addEventListener('click', () => toggleSymbolActive(sym));
  });
}

async function syncSymbolsNow() {
  const statusEl = document.getElementById('symbol-sync-status');
  statusEl.textContent = '同期中...';
  try {
    const res = await api('/admin/symbols/sync', { method: 'POST' });
    statusEl.textContent = `JP ${res.jpCount}件 / US ${res.usCount}件 反映${res.errors.length ? '（一部エラーあり: ' + res.errors.join(', ') + '）' : ''}`;
    toast('銘柄マスタを同期しました');
    renderSymbols();
  } catch (e) {
    statusEl.textContent = '';
    toast(`同期に失敗しました: ${e.message}`);
  }
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
