import { parseTicketSnapshot } from './ticket-snapshot';

const valid = {
  buyerEmail: 'buyer@seatlock.fun',
  eventTitle: 'Концерт',
  startsAt: '2026-12-20T19:00:00.000Z',
  venueName: 'Дворец спорта',
  venueCity: 'Минск',
  venueAddress: 'пр. Победителей, 1',
  seatSection: 'A',
  seatRow: 3,
  seatNumber: 12,
};

describe('parseTicketSnapshot', () => {
  it('корректный снимок разбирается как есть, секция может быть null', () => {
    expect(parseTicketSnapshot(valid)).toEqual(valid);
    expect(parseTicketSnapshot({ ...valid, seatSection: null })?.seatSection).toBeNull();
  });

  it('лишние поля отбрасываются', () => {
    const parsed = parseTicketSnapshot({ ...valid, secret: 'x' });
    expect(parsed).not.toHaveProperty('secret');
  });

  it.each([
    ['не объект', 'строка'],
    ['null', null],
    ['undefined (событие от старой версии payment)', undefined],
    ['нет email', { ...valid, buyerEmail: undefined }],
    ['пустой email', { ...valid, buyerEmail: '' }],
    ['ряд строкой', { ...valid, seatRow: '3' }],
    ['секция числом', { ...valid, seatSection: 5 }],
    ['дата не парсится', { ...valid, startsAt: 'не дата' }],
  ])('%s — null, consumer идёт запасным путём', (_name, raw) => {
    expect(parseTicketSnapshot(raw)).toBeNull();
  });
});
