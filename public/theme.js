// 保存済みのテーマ指定（ライト／ダーク）を、描画前に <html data-theme> へ反映する。
// 未指定なら何もせず、CSSの prefers-color-scheme（端末の設定）に従う。
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* 保存領域が使えない環境では端末の設定に従う */ }
})();
