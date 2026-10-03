/*
 * 銘柄インデックス（クライアント側 IndexedDB）
 *
 * 銘柄マスタ（日本株・米国株 約1.5万件）を GET /api/symbols（全件）から取得して IndexedDB に保存し、
 * 検索はすべてブラウザ内で行う。サーバーへ都度問い合わせないので、入力ごとの通信が発生しない。
 *  - 起動時: IndexedDB の内容を即メモリへ読み込む（以後の検索はメモリ上で実行）
 *  - 鮮度: 最終取得から TTL（サーバー側キャッシュと同じ12時間）を超えていたら再取得して丸ごと置換。
 *          古いデータがある間はそれを使い続け、裏で更新する（初回だけ取得完了を待つ）
 *  - IndexedDB が使えない環境（プライベートモード等）でも、メモリのみで動作する
 * 検索対象は 証券コード / ティッカー / 銘柄名。全角半角・大文字小文字・ひらがな/カタカナの違いを吸収する。
 */
(function () {
  'use strict';

  const DB_NAME = 'demo-trade-symbols';
  const DB_VERSION = 1;
  const STORE = 'symbols';
  const META = 'meta';
  const TTL_MS = 12 * 60 * 60 * 1000;

  let db = null;
  let items = []; // 検索用に正規化済みの全件
  let byKey = new Map(); // 'JP:7203' -> item
  let fetcher = null;
  let initPromise = null;
  let refreshPromise = null;
  const listeners = new Set();
  const status = { state: 'idle', count: 0, updatedAt: 0, error: null }; // state: idle | loading | ready | error

  // ---------- 正規化 ----------
  // NFKC（全角英数→半角、半角カナ→全角カナ）→小文字化→ひらがなをカタカナへ
  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  }

  function setItems(rows) {
    items = rows.map((r) => ({
      code: r.code,
      market: r.market,
      symbol: r.symbol,
      name: r.name,
      currency: r.currency,
      unit_size: r.unit_size,
      _code: norm(r.code),
      _sym: norm(r.symbol),
      _name: norm(r.name),
    }));
    byKey = new Map(items.map((it) => [`${it.market}:${it.code}`, it]));
    status.count = items.length;
  }

  function notify() {
    listeners.forEach((cb) => {
      try { cb(getStatus()); } catch { /* noop */ }
    });
  }

  // ---------- IndexedDB ----------
  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('indexedDB unavailable')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: ['market', 'code'] });
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function readAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readonly');
      const rowsReq = tx.objectStore(STORE).getAll();
      const metaReq = tx.objectStore(META).get('syncedAt');
      tx.oncomplete = () => resolve({ rows: rowsReq.result || [], syncedAt: metaReq.result ? metaReq.result.value : 0 });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // 全件を1トランザクションで置換（途中で失敗しても古いデータが残る）
  function replaceAll(rows, syncedAt) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      for (const r of rows) {
        store.put({ market: r.market, code: r.code, symbol: r.symbol, name: r.name, currency: r.currency, unit_size: r.unit_size });
      }
      tx.objectStore(META).put({ key: 'syncedAt', value: syncedAt });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ---------- 取得・更新 ----------
  function refresh(force) {
    if (refreshPromise) return refreshPromise;
    if (!fetcher) return Promise.resolve(getStatus());
    if (!force && items.length && Date.now() - status.updatedAt <= TTL_MS) return Promise.resolve(getStatus());

    if (!items.length) status.state = 'loading';
    notify();
    refreshPromise = (async () => {
      try {
        const res = await fetcher();
        const rows = res && Array.isArray(res.symbols) ? res.symbols : null;
        if (!rows || !rows.length) throw new Error('銘柄データが空です');
        const now = Date.now();
        setItems(rows);
        status.updatedAt = now;
        status.state = 'ready';
        status.error = null;
        if (db) {
          try { await replaceAll(rows, now); } catch { /* 永続化に失敗してもメモリ上では使える */ }
        }
      } catch (e) {
        status.error = e && e.message ? e.message : String(e);
        // 古いデータが残っていればそのまま使い続ける
        status.state = items.length ? 'ready' : 'error';
      } finally {
        refreshPromise = null;
        notify();
      }
      return getStatus();
    })();
    return refreshPromise;
  }

  async function doInit() {
    status.state = 'loading';
    try { db = await openDb(); } catch { db = null; }
    if (db) {
      try {
        const { rows, syncedAt } = await readAll();
        if (rows.length) {
          setItems(rows);
          status.updatedAt = syncedAt || 0;
          status.state = 'ready';
        }
      } catch { /* 読めなければ取得し直す */ }
    }
    notify();
    const stale = !items.length || Date.now() - status.updatedAt > TTL_MS;
    if (stale) {
      const p = refresh(true);
      if (!items.length) await p; // 初回のみ待つ。2回目以降は手元のデータで即利用し、裏で更新
    }
    return getStatus();
  }

  /** 初期化（冪等）。fetchFn は () => Promise<{symbols: [...]}>（認証付きの /api/symbols を呼ぶ関数） */
  function init(fetchFn) {
    if (fetchFn) fetcher = fetchFn;
    // 銘柄データが無いままエラーになっていた場合のみ、次回の呼び出しで再試行する
    if (!initPromise || (status.state === 'error' && !items.length)) initPromise = doInit();
    return initPromise;
  }

  // ---------- 検索 ----------
  /**
   * 銘柄を検索する。複数語（スペース区切り）は AND。
   * 並び順: コード/ティッカー完全一致 → 前方一致 → 銘柄名の前方一致 → コード/ティッカー部分一致 → 銘柄名部分一致
   * @returns {{results: Array, total: number}}
   */
  function search(query, opts) {
    const o = opts || {};
    const limit = o.limit || 30;
    const offset = o.offset || 0;
    const market = o.market || null;
    const q = norm(query).trim();
    if (!q) return { results: [], total: 0 };
    const tokens = q.split(/\s+/).filter(Boolean);
    const first = tokens[0];

    const hits = [];
    for (const it of items) {
      if (market && it.market !== market) continue;
      let ok = true;
      for (const t of tokens) {
        if (!(it._code.includes(t) || it._sym.includes(t) || it._name.includes(t))) { ok = false; break; }
      }
      if (!ok) continue;
      let score;
      if (it._code === first || it._sym === first) score = 0;
      else if (it._code.startsWith(first) || it._sym.startsWith(first)) score = 1;
      else if (it._name.startsWith(first)) score = 2;
      else if (it._code.includes(first) || it._sym.includes(first)) score = 3;
      else score = 4;
      hits.push({ it, score });
    }
    hits.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.it.market !== b.it.market) return a.it.market === 'JP' ? -1 : 1;
      return a.it._code < b.it._code ? -1 : a.it._code > b.it._code ? 1 : 0;
    });
    return { results: hits.slice(offset, offset + limit).map((h) => h.it), total: hits.length };
  }

  /** 市場+コードの完全一致 */
  function get(market, code) {
    return byKey.get(`${market}:${code}`) || null;
  }

  function getStatus() {
    return { state: status.state, count: status.count, updatedAt: status.updatedAt, error: status.error };
  }

  /** 状態変化（読み込み完了・更新・失敗）の通知を購読する。戻り値は購読解除関数 */
  function subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  window.SymbolIndex = { init, refresh, search, get, getStatus, subscribe };
})();
