import {
  fetchAidDetails,
  fetchAidList,
  submitClaim,
} from '../services/aidApi';

const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('aidApi service', () => {
  it('fetches the aid overview list from the backend', async () => {
    const payload = [
      {
        id: 'aid-1',
        title: 'Emergency Food Supply',
        description: 'Food package distribution',
        status: 'active',
        location: 'Sector A',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });

    await expect(fetchAidList()).resolves.toEqual(payload);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringMatching(/\/aid$/));
  });

  it('throws a status-specific error when the aid list request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(fetchAidList()).rejects.toThrow('HTTP error! status: 503');
  });

  it('fetches aid details for the selected aid id', async () => {
    const payload = {
      id: 'aid-42',
      title: 'Medical Aid Convoy',
      description: 'Mobile medical support',
      recipient: {
        name: 'Amina Yusuf',
        id: 'REC-2041',
        wallet: 'GAKD...Q9X2',
      },
      tokenType: 'USDC',
      amount: '150',
      expiryDate: '2026-02-01T00:00:00Z',
      status: 'verified',
      claimId: 'claim-42',
      createdAt: '2026-01-01T00:00:00Z',
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });

    await expect(fetchAidDetails('aid-42')).resolves.toEqual(payload);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringMatching(/\/aid\/aid-42$/));
  });

  it('submits claims with an idempotency key header', async () => {
    const payload = { status: 'accepted', claimId: 'claim-123' };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });

    await expect(submitClaim('claim-123', 'idem-123')).resolves.toEqual(payload);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/claims\/claim-123\/submit$/),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-123',
        },
      },
    );
  });

  it('throws a status-specific error when claim submission fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 409 });

    await expect(submitClaim('claim-123', 'idem-123')).rejects.toThrow(
      'HTTP error! status: 409',
    );
  });
});
