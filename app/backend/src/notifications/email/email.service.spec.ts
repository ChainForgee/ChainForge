import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import sgMail from '@sendgrid/mail';
import { EmailService } from './email.service';
import { MetricsService } from '../../observability/metrics/metrics.service';

jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  default: {
    setApiKey: jest.fn(),
    send: jest.fn(),
  },
}));

describe('EmailService', () => {
  let service: EmailService;
  let configMock: { get: jest.Mock };
  let metricsMock: { recordEmailDelivery: jest.Mock };

  const buildService = async (apiKey?: string) => {
    configMock = {
      get: jest.fn((key: string) => {
        if (key === 'SENDGRID_API_KEY') return apiKey;
        if (key === 'EMAIL_FROM_ADDRESS') return 'no-reply@chainforge.local';
        if (key === 'EMAIL_FROM_NAME') return 'ChainForge';
        return undefined;
      }),
    };
    metricsMock = { recordEmailDelivery: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: ConfigService, useValue: configMock },
        { provide: MetricsService, useValue: metricsMock },
      ],
    }).compile();

    return module.get<EmailService>(EmailService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', async () => {
    service = await buildService('test-api-key');
    expect(service).toBeDefined();
  });

  it('should throw and record a failed metric when no API key is configured', async () => {
    service = await buildService(undefined);

    await expect(
      service.sendEmail({
        to: 'recipient@example.com',
        subject: 'Subject',
        text: 'Body',
      }),
    ).rejects.toThrow('Email provider is not configured');

    expect(metricsMock.recordEmailDelivery).toHaveBeenCalledWith(
      'failed',
      expect.any(Number),
    );
  });

  it('should send via SendGrid and record a success metric', async () => {
    (sgMail.send as jest.Mock).mockResolvedValue([
      { statusCode: 202, headers: { 'x-message-id': 'sg-message-1' } },
    ]);
    service = await buildService('test-api-key');

    const result = await service.sendEmail({
      to: 'recipient@example.com',
      subject: 'Subject',
      text: 'Body',
    });

    expect(result).toEqual({ success: true, messageId: 'sg-message-1' });
    expect(sgMail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'recipient@example.com',
        subject: 'Subject',
        text: 'Body',
      }),
    );
    expect(metricsMock.recordEmailDelivery).toHaveBeenCalledWith(
      'success',
      expect.any(Number),
    );
  });

  it('should re-throw and record a failed metric when SendGrid rejects', async () => {
    (sgMail.send as jest.Mock).mockRejectedValue(new Error('SendGrid down'));
    service = await buildService('test-api-key');

    await expect(
      service.sendEmail({
        to: 'recipient@example.com',
        subject: 'Subject',
        text: 'Body',
      }),
    ).rejects.toThrow('SendGrid down');

    expect(metricsMock.recordEmailDelivery).toHaveBeenCalledWith(
      'failed',
      expect.any(Number),
    );
  });
});
