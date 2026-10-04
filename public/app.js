// デモトレード フロントエンド（素のJS、ビルド不要）
// API契約は src/routes/*.ts を参照。

const state = {
  tab: 'home',
  prevTab: 'home', // 検索画面から戻る先
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
  document.body.classList.toggle('logged-in', isLoggedIn());
  if (!isLoggedIn()) {
    disconnectLiveFeed();
    renderAuth();
    return;
  }
  removeTurnstile();
  // 銘柄インデックス（IndexedDB）を初期化。初回のみ全件取得、以降は手元のデータを使い12時間ごとに裏で更新
  SymbolIndex.init(() => api('/symbols')).catch(() => { /* 失敗時は検索画面・注文画面側で案内 */ });
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
      ${tabButton('mypage', '📊', 'マイページ')}
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
  const current = state.tab === 'search' ? 'home' : state.tab;
  const active = current === tab ? 'active' : '';
  return `<button class="tab-item ${active}" data-tab="${tab}">
    <span class="icon">${icon}</span><span>${label}</span>
  </button>`;
}

async function renderMain() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="empty-hint">読み込み中...</div>`;
  if (state.tab !== 'search') clearSearchLive(); // 検索画面を離れたら検索結果分のライブ購読を解除
  if (state.tab === 'search') return renderSearch(main);
  if (state.tab === 'home') return renderHome(main);
  if (state.tab === 'mypage') return renderMypage(main);
  if (state.tab === 'order') return renderOrder(main);
  if (state.tab === 'history') return renderHistory(main);
  if (state.tab === 'fx') return renderFx(main);
  if (state.tab === 'settings') return renderSettings(main);
}

// ---------- 共通ヘルパー ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function formatUnixDateTime(sec) {
  return new Date(sec * 1000).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

// ---------- マイページ（仕様書7.4） ----------
const mypageState = { metric: 'total' };

const MYPAGE_METRICS = {
  total: { label: '総資産', key: 'total_assets_jpy_c', fmt: yen },
  valuation: { label: '評価額', key: 'valuation_jpy_c', fmt: yen },
  cash_jpy: { label: '現金(円)', key: 'cash_jpy_c', fmt: yen },
  cash_usd: { label: '現金(ドル)', key: 'cash_usd_c', fmt: usd },
};

function renderLineChart(points, fmt) {
  if (!points.length) return '<div class="empty-hint">まだデータがありません</div>';
  const W = 320, H = 150, padX = 10, padY = 14;
  const vs = points.map((p) => p.v);
  let min = Math.min(...vs);
  let max = Math.max(...vs);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => (points.length === 1 ? W / 2 : padX + ((W - padX * 2) * i) / (points.length - 1));
  const y = (v) => padY + (H - padY * 2) * (1 - (v - min) / (max - min));
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${H - padY} ${line} ${x(points.length - 1).toFixed(1)},${H - padY}`;
  const last = points[points.length - 1];
  return `
    <svg class="line-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="推移グラフ">
      ${points.length > 1 ? `<polygon points="${area}" class="chart-area"></polygon>` : ''}
      ${points.length > 1 ? `<polyline points="${line}" class="chart-line" fill="none"></polyline>` : ''}
      <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="3.5" class="chart-dot"></circle>
    </svg>
    <div class="chart-meta">
      <span>${points[0].date}</span>
      <span>最高 ${fmt(Math.max(...vs))} / 最低 ${fmt(Math.min(...vs))}</span>
      <span>${last.date}</span>
    </div>
    ${points.length < 2 ? '<div class="empty-hint">日次の記録が貯まると推移グラフになります（毎朝8:30 JSTに記録）</div>' : ''}
  `;
}

async function renderMypage(main) {
  let d;
  try {
    d = await api('/mypage');
  } catch (e) {
    main.innerHTML = `<div class="empty-hint">読み込みに失敗しました: ${e.message}</div>`;
    return;
  }

  mypageData = d;
  const pp = pnlParts(d.unrealized_pnl_jpy_c, d.cost_jpy_c);

  main.innerHTML = `
    <div class="section">
      <div class="asset-card">
        <div class="asset-label">総資産（円換算）</div>
        <div class="asset-total" id="mp-total">${d.total_assets_jpy_c == null ? '--' : yen(d.total_assets_jpy_c)}</div>
        <div class="asset-pnl">
          評価損益
          <span class="pnl ${pp.cls}" id="mp-pnl">${pp.text}</span>
        </div>
        <div class="asset-note" id="mp-note"></div>
      </div>
      ${d.stale ? '<div class="empty-hint">一部の現在値・為替を取得できなかったため、取得価格などで概算しています。</div>' : ''}

      <div class="stat-grid">
        <div class="stat"><div class="stat-label">現金（円）</div><div class="stat-value">${yen(d.cash_jpy_c)}</div></div>
        <div class="stat"><div class="stat-label">現金（ドル）</div><div class="stat-value">${usd(d.cash_usd_c)}</div></div>
        <div class="stat"><div class="stat-label">保有評価額</div><div class="stat-value" id="mp-valuation">${yen(d.valuation_jpy_c)}</div></div>
        <div class="stat"><div class="stat-label">USD/JPY</div><div class="stat-value" id="mp-rate">${d.usd_jpy == null ? '--' : d.usd_jpy.toFixed(2)}</div></div>
      </div>

      <div class="section-title">推移（日次）</div>
      <div class="subtabs" id="mypage-metrics">
        ${Object.entries(MYPAGE_METRICS).map(([k, m]) =>
          `<button data-v="${k}" class="${mypageState.metric === k ? 'active' : ''}">${m.label}</button>`).join('')}
      </div>
      <div id="mypage-chart"></div>

      <button class="btn btn-primary" id="topup-btn" style="margin-top:18px">現金の増額を申請する</button>
    </div>
  `;

  const drawChart = () => {
    const m = MYPAGE_METRICS[mypageState.metric];
    const points = (d.snapshots || []).map((sn) => ({ date: sn.snapshot_date, v: sn[m.key] }));
    document.getElementById('mypage-chart').innerHTML = renderLineChart(points, m.fmt);
  };
  drawChart();
  main.querySelectorAll('#mypage-metrics button').forEach((b) => b.addEventListener('click', () => {
    mypageState.metric = b.dataset.v;
    main.querySelectorAll('#mypage-metrics button').forEach((x) => x.classList.toggle('active', x === b));
    drawChart();
  }));
  document.getElementById('topup-btn').addEventListener('click', openTopupDialog);

  // 保有銘柄はWSSを購読し、受信済み/受信したライブ価格で評価額を即時に更新する
  // （サーバーから届いた値は30分キャッシュの価格。ライブ価格が無い銘柄だけこの値のまま）
  const syms = (d.holdings || []).map((h) => h.symbol);
  connectLiveFeed();
  subscribeLive([...syms, 'JPY=X']);
  recalcMypage();
}

let mypageData = null;
let mypageRecalcQueued = false;

function pnlParts(pnlC, costC) {
  const pct = costC > 0 ? (pnlC / costC) * 100 : null;
  const sign = pnlC > 0 ? '+' : '';
  return {
    cls: pnlC > 0 ? 'up' : pnlC < 0 ? 'down' : '',
    text: `${sign}${yen(pnlC)}${pct == null ? '' : `（${sign}${pct.toFixed(2)}%）`}`,
  };
}

function scheduleMypageRecalc() {
  if (mypageRecalcQueued) return;
  mypageRecalcQueued = true;
  requestAnimationFrame(() => { mypageRecalcQueued = false; recalcMypage(); });
}

// サーバーの内訳(holdings)に、WSSで受信済みのライブ価格を当てはめて、総資産・評価額・評価損益を再計算する
function recalcMypage() {
  const d = mypageData;
  if (!d || state.tab !== 'mypage' || !document.getElementById('mp-total')) return;
  const liveRate = live.prices['JPY=X'];
  const rate = typeof liveRate === 'number' ? liveRate : d.usd_jpy;
  const holdings = d.holdings || [];

  let valuation = 0;
  let cost = 0;
  let liveCount = 0;
  let oldest = null;
  for (const h of holdings) {
    cost += h.cost_jpy_c;
    const lp = live.prices[h.symbol];
    if (typeof lp === 'number' && (h.market === 'JP' || rate != null)) {
      valuation += Math.floor(lp * h.quantity * (h.market === 'US' ? rate : 1) * 100);
      liveCount += 1;
    } else {
      valuation += h.valuation_jpy_c;
      if (h.as_of && (oldest === null || h.as_of < oldest)) oldest = h.as_of;
    }
  }

  if (rate != null) {
    const total = d.cash_jpy_c + Math.floor(d.cash_usd_c * rate) + valuation;
    document.getElementById('mp-total').textContent = yen(total);
    document.getElementById('mp-rate').textContent = rate.toFixed(2);
  }
  document.getElementById('mp-valuation').textContent = yen(valuation);
  const pp = pnlParts(valuation - cost, cost);
  const pnlEl = document.getElementById('mp-pnl');
  pnlEl.textContent = pp.text;
  pnlEl.className = `pnl ${pp.cls}`;

  const noteEl = document.getElementById('mp-note');
  if (noteEl) {
    if (!holdings.length) noteEl.textContent = '';
    else if (liveCount === holdings.length) noteEl.textContent = 'ライブ価格で表示中';
    else noteEl.textContent = `${liveCount}/${holdings.length}銘柄がライブ価格。残りは${oldest ? `${formatAsOf(oldest)}時点の` : '取得価格などの'}値`;
  }
}

// ---------- 現金増額申請（仕様書7.5） ----------
function openTopupDialog() {
  if (document.getElementById('modal-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">現金の増額を申請</div>
      <p class="modal-text">運営が承認すると、残高にその場で加算されます。承認までは残高は変わりません。</p>
      <div class="form-group">
        <label>通貨</label>
        <select id="topup-currency"><option value="JPY">円 (JPY)</option><option value="USD">ドル (USD)</option></select>
      </div>
      <div class="form-group">
        <label>金額</label>
        <input type="number" id="topup-amount" min="1" step="1" inputmode="decimal">
      </div>
      <div class="form-group">
        <label>理由・メモ（任意）</label>
        <textarea id="topup-reason" rows="3" maxlength="500"></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="topup-cancel">キャンセル</button>
        <button class="btn btn-primary" id="topup-submit">申請する</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('topup-currency').addEventListener('change', (e) => {
    document.getElementById('topup-amount').step = e.target.value === 'JPY' ? '1' : '0.01';
  });
  document.getElementById('topup-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('topup-submit').addEventListener('click', async (e) => {
    const currency = document.getElementById('topup-currency').value;
    const amount = parseFloat(document.getElementById('topup-amount').value);
    const reason = document.getElementById('topup-reason').value;
    if (!(amount > 0)) { toast('金額を入力してください'); return; }
    e.target.disabled = true;
    try {
      await api('/cash-topup-requests', { method: 'POST', body: { currency, amount, reason } });
      close();
      toast('申請しました。承認をお待ちください');
      historyState.sub = 'cash';
    } catch (err) {
      e.target.disabled = false;
      toast(`申請に失敗しました: ${err.message}`);
    }
  });
}

// ---------- 銘柄検索画面（仕様書7.3.2。検索はクライアントのIndexedDBインデックス） ----------
const SEARCH_PAGE = 30;
const SEARCH_MAX = 300;
const searchState = { q: '', market: 'ALL', limit: SEARCH_PAGE };
let searchLiveSymbols = new Set();
let searchDebounce = null;
let searchIndexUnsub = null;
let searchFallbackTimer = null;
const SEARCH_FALLBACK_MAX = 15;

function openSearch() {
  if (state.tab !== 'search') state.prevTab = state.tab;
  state.tab = 'search';
  render();
}

function clearSearchLive() {
  if (searchIndexUnsub) { searchIndexUnsub(); searchIndexUnsub = null; }
  clearTimeout(searchDebounce);
  clearTimeout(searchFallbackTimer);
  if (searchLiveSymbols.size) unsubscribeLive([...searchLiveSymbols]);
  searchLiveSymbols = new Set();
}

function renderSearch(main) {
  main.innerHTML = `
    <div class="search-screen">
      <div class="search-bar">
        <button type="button" class="search-back" id="search-back" aria-label="戻る">‹</button>
        <div class="search-input-wrap">
          <span class="search-icon">🔍</span>
          <input type="search" id="search-input" placeholder="銘柄名・ティッカー・証券コード" autocomplete="off" value="${escapeHtml(searchState.q)}">
          <button type="button" class="search-clear" id="search-clear" aria-label="クリア" ${searchState.q ? '' : 'hidden'}>✕</button>
        </div>
      </div>
      <div class="chips" id="search-market">
        ${[['ALL', 'すべて'], ['JP', '日本株'], ['US', '米国株']].map(([v, l]) =>
          `<button type="button" data-v="${v}" class="chip ${searchState.market === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div id="search-results"></div>
      <div class="search-foot" id="search-foot"></div>
    </div>
  `;
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');

  document.getElementById('search-back').addEventListener('click', () => {
    state.tab = state.prevTab && state.prevTab !== 'search' ? state.prevTab : 'home';
    render();
  });
  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchState.q = input.value;
      searchState.limit = SEARCH_PAGE;
      drawSearchResults();
    }, 80);
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    searchState.q = '';
    searchState.limit = SEARCH_PAGE;
    drawSearchResults();
    input.focus();
  });
  main.querySelectorAll('#search-market .chip').forEach((b) => b.addEventListener('click', () => {
    searchState.market = b.dataset.v;
    searchState.limit = SEARCH_PAGE;
    main.querySelectorAll('#search-market .chip').forEach((x) => x.classList.toggle('active', x === b));
    drawSearchResults();
  }));

  // 銘柄データの読み込み完了・更新に合わせて再描画
  if (searchIndexUnsub) searchIndexUnsub();
  searchIndexUnsub = SymbolIndex.subscribe(() => { if (state.tab === 'search') drawSearchResults(); });
  SymbolIndex.init(() => api('/symbols')).catch(() => {});

  drawSearchResults();
  if (!searchState.q) input.focus();
}

function drawSearchResults() {
  const box = document.getElementById('search-results');
  const foot = document.getElementById('search-foot');
  if (!box || !foot) return; // 画面遷移済み
  const st = SymbolIndex.getStatus();

  const footInfo = st.count
    ? `銘柄データ ${st.count.toLocaleString()}件${st.updatedAt ? `（${formatUnixDateTime(Math.floor(st.updatedAt / 1000))} 取得）` : ''} <button type="button" class="link-btn" id="search-refresh">更新</button>`
    : '';
  const bindRefresh = () => {
    const btn = document.getElementById('search-refresh');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      await SymbolIndex.refresh(true);
      toast(SymbolIndex.getStatus().error ? '更新に失敗しました' : '銘柄データを更新しました');
    });
  };

  if (st.state !== 'ready') {
    syncSearchLive([]);
    box.innerHTML = st.state === 'error'
      ? `<div class="empty-hint">銘柄データを取得できませんでした（${escapeHtml(st.error || '')}）<br><button type="button" class="btn btn-outline" id="search-retry" style="margin-top:10px">再試行</button></div>`
      : '<div class="empty-hint">銘柄データを読み込み中…（初回のみ数秒かかります）</div>';
    foot.innerHTML = '';
    const retry = document.getElementById('search-retry');
    if (retry) retry.addEventListener('click', () => SymbolIndex.refresh(true));
    return;
  }

  const q = searchState.q.trim();
  if (!q) {
    syncSearchLive([]);
    box.innerHTML = '<div class="empty-hint">銘柄名（例: トヨタ）、ティッカー（例: AAPL）、証券コード（例: 7203）で検索できます。ひらがな・全角でも検索できます。</div>';
    foot.innerHTML = footInfo;
    bindRefresh();
    return;
  }

  const market = searchState.market === 'ALL' ? null : searchState.market;
  const { results, total } = SymbolIndex.search(q, { limit: searchState.limit, market });
  if (!results.length) {
    syncSearchLive([]);
    box.innerHTML = '<div class="empty-hint">該当する銘柄がありません</div>';
    foot.innerHTML = footInfo;
    bindRefresh();
    return;
  }

  box.innerHTML = results.map((r) => `
    <div class="list-row search-row">
      <div class="search-main">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="sub">${escapeHtml(r.code)} ・ ${escapeHtml(r.symbol)} ・ ${MARKET_LABEL[r.market] || r.market}</div>
        <div class="row-actions">
          <button type="button" class="row-action-btn buy" data-act="BUY" data-market="${r.market}" data-code="${escapeHtml(r.code)}">買い</button>
          <button type="button" class="row-action-btn sell" data-act="SELL" data-market="${r.market}" data-code="${escapeHtml(r.code)}">売り</button>
        </div>
      </div>
      <div class="value">
        <span data-live-symbol="${escapeHtml(r.symbol)}" data-live-format="quote" data-currency="${r.currency}">--</span>
        <span class="live-dot" data-live-dot="${escapeHtml(r.symbol)}" title="ライブ未接続">●</span>
        <div class="asof" data-asof="${escapeHtml(r.symbol)}"></div>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    startOrderFromHolding(b.dataset.market, b.dataset.code, b.dataset.act, 0);
  }));

  const more = total > results.length && searchState.limit < SEARCH_MAX;
  foot.innerHTML = `
    <div>${total.toLocaleString()}件中 ${results.length.toLocaleString()}件を表示</div>
    ${more ? '<button type="button" class="btn btn-outline" id="search-more" style="margin:10px 0">さらに表示</button>' : ''}
    ${total > SEARCH_MAX && searchState.limit >= SEARCH_MAX ? '<div>件数が多いため、キーワードを足して絞り込んでください</div>' : ''}
    <div style="margin-top:6px">${footInfo}</div>`;
  const moreBtn = document.getElementById('search-more');
  if (moreBtn) moreBtn.addEventListener('click', () => {
    searchState.limit = Math.min(SEARCH_MAX, searchState.limit + SEARCH_PAGE);
    drawSearchResults();
  });
  bindRefresh();

  syncSearchLive(results.map((r) => r.symbol));
  results.forEach((r) => applyLivePriceToDom(r.symbol));
  // 検索の打鍵ごとに外部取得が走らないよう、入力が落ち着いてから上位の銘柄だけ暫定価格を取得する
  clearTimeout(searchFallbackTimer);
  const topSymbols = results.slice(0, SEARCH_FALLBACK_MAX).map((r) => r.symbol);
  searchFallbackTimer = setTimeout(() => ensureFallbackPrices(topSymbols), 500);
}

// 検索結果に出ている銘柄だけをライブ購読する（結果が変わったら不要になった分を解除）
function syncSearchLive(symbols) {
  const next = new Set(symbols);
  const gone = [...searchLiveSymbols].filter((x) => !next.has(x));
  if (gone.length) unsubscribeLive(gone);
  searchLiveSymbols = next;
  if (next.size) {
    connectLiveFeed();
    subscribeLive([...next]);
  }
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
            ・現在値 <span data-live-symbol="${t.symbol}" data-buy-price="${t.buy_price}">${t.market === 'JP' ? '¥' : '$'}${t.buy_price}</span><span class="asof" data-asof="${t.symbol}"></span>
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
      <button type="button" class="search-pill" id="home-search-btn">
        <span class="search-icon">🔍</span><span>銘柄を検索（名前・ティッカー・証券コード）</span>
      </button>
      <div class="section-title">保有銘柄</div>
      ${rows}
    </div>
  `;
  document.getElementById('home-search-btn').addEventListener('click', openSearch);

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
    // WSSの初回tickが届くまでは、APIで取得した暫定価格を表示する
    ensureFallbackPrices(state.portfolio.map((t) => t.symbol));
  }
}
// 保有銘柄から注文タブへ遷移し、銘柄・売買方向を事前セットする
function startOrderFromHolding(market, code, side, heldQty) {
  const sym = SymbolIndex.get(market, code);
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

// ---------- 指値有効期限カレンダー（仕様書7.2.2） ----------
// ネイティブのdate inputは使わず、取引所現地日付で「当日〜14日先」だけ選べる自前カレンダーにする。
// 範囲外の日付はクリック不可（サーバー側の isWithinExpiryRange と同じ条件をフロントでも守る）。
const ORDER_EXPIRY_MAX_DAYS = 14;
const calendarState = { year: 0, month: 0 }; // month: 0始まり

function marketToday(market) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'JP' ? 'Asia/Tokyo' : 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function expiryRange(market) {
  const min = marketToday(market);
  return { min, max: addDaysStr(min, ORDER_EXPIRY_MAX_DAYS) };
}
function isExpiryInRange(dateStr, market) {
  const { min, max } = expiryRange(market);
  return dateStr >= min && dateStr <= max; // YYYY-MM-DD は文字列比較で日付順になる
}

function renderExpiryCalendar() {
  const box = document.getElementById('expiry-calendar');
  if (!box) return;
  const { min, max } = expiryRange(orderState.market);
  const { year, month } = calendarState;
  const pad = (n) => String(n).padStart(2, '0');
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const minYm = Number(min.slice(0, 4)) * 12 + Number(min.slice(5, 7)) - 1;
  const maxYm = Number(max.slice(0, 4)) * 12 + Number(max.slice(5, 7)) - 1;
  const curYm = year * 12 + month;

  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<span class="cal-cell empty"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const str = `${year}-${pad(month + 1)}-${pad(d)}`;
    const ok = str >= min && str <= max;
    const cls = ['cal-cell', ok ? 'ok' : 'disabled', str === orderState.expiresDate ? 'selected' : '', str === min ? 'today' : '']
      .filter(Boolean).join(' ');
    cells += `<button type="button" class="${cls}" data-date="${str}" ${ok ? '' : 'disabled'}>${d}</button>`;
  }

  box.innerHTML = `
    <div class="cal-head">
      <button type="button" class="cal-nav" id="cal-prev" ${curYm <= minYm ? 'disabled' : ''}>‹</button>
      <span class="cal-title">${year}年${month + 1}月</span>
      <button type="button" class="cal-nav" id="cal-next" ${curYm >= maxYm ? 'disabled' : ''}>›</button>
    </div>
    <div class="cal-grid cal-dow">${['日', '月', '火', '水', '木', '金', '土'].map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-foot">選択できるのは ${min} 〜 ${max}（${orderState.market === 'JP' ? '東京' : 'ニューヨーク'}時間）</div>
  `;
  document.getElementById('cal-prev').addEventListener('click', () => {
    const d = new Date(Date.UTC(year, month - 1, 1));
    calendarState.year = d.getUTCFullYear(); calendarState.month = d.getUTCMonth();
    renderExpiryCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    const d = new Date(Date.UTC(year, month + 1, 1));
    calendarState.year = d.getUTCFullYear(); calendarState.month = d.getUTCMonth();
    renderExpiryCalendar();
  });
  box.querySelectorAll('.cal-cell.ok').forEach((b) => b.addEventListener('click', () => {
    orderState.expiresDate = b.dataset.date;
    document.getElementById('order-expires-text').textContent = orderState.expiresDate;
    box.hidden = true;
  }));
}

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
  // 市場切替や日付またぎで範囲外になった有効期限は選び直させる
  if (orderState.expiresDate && !isExpiryInRange(orderState.expiresDate, orderState.market)) {
    orderState.expiresDate = '';
  }

  main.innerHTML = `
    <div class="section">
      <div class="segmented" id="market-seg">
        <button data-v="JP" class="${orderState.market === 'JP' ? 'active' : ''}">日本株</button>
        <button data-v="US" class="${orderState.market === 'US' ? 'active' : ''}">米国株</button>
      </div>

      <div class="form-group symbol-field">
        <label>銘柄（名前・ティッカー・コードで検索）</label>
        <input type="text" id="order-code" autocomplete="off" placeholder="例: トヨタ / 7203 / MSFT" value="${escapeHtml(orderState.code)}">
        <div class="suggest" id="symbol-suggest" hidden></div>
      </div>

      <div class="form-group" id="order-price-preview" style="display:none">
        <label>現在値（ライブ）</label>
        <div><span class="ticker-value" id="order-price-preview-value" style="font-size:18px"></span><span class="asof" data-asof="" id="order-price-preview-asof"></span></div>
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

      <div id="limit-fields" ${orderState.orderType === 'LIMIT' ? '' : 'hidden'}>
        <div class="form-group">
          <label>指値価格</label>
          <input type="number" id="order-target-price" step="0.01" value="${orderState.targetPrice}">
        </div>
        <div class="form-group">
          <label>有効期限（現地日付・最大2週間先）</label>
          <button type="button" class="date-field" id="order-expires-btn">
            <span id="order-expires-text">${orderState.expiresDate || '日付を選択'}</span>
            <span class="date-field-icon">📅</span>
          </button>
          <div class="calendar" id="expiry-calendar" hidden></div>
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
    b.addEventListener('click', () => {
      orderState.orderType = b.dataset.v;
      if (orderState.orderType === 'MARKET') { orderState.targetPrice = ''; orderState.expiresDate = ''; }
      renderOrder(main);
    }));
  const settleSeg = document.getElementById('settle-seg');
  if (settleSeg) {
    settleSeg.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { orderState.settlementCurrency = b.dataset.v; renderOrder(main); }));
  }

  const codeEl = document.getElementById('order-code');
  codeEl.addEventListener('input', (e) => {
    orderState.code = e.target.value.trim().toUpperCase();
    updateQtyHint();
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => showSymbolSuggest(e.target.value), 80);
  });
  codeEl.addEventListener('focus', (e) => {
    if (e.target.value.trim() && !findSymbol()) showSymbolSuggest(e.target.value);
  });
  // 候補リストの外をタップしたら閉じる（再描画のたびに付け替える）
  if (suggestOutsideHandler) document.removeEventListener('click', suggestOutsideHandler);
  suggestOutsideHandler = (e) => {
    if (!e.target.closest('.symbol-field')) {
      const box = document.getElementById('symbol-suggest');
      if (box) box.hidden = true;
    }
  };
  document.addEventListener('click', suggestOutsideHandler);
  document.getElementById('order-qty').addEventListener('input', (e) => {
    orderState.quantity = Math.max(1, parseInt(e.target.value || '1', 10));
  });
  // +/-は単元の倍数にスナップして増減する（例: 単元100で 1→100→200、250→300 / 200）
  document.getElementById('qty-minus').addEventListener('click', () => {
    const step = getUnitStep();
    orderState.quantity = Math.max(1, Math.ceil(orderState.quantity / step) * step - step);
    document.getElementById('order-qty').value = orderState.quantity;
  });
  document.getElementById('qty-plus').addEventListener('click', () => {
    const step = getUnitStep();
    orderState.quantity = (Math.floor(orderState.quantity / step) + 1) * step;
    document.getElementById('order-qty').value = orderState.quantity;
  });
  // 銘柄データの読み込みが後から終わった場合も、単元・銘柄名の表示を更新する
  SymbolIndex.init(() => api('/symbols')).then(() => updateQtyHint()).catch(() => updateQtyHint());

  const targetPriceEl = document.getElementById('order-target-price');
  if (targetPriceEl) targetPriceEl.addEventListener('input', (e) => { orderState.targetPrice = e.target.value; });
  const expiresBtn = document.getElementById('order-expires-btn');
  if (expiresBtn) {
    expiresBtn.addEventListener('click', () => {
      const box = document.getElementById('expiry-calendar');
      if (box.hidden) {
        const { min } = expiryRange(orderState.market);
        const base = orderState.expiresDate || min;
        calendarState.year = Number(base.slice(0, 4));
        calendarState.month = Number(base.slice(5, 7)) - 1;
        renderExpiryCalendar();
        box.hidden = false;
      } else {
        box.hidden = true;
      }
    });
  }

  document.getElementById('order-submit').addEventListener('click', submitOrder);
}

function findSymbol() {
  return SymbolIndex.get(orderState.market, orderState.code);
}

// 1回の注文単位。銘柄が見つからない間も、日本株は既定100株で動かす（米国株は1株）。
function getUnitStep() {
  const sym = findSymbol();
  const u = sym ? Number(sym.unit_size) : 0;
  if (u > 0) return u;
  return orderState.market === 'JP' ? 100 : 1;
}

// ---------- 銘柄サジェスト（注文画面。検索はクライアントのIndexedDBインデックスで行う） ----------
let suggestTimer = null;
let suggestOutsideHandler = null;

const MARKET_LABEL = { JP: '日本株', US: '米国株' };

function showSymbolSuggest(text) {
  const box = document.getElementById('symbol-suggest');
  if (!box) return;
  const q = (text || '').trim();
  if (!q) { box.hidden = true; return; }
  const st = SymbolIndex.getStatus();
  if (st.state !== 'ready') {
    box.innerHTML = `<div class="suggest-empty">${st.state === 'error' ? '銘柄データを取得できませんでした' : '銘柄データを読み込み中…'}</div>`;
    box.hidden = false;
    return;
  }
  const { results, total } = SymbolIndex.search(q, { limit: 12 });
  if (!results.length) {
    box.innerHTML = '<div class="suggest-empty">該当する銘柄がありません</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = results.map((r) => `
    <button type="button" class="suggest-item" data-market="${r.market}" data-code="${escapeHtml(r.code)}">
      <span class="suggest-name">${escapeHtml(r.name)}</span>
      <span class="suggest-sub">${escapeHtml(r.code)} ・ ${escapeHtml(r.symbol)} ・ ${MARKET_LABEL[r.market] || r.market}</span>
    </button>`).join('') + (total > results.length ? `<div class="suggest-more">ほか ${total - results.length} 件（絞り込んでください）</div>` : '');
  box.hidden = false;
  box.querySelectorAll('.suggest-item').forEach((b) => b.addEventListener('click', () => {
    const sym = SymbolIndex.get(b.dataset.market, b.dataset.code);
    if (sym) selectSymbolForOrder(sym);
  }));
}

function selectSymbolForOrder(sym) {
  const marketChanged = orderState.market !== sym.market;
  orderState.market = sym.market;
  orderState.code = sym.code;
  const box = document.getElementById('symbol-suggest');
  if (box) box.hidden = true;
  if (marketChanged) {
    // 市場が変わると米国株の円貨決済欄・指値期限の現地日付などが変わるため、画面ごと描き直す
    orderState.settlementCurrency = 'NATIVE';
    renderOrder(document.getElementById('main'));
  } else {
    document.getElementById('order-code').value = sym.code;
    updateQtyHint();
  }
}

function updateQtyHint() {
  const hint = document.getElementById('qty-hint');
  if (!hint) return;
  const sym = findSymbol();
  const st = SymbolIndex.getStatus();
  hint.textContent = sym
    ? `${sym.name}（${MARKET_LABEL[sym.market] || sym.market}） 単元: ${sym.unit_size}株 / 通貨: ${sym.currency}`
    : !orderState.code
      ? '銘柄名・ティッカー・コードを入力してください'
      : st.state === 'ready'
        ? '該当する銘柄が見つかりません。候補から選んでください'
        : '銘柄データを読み込み中…';
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
  const known = typeof live.prices[sym.symbol] === 'number' || live.fallback[sym.symbol];
  valEl.textContent = known ? '' : '読み込み中...';
  const asofEl = document.getElementById('order-price-preview-asof');
  if (asofEl) asofEl.dataset.asof = sym.symbol;
  connectLiveFeed();
  subscribeLive([sym.symbol]);
  applyLivePriceToDom(sym.symbol);
  ensureFallbackPrices([sym.symbol]);
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
  if (SymbolIndex.getStatus().state === 'ready' && !findSymbol()) {
    toast('銘柄を候補から選んでください');
    return;
  }
  try {
    if (orderState.orderType === 'MARKET') {
      await api('/orders/market', { method: 'POST', body });
      toast('注文が約定しました');
    } else {
      if (!orderState.targetPrice || !orderState.expiresDate) {
        toast('指値価格と有効期限を入力してください');
        return;
      }
      if (!isExpiryInRange(orderState.expiresDate, orderState.market)) {
        toast(`有効期限は当日から${ORDER_EXPIRY_MAX_DAYS}日先までの日付を選んでください`);
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
        <button data-v="cash" class="${historyState.sub === 'cash' ? 'active' : ''}">入出金</button>
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
    } else if (historyState.sub === 'cash') {
      const { requests } = await api('/cash-topup-requests');
      const label = { PENDING: '承認待ち', APPROVED: '承認済み', REJECTED: '却下' };
      list.innerHTML = requests.length ? requests.map((r) => `
        <div class="list-row">
          <div>
            <div class="name">運営への入金申請 <span class="badge ${r.status}">${label[r.status] || r.status}</span></div>
            <div class="sub">${formatUnixDateTime(r.requested_at)}${r.reason ? ` ・ ${escapeHtml(r.reason)}` : ''}</div>
          </div>
          <div class="value ${r.status === 'APPROVED' ? 'up' : ''}">${r.status === 'APPROVED' ? '+' : ''}${r.currency === 'JPY' ? yen(r.amount_c) : usd(r.amount_c)}</div>
        </div>
      `).join('') : `<div class="empty-hint">入出金の履歴はありません。マイページから増額を申請できます。</div>`;
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

      <div class="section-title danger-title">危険な操作</div>
      <button class="btn btn-danger-outline" id="delete-account-btn">アカウントを削除する</button>
    </div>
  `;
  document.getElementById('delete-account-btn').addEventListener('click', openDeleteAccountDialog);
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

// ---------- アカウント削除 ----------
function openDeleteAccountDialog() {
  if (document.getElementById('modal-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">アカウントを削除しますか？</div>
      <p class="modal-text">アカウントは削除され、ログインできなくなります。この操作は取り消せません（同じユーザー名での再登録もできません）。</p>
      <div class="form-group">
        <label>確認のためパスワードを入力</label>
        <input type="password" id="delete-pass" autocomplete="current-password">
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="delete-cancel">キャンセル</button>
        <button class="btn btn-danger" id="delete-confirm">削除する</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('delete-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('delete-confirm').addEventListener('click', async (e) => {
    const password = document.getElementById('delete-pass').value;
    if (!password) { toast('パスワードを入力してください'); return; }
    e.target.disabled = true;
    try {
      await api('/account/delete', { method: 'POST', body: { password } });
      close();
      disconnectLiveFeed();
      state.authMode = 'login';
      toast('アカウントを削除しました');
      render();
    } catch (err) {
      e.target.disabled = false;
      toast(`削除に失敗しました: ${err.message}`);
    }
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
        <input type="password" id="auth-password" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
      </div>
      ${isLogin ? '' : `
      <div class="form-group">
        <label>パスワード（確認）</label>
        <input type="password" id="auth-password-confirm" autocomplete="new-password">
      </div>`}
      <div class="form-group" id="turnstile-container">
        <div id="turnstile-widget"></div>
      </div>
      <button class="btn btn-primary" id="auth-submit">${isLogin ? 'ログイン' : '新規登録'}</button>
      <div class="auth-switch">
        ${isLogin ? 'アカウントをお持ちでない方は' : 'すでにアカウントをお持ちの方は'}
        <button class="btn-link" id="auth-switch-btn">${isLogin ? '新規登録' : 'ログイン'}</button>
      </div>
    </div>
  `;
  renderTurnstile();
  document.getElementById('auth-switch-btn').addEventListener('click', () => {
    state.authMode = isLogin ? 'register' : 'login';
    renderAuth();
  });
  document.getElementById('auth-submit').addEventListener('click', async () => {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const turnstileToken = window.__turnstileToken || '';
    if (!username || !password) { toast('ユーザー名とパスワードを入力してください'); return; }
    if (!isLogin) {
      const confirm = document.getElementById('auth-password-confirm').value;
      if (password !== confirm) { toast('パスワードが一致しません'); return; }
    }
    if (!turnstileToken) { toast('ボット確認の完了をお待ちください'); return; }
    try {
      if (isLogin) {
        await api('/login', { method: 'POST', body: { username, password, turnstileToken } });
        toast('ログインしました');
      } else {
        // 登録APIがセッションも発行するため、そのままログイン状態になる
        await api('/register', { method: 'POST', body: { username, password, turnstileToken } });
        toast('登録しました');
        state.authMode = 'login';
      }
      render();
    } catch (e) {
      toast(`失敗しました: ${e.message}`);
      resetTurnstileToken(); // トークンは1回限り有効なので再取得させる
    }
  });
}

// Turnstileのコールバック（Turnstileのscriptタグ読み込み後にグローバルとして呼ばれる）
// ---------- Turnstile（明示的レンダリング） ----------
// ログイン⇔登録の切替で画面が再描画されるたびにウィジェットを作り直す。
// 自動レンダリング(.cf-turnstile)だと、innerHTML差し替え後にウィジェットが消える。
const TURNSTILE_SITE_KEY = '__TURNSTILE_SITE_KEY__';
let turnstileWidgetId = null;
let turnstileGeneration = 0;

function removeTurnstile() {
  turnstileGeneration++; // 待機中の描画ループを無効化
  if (turnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.remove(turnstileWidgetId); } catch { /* noop */ }
  }
  turnstileWidgetId = null;
  window.__turnstileToken = '';
}

function renderTurnstile() {
  removeTurnstile();
  const gen = turnstileGeneration;
  const tryRender = (retry) => {
    if (gen !== turnstileGeneration) return; // 新しい描画要求があれば中止
    const el = document.getElementById('turnstile-widget');
    if (!el) return;
    if (!window.turnstile) { // api.jsの読み込み待ち（最大約10秒）
      if (retry < 100) setTimeout(() => tryRender(retry + 1), 100);
      return;
    }
    turnstileWidgetId = window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => { window.__turnstileToken = token; },
      'expired-callback': () => { window.__turnstileToken = ''; },
      'error-callback': () => { window.__turnstileToken = ''; },
    });
  };
  tryRender(0);
}

function resetTurnstileToken() {
  window.__turnstileToken = '';
  if (turnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.reset(turnstileWidgetId); } catch { /* noop */ }
  }
}

// ---------- ライブ株価フィード (Yahoo Finance WSS, 表示専用) ----------
// 注意: 非公式・無保証のストリーミングエンドポイントを直接ブラウザから利用する。
// 約定判定・残高計算には一切使わない（そちらは引き続きWorker側のHTTP取得のみを正とする）。
// 接続できない/切れても表示が静的な最終取得価格に留まるだけで、アプリの他機能には影響しない。
const live = {
  ws: null,
  prices: {}, // symbol -> price（WSSで受信したライブ価格）
  fallback: {}, // symbol -> {price, asOf}（GET /api/prices で取得した暫定価格。WSSの初回tickが届くまでの表示用）
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

function unsubscribeLive(symbols) {
  const gone = symbols.filter((s) => live.subscribed.delete(s));
  if (!gone.length) return;
  if (live.ws && live.ws.readyState === WebSocket.OPEN) {
    try { live.ws.send(JSON.stringify({ unsubscribe: gone })); } catch { /* noop */ }
  }
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
  // 表示する価格: WSSのライブ価格を優先し、まだ届いていなければ /api/prices の暫定価格を使う
  const liveP = live.prices[symbol];
  const fb = live.fallback[symbol];
  const isLive = typeof liveP === 'number';
  const price = isLive ? liveP : (fb ? fb.price : undefined);
  if (typeof price !== 'number') return;

  const dotEl = document.querySelector(`[data-live-dot="${cssEscape(symbol)}"]`);
  if (dotEl && isLive) { dotEl.style.color = 'var(--primary)'; dotEl.title = 'ライブ接続中'; }
  if (dotEl && !isLive) dotEl.title = `ライブ待機中（${formatAsOf(fb.asOf)}時点の値を表示）`;

  // 「○○時点」表示（暫定価格のときだけ。ライブ受信後は消す）
  document.querySelectorAll(`[data-asof="${cssEscape(symbol)}"]`).forEach((el) => {
    el.textContent = isLive ? '' : `（${formatAsOf(fb.asOf)}時点）`;
  });

  // 同じsymbolの表示要素が複数ある場合（同一銘柄を複数ロット保有、ティッカーバー等）に
  // 全て更新できるようquerySelectorAllを使う
  document.querySelectorAll(`[data-live-symbol="${cssEscape(symbol)}"]`).forEach((priceEl) => {
    const format = priceEl.dataset.liveFormat;
    if (format === 'rate' || format === 'index') {
      priceEl.textContent = price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (format === 'quote') {
      // 注文画面・検索画面の現在値（表示専用、約定には使わない）
      const cur = priceEl.dataset.currency;
      priceEl.textContent = (cur === 'USD' ? '$' : '¥') + price.toLocaleString(undefined, { maximumFractionDigits: 2 });
    } else {
      // ポートフォリオ行の1株あたり価格表示（¥/$記号付き）
      const valueEl = document.querySelector(`[data-live-value="${cssEscape(symbol)}"]`);
      const market = valueEl ? valueEl.dataset.market : null;
      priceEl.textContent = (market === 'US' ? '$' : '¥') + price.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    if (isLive && prevPrice != null && price !== prevPrice) {
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

  // マイページはWSSの受信分を評価額へ反映する
  if (isLive && state.tab === 'mypage') scheduleMypageRecalc();
}

// 取得時刻の短い表記（当日なら HH:MM、それ以外は M/D HH:MM）
function formatAsOf(sec) {
  const d = new Date(sec * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// WSSの初回tickが届くまでの暫定価格を取得して表示に反映する（サーバー側は30分KVキャッシュ）。
// すでにライブ価格・暫定価格を持っている銘柄は取りに行かない。
const fallbackInFlight = new Set();
const fallbackMissAt = {};
async function ensureFallbackPrices(symbols) {
  const now = Date.now();
  const need = [...new Set(symbols)].filter((sym) =>
    sym && typeof live.prices[sym] !== 'number' && !live.fallback[sym] && !fallbackInFlight.has(sym)
    && !(fallbackMissAt[sym] && now - fallbackMissAt[sym] < 5 * 60 * 1000)); // 取得失敗した銘柄は5分間は再取得しない
  if (!need.length) return;
  need.forEach((sym) => fallbackInFlight.add(sym));
  const BATCH = 30; // サーバー側の1リクエスト上限
  for (let i = 0; i < need.length; i += BATCH) {
    const chunk = need.slice(i, i + BATCH);
    try {
      const { prices } = await api(`/prices?symbols=${encodeURIComponent(chunk.join(','))}`);
      for (const [sym, p] of Object.entries(prices || {})) {
        live.fallback[sym] = { price: p.price, asOf: p.as_of };
      }
    } catch { /* 取得できなくても表示が「--」のままになるだけ */ }
    chunk.forEach((sym) => {
      fallbackInFlight.delete(sym);
      if (!live.fallback[sym]) fallbackMissAt[sym] = Date.now();
    });
    chunk.forEach((sym) => applyLivePriceToDom(sym));
  }
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
