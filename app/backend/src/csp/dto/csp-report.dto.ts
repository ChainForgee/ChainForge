import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNumber,
  ValidateNested,
  IsNotEmptyObject,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Inner CSP violation report as sent by browsers.
 * @see https://www.w3.org/TR/CSP3/#violation-reports
 */
export class CspViolationDetails {
  @ApiPropertyOptional({
    description: 'The URI of the document where the violation occurred',
    example: 'https://example.com/page',
  })
  @IsOptional()
  @IsString()
  'document-uri'?: string;

  @ApiPropertyOptional({
    description: 'The referrer of the document where the violation occurred',
    example: 'https://example.com/',
  })
  @IsOptional()
  @IsString()
  referrer?: string;

  @ApiPropertyOptional({
    description: 'The directive that was violated',
    example: 'script-src',
  })
  @IsOptional()
  @IsString()
  'violated-directive'?: string;

  @ApiPropertyOptional({
    description: 'The effective directive that was violated',
    example: 'script-src',
  })
  @IsOptional()
  @IsString()
  'effective-directive'?: string;

  @ApiPropertyOptional({
    description: 'The original policy as specified in the CSP header',
    example: "default-src 'self'; script-src 'self'",
  })
  @IsOptional()
  @IsString()
  'original-policy'?: string;

  @ApiPropertyOptional({
    description: 'The disposition of the policy (enforce or report)',
    example: 'enforce',
  })
  @IsOptional()
  @IsString()
  disposition?: string;

  @ApiPropertyOptional({
    description: 'The URI of the resource that was blocked',
    example: 'https://evil.com/script.js',
  })
  @IsOptional()
  @IsString()
  'blocked-uri'?: string;

  @ApiPropertyOptional({
    description: 'The line number in the source file where the violation occurred',
    example: 42,
  })
  @IsOptional()
  @IsNumber()
  'line-number'?: number;

  @ApiPropertyOptional({
    description: 'The column number in the source file where the violation occurred',
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  'column-number'?: number;

  @ApiPropertyOptional({
    description: 'The URI of the source file where the violation occurred',
    example: 'https://example.com/app.js',
  })
  @IsOptional()
  @IsString()
  'source-file'?: string;

  @ApiPropertyOptional({
    description: 'The HTTP status code of the document',
    example: 200,
  })
  @IsOptional()
  @IsNumber()
  'status-code'?: number;

  @ApiPropertyOptional({
    description: 'Sample of the inline script/style that caused the violation',
    example: 'alert(1)',
  })
  @IsOptional()
  @IsString()
  'script-sample'?: string;
}

/**
 * Top-level CSP report payload as sent by browsers.
 * Browsers wrap the violation details in a "csp-report" object.
 */
export class CspReportDto {
  @ApiProperty({
    description: 'The CSP violation report details',
    type: CspViolationDetails,
  })
  @ValidateNested()
  @Type(() => CspViolationDetails)
  @IsNotEmptyObject()
  'csp-report'!: CspViolationDetails;
}
