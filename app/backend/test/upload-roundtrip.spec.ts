import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../src/common/encryption/encryption.service';
import * as fc from 'fast-check';
import * as crypto from 'crypto';

describe('AES Envelope Round-Trip (Property-Based Test)', () => {
  let encryptionService: EncryptionService;

  beforeAll(() => {
    const configService = new ConfigService({
      ENCRYPTION_MASTER_KEY: 'test-master-key-value-suitable-for-testing-12345',
    });
    encryptionService = new EncryptionService(configService);
  });

  it('should preserve checksum equality and correctly decrypt buffers across all evidence sizes (1 KB to 100 MB)', () => {
    // We generate a float/double between 0 and 1 using fast-check.
    // We map this value to a piecewise log-uniform distribution to bias the sizes towards smaller values (e.g. 90% < 1 MB)
    // while still ensuring that large values up to 100 MB are covered.
    // This allows us to run 1000 iterations in CI in just a few seconds.
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true, noInfinity: true }),
        (d) => {
          let size: number;
          if (d < 0.1) {
            // 10% of tests are large (1 MB to 100 MB)
            const logMin = Math.log(1024 * 1024);
            const logMax = Math.log(100 * 1024 * 1024);
            const logVal = (d / 0.1) * (logMax - logMin) + logMin;
            size = Math.floor(Math.exp(logVal));
          } else {
            // 90% of tests are small to medium (1 KB to 1 MB)
            const logMin = Math.log(1024);
            const logMax = Math.log(1024 * 1024);
            const logVal = ((d - 0.1) / 0.9) * (logMax - logMin) + logMin;
            size = Math.floor(Math.exp(logVal));
          }

          // Construct original buffer of generated size.
          // To make this extremely fast and avoid entropy bottlenecks,
          // we generate a small random chunk (up to 4KB) and copy it repeatedly.
          const patternSize = Math.min(size, 4096);
          const pattern = crypto.randomBytes(patternSize);
          const originalBuffer = Buffer.alloc(size);

          let offset = 0;
          while (offset < size) {
            const bytesToWrite = Math.min(patternSize, size - offset);
            pattern.copy(originalBuffer, offset, 0, bytesToWrite);
            offset += bytesToWrite;
          }

          const originalChecksum = crypto
            .createHash('sha256')
            .update(originalBuffer)
            .digest('hex');

          // Encrypt and decrypt buffer (AES envelope round-trip)
          const encrypted = encryptionService.encryptBuffer(originalBuffer);
          const decrypted = encryptionService.decryptBuffer(encrypted);

          const decryptedChecksum = crypto
            .createHash('sha256')
            .update(decrypted)
            .digest('hex');

          expect(decryptedChecksum).toBe(originalChecksum);
          expect(decrypted.equals(originalBuffer)).toBe(true);
        }
      ),
      { numRuns: 1000 }
    );
  }, 35000); // 35 second timeout to be safe, though it should complete in under 5 seconds
});
