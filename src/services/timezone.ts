import type { Market } from '../types';

/**
 * 仕様書4.3: 指値の有効期限は「取引所現地時間での日付」で指定し、
 * その現地日付の23:59:59をUTC秒に変換して保存する。
 * サマータイム(DST)は Intl.DateTimeFormat の timeZone 解決に任せるため、
 * 固定オフセットのテーブルを自前で持つ必要はない。
 */

export function timeZoneOf(market: Market): string {
  return market === 'JP' ? 'Asia/Tokyo' : 'America/New_York';
}

/** 指定タイムゾーンでの、ある日付(UTC正午を基準)のUTCオフセット（分）を求める */
function getUtcOffsetMinutes(dateStr: string, timeZone: string): number {
  const refInstant = new Date(`${dateStr}T12:00:00Z`);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(refInstant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  // hour='24' になるケースがあるため 0 に正規化
  const hour = map.hour === '24' ? 0 : Number(map.hour);

  const localAsUtcMs = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return (localAsUtcMs - refInstant.getTime()) / 60000;
}

/** "YYYY-MM-DD" を [year, month, day] に分解する（不正な形式ならエラー） */
function parseDateStr(dateStr: string): [number, number, number] {
  const parts = dateStr.split('-').map(Number);
  const [y, m, d] = parts;
  if (parts.length !== 3 || y == null || m == null || d == null || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    throw new Error(`invalid date string: ${dateStr}`);
  }
  return [y, m, d];
}

/** "YYYY-MM-DD" の現地23:59:59をUTC秒(UNIX秒)に変換する */
export function localEndOfDayToUnix(dateStr: string, timeZone: string): number {
  const offsetMinutes = getUtcOffsetMinutes(dateStr, timeZone);
  const [y, m, d] = parseDateStr(dateStr);
  const localEndOfDayAsUtcMs = Date.UTC(y, m - 1, d, 23, 59, 59);
  const utcMs = localEndOfDayAsUtcMs - offsetMinutes * 60000;
  return Math.floor(utcMs / 1000);
}

/** 現在時刻(UNIX秒)を、指定タイムゾーンでの "YYYY-MM-DD" 文字列に変換する */
export function unixToLocalDateStr(unixSeconds: number, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(new Date(unixSeconds * 1000)); // en-CA は YYYY-MM-DD 形式
}

/** dateStr(YYYY-MM-DD)が [today, today+maxDays] の範囲内かを判定する */
export function isWithinExpiryRange(
  dateStr: string,
  timeZone: string,
  nowUnix: number,
  maxDays: number,
): boolean {
  const todayStr = unixToLocalDateStr(nowUnix, timeZone);
  const toMs = (s: string) => {
    const [y, m, d] = parseDateStr(s);
    return Date.UTC(y, m - 1, d);
  };
  const diffDays = Math.round((toMs(dateStr) - toMs(todayStr)) / 86400000);
  return diffDays >= 0 && diffDays <= maxDays;
}
