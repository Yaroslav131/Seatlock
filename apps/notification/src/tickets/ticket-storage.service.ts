import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

@Injectable()
export class TicketStorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
    this.client = new S3Client({
      endpoint: this.config.getOrThrow<string>('S3_ENDPOINT'),
      region: 'us-east-1', // MinIO игнорирует регион, но SDK требует значение
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY'),
        secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_KEY'),
      },
      // Обязательно для MinIO: virtual-hosted-style (bucket.host/key,
      // стиль по умолчанию у AWS SDK) не работает с локальным MinIO
      // без отдельной DNS-настройки под wildcard-поддомены.
      forcePathStyle: true,
    });
  }

  onModuleDestroy(): void {
    // S3Client держит keep-alive HTTP-агент — без явного destroy() при
    // остановке сервиса сокет остаётся открытым (тот же класс проблемы,
    // что PrismaService.$disconnect()/RabbitmqModule решают для своих
    // соединений).
    this.client.destroy();
  }

  async uploadTicket(orderId: string, pdf: Buffer): Promise<string> {
    const key = `tickets/${orderId}.pdf`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: pdf,
        ContentType: 'application/pdf',
      }),
    );
    return key;
  }
}
