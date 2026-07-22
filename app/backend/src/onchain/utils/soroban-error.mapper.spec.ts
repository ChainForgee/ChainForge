import { SorobanErrorMapper } from './soroban-error.mapper';

describe('SorobanErrorMapper', () => {
  const mapper = new SorobanErrorMapper();

  it('maps invalid token contract errors from numeric contract codes', () => {
    expect(mapper.mapError({ errorCode: 17 })).toEqual({
      statusCode: 400,
      message: 'Invalid token contract address',
      details: {
        error_code: 17,
        error_type: 'contract_error',
      },
    });
  });

  it('maps reverted token transfers from numeric contract codes', () => {
    expect(mapper.mapError({ errorCode: 18 })).toEqual({
      statusCode: 502,
      message: 'Token transfer failed',
      details: {
        error_code: 18,
        error_type: 'contract_error',
      },
    });
  });

  it('maps token errors from contract error messages', () => {
    expect(
      mapper.mapError(
        new Error('HostError: Error(Contract, #17) InvalidToken'),
      ),
    ).toMatchObject({
      statusCode: 400,
      message: 'Invalid token contract address',
      details: {
        error_name: 'InvalidToken',
        error_type: 'contract_error',
      },
    });
  });

  it('maps token errors embedded in Soroban JSON-RPC responses', () => {
    expect(
      mapper.mapError({
        response: {
          data: {
            error: {
              code: -32603,
              message: 'HostError: Error(Contract, #18)',
            },
          },
        },
      }),
    ).toMatchObject({
      statusCode: 502,
      message: 'Token transfer failed',
      details: {
        error_code: 18,
        error_type: 'contract_error',
      },
    });
  });

  // ----------------------------------------------------------------------
  // Issue #233: numeric code 23 (`TooManyAllowedTokens`) is mapped so the
  // backend never falls back to the catch-all 500 for `set_config` calls
  // that exceed the length cap.
  // ----------------------------------------------------------------------
  it('maps too-many-allowed-tokens (#23) to HTTP 413', () => {
    expect(mapper.mapError({ errorCode: 23 })).toEqual({
      statusCode: 413,
      message: 'Allowed-tokens list exceeds maximum length',
      details: {
        error_code: 23,
        error_type: 'contract_error',
      },
    });
  });

  it('maps merkle allowlist expiry (#19) to HTTP 410', () => {
    expect(mapper.mapError({ errorCode: 19 })).toEqual({
      statusCode: 410,
      message: 'Merkle allowlist has expired',
      details: {
        error_code: 19,
        error_type: 'contract_error',
      },
    });
  });

  it('maps oversized proof (#20) to HTTP 400', () => {
    expect(mapper.mapError({ errorCode: 20 })).toEqual({
      statusCode: 400,
      message: 'Claim proof exceeds maximum depth',
      details: {
        error_code: 20,
        error_type: 'contract_error',
      },
    });
  });

  it('maps no pending admin (#21) to HTTP 400', () => {
    expect(mapper.mapError({ errorCode: 21 })).toEqual({
      statusCode: 400,
      message: 'No admin rotation is pending',
      details: {
        error_code: 21,
        error_type: 'contract_error',
      },
    });
  });

  it('maps admin rotation expired (#22) to HTTP 400', () => {
    expect(mapper.mapError({ errorCode: 22 })).toEqual({
      statusCode: 400,
      message: 'Admin rotation deadline has passed',
      details: {
        error_code: 22,
        error_type: 'contract_error',
      },
    });
  });

  // ----------------------------------------------------------------------
  // String-based fallback paths for codes 19..23. The numeric mapper
  // ({errorCode: N}) is the primary path; these tests pin the secondary
  // mapContractErrorMessage() fallback so the new errors never silently
  // fall through to the catch-all 500 when an upstream layer surfaces
  // them as a textual `Error(Contract, #N)` or
  // `Error(Contract, VariantName)` form.
  // ----------------------------------------------------------------------
  it.each([
    [
      19,
      'AllowlistExpired',
      410,
      'Merkle allowlist has expired',
    ],
    [20, 'ProofTooLarge', 400, 'Claim proof exceeds maximum depth'],
    [21, 'NoPendingAdmin', 400, 'No admin rotation is pending'],
    [
      22,
      'AdminRotationExpired',
      400,
      'Admin rotation deadline has passed',
    ],
    [
      23,
      'TooManyAllowedTokens',
      413,
      'Allowed-tokens list exceeds maximum length',
    ],
  ])(
    'maps code #%i variant %s by name (string fallback) to HTTP %i',
    (code, variant, expectedStatus, expectedMessage) => {
      expect(
        mapper.mapError(
          new Error(`HostError: Error(Contract, #${code}) ${variant}`),
        ),
      ).toMatchObject({
        statusCode: expectedStatus,
        message: expectedMessage,
        details: {
          error_name: variant,
          error_type: 'contract_error',
        },
      });
    },
  );

  it('falls back to numeric regex for #23 even when the variant name is absent', () => {
    // Simulate a Soroban RPC that surfaces only the numeric token,
    // no Rust variant name — second loop of mapContractErrorMessage
    // catches it via `#N(?!\\d)`.
    expect(
      mapper.mapError(new Error('HostError: Error(Contract, #23)')),
    ).toMatchObject({
      statusCode: 413,
      message: 'Allowed-tokens list exceeds maximum length',
      details: {
        error_code: 23,
        error_type: 'contract_error',
      },
    });
  });
});
