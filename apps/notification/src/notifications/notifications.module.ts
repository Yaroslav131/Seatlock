import { Module } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { TicketPdfService } from '../tickets/ticket-pdf.service';
import { TicketStorageService } from '../tickets/ticket-storage.service';
import { OrderPaidConsumer } from './order-paid.consumer';

@Module({
  providers: [OrderPaidConsumer, TicketPdfService, TicketStorageService, MailService],
})
export class NotificationsModule {}
