import { describe, expect, it } from 'vitest';
import { formatDateTime, formatPrice } from './format';

// formatDateTime форматирует в локальном времени раннера (toLocaleString
// без явного timeZone) — фиксируем зону явно, иначе тест был бы
// недетерминированным между локальной машиной и CI. Europe/Minsk — без
// перехода на летнее время, круглый год UTC+3, поэтому смещение не
// плавает по календарю.
process.env.TZ = 'Europe/Minsk';

// Intl.NumberFormat('ru-RU', {style:'currency',...}) разделяет разряды
// и валюту неразрывным пробелом (U+00A0), не обычным — на глаз в
// консоли неотличимо от ASCII-пробела, поэтому фиксируем явно.
const NBSP = ' ';

describe('formatPrice', () => {
  it('переводит копейки в рубли и округляет до целого', () => {
    expect(formatPrice(150000)).toBe(`1${NBSP}500${NBSP}₽`);
  });

  it('ноль остаётся нулём, а не пустой строкой', () => {
    expect(formatPrice(0)).toBe(`0${NBSP}₽`);
  });
});

describe('formatDateTime', () => {
  it('форматирует ISO-дату в день, месяц и время по-русски', () => {
    // 2026-12-31T17:00:00Z в Europe/Minsk (UTC+3) — 20:00. Год и день
    // недели намеренно не проверяем, формат в коде их и не показывает.
    expect(formatDateTime('2026-12-31T17:00:00.000Z')).toBe('31 декабря в 20:00');
  });
});
