import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class TokenRequestDto {
  @ApiProperty({
    enum: ['client_credentials', 'refresh_token'],
    description:
      'OAuth grant type. This backend has no password login flow, so JWT issuance is based on existing API-key client credentials.',
  })
  @IsIn(['client_credentials', 'refresh_token'])
  grant_type!: 'client_credentials' | 'refresh_token';

  @ApiPropertyOptional({
    description:
      'Optional client identifier. API-key records are validated by client_secret.',
  })
  @IsOptional()
  @IsString()
  client_id?: string;

  @ApiPropertyOptional({
    description: 'Existing ChainForge API key used as the OAuth client secret.',
  })
  @IsOptional()
  @IsString()
  client_secret?: string;

  @ApiPropertyOptional({
    description: 'Refresh token, required when grant_type=refresh_token.',
  })
  @IsOptional()
  @IsString()
  refresh_token?: string;
}

export class TokenIntrospectionDto {
  @ApiProperty({ description: 'JWT access or refresh token to introspect.' })
  @IsString()
  token!: string;
}

export class TokenRevocationDto {
  @ApiProperty({ description: 'JWT access or refresh token to revoke.' })
  @IsString()
  token!: string;
}
