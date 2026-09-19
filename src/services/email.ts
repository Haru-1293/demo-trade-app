import type { Env } from '../types';
import { EmailMessage } from 'cloudflare:email';

/**
 * 仕様書4.5: 管理者によるパスワード直接変更時、Cloudflare Email Routingで通知メールを送る。
 * 送信元アドレスは Email Routing 側で検証済みのアドレスである必要がある（デプロイ時に置き換える）。
 * mimetextなどの外部ライブラリは使わず、シンプルなプレーンテキストのRFC822メッセージを自前で組む。
 */
const FROM_ADDRESS = 'no-reply@example.com'; // TODO: 実際に検証済みの送信元アドレスへ置き換える

export async function sendPasswordChangedEmail(
  env: Env,
  toAddress: string,
  username: string,
): Promise<boolean> {
  try {
    const subject = '【デモトレード】パスワードが変更されました';
    const body = [
      `${username} 様`,
      '',
      '管理者によりアカウントのパスワードが変更されました。',
      '心当たりがない場合は、お早めに管理者までご連絡ください。',
      '',
      '---',
      'デモトレード運営（本メールはデモ・学習用システムからの自動送信です）',
    ].join('\r\n');

    const raw = [
      `From: ${FROM_ADDRESS}`,
      `To: ${toAddress}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');

    const message = new EmailMessage(FROM_ADDRESS, toAddress, raw);
    await env.SEND_EMAIL.send(message);
    return true;
  } catch {
    // 送信失敗してもパスワード変更自体は既に成功しているため、呼び出し元はエラーにしない
    return false;
  }
}
