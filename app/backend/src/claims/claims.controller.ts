import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Query,
  Request,
  Res,
  Version,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { Request as ExpressRequest } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ClaimsService } from './claims.service';
import { CancelAndReissueService } from './cancel-and-reissue.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import {
  ClaimReceiptDto,
  ClaimShareResponseDto,
  SendReceiptShareDto,
} from './dto/claim-receipt.dto';
import { CancelClaimDto } from './dto/cancel-claim.dto';
import { ReissueClaimDto } from './dto/reissue-claim.dto';
import { ExportClaimsQueryDto } from './dto/export-claims.dto';
import { Roles } from 'src/auth/roles.decorator';
import { AppRole } from 'src/auth/app-role.enum';
import { InternalNotesService } from 'src/common/services/internal-notes.service';
import { CreateInternalNoteDto } from 'src/common/dto/create-internal-note.dto';
import { InternalNoteResponseDto } from 'src/common/dto/internal-note-response.dto';
import {
  Pagination,
  PaginationDefaults,
  PaginationParams,
  ApiOkPaginatedResponse,
} from '../common/decorators/pagination.decorator';
import { ApiResponseDto } from '../common/dto/api-response.dto';

@ApiTags('Onchain Proxy')
@ApiBearerAuth('JWT-auth')
@PaginationDefaults({ default: 25, max: 100 })
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly cancelAndReissueService: CancelAndReissueService,
    private readonly internalNotesService: InternalNotesService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a claim',
    description: 'Initializes a new claim for a specific campaign.',
  })
  @ApiCreatedResponse({
    description: 'Claim created successfully.',
    type: CreateClaimDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid input parameters.',
  })
  @ApiNotFoundResponse({
    description: 'The specified campaign was not found.',
  })
  async create(@Body() createClaimDto: CreateClaimDto) {
    const claim = await this.claimsService.create(createClaimDto);
    return ApiResponseDto.ok(claim, 'Claim created successfully');
  }

  @Get()
  @ApiOperation({
    summary: 'List all claims',
    description: 'Retrieves a list of all claims across all campaigns.',
  })
  @ApiOkPaginatedResponse(CreateClaimDto)
  async findAll(@Pagination() pagination: PaginationParams) {
    const result = await this.claimsService.findAll(pagination);
    return ApiResponseDto.ok(result, 'Claims fetched successfully');
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get claim details',
    description:
      'Retrieves the current details and status of a specific claim.',
  })
  @ApiOkResponse({
    description: 'Claim details retrieved successfully.',
  })
  @ApiNotFoundResponse({
    description: 'The specified claim was not found.',
  })
  async findOne(@Param('id') id: string) {
    const claim = await this.claimsService.findOne(id);
    return ApiResponseDto.ok(claim, 'Claim fetched successfully');
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    summary: 'Verify a claim',
    description: 'Marks a claim as verified. Requires operator or admin role.',
  })
  @ApiOkResponse({
    description: 'Claim status transitioned to verified successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Invalid status transition.',
  })
  @ApiForbiddenResponse({
    description: 'Access denied - insufficient permissions.',
  })
  @ApiNotFoundResponse({
    description: 'The specified claim was not found.',
  })
  async verify(@Param('id') id: string) {
    const claim = await this.claimsService.verify(id);
    return ApiResponseDto.ok(claim, 'Claim verified successfully');
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(AppRole.admin)
  @ApiOperation({
    summary: 'Approve a claim',
    description: 'Approves a verified claim. Requires admin role.',
  })
  @ApiOkResponse({
    description: 'Claim approved successfully (verified → approved).',
  })
  @ApiBadRequestResponse({
    description: 'Invalid status transition.',
  })
  @ApiForbiddenResponse({
    description: 'Access denied - admin role required.',
  })
  @ApiNotFoundResponse({
    description: 'The specified claim was not found.',
  })
  async approve(@Param('id') id: string) {
    const claim = await this.claimsService.approve(id);
    return ApiResponseDto.ok(claim, 'Claim approved successfully');
  }

  @Post(':id/disburse')
  @HttpCode(HttpStatus.OK)
  @Roles(AppRole.admin)
  @ApiOperation({
    summary: 'Disburse funds for a claim',
    description:
      'Initiates on-chain disbursement for an approved claim. Requires admin role.',
  })
  @ApiOkResponse({
    description: 'On-chain disbursement initiated or completed successfully.',
    content: {
      'application/json': {
        examples: {
          success: {
            summary: 'Successful on-chain disbursement',
            value: {
              id: 'claim_123',
              status: 'disbursed',
              transactionHash: '0x123...abc',
              amount: '100.50',
            },
          },
          pending: {
            summary: 'Disbursement pending on-chain',
            value: {
              id: 'claim_123',
              status: 'disbursing',
              message: 'Check back for final transaction hash.',
            },
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid status transition or account state.',
  })
  @ApiForbiddenResponse({
    description: 'Access denied - admin role required.',
  })
  @ApiNotFoundResponse({
    description: 'The specified claim was not found.',
  })
  async disburse(@Param('id') id: string) {
    const claim = await this.claimsService.disburse(id);
    return ApiResponseDto.ok(claim, 'Claim disbursed successfully');
  }

  @Patch(':id/archive')
  @ApiOperation({
    summary: 'Archive a claim',
    description: 'Soft-archives a claim, hiding it from general listings.',
  })
  @ApiOkResponse({
    description: 'Claim archived successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Invalid status transition.',
  })
  @ApiNotFoundResponse({
    description: 'The specified claim was not found.',
  })
  async archive(@Param('id') id: string) {
    const claim = await this.claimsService.archive(id);
    return ApiResponseDto.ok(claim, 'Claim archived successfully');
  }

  @Get(':id/receipt')
  @ApiOperation({
    summary: 'Get claim receipt',
    description: 'Generates a shareable receipt for the specified claim.',
  })
  @ApiOkResponse({
    description: 'Claim receipt generated successfully.',
    type: ClaimReceiptDto,
  })
  @ApiNotFoundResponse({
    description: 'The specified claim was not found.',
  })
  async getReceipt(@Param('id') id: string): Promise<ApiResponseDto<ClaimReceiptDto>> {
    const receipt = await this.claimsService.getReceipt(id);
    return ApiResponseDto.ok(receipt, 'Claim receipt generated successfully');
  }

  @Post(':id/receipt/share')
  @ApiOperation({
    summary: 'Share claim receipt',
    description:
      'Generates and optionally sends the claim receipt via email or SMS.',
  })
  @ApiOkResponse({
    description: 'Receipt generated and sharing initiated successfully.',
    type: ClaimShareResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid share parameters.',
  })
  @ApiNotFoundResponse({
    description: 'The specified claim was not found.',
  })
  async shareReceipt(
    @Param('id') id: string,
    @Body() shareDto: SendReceiptShareDto,
  ): Promise<ApiResponseDto<ClaimShareResponseDto>> {
    const res = await this.claimsService.shareReceipt(id, shareDto);
    return ApiResponseDto.ok(res, 'Claim receipt share initiated successfully');
  }

  @Post(':id/notes')
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    summary: 'Add an internal note to a claim',
    description: 'Adds a secure internal note for staff review only.',
  })
  @ApiCreatedResponse({
    description: 'Internal note added successfully.',
    type: InternalNoteResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Access denied - staff role required.',
  })
  async addNote(
    @Param('id') id: string,
    @Body() dto: CreateInternalNoteDto,
    @Request() req: ExpressRequest,
  ) {
    const authorId = req.user?.apiKeyId || req.user?.authType || 'system';
    const note = await this.internalNotesService.createNote('claim', id, authorId, dto);
    return ApiResponseDto.ok(note, 'Internal note added successfully');
  }

  @Get(':id/notes')
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    summary: 'List internal notes for a claim',
    description: 'Retrieves all internal notes for a specific claim.',
  })
  @ApiOkResponse({
    description: 'Internal notes retrieved successfully.',
    type: [InternalNoteResponseDto],
  })
  @ApiForbiddenResponse({
    description: 'Access denied - staff role required.',
  })
  async getNotes(@Param('id') id: string) {
    const notes = await this.internalNotesService.findNotesByEntity('claim', id);
    return ApiResponseDto.ok(notes, 'Internal notes retrieved successfully');
  }

  // ---------------------------------------------------------------------------
  // Cancel-and-Reissue
  // ---------------------------------------------------------------------------

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    summary: 'Cancel a claim',
    description:
      'Cancels an active claim (requested / verified / approved). ' +
      'Releases the locked budget back to the campaign and records a full audit trail. ' +
      'Disbursed claims cannot be cancelled.',
  })
  @ApiOkResponse({ description: 'Claim cancelled successfully.' })
  @ApiBadRequestResponse({
    description: 'Claim is already cancelled or in a non-cancellable status.',
  })
  @ApiForbiddenResponse({
    description: 'Access denied - operator role required.',
  })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  async cancel(@Param('id') id: string, @Body() dto: CancelClaimDto) {
    const result = await this.cancelAndReissueService.cancel(id, dto);
    return ApiResponseDto.ok(result, 'Claim cancelled successfully');
  }

  @Post(':id/reissue')
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    summary: 'Cancel and reissue a claim',
    description:
      'Atomically cancels the original claim and creates a replacement. ' +
      'The replacement is linked to the original via `reissuedFromId`, ' +
      'preserving the full audit chain. Locked balances are transferred to ' +
      'the new claim — no double-counting occurs. ' +
      'Returns both the cancelled original and the new replacement.',
  })
  @ApiCreatedResponse({
    description: 'Original claim cancelled and replacement created.',
    schema: {
      properties: {
        original: {
          type: 'object',
          description: 'The cancelled original claim.',
        },
        replacement: {
          type: 'object',
          description: 'The newly created replacement claim.',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Original claim is not in a cancellable status.',
  })
  @ApiForbiddenResponse({
    description: 'Access denied - operator role required.',
  })
  @ApiNotFoundResponse({ description: 'Original claim not found.' })
  async reissue(@Param('id') id: string, @Body() dto: ReissueClaimDto) {
    const result = await this.cancelAndReissueService.reissue(id, dto);
    return ApiResponseDto.ok(result, 'Claim reissued successfully');
  }

  @Get(':id/reissue-history')
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    summary: 'Get reissue chain for a claim',
    description:
      'Returns the full lineage of a claim — the original and every ' +
      'replacement — ordered from oldest to newest. Pass any claim ID in ' +
      'the chain to retrieve the complete history.',
  })
  @ApiOkResponse({
    description: 'Reissue chain retrieved successfully.',
    schema: { type: 'array', items: { type: 'object' } },
  })
  @ApiForbiddenResponse({
    description: 'Access denied - operator role required.',
  })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  async getReissueHistory(@Param('id') id: string) {
    const result = await this.cancelAndReissueService.getReissueHistory(id);
    return ApiResponseDto.ok(result, 'Reissue history retrieved successfully');
  }

  @Get('export')
  @Version('1')
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    summary: 'Export claims as CSV',
    description:
      'Exports claim records as CSV with support for date range, status, organization, token, and pagination filters. ' +
      'Excludes sensitive recipient data (recipientRef is encrypted and not exported).',
  })
  @ApiOkResponse({
    description: 'Claims exported successfully.',
    content: {
      'text/csv': {
        schema: { type: 'string' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid authentication credentials.',
  })
  @ApiForbiddenResponse({
    description: 'Access denied - operator or admin role required.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Start date (ISO string)',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'End date (ISO string)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Claim status filter',
  })
  @ApiQuery({
    name: 'campaignId',
    required: false,
    description: 'Campaign ID filter',
  })
  @ApiQuery({
    name: 'orgId',
    required: false,
    description: 'Organization ID filter',
  })
  @ApiQuery({
    name: 'tokenAddress',
    required: false,
    description: 'Token address filter',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page (default: 50, max: 200)',
  })
  async exportClaims(
    @Query() query: ExportClaimsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.claimsService.exportClaims(query);

    const csv = this.claimsService.buildCsv(result.data);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="claims-export-${Date.now()}.csv"`,
    );
    res.setHeader('X-Total-Count', String(result.total));
    res.setHeader('X-Page', String(result.page));
    res.setHeader('X-Limit', String(result.limit));

    return csv;
  }
}
