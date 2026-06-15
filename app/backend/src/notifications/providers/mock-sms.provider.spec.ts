import { MockSmsProvider } from './mock-sms.provider';

describe('MockSmsProvider', () => {
  it('resolves with a synthetic message id and never throws', async () => {
    const provider = new MockSmsProvider();

    const result = await provider.send('+15551234567', 'Hello');

    expect(result.messageId).toMatch(/^mock-sms-/);
  });
});
