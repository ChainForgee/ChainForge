import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ErrorCode } from '../errors/codes';

export class ApiResponseDto<T> {
  @ApiProperty({
    description: 'Indicates if the request was successful.',
    example: true,
  })
  success!: boolean;

  @ApiPropertyOptional({
    description: 'Human-readable message explaining the result.',
    example: 'Request processed successfully.',
  })
  message?: string;

  @ApiPropertyOptional({
    description: 'The response payload data.',
  })
  data?: T;

  @ApiPropertyOptional({
    description: 'Detailed error information for failed requests.',
    example: { code: 'VAL_ERR_001', details: 'Validation failed' },
  })
  error?: unknown;

  /**
   * Cross-stack taxonomy identifier (Issue #249).
   *
   * Optional companion to `error` that mirrors the AI-service
   * `ErrorEnvelope.code` field.  Same string is emitted by the AI
   * service for the same error class so mobile/web clients can branch
   * on a stable identifier regardless of which backend raised it.
   * See `docs/errors.yaml` for the canonical list.
   */
  @ApiPropertyOptional({
    description:
      'Cross-stack taxonomy identifier (mirrors AI-service ErrorEnvelope.code).',
    example: ErrorCode.VALIDATION_ERROR,
  })
  errorCode?: ErrorCode;

  static ok<T>(data: T, message?: string): ApiResponseDto<T> {
    return { success: true, message, data };
  }

  static fail(message: string, error?: unknown): ApiResponseDto<null> {
    return { success: false, message, error, data: null };
  }
}
