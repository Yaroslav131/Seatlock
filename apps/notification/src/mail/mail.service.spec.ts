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
});
