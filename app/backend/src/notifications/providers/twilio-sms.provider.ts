import { Logger } from '@nestjs/common';
import twilio, { Twilio } from 'twilio';
import { SmsProvider } from './sms-provider.interface';

/** Matches an E.164 phone number, e.g. +15551234567. */
const E164 = /^\+[1-9]\d{1,14}$/;

/**
 * Sends SMS through Twilio's REST API.
 *
 * Failures (invalid number, Twilio API error) are thrown so the BullMQ
 * processor can retry and, once attempts are exhausted, route the job to the
 * dead-letter queue.
 */
export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly client: Twilio;

  constructor(
    accountSid: string,
    authToken: string,
    private readonly fromNumber: string,
  ) {
    this.client = twilio(accountSid, authToken);
  }

  async send(to: string, body: string): Promise<{ messageId: string }> {
    if (!E164.test(to)) {
      throw new Error(`Invalid E.164 phone number: ${to}`);
    }

    const message = await this.client.messages.create({
      to,
      from: this.fromNumber,
      body,
    });

    this.logger.debug(`Twilio accepted SMS to ${to} (sid=${message.sid})`);
    return { messageId: message.sid };
  }
}
