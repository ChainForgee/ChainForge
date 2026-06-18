import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sgMail from '@sendgrid/mail';
import { MetricsService } from '../../observability/metrics/metrics.service';

export interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  success: true;
  messageId?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly fromAddress: string;
  private readonly fromName: string;
  private readonly configured: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
  ) {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');
    this.fromAddress =
      this.configService.get<string>('EMAIL_FROM_ADDRESS') ||
      'no-reply@chainforge.local';
    this.fromName =
      this.configService.get<string>('EMAIL_FROM_NAME') || 'ChainForge';
    this.configured = Boolean(apiKey);

    if (this.configured) {
      sgMail.setApiKey(apiKey as string);
    } else {
      this.logger.warn(
        'SENDGRID_API_KEY is not configured — outgoing emails will fail until it is set',
      );
    }
  }

  /**
   * Sends a single email via SendGrid. Throws on any failure so the caller
   * (BullMQ job processor) can retry/DLQ rather than silently dropping mail.
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const startedAt = Date.now();

    if (!this.configured) {
      this.metricsService.recordEmailDelivery(
        'failed',
        (Date.now() - startedAt) / 1000,
      );
      throw new Error('Email provider is not configured');
    }

    try {
      const [response] = await sgMail.send({
        to: params.to,
        from: { email: this.fromAddress, name: this.fromName },
        subject: params.subject,
        text: params.text,
        html: params.html ?? params.text,
      });

      const messageId = response.headers?.['x-message-id'] as
        | string
        | undefined;

      this.metricsService.recordEmailDelivery(
        'success',
        (Date.now() - startedAt) / 1000,
      );
      this.logger.log(`Email delivered with status ${response.statusCode}`);

      return { success: true, messageId };
    } catch (error) {
      this.metricsService.recordEmailDelivery(
        'failed',
        (Date.now() - startedAt) / 1000,
      );
      this.logger.error(
        `Email delivery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      throw error;
    }
  }
}
