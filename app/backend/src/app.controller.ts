import { Controller, Get, Version } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { AppService } from './app.service';
import { API_VERSIONS } from './common/constants/api-version.constants';
import { Public } from './common/decorators/public.decorator';
import { Deprecated } from './common/decorators/deprecated.decorator';

interface VersionInfo {
  latestVersion: string;
  minRequiredVersion: string;
  releaseNotes: string[];
  storeUrl: { ios: string; android: string };
}

const MOCK_VERSION_INFO: VersionInfo = {
  latestVersion: '1.1.0',
  minRequiredVersion: '1.0.0',
  releaseNotes: [
    'Added support for on-chain verification',
    'Improved sync reliability in low-bandwidth areas',
    'Fixed a bug in QR code scanning for legacy NGO cards',
    'Reduced app bundle size by 15%',
  ],
  storeUrl: {
    ios: 'https://apps.apple.com/app/chainforge',
    android: 'https://play.google.com/store/apps/details?id=com.chainforge.mobile',
  },
};

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Version(API_VERSIONS.V1)
  @ApiOperation({
    summary: 'Root endpoint (v1)',
    description:
      'Returns a welcome message and API information. Part of v1 API.',
  })
  @ApiOkResponse({
    description: 'Welcome message returned successfully.',
    schema: {
      example: {
        message: 'Welcome to ChainForge API',
        version: 'v1',
        docs: '/api/docs',
      },
    },
  })
  getHello() {
    return this.appService.getHello();
  }

  @Public()
  @Get('health')
  @ApiOperation({
    summary: 'Simple health check',
    description:
      'Basic endpoint to verify the service is running and reach the backend.',
  })
  @ApiOkResponse({ description: 'Service is available.' })
  health() {
    return { status: 'ok', service: 'backend' };
  }

  @Public()
  @Get('mobile/version')
  @ApiOperation({
    summary: 'Get mobile app version information',
    description:
      'Returns version info including latest version, minimum required, and release notes.',
  })
  @ApiOkResponse({ description: 'Version information returned successfully.' })
  getMobileVersion(): VersionInfo {
    return MOCK_VERSION_INFO;
  }

  @Public()
  @Get('deprecated-test')
  @Deprecated({
    deprecatedSince: '2025-01-01',
    sunsetDate: '2025-12-31',
    reason: 'This endpoint is for testing deprecation headers.',
    alternative: '/api/v1/health',
    migrationGuide: 'https://docs.chainforge.app/migration',
  })
  deprecatedTest() {
    return { message: 'This endpoint is deprecated' };
  }
}
