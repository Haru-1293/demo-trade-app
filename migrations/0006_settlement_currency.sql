-- 0006_settlement_currency.sql
-- 米国株の買い注文(成行・指値)に円貨決済オプションを追加する。
-- 'NATIVE': 決済通貨は銘柄本来の通貨(日本株=JPY, 米国株=USD、従来通り)
-- 'JPY':    米国株の買いを日本円残高から拘束・決済する(円貨決済)
-- 売却時の受取通貨選択・日本株での使用は対象外（常にNATIVE相当）。

ALTER TABLE orders ADD COLUMN settlement_currency TEXT NOT NULL DEFAULT 'NATIVE'
  CHECK (settlement_currency IN ('NATIVE', 'JPY'));
