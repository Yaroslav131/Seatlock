import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';

export interface TicketData {
  orderId: string;
  eventTitle: string;
  startsAt: Date;
  venueName: string;
  venueCity: string;
  venueAddress: string;
  seatSection: string | null;
  seatRow: number;
  seatNumber: number;
  amountCents: number;
}

@Injectable()
export class TicketPdfService {
  // QR кодирует orderId — простейший верификатор билета на входе
  // (сверить с заказом в payment), без отдельного подписанного токена:
  // некому пока сканировать эти QR в реальности, усложнять незачем.
  async generate(ticket: TicketData): Promise<Buffer> {
    const qrPng = await QRCode.toBuffer(ticket.orderId, { width: 200 });

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A5', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text('SeatLock — билет', { align: 'center' });
      doc.moveDown();
      doc.fontSize(14).text(ticket.eventTitle);
      doc.fontSize(11).text(ticket.startsAt.toLocaleString('ru-RU'));
      doc.moveDown();
      doc.text(`${ticket.venueName}, ${ticket.venueCity}`);
      doc.text(ticket.venueAddress);
      doc.moveDown();
      const seatLabel = ticket.seatSection
        ? `Секция ${ticket.seatSection}, ряд ${ticket.seatRow}, место ${ticket.seatNumber}`
        : `Ряд ${ticket.seatRow}, место ${ticket.seatNumber}`;
      doc.fontSize(13).text(seatLabel);
      doc.fontSize(11).text(`Оплачено: ${(ticket.amountCents / 100).toFixed(2)} USD`);
      doc.moveDown();
      doc.fontSize(9).text(`Заказ: ${ticket.orderId}`);
      doc.image(qrPng, { fit: [150, 150], align: 'center' });

      doc.end();
    });
  }
}
