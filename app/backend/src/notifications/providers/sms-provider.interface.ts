/**
 * Abstraction over an SMS delivery backend (Twilio, AWS SNS, a mock, ...).
 *
 * Implementations are responsible for talking to the underlying provider and
 * surfacing failures by throwing — the BullMQ processor relies on a thrown
 * error to trigger retries, the dead-letter queue, and outbox status updates.
 */
export interface SmsProvider {
  /**
   * Send a single SMS message.
   *
   * @param to   Destination phone number in E.164 format (e.g. +15551234567).
   * @param body Message text.
   * @returns    The provider-assigned message identifier.
   * @throws     If the provider rejects the request or the number is invalid.
   */
  send(to: string, body: string): Promise<{ messageId: string }>;
}

/** DI token for the active {@link SmsProvider} implementation. */
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
