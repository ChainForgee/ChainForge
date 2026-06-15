import { TwilioSmsProvider } from './twilio-sms.provider';

const createMock = jest.fn();

jest.mock('twilio', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    messages: { create: (...args: unknown[]) => createMock(...args) },
  })),
}));

describe('TwilioSmsProvider', () => {
  let provider: TwilioSmsProvider;

  beforeEach(() => {
    createMock.mockReset();
    provider = new TwilioSmsProvider('AC_sid', 'token', '+15550000000');
  });

  it('sends an SMS and returns the Twilio message sid', async () => {
    createMock.mockResolvedValueOnce({ sid: 'SM123' });

    const result = await provider.send('+15551234567', 'Hello');

    expect(createMock).toHaveBeenCalledWith({
      to: '+15551234567',
      from: '+15550000000',
      body: 'Hello',
    });
    expect(result).toEqual({ messageId: 'SM123' });
  });

  it('rejects non-E.164 numbers without calling Twilio', async () => {
    await expect(provider.send('5551234567', 'Hi')).rejects.toThrow(
      /Invalid E\.164/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('propagates Twilio API errors', async () => {
    createMock.mockRejectedValueOnce(new Error('Twilio unauthorized'));

    await expect(provider.send('+15551234567', 'Hi')).rejects.toThrow(
      'Twilio unauthorized',
    );
  });
});
