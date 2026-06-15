import { Logger } from '@nestjs/common';
import { SmsProvider } from './sms-provider.interface';

/**
 * No-op SMS provider used when Twilio credentials are not configured
 * (local development, tests, CI). Logs the message and returns a synthetic
 * message id so callers and the outbox treat the send as successful, keeping
 * the dead-letter queue free of noise in unconfigured environments.
 *
 * Mirrors the existing `VERIFICATION_MODE=mock` idiom used elsewhere.
 */
export class MockSmsProvider implements SmsProvider {
  private readonly logger = new Logger(MockSmsProvider.name);

  send(to: string, body: string): Promise<{ messageId: string }> {
    this.logger.debug(`[SMS mock] Would send to ${to}: ${body}`);
    return Promise.resolve({ messageId: `mock-sms-${Date.now()}` });
  }
}
