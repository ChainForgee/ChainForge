import { Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationProcessor } from './notifications.processor';
import { OutboxController } from './outbox.controller';
import { EmailService } from './email/email.service';
import { JobsModule } from '../jobs/jobs.module';
import { MetricsModule } from '../observability/metrics/metrics.module';
import { LoggerModule } from '../logger/logger.module';
import { SmsProvider, SMS_PROVIDER } from './providers/sms-provider.interface';
import { TwilioSmsProvider } from './providers/twilio-sms.provider';
import { MockSmsProvider } from './providers/mock-sms.provider';

/**
 * Selects the SMS provider at startup: Twilio when credentials are present,
 * otherwise a logging mock (mirrors the `VERIFICATION_MODE=mock` idiom).
 */
const smsProviderFactory = (configService: ConfigService): SmsProvider => {
  const accountSid = configService.get<string>('TWILIO_ACCOUNT_SID');
  const authToken = configService.get<string>('TWILIO_AUTH_TOKEN');
  const fromNumber = configService.get<string>('TWILIO_FROM_NUMBER');

  if (accountSid && authToken && fromNumber) {
    return new TwilioSmsProvider(accountSid, authToken, fromNumber);
  }

  new Logger('NotificationsModule').warn(
    'Twilio credentials not configured; SMS will use MockSmsProvider',
  );
  return new MockSmsProvider();
};

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueueAsync({
      name: 'notifications',
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST') || 'localhost',
          port: parseInt(configService.get<string>('REDIS_PORT') || '6379'),
        },
      }),
      inject: [ConfigService],
    }),
    JobsModule,
    MetricsModule,
    LoggerModule,
  ],
  controllers: [OutboxController],
  providers: [
    NotificationsService,
    NotificationProcessor,
    EmailService,
    {
      provide: SMS_PROVIDER,
      useFactory: smsProviderFactory,
      inject: [ConfigService],
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
