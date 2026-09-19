-- 0007_user_email.sql
-- 管理者によるパスワード変更通知メール送信(4.5)の宛先として使用する。
-- 登録時の必須項目ではないため、値が無いユーザーには通知メールを送らない。

ALTER TABLE users ADD COLUMN email TEXT;
