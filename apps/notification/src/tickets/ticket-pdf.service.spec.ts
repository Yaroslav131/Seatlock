import { TicketPdfService } from './ticket-pdf.service';

describe('TicketPdfService', () => {
  it('генерирует непустой PDF-буфер, начинающийся с сигнатуры %PDF', async () => {
    const service = new TicketPdfService();

    const pdf = await service.generate({
      orderId: 'order-1',
      eventTitle: 'Тестовый концерт',
      startsAt: new Date('2026-12-01T19:00:00Z'),
      venueName: 'Дворец спорта',
      venueCity: 'Минск',
      venueAddress: 'пр. Победителей, 1',
      seatSection: 'A',
      seatRow: 3,
      seatNumber: 12,
      amountCents: 150000,
    });

    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});
