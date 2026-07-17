import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  TokenIntrospectionDto,
  TokenRequestDto,
  TokenRevocationDto,
} from './dto';
import { TokenService } from './token.service';

@ApiTags('OAuth')
@Controller('oauth')
export class TokenController {
  constructor(private readonly tokenService: TokenService) {}

  @Public()
  @Post('token')
  @ApiOperation({
    summary: 'Issue or refresh OAuth-compatible JWTs',
    description:
      'Supports client_credentials using an existing ChainForge API key as client_secret, and refresh_token. No password login flow exists in this backend.',
  })
  @ApiBody({ type: TokenRequestDto })
  @ApiOkResponse({ description: 'Token pair issued.' })
  async token(@Body() dto: TokenRequestDto) {
    if (dto.grant_type === 'client_credentials') {
      return this.tokenService.issueForClientCredentials(dto.client_secret);
    }
    return this.tokenService.refresh(dto.refresh_token);
  }

  @Public()
  @UseGuards(JwtAuthGuard)
  @Get('userinfo')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Return claims for the current JWT principal' })
  userinfo(@Req() req: Request) {
    return req.user;
  }

  @Public()
  @Post('introspect')
  @ApiOperation({
    summary: 'Introspect a JWT using RFC 7662 active/inactive shape',
  })
  @ApiBody({ type: TokenIntrospectionDto })
  introspect(@Body() dto: TokenIntrospectionDto) {
    return this.tokenService.introspect(dto.token);
  }

  @Public()
  @Post('revoke')
  @ApiOperation({ summary: 'Revoke a JWT by adding its jti to Redis' })
  @ApiBody({ type: TokenRevocationDto })
  async revoke(@Body() dto: TokenRevocationDto) {
    await this.tokenService.revoke(dto.token);
    return { revoked: true };
  }
}
