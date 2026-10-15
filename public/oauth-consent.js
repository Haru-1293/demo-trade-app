// OAuth承認画面（仕様書4.17）。外部アプリ（MCPクライアント）の接続を、ユーザーが権限ごとに許可・拒否する。
// 認可リクエストのクエリ（location.search）は、サーバーが表示のたびに・決定のたびに再検証する。

const app = document.getElementById('app');

// 権限の表示。trade:write だけは初期OFFで、お金が動くことを明示する
const PERMISSIONS = {
  'portfolio:read': { title: '資産・保有・履歴を見る', desc: '現金残高、総資産、保有株、注文履歴、取引履歴を読み取ります。', defaultOn: true },
  'market:read': { title: '銘柄検索・現在値を見る', desc: '銘柄の検索と、表示用の現在値の取得ができます。', defaultOn: true },
  'trade:write': { title: '注文を出す・取り消す', desc: '成行・指値注文の発注と、未約定注文の取消ができます。', danger: 'デモ用の資金が動きます（実際のお金ではありません）', defaultOn: false },
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function api(path, options = {}) {
  const csrf = getCookie('csrf_token');
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(json?.error_description || json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ログインが必要なときは、アプリのログイン画面へ。ログイン後にこの画面へ戻る（next は同一サイトのこの画面だけ許可される）
function goLogin() {
  document.cookie = 'csrf_token=; Max-Age=0; Path=/; Secure; SameSite=Lax'; // 期限切れのセッションを見かけ上ログインのままにしない
  location.replace('/?next=' + encodeURIComponent(location.pathname + location.search));
}

function showError(message) {
  app.innerHTML = `
    <div class="consent-screen">
      <h2>接続できませんでした</h2>
      <div class="consent-error">${escapeHtml(message)}</div>
      <p class="consent-lead">接続を始めたアプリに戻って、もう一度お試しください。</p>
    </div>`;
}

function redirectHint(r) {
  if (r.kind === 'web') return `接続が終わると <strong>${escapeHtml(r.host)}</strong> に戻ります。`;
  if (r.kind === 'loopback') return 'この端末上で動いているアプリに戻ります。';
  return `接続が終わると「${escapeHtml(r.host)}」アプリを開きます。`;
}

async function main() {
  if (!getCookie('csrf_token')) { goLogin(); return; }
  const query = location.search.replace(/^\?/, '');

  let info;
  try {
    info = await api('/oauth/authorization-info?' + query);
  } catch (e) {
    if (e.status === 401) { goLogin(); return; }
    showError(e.message);
    return;
  }

  const perms = info.scopes.map((s) => {
    const p = PERMISSIONS[s];
    if (!p) return '';
    return `
      <label class="consent-perm">
        <input type="checkbox" data-scope="${escapeHtml(s)}" ${p.defaultOn ? 'checked' : ''}>
        <span>
          <div class="perm-title">${escapeHtml(p.title)}</div>
          <div class="perm-desc">${escapeHtml(p.desc)}</div>
          ${p.danger ? `<div class="perm-danger">${escapeHtml(p.danger)}</div>` : ''}
        </span>
      </label>`;
  }).join('');

  app.innerHTML = `
    <div class="consent-screen">
      <h2>アプリの接続</h2>
      <p class="consent-lead">次のアプリが、あなたのデモ口座にアクセスしようとしています。</p>
      <div class="card">
        <div class="consent-app">${escapeHtml(info.client.name)}</div>
        <div class="consent-center"><span class="consent-badge">アプリ名は自己申告で、確認されていません</span></div>
        ${info.client.host ? `<p class="consent-meta consent-center">提供元: ${escapeHtml(info.client.host)}</p>` : ''}
        <p class="consent-meta consent-center">${redirectHint(info.redirect)}</p>
        ${info.redirect.kind === 'loopback' ? '<div class="consent-warn">心当たりのないアプリは許可しないでください。この端末上の別のプログラムが、アプリになりすませる場合があります。</div>' : ''}
      </div>
      <div class="section-title">許可する権限</div>
      <div class="card" id="perm-list">${perms}</div>
      <div class="consent-actions">
        <button type="button" class="btn btn-primary" id="allow-btn">許可する</button>
        <button type="button" class="btn btn-outline" id="deny-btn">キャンセル</button>
      </div>
      <p class="consent-user">ログイン中: ${escapeHtml(info.username)}　<button type="button" class="link-btn" id="switch-btn">別のアカウントで続ける</button></p>
      <p class="consent-meta consent-center">許可はいつでも、アプリの「設定」→「連携アプリ」から取り消せます。</p>
    </div>`;

  const allowBtn = document.getElementById('allow-btn');
  const denyBtn = document.getElementById('deny-btn');

  function selectedScopes() {
    return [...document.querySelectorAll('#perm-list input[data-scope]')].filter((i) => i.checked).map((i) => i.dataset.scope);
  }
  function syncAllow() { allowBtn.disabled = selectedScopes().length === 0; }
  document.querySelectorAll('#perm-list input').forEach((i) => i.addEventListener('change', syncAllow));
  syncAllow();

  async function decide(approved) {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    try {
      const { redirect } = await api('/oauth/decision', { method: 'POST', body: { query, approved, scopes: approved ? selectedScopes() : [] } });
      app.innerHTML = `
        <div class="consent-screen"><div class="consent-done">
          ${approved ? '接続を許可しました。' : 'キャンセルしました。'}<br>
          アプリに戻っています…<br>
          <span class="consent-meta">戻らない場合は、アプリに戻ってこのタブを閉じてください。</span>
        </div></div>`;
      location.href = redirect; // フォーム送信ではなくJSからの移動（CSPのform-actionを守るため）
    } catch (e) {
      if (e.status === 401) { goLogin(); return; }
      showError(e.message);
    }
  }
  allowBtn.addEventListener('click', () => decide(true));
  denyBtn.addEventListener('click', () => decide(false));
  document.getElementById('switch-btn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* noop */ }
    goLogin();
  });
}

main();
