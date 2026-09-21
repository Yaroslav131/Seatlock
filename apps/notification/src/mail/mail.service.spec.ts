import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';

jest.mock('nodemailer');

function createConfigMock(values: Record<string, string>) {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) {
        throw new Error(`отсутствует обязательная переменная ${key}`);
      }
      return values[key];
    }),
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
  };
}

describe('MailService', () => {
  const createTransportMock = nodemailer.createTransport as jest.Mock;

  beforeEach(() => {
    createTransportMock.mockReset();
    createTransportMock.mockReturnValue({ sendMail: jest.fn() });
  });

  it('без SMTP_USER — транспорт без auth и без TLS (Mailpit в dev/CI)', () => {
    new MailService(createConfigMock({ SMTP_HOST: 'localhost', SMTP_PORT: '1025' }) as never);

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'localhost', secure: false, auth: undefined }),
    );
  });

  it('с SMTP_USER — транспорт с auth и secure:true (реальный релей, например Resend)', () => {
    new MailService(
      createConfigMock({
        SMTP_HOST: 'smtp.resend.com',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'resend',
        SMTP_PASSWORD: 'api-key',
      }) as never,
    );

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.resend.com',
        secure: true,
        auth: { user: 'resend', pass: 'api-key' },
      }),
    );
  });

  it('SMTP-соединения переиспользуются (pool), их число равно NOTIFICATION_PREFETCH', () => {
    new MailService(
      createConfigMock({ SMTP_HOST: 'localhost', NOTIFICATION_PREFETCH: '4' }) as never,
    );

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ pool: true, maxConnections: 4 }),
    );
  });

  it('при остановке закрывает пул соединений', () => {
    const close = jest.fn();
    createTransportMock.mockReturnValue({ sendMail: jest.fn(), close });

    new MailService(createConfigMock({ SMTP_HOST: 'localhost' }) as never).onModuleDestroy();

    expect(close).toHaveBeenCalledTimes(1);
  });

  describe('sendTicket', () => {
    const pdf = Buffer.from('pdf');
    let sendMail: jest.Mock;
    let service: MailService;

    beforeEach(() => {
      sendMail = jest.fn().mockResolvedValue(undefined);
      createTransportMock.mockReturnValue({ sendMail });
      service = new MailService(createConfigMock({ SMTP_HOST: 'localhost' }) as never);
    });

    it('обычному получателю — письмо уходит в SMTP', async () => {
      await service.sendTicket({ to: 'buyer@example.com', eventTitle: 'Концерт', pdf });

      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'buyer@example.com' }));
    });

    it('получателю на @loadtest.invalid — письмо не отправляется (нагрузочный тест)', async () => {
      await service.sendTicket({ to: 'k6-buyer-7@loadtest.invalid', eventTitle: 'Концерт', pdf });
      await service.sendTicket({ to: 'K6-BUYER-8@LoadTest.Invalid', eventTitle: 'Концерт', pdf });

      expect(sendMail).not.toHaveBeenCalled();
    });

    it('домен, лишь похожий на тестовый, не подавляется', async () => {
      await service.sendTicket({
        to: 'buyer@notloadtest.invalid.example.com',
        eventTitle: 'Х',
        pdf,
      });

      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });
});
