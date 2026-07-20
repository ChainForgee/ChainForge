import { Controller, Post, Body, Version } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { LoggerService } from '../../logger/logger.service';
import { API_VERSIONS } from '../constants/api-version.constants';

@ApiTags('CSP')
@Controller('csp-report')
export class CspReportController {
  constructor(private readonly loggerService: LoggerService) {}

  @Public()
  @Post()
  @Version(API_VERSIONS.V1)
  @ApiOperation({
    summary: 'Receive CSP violation reports',
    description: 'Endpoint to receive and log Content Security Policy violations.',
  })
  handleCspReport(@Body() report: any) {
    this.loggerService.warn(
      'CSP violation reported',
      'CspReportController',
      { cspReport: report },
    );

    return { status: 'ok' };
  }
}
