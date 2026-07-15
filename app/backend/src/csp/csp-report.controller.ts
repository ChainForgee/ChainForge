import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Version,
  UsePipes,
  ValidationPipe,
  PayloadTooLargeException,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiNoContentResponse,
  ApiPayloadTooLargeResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CspReportService } from './csp-report.service';
import { CspReportDto } from './dto/csp-report.dto';

const MAX_BODY_SIZE_BYTES = 8 * 1024; // 8 KiB

@ApiTags('Security (Internal)')
@Controller('csp-report')
export class CspReportController {
  constructor(private readonly cspReportService: CspReportService) {}

  @Post()
  @Version('1')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false, // Allow extra browser-specific fields
      transform: true,
    }),
  )
  @ApiOperation({
    summary: 'Receive CSP violation reports',
    description:
      'Internal endpoint for browsers to report Content Security Policy violations. ' +
      'Reports are deduplicated by (sourceFile, lineNumber, blockedUri) and counted ' +
      'in Prometheus metrics. Request body is limited to 8 KiB.',
  })
  @ApiNoContentResponse({
    description: 'Report received and processed (or deduplicated)',
  })
  @ApiPayloadTooLargeResponse({
    description: 'Request body exceeds 8 KiB limit',
  })
  @ApiBadRequestResponse({
    description: 'Invalid CSP report format',
  })
  async receiveReport(
    @Req() req: Request,
    @Body() report: CspReportDto,
  ): Promise<void> {
    // Check content-length header for early rejection
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_BODY_SIZE_BYTES) {
      throw new PayloadTooLargeException(
        `Request body exceeds ${MAX_BODY_SIZE_BYTES} bytes limit`,
      );
    }

    await this.cspReportService.processReport(report['csp-report']);
  }
}
