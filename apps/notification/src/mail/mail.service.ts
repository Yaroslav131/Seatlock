import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { ticketMailSuppressedTotal } from '../metrics/business-metrics';
import { readPrefetch } from '../rabbitmq/prefetch';

// .invalid зарезервирован RFC 2606 и никогда не резолвится — реальный человек
// с таким адресом существовать не может. Нагрузочный тест (packages/load-test)
// заводит покупателей на этом домене, чтобы вся цепочка (PDF, S3, лог) работала
// по-настоящему, а письма в Resend не уходили. Проверка по получателю, а не
// глобальный флаг: её нельзя случайно оставить включённой для реальных клиентов.
export const SUPPRESSED_MAIL_DOMAIN = '@loadtest.invalid';

export interface TicketEmail {
  to: string;
  eventTitle: string;
  pdf: Buffer;
}

@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly transport: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    // В dev/CI это Mailpit — без TLS и без пароля, SMTP_SECURE/SMTP_USER
    // не заданы. В проде — Resend (smtp.resend.com:465, логин "resend",
    // пароль — API-ключ): secure:true и auth обязательны, иначе релей
    // отклонит соединение.
    const smtpUser = this.config.get<string>('SMTP_USER');
    this.transport = nodemailer.createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: this.config.get<number>('SMTP_PORT', 1025),
      secure: this.config.get<string>('SMTP_SECURE', 'false') === 'true',
      // Пул переиспользует SMTP-соединения. Без него каждое письмо открывает новое
      // (TCP, TLS, AUTH): на замере против Mailpit это 8 с на письмо против 5-9 мс
      // по готовому соединению, а с реальным релеем — сотни миллисекунд на письмо.
      // Соединений не больше, чем писем в работе одновременно.
      pool: true,
      maxConnections: readPrefetch(this.config),
      auth: smtpUser
        ? { user: smtpUser, pass: this.config.getOrThrow<string>('SMTP_PASSWORD') }
        : undefined,
    });
  }

  onModuleDestroy(): void {
    // Пул держит открытые сокеты — закрываем, иначе процесс не завершится чисто.
    this.transport.close();
  }

  async sendTicket(email: TicketEmail): Promise<void> {
    if (email.to.toLowerCase().endsWith(SUPPRESSED_MAIL_DOMAIN)) {
      ticketMailSuppressedTotal.inc();
      return;
    }
    await this.transport.sendMail({
      from: 'tickets@seatlock.fun',
      to: email.to,
      subject: `Ваш билет: ${email.eventTitle}`,
      text: `Билет на «${email.eventTitle}» во вложении.`,
      attachments: [{ filename: 'ticket.pdf', content: email.pdf, contentType: 'application/pdf' }],
    });
  }
}
