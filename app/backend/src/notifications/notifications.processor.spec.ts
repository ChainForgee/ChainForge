import { Test, TestingModule } from '@nestjs/testing';
import { NotificationProcessor } from './notifications.processor';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from './interfaces/notification-job.interface';
import { Job } from 'bullmq';
import { DlqService } from '../jobs/dlq.service';
import { MetricsService } from '../observability/metrics/metrics.service';
import { SMS_PROVIDER } from './providers/sms-provider.interface';
import { EmailService } from './email/email.service';

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;
  let prismaMock: {
    notificationOutbox: {
      update: jest.Mock;
    };
  };
  let metricsMock: { incrementCallbackFailure: jest.Mock };
  let smsProviderMock: { send: jest.Mock };
  let emailServiceMock: { sendEmail: jest.Mock };

  const makeJob = (
    overrides: Partial<{
      outboxId: string;
      type: string;
      recipient: string;
      message: string;
    }> = {},
  ): Job<any, any, string> =>
    ({
      id: 'job-test-1',
      data: {
        type: NotificationType.EMAIL,
        recipient: 'test@example.com',
        message: 'Test message',
        timestamp: Date.now(),
        outboxId: 'outbox-test-1',
        ...overrides,
      },
      attemptsMade: 0,
    }) as unknown as Job<any, any, string>;

  beforeEach(async () => {
    prismaMock = {
      notificationOutbox: {
        update: jest.fn().mockResolvedValue({}),
      },
    };
    metricsMock = { incrementCallbackFailure: jest.fn() };
    smsProviderMock = {
      send: jest.fn().mockResolvedValue({ messageId: 'twilio-sid-1' }),
    };
    emailServiceMock = {
      sendEmail: jest.fn().mockResolvedValue({
        success: true,
        messageId: 'mock-message-id',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
        {
          provide: DlqService,
          useValue: {
            moveToDlq: jest.fn(),
          },
        },
        {
          provide: MetricsService,
          useValue: metricsMock,
        },
        {
          provide: SMS_PROVIDER,
          useValue: smsProviderMock,
        },
        {
          provide: EmailService,
          useValue: emailServiceMock,
        },
      ],
    }).compile();

    processor = module.get<NotificationProcessor>(NotificationProcessor);
  });

  describe('process', () => {
    it('should call prisma.update with lastAttemptAt when outboxId is present', async () => {
      const job = makeJob({ outboxId: 'outbox-abc' });

      await processor.process(job);

      expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'outbox-abc' },
        data: { lastAttemptAt: expect.any(Date) },
      });
    });

    it('should log a warning and not throw when outboxId is absent', async () => {
      const job = makeJob({ outboxId: undefined });
      // Remove outboxId entirely
      delete job.data.outboxId;

      await expect(processor.process(job)).resolves.toBeDefined();
      expect(prismaMock.notificationOutbox.update).not.toHaveBeenCalled();
    });

    it('should return a successful NotificationResult', async () => {
      const job = makeJob();

      const result = await processor.process(job);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should log correlationId when present in job data', async () => {
      const logSpy = jest.spyOn(processor['logger'], 'log');
      const job = makeJob({ outboxId: 'outbox-abc' });
      job.data.correlationId = 'test-correlation-id';

      await processor.process(job);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-correlation-id'),
      );
    });

    it('should re-throw when prisma.update throws during process', async () => {
      prismaMock.notificationOutbox.update.mockRejectedValueOnce(
        new Error('DB error'),
      );
      const job = makeJob({ outboxId: 'outbox-abc' });

      await expect(processor.process(job)).rejects.toThrow('DB error');
    });

    it('should deliver SMS jobs through the SMS provider', async () => {
      const job = makeJob({
        type: NotificationType.SMS,
        recipient: '+15551234567',
        message: 'Claim receipt',
      });

      const result = await processor.process(job);

      expect(smsProviderMock.send).toHaveBeenCalledWith(
        '+15551234567',
        'Claim receipt',
      );
      expect(result).toEqual({ success: true, messageId: 'twilio-sid-1' });
    });

    it('should not call the SMS provider for email jobs', async () => {
      const job = makeJob({ type: NotificationType.EMAIL });

      await processor.process(job);

      expect(smsProviderMock.send).not.toHaveBeenCalled();
    });

    it('should propagate SMS provider failures so the job is retried', async () => {
      smsProviderMock.send.mockRejectedValueOnce(new Error('Twilio 500'));
      const job = makeJob({
        type: NotificationType.SMS,
        recipient: '+15551234567',
      });

      await expect(processor.process(job)).rejects.toThrow('Twilio 500');
      expect(metricsMock.incrementCallbackFailure).toHaveBeenCalledWith(
        'notification_delivery',
        'Twilio 500',
      );
    });

    it('should deliver email notifications via EmailService', async () => {
      const job = makeJob();

      const result = await processor.process(job);

      expect(emailServiceMock.sendEmail).toHaveBeenCalledWith({
        to: 'test@example.com',
        subject: 'ChainForge Notification',
        text: 'Test message',
      });
      expect(result).toEqual({
        success: true,
        messageId: 'mock-message-id',
      });
    });

    it('should not call EmailService for SMS jobs', async () => {
      const job = makeJob({
        type: NotificationType.SMS,
        recipient: '+15551234567',
      });

      await processor.process(job);

      expect(emailServiceMock.sendEmail).not.toHaveBeenCalled();
    });

    it('should re-throw and increment failure metric when EmailService rejects', async () => {
      emailServiceMock.sendEmail.mockRejectedValueOnce(
        new Error('Email provider is not configured'),
      );
      const job = makeJob({ outboxId: 'outbox-abc' });

      await expect(processor.process(job)).rejects.toThrow(
        'Email provider is not configured',
      );
      expect(metricsMock.incrementCallbackFailure).toHaveBeenCalledWith(
        'notification_delivery',
        'Email provider is not configured',
      );
    });
  });

  describe('onCompleted', () => {
    it('should update outbox record to sent with sentAt when outboxId is present', async () => {
      const job = makeJob({ outboxId: 'outbox-abc' });

      await processor.onCompleted(job);

      expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'outbox-abc' },
        data: {
          status: 'sent',
          sentAt: expect.any(Date),
        },
      });
    });

    it('should log a warning and not throw when outboxId is absent', async () => {
      const job = makeJob();
      delete job.data.outboxId;

      await expect(processor.onCompleted(job)).resolves.toBeUndefined();
      expect(prismaMock.notificationOutbox.update).not.toHaveBeenCalled();
    });

    it('should swallow prisma errors and not throw', async () => {
      prismaMock.notificationOutbox.update.mockRejectedValueOnce(
        new Error('DB error'),
      );
      const job = makeJob({ outboxId: 'outbox-abc' });

      await expect(processor.onCompleted(job)).resolves.toBeUndefined();
    });
  });

  describe('onFailed', () => {
    it('should update outbox record to failed with retryCount increment and lastError when outboxId is present and exhausted', async () => {
      const job = makeJob({ outboxId: 'outbox-abc' });
      job.opts = { attempts: 1 } as any;
      job.attemptsMade = 1;
      const error = new Error('Something went wrong');

      await processor.onFailed(job, error);

      expect(metricsMock.incrementCallbackFailure).toHaveBeenCalledWith(
        'notification_job',
        'Something went wrong',
      );

      expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'outbox-abc' },
        data: {
          status: 'failed',
          retryCount: { increment: 1 },
          lastError: 'Something went wrong',
        },
      });
    });

    it('should keep status enqueued while retries remain and still increment retryCount', async () => {
      const job = makeJob({ outboxId: 'outbox-abc' });
      job.opts = { attempts: 3 } as any;
      job.attemptsMade = 1;
      const error = new Error('Temporary failure');

      await processor.onFailed(job, error);

      expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'outbox-abc' },
        data: {
          status: 'enqueued',
          retryCount: { increment: 1 },
          lastError: 'Temporary failure',
        },
      });
    });

    it('should log a warning and not throw when outboxId is absent', async () => {
      const job = makeJob();
      delete job.data.outboxId;
      const error = new Error('Job failed');

      await expect(processor.onFailed(job, error)).resolves.toBeUndefined();
      expect(prismaMock.notificationOutbox.update).not.toHaveBeenCalled();
    });

    it('should handle undefined job gracefully', async () => {
      const error = new Error('Job failed');

      await expect(
        processor.onFailed(undefined, error),
      ).resolves.toBeUndefined();
      expect(prismaMock.notificationOutbox.update).not.toHaveBeenCalled();
    });

    it('should swallow prisma errors and not throw', async () => {
      prismaMock.notificationOutbox.update.mockRejectedValueOnce(
        new Error('DB error'),
      );
      const job = makeJob({ outboxId: 'outbox-abc' });
      const error = new Error('Job failed');

      await expect(processor.onFailed(job, error)).resolves.toBeUndefined();
    });
  });
});
