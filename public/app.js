// デモトレード フロントエンド（素のJS、ビルド不要）
// API契約は src/routes/*.ts を参照。

const state = {
  tab: 'home',
  symbols: [],
  portfolio: [],
  orders: [],
  trades: [],
  fxTransactions: [],
  authMode: 'login', // 'login' | 'register'
};

// ---------- Cookie / CSRF ----------
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function csrfHeaders() {
  const token = getCookie('csrf_token');
  return token ? { 'X-CSRF-Token': token } : {};
}

function isLoggedIn() {
  return !!getCookie('csrf_token');
}

// ---------- API helper ----------
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeaders(),
      ...(options.headers || {}),
    },
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

function uuid() {
  return crypto.randomUUID();
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function yen(amountC) {
  return '¥' + Math.floor(amountC / 100).toLocaleString();
}
function usd(amountC) {
  return '$' + (amountC / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- Root render ----------
const app = document.getElementById('app');

function render() {
  if (!isLoggedIn()) {
    disconnectLiveFeed();
    renderAuth();
    return;
  }
  app.innerHTML = `
    <header class="app-header">
      <h1>デモトレード</h1>
    </header>
    <div class="market-ticker">
      <div class="ticker-item">
        <span class="ticker-label">USD/JPY</span>
        <span class="ticker-value" data-live-symbol="JPY=X" data-live-format="rate">--</span>
      </div>
      <div class="ticker-item">
        <span class="ticker-label">日経平均</span>
        <span class="ticker-value" data-live-symbol="^N225" data-live-format="index">--</span>
      </div>
      <div class="ticker-item">
        <span class="ticker-label">NYダウ</span>
        <span class="ticker-value" data-live-symbol="^DJI" data-live-format="index">--</span>
      </div>
    </div>
    <main id="main"></main>
    <nav class="tab-bar">
      ${tabButton('home', '🏠', 'ホーム')}
      ${tabButton('order', '➕', '注文')}
      ${tabButton('history', '📜', '履歴')}
      ${tabButton('fx', '💱', '両替')}
      ${tabButton('settings', '⚙️', '設定')}
    </nav>
  `;
  document.querySelectorAll('.tab-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      render();
    });
  });
  renderMain();
  initMarketTicker();
}

// ティッカーバー: WSSのみに統一（HTTPスナップショットのフォールバックは廃止）。
// ライブフィードから最初のtickが届くまでは「--」表示のまま。
function initMarketTicker() {
  connectLiveFeed();
  subscribeLive(['JPY=X', '^N225', '^DJI']);
  // 既にライブ値を持っていれば即反映（タブ切替での再描画時など）
  ['JPY=X', '^N225', '^DJI'].forEach((s) => applyLivePriceToDom(s));
}

function tabButton(tab, icon, label) {
  const active = state.tab === tab ? 'active' : '';
  return `<button class="tab-item ${active}" data-tab="${tab}">
    <span class="icon">${icon}</span><span>${label}</span>
  </button>`;
}

async function renderMain() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="empty-hint">読み込み中...</div>`;
  if (state.tab === 'home') return renderHome(main);
  if (state.tab === 'order') return renderOrder(main);
  if (state.tab === 'history') return renderHistory(main);
  if (state.tab === 'fx') return renderFx(main);
  if (state.tab === 'settings') return renderSettings(main);
}

// ---------- ホーム(ポートフォリオ) ----------
async function renderHome(main) {
  try {
    const { trades } = await api('/portfolio');
    state.portfolio = trades || [];
  } catch (e) {
    main.innerHTML = `<div class="empty-hint">読み込みに失敗しました: ${e.message}</div>`;
    return;
  }

  const rows = state.portfolio.length
    ? state.portfolio.map((t) => `
      <div class="list-row" data-symbol-row="${t.symbol}">
        <div>
          <div class="name">${t.name} <span class="sub">${t.code}</span></div>
          <div class="sub">
            ${t.quantity}株 @ ${t.buy_price} (${t.buy_date})
            ・現在値 <span data-live-symbol="${t.symbol}" data-buy-price="${t.buy_price}">${t.market === 'JP' ? '¥' : '$'}${t.buy_price}</span>
            <span class="live-dot" data-live-dot="${t.symbol}" title="ライブ未接続">●</span>
          </div>
          <div class="row-actions">
            <button type="button" class="row-action-btn buy" data-holding-action="BUY" data-market="${t.market}" data-code="${t.code}" data-qty="${t.quantity}">追加購入</button>
            <button type="button" class="row-action-btn sell" data-holding-action="SELL" data-market="${t.market}" data-code="${t.code}" data-qty="${t.quantity}">売却</button>
          </div>
        </div>
        <div class="value" data-live-value="${t.symbol}" data-market="${t.market}" data-quantity="${t.quantity}">
          ${t.market === 'JP' ? yenFromPrice(t.buy_price, t.quantity) : usdFromPrice(t.buy_price, t.quantity)}
        </div>
      </div>
    `).join('')
    : `<div class="empty-hint">保有中の銘柄はありません。「注文」タブから購入できます。</div>`;

  main.innerHTML = `
    <div class="section">
      <div class="section-title">保有銘柄</div>
      ${rows}
    </div>
  `;

  main.querySelectorAll('[data-holding-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      startOrderFromHolding(btn.dataset.market, btn.dataset.code, btn.dataset.holdingAction, parseInt(btn.dataset.qty, 10));
    });
  });

  if (state.portfolio.length) {
    connectLiveFeed();
    subscribeLive(state.portfolio.map((t) => t.symbol));
    // 接続前に既にpriceを持っていれば即反映
    state.portfolio.forEach((t) => applyLivePriceToDom(t.symbol));
  }
}
// 保有銘柄から注文タブへ遷移し、銘柄・売買方向を事前セットする
function startOrderFromHolding(market, code, side, heldQty) {
  const sym = state.symbols.find((x) => x.market === market && x.code === code);
  const unit = sym && sym.unit_size ? sym.unit_size : (market === 'JP' ? 100 : 1);
  orderState.market = market;
  orderState.code = code;
  orderState.side = side;
  orderState.orderType = 'MARKET';
  orderState.targetPrice = '';
  orderState.expiresDate = '';
  orderState.settlementCurrency = 'NATIVE';
  orderState.unitSize = unit;
  // 売却は保有数を超えない範囲で1単元を初期値に
  orderState.quantity = side === 'SELL' && heldQty > 0 ? Math.min(unit, heldQty) : unit;
  state.tab = 'order';
  render();
}
function yenFromPrice(price, qty) { return '¥' + Math.round(price * qty).toLocaleString(); }
function usdFromPrice(price, qty) { return '$' + (price * qty).toFixed(2); }

// ---------- 注文 ----------
const orderState = {
  market: 'JP',
  side: 'BUY',
  orderType: 'MARKET', // 'MARKET' | 'LIMIT'
  code: '',
  quantity: 1,
  unitSize: 1,
  targetPrice: '',
  expiresDate: '',
  settlementCurrency: 'NATIVE', // 'NATIVE' | 'JPY'（米国株の買いのみ有効、仕様書4.9）
};

async function renderOrder(main) {
  if (!state.symbols.length) {
    try {
      const { symbols } = await api('/symbols');
      state.symbols = symbols || [];
    } catch { /* noop */ }
  }

  main.innerHTML = `
    <div class="section">
      <div class="segmented" id="market-seg">
        <button data-v="JP" class="${orderState.market === 'JP' ? 'active' : ''}">日本株</button>
        <button data-v="US" class="${orderState.market === 'US' ? 'active' : ''}">米国株</button>
      </div>

      <div class="form-group">
        <label>銘柄コード</label>
        <input type="text" id="order-code" list="symbol-list" placeholder="例: 7203 / MSFT" value="${orderState.code}">
        <datalist id="symbol-list">
          ${state.symbols.filter((s) => s.market === orderState.market)
            .map((s) => `<option value="${s.code}">${s.name}</option>`).join('')}
        </datalist>
      </div>

      <div class="form-group" id="order-price-preview" style="display:none">
        <label>現在値（ライブ）</label>
        <div class="ticker-value" id="order-price-preview-value" style="font-size:18px"></div>
      </div>

      <div class="segmented buy-sell" id="side-seg">
        <button data-v="BUY" class="${orderState.side === 'BUY' ? 'active buy' : ''}">買い</button>
        <button data-v="SELL" class="${orderState.side === 'SELL' ? 'active sell' : ''}">売り</button>
      </div>

      ${orderState.market === 'US' && orderState.side === 'BUY' ? `
      <div class="form-group">
        <label>決済通貨</label>
        <div class="segmented" id="settle-seg">
          <button data-v="NATIVE" class="${orderState.settlementCurrency === 'NATIVE' ? 'active' : ''}">外貨決済(USD)</button>
          <button data-v="JPY" class="${orderState.settlementCurrency === 'JPY' ? 'active' : ''}">円貨決済(JPY)</button>
        </div>
      </div>` : ''}

      <div class="segmented" id="type-seg">
        <button data-v="MARKET" class="${orderState.orderType === 'MARKET' ? 'active' : ''}">成行</button>
        <button data-v="LIMIT" class="${orderState.orderType === 'LIMIT' ? 'active' : ''}">指値</button>
      </div>

      <div class="form-group">
        <label>数量（+/-は単元単位、直接入力で1株単位も可）</label>
        <div class="qty-stepper">
          <button id="qty-minus">−</button>
          <input type="number" id="order-qty" value="${orderState.quantity}" min="1">
          <button id="qty-plus">＋</button>
        </div>
        <div class="qty-hint" id="qty-hint"></div>
      </div>

      <div id="limit-fields" style="display:${orderState.orderType === 'LIMIT' ? 'block' : 'none'}">
        <div class="form-group">
          <label>指値価格</label>
          <input type="number" id="order-target-price" step="0.01" value="${orderState.targetPrice}">
        </div>
        <div class="form-group">
          <label>有効期限（現地日付・最大2週間先）</label>
          <input type="date" id="order-expires" value="${orderState.expiresDate}">
        </div>
      </div>

      <button class="btn btn-primary" id="order-submit">
        ${orderState.side === 'BUY' ? '買い注文を出す' : '売り注文を出す'}
      </button>
    </div>
  `;

  updateQtyHint();

  main.querySelectorAll('#market-seg button').forEach((b) =>
    b.addEventListener('click', () => {
      orderState.market = b.dataset.v; orderState.code = ''; orderState.settlementCurrency = 'NATIVE';
      renderOrder(main);
    }));
  main.querySelectorAll('#side-seg button').forEach((b) =>
    b.addEventListener('click', () => {
      orderState.side = b.dataset.v;
      if (orderState.side !== 'BUY') orderState.settlementCurrency = 'NATIVE';
      renderOrder(main);
    }));
  main.querySelectorAll('#type-seg button').forEach((b) =>
    b.addEventListener('click', () => { orderState.orderType = b.dataset.v; renderOrder(main); }));
  const settleSeg = document.getElementById('settle-seg');
  if (settleSeg) {
    settleSeg.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { orderState.settlementCurrency = b.dataset.v; renderOrder(main); }));
  }

  document.getElementById('order-code').addEventListener('input', (e) => {
    orderState.code = e.target.value.trim().toUpperCase();
    updateQtyHint();
  });
  document.getElementById('order-qty').addEventListener('input', (e) => {
    orderState.quantity = Math.max(1, parseInt(e.target.value || '1', 10));
  });
  document.getElementById('qty-minus').addEventListener('click', () => {
    const sym = findSymbol();
    const step = sym ? sym.unit_size : 1;
    orderState.quantity = Math.max(1, orderState.quantity - step);
    document.getElementById('order-qty').value = orderState.quantity;
  });
  document.getElementById('qty-plus').addEventListener('click', () => {
    const sym = findSymbol();
    const step = sym ? sym.unit_size : 1;
    orderState.quantity = orderState.quantity + step;
    document.getElementById('order-qty').value = orderState.quantity;
  });

  const targetPriceEl = document.getElementById('order-target-price');
  if (targetPriceEl) targetPriceEl.addEventListener('input', (e) => { orderState.targetPrice = e.target.value; });
  const expiresEl = document.getElementById('order-expires');
  if (expiresEl) expiresEl.addEventListener('input', (e) => { orderState.expiresDate = e.target.value; });

  document.getElementById('order-submit').addEventListener('click', submitOrder);
}

function findSymbol() {
  return state.symbols.find((s) => s.market === orderState.market && s.code === orderState.code);
}
function updateQtyHint() {
  const hint = document.getElementById('qty-hint');
  if (!hint) return;
  const sym = findSymbol();
  hint.textContent = sym ? `単元: ${sym.unit_size}株 / 通貨: ${sym.currency}` : '銘柄コードを入力してください';
  updateOrderPricePreview(sym);
}

// 選択中の銘柄の現在値をライブフィード(/api/live-prices)から表示する（表示専用、約定には使わない）
function updateOrderPricePreview(sym) {
  const box = document.getElementById('order-price-preview');
  const valEl = document.getElementById('order-price-preview-value');
  if (!box || !valEl) return;
  if (!sym) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  valEl.dataset.liveSymbol = sym.symbol;
  valEl.dataset.liveFormat = 'quote';
  valEl.dataset.currency = sym.currency;
  valEl.textContent = live.prices[sym.symbol] != null ? '' : '読み込み中...';
  connectLiveFeed();
  subscribeLive([sym.symbol]);
  applyLivePriceToDom(sym.symbol);
}

async function submitOrder() {
  const body = {
    code: orderState.code,
    market: orderState.market,
    side: orderState.side,
    quantity: orderState.quantity,
    idempotency_key: uuid(),
    // 米国株の買いのみ意味を持つ。他は'NATIVE'を送っても無視される（バックエンド側で検証）
    settlement_currency: orderState.settlementCurrency,
  };
  try {
    if (orderState.orderType === 'MARKET') {
      await api('/orders/market', { method: 'POST', body });
      toast('注文が約定しました');
    } else {
      if (!orderState.targetPrice || !orderState.expiresDate) {
        toast('指値価格と有効期限を入力してください');
        return;
      }
      await api('/orders/limit', {
        method: 'POST',
        body: {
          ...body,
          order_type: orderState.side === 'BUY' ? 'BUY_LIMIT' : 'SELL_LIMIT',
          target_price: Number(orderState.targetPrice),
          expires_date: orderState.expiresDate,
        },
      });
      toast('指値注文を出しました');
    }
    state.tab = 'home';
    render();
  } catch (e) {
    toast(`注文に失敗しました: ${e.message}`);
  }
}

// ---------- 履歴 ----------
const historyState = { sub: 'orders' };

async function renderHistory(main) {
  main.innerHTML = `
    <div class="section">
      <div class="subtabs" id="history-subtabs">
        <button data-v="orders" class="${historyState.sub === 'orders' ? 'active' : ''}">注文</button>
        <button data-v="trades" class="${historyState.sub === 'trades' ? 'active' : ''}">取引</button>
        <button data-v="fx" class="${historyState.sub === 'fx' ? 'active' : ''}">両替</button>
      </div>
      <div id="history-list"><div class="empty-hint">読み込み中...</div></div>
    </div>
  `;
  main.querySelectorAll('#history-subtabs button').forEach((b) =>
    b.addEventListener('click', () => { historyState.sub = b.dataset.v; renderHistory(main); }));

  const list = document.getElementById('history-list');
  try {
    if (historyState.sub === 'orders') {
      const { orders } = await api('/orders');
      list.innerHTML = orders.length ? orders.map((o) => `
        <div class="list-row">
          <div>
            <div class="name">${o.symbol} <span class="badge ${o.status}">${o.status}</span></div>
            <div class="sub">${o.order_type} / ${o.quantity}株${o.target_price ? ` @ ${o.target_price}` : ''}</div>
          </div>
          ${o.status === 'PENDING' ? `<button class="btn-link" data-cancel="${o.id}">取消</button>` : ''}
        </div>
      `).join('') : `<div class="empty-hint">注文履歴はありません</div>`;
      list.querySelectorAll('[data-cancel]').forEach((b) =>
        b.addEventListener('click', () => cancelOrder(b.dataset.cancel)));
    } else if (historyState.sub === 'trades') {
      const { trades } = await api('/trades');
      list.innerHTML = trades.length ? trades.map((t) => `
        <div class="list-row">
          <div>
            <div class="name">${t.name} <span class="badge ${t.status}">${t.status}</span></div>
            <div class="sub">${t.quantity}株 買 ${t.buy_price}(${t.buy_date})${t.sell_price ? ` → 売 ${t.sell_price}(${t.sell_date})` : ''}</div>
          </div>
          ${t.profit_jpy_c != null ? `<div class="value ${t.profit_jpy_c >= 0 ? 'up' : 'down'}">${yen(t.profit_jpy_c)}</div>` : ''}
        </div>
      `).join('') : `<div class="empty-hint">取引履歴はありません</div>`;
    } else {
      const { transactions } = await api('/fx/transactions');
      list.innerHTML = transactions.length ? transactions.map((f) => `
        <div class="list-row">
          <div>
            <div class="name">${f.direction === 'JPY_TO_USD' ? 'JPY → USD' : 'USD → JPY'}</div>
            <div class="sub">レート ${f.fx_rate}</div>
          </div>
          <div class="value">${f.direction === 'JPY_TO_USD' ? usd(f.result_amount_c) : yen(f.result_amount_c)}</div>
        </div>
      `).join('') : `<div class="empty-hint">両替履歴はありません</div>`;
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-hint">読み込みに失敗しました: ${e.message}</div>`;
  }
}

async function cancelOrder(id) {
  try {
    await api(`/orders/${id}/cancel`, { method: 'POST' });
    toast('注文を取り消しました');
    renderHistory(document.getElementById('main'));
  } catch (e) {
    toast(`取消に失敗しました: ${e.message}`);
  }
}

// ---------- 両替 ----------
const fxState = { direction: 'JPY_TO_USD', amount: '' };

function renderFx(main) {
  main.innerHTML = `
    <div class="section">
      <div class="segmented" id="fx-dir">
        <button data-v="JPY_TO_USD" class="${fxState.direction === 'JPY_TO_USD' ? 'active' : ''}">JPY → USD</button>
        <button data-v="USD_TO_JPY" class="${fxState.direction === 'USD_TO_JPY' ? 'active' : ''}">USD → JPY</button>
      </div>
      <div class="form-group">
        <label>両替元金額（${fxState.direction === 'JPY_TO_USD' ? '円' : 'ドル'}）</label>
        <input type="number" id="fx-amount" step="0.01" value="${fxState.amount}">
      </div>
      <button class="btn btn-primary" id="fx-submit">両替する</button>
    </div>
  `;
  main.querySelectorAll('#fx-dir button').forEach((b) =>
    b.addEventListener('click', () => { fxState.direction = b.dataset.v; renderFx(main); }));
  document.getElementById('fx-amount').addEventListener('input', (e) => { fxState.amount = e.target.value; });
  document.getElementById('fx-submit').addEventListener('click', async () => {
    const amountC = Math.round(Number(fxState.amount) * 100);
    if (!amountC || amountC <= 0) { toast('金額を入力してください'); return; }
    try {
      const res = await api('/fx/exchange', { method: 'POST', body: { direction: fxState.direction, amount_c: amountC } });
      toast(`両替しました（レート ${res.fx_rate}）`);
      fxState.amount = '';
      renderFx(main);
    } catch (e) {
      toast(`両替に失敗しました: ${e.message}`);
    }
  });
}

// ---------- 設定 ----------
function renderSettings(main) {
  main.innerHTML = `
    <div class="section">
      <div class="section-title">パスワード変更</div>
      <div class="card">
        <div class="form-group">
          <label>現在のパスワード</label>
          <input type="password" id="cur-pass">
        </div>
        <div class="form-group">
          <label>新しいパスワード</label>
          <input type="password" id="new-pass">
        </div>
        <button class="btn btn-primary" id="pass-submit">変更する</button>
      </div>

      <div class="section-title">アカウント</div>
      <button class="btn btn-outline" id="logout-btn">ログアウト</button>
    </div>
  `;
  document.getElementById('pass-submit').addEventListener('click', async () => {
    const currentPassword = document.getElementById('cur-pass').value;
    const newPassword = document.getElementById('new-pass').value;
    try {
      await api('/account/password', { method: 'POST', body: { currentPassword, newPassword } });
      toast('パスワードを変更しました');
    } catch (e) {
      toast(`変更に失敗しました: ${e.message}`);
    }
  });
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* noop */ }
    render();
  });
}

// ---------- 認証画面 ----------
function renderAuth() {
  const isLogin = state.authMode === 'login';
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-logo">
        <div class="emoji">📈</div>
        <h2>デモトレード</h2>
      </div>
      <div class="form-group">
        <label>ユーザー名</label>
        <input type="text" id="auth-username">
      </div>
      <div class="form-group">
        <label>パスワード</label>
        <input type="password" id="auth-password">
      </div>
      <div class="form-group" id="turnstile-container">
        <div class="cf-turnstile" data-sitekey="__TURNSTILE_SITE_KEY__" data-callback="onTurnstileToken"></div>
      </div>
      <button class="btn btn-primary" id="auth-submit">${isLogin ? 'ログイン' : '新規登録'}</button>
      <div class="auth-switch">
        ${isLogin ? 'アカウントをお持ちでない方は' : 'すでにアカウントをお持ちの方は'}
        <button class="btn-link" id="auth-switch-btn">${isLogin ? '新規登録' : 'ログイン'}</button>
      </div>
    </div>
  `;
  document.getElementById('auth-switch-btn').addEventListener('click', () => {
    state.authMode = isLogin ? 'register' : 'login';
    renderAuth();
  });
  document.getElementById('auth-submit').addEventListener('click', async () => {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const turnstileToken = window.__turnstileToken || '';
    if (!username || !password) { toast('ユーザー名とパスワードを入力してください'); return; }
    try {
      if (isLogin) {
        await api('/login', { method: 'POST', body: { username, password, turnstileToken } });
        toast('ログインしました');
      } else {
        await api('/register', { method: 'POST', body: { username, password, turnstileToken } });
        toast('登録しました。続けてログインしてください');
        state.authMode = 'login';
      }
      render();
    } catch (e) {
      toast(`失敗しました: ${e.message}`);
    }
  });
}

// Turnstileのコールバック（Turnstileのscriptタグ読み込み後にグローバルとして呼ばれる）
window.onTurnstileToken = (token) => { window.__turnstileToken = token; };

// ---------- ライブ株価フィード (Yahoo Finance WSS, 表示専用) ----------
// 注意: 非公式・無保証のストリーミングエンドポイントを直接ブラウザから利用する。
// 約定判定・残高計算には一切使わない（そちらは引き続きWorker側のHTTP取得のみを正とする）。
// 接続できない/切れても表示が静的な最終取得価格に留まるだけで、アプリの他機能には影響しない。
const live = {
  ws: null,
  prices: {}, // symbol -> price
  subscribed: new Set(),
  reconnectAttempts: 0,
  manuallyClosed: false,
};

function connectLiveFeed() {
  if (live.ws && (live.ws.readyState === WebSocket.OPEN || live.ws.readyState === WebSocket.CONNECTING)) return;
  live.manuallyClosed = false;
  try {
    // Worker側(/api/live-prices)がYahoo FinanceのWSSへパススルー中継する。
    // クライアントは自分のドメインにだけ接続すればよい（仕様書4.8）。
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    live.ws = new WebSocket(`${proto}//${location.host}/api/live-prices`);
  } catch {
    return; // WSS非対応環境など。静的表示のままにする。
  }

  live.ws.onopen = () => {
    live.reconnectAttempts = 0;
    setLiveDots('connected');
    if (live.subscribed.size) sendSubscribe([...live.subscribed]);
  };

  live.ws.onmessage = (event) => {
    try {
      const outer = JSON.parse(event.data);
      if (!outer.message) return;
      const bytes = base64ToBytes(outer.message);
      const tick = decodeYatickerMinimal(bytes);
      if (tick.id && typeof tick.price === 'number') {
        const prev = live.prices[tick.id];
        live.prices[tick.id] = tick.price;
        applyLivePriceToDom(tick.id, prev);
      }
    } catch {
      // フォーマット不明のメッセージは無視（表示専用機能のため通信は継続する）
    }
  };

  live.ws.onclose = () => {
    setLiveDots('disconnected');
    if (live.manuallyClosed) return;
    const delay = Math.min(10000, 1000 * 2 ** live.reconnectAttempts);
    live.reconnectAttempts += 1;
    setTimeout(() => { if (!live.manuallyClosed) connectLiveFeed(); }, delay);
  };

  live.ws.onerror = () => { /* oncloseに続く。ここでは何もしない */ };
}

function disconnectLiveFeed() {
  live.manuallyClosed = true;
  live.subscribed.clear();
  if (live.ws) {
    try { live.ws.close(); } catch { /* noop */ }
  }
}

function subscribeLive(symbols) {
  const newOnes = symbols.filter((s) => s && !live.subscribed.has(s));
  newOnes.forEach((s) => live.subscribed.add(s));
  if (!newOnes.length) return;
  if (live.ws && live.ws.readyState === WebSocket.OPEN) sendSubscribe(newOnes);
}

function sendSubscribe(symbols) {
  try { live.ws.send(JSON.stringify({ subscribe: symbols })); } catch { /* noop */ }
}

function setLiveDots(status) {
  document.querySelectorAll('[data-live-dot]').forEach((el) => {
    el.title = status === 'connected' ? 'ライブ接続中' : 'ライブ未接続（最終価格を表示中）';
    el.style.color = status === 'connected' ? 'var(--primary)' : '#cfcfcf';
  });
}

function applyLivePriceToDom(symbol, prevPrice) {
  const price = live.prices[symbol];
  if (typeof price !== 'number') return;

  const dotEl = document.querySelector(`[data-live-dot="${cssEscape(symbol)}"]`);
  if (dotEl) { dotEl.style.color = 'var(--primary)'; dotEl.title = 'ライブ接続中'; }

  // 同じsymbolの表示要素が複数ある場合（同一銘柄を複数ロット保有、ティッカーバー等）に
  // 全て更新できるようquerySelectorAllを使う
  document.querySelectorAll(`[data-live-symbol="${cssEscape(symbol)}"]`).forEach((priceEl) => {
    const format = priceEl.dataset.liveFormat;
    if (format === 'rate' || format === 'index') {
      priceEl.textContent = price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (format === 'quote') {
      // 注文画面の現在値プレビュー（表示専用、約定には使わない）
      const cur = priceEl.dataset.currency;
      priceEl.textContent = (cur === 'USD' ? '$' : '¥') + price.toLocaleString(undefined, { maximumFractionDigits: 2 });
    } else {
      // ポートフォリオ行の1株あたり価格表示（¥/$記号付き）
      const valueEl = document.querySelector(`[data-live-value="${cssEscape(symbol)}"]`);
      const market = valueEl ? valueEl.dataset.market : null;
      priceEl.textContent = (market === 'US' ? '$' : '¥') + price.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    if (prevPrice != null && price !== prevPrice) {
      priceEl.classList.remove('flash-up', 'flash-down');
      void priceEl.offsetWidth; // reflow強制してアニメーションを再トリガー
      priceEl.classList.add(price > prevPrice ? 'flash-up' : 'flash-down');
    }
  });

  // ポートフォリオ行の評価額（1株価格×数量）側も同様に全件更新
  document.querySelectorAll(`[data-live-value="${cssEscape(symbol)}"]`).forEach((valueEl) => {
    const qty = Number(valueEl.dataset.quantity || '0');
    const market = valueEl.dataset.market;
    valueEl.textContent = market === 'US' ? usdFromPrice(price, qty) : yenFromPrice(price, qty);
  });
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Yahoo Finance ストリーミングのPricingDataメッセージ(protobuf)から
 * 必要な2フィールドだけを取り出す最小限のデコーダ。
 * field 1 = id (string, symbol), field 2 = price (float32)
 * それ以外のフィールドはワイヤタイプに従って読み飛ばす。
 */
function decodeYatickerMinimal(bytes) {
  let pos = 0;
  const out = {};
  const len = bytes.length;
  while (pos < len) {
    const [tag, p1] = readVarint(bytes, pos);
    pos = p1;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;

    if (wireType === 0) {
      const [, p2] = readVarint(bytes, pos);
      pos = p2;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const [strLen, p2] = readVarint(bytes, pos);
      pos = p2;
      if (fieldNum === 1) {
        out.id = new TextDecoder().decode(bytes.slice(pos, pos + strLen));
      }
      pos += strLen;
    } else if (wireType === 5) {
      if (fieldNum === 2 && pos + 4 <= len) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
        out.price = view.getFloat32(0, true);
      }
      pos += 4;
    } else {
      break; // 未知のワイヤタイプ。以降のパースを打ち切る（表示専用のため安全側に倒す）
    }
  }
  return out;
}

function readVarint(bytes, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80 && shift < 35);
  return [result >>> 0, pos];
}

render();
