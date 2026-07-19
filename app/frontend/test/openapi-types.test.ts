import createClient from 'openapi-fetch';
import type { paths } from '../src/lib/generated/api';

describe('OpenAPI Generated Client Types', () => {
  it('should compile with the generated paths interface', () => {
    // This is purely a type-level test to ensure openapi-fetch 
    // and the generated openapi-typescript types are compatible.
    const client = createClient<paths>({ baseUrl: 'http://localhost' });

    // Assert the client is created and has the expected HTTP methods
    expect(client).toBeDefined();
    expect(typeof client.GET).toBe('function');
    expect(typeof client.POST).toBe('function');
    expect(typeof client.PUT).toBe('function');
    expect(typeof client.DELETE).toBe('function');
    expect(typeof client.PATCH).toBe('function');
  });
});
