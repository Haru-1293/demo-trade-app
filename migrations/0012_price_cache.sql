-- 0012_price_cache.sql
-- 表示用の現在値キャッシュ（仕様書 4.14）。KVの書き込み上限（Freeプランは1日1,000回）を避けるためD1に置く。
-- WITHOUT ROWID: 主キーがそのままテーブル本体になり、書き込み1回あたりの書き込み行数が増えない（インデックス分の追加書き込みが無い）。
-- 行数は銘柄数が上限で、同じ銘柄は上書きされる。有効期限は読み出し時に as_of で判定する。
CREATE TABLE price_cache (
  symbol TEXT PRIMARY KEY,
  price REAL NOT NULL,
  as_of INTEGER NOT NULL -- この価格を取得した時刻（UNIX秒）
) WITHOUT ROWID;
