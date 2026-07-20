import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import {
  Pagination,
  PaginationDefaults,
  PaginationParams,
  ApiPaginatedResponse,
} from 'src/common/decorators/pagination.decorator';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ClaimsService } from './claims.service';
import { CancelAndReissueService } from './cancel-and-reissue.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { CancelClaimDto } from './dto/cancel-claim.dto';
import { ReissueClaimDto } from './dto/reissue-claim.dto';
import { Roles } from 'src/auth/roles.decorator';
import { AppRole } from 'src/auth/app-role.enum';
import { InternalNotesService } from 'src/common/services/internal-notes.service';
import { CreateInternalNoteDto } from 'src/common/dto/create-internal-note.dto';
import { InternalNoteResponseDto } from 'src/common/dto/internal-note-response.dto';
import { ApiResponseDto } from '../common/dto/api-response.dto';
import { HttpCacheTtl } from 'src/common/decorators/http-cache.decorator';

@ApiTags('Onchain Proxy')
@ApiBearerAuth('JWT-auth')
@Controller('claims')
export class ClaimLifecycleController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly cancelAndReissueService: CancelAndReissueService,
    private readonly internalNotesService: InternalNotesService,
  ) {}

  @Post()
  @ApiOperation({
    operationId: 'ClaimsController_create_v1',
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
    const result = await this.claimsService.create(createClaimDto);
    return ApiResponseDto.ok(result, 'Claim created successfully');
  }

  @HttpCacheTtl(30) // Response cached for 30 seconds
  @Get()
  @PaginationDefaults({ default: 25, max: 100 })
  @ApiOperation({
    operationId: 'ClaimsController_findAll_v1',
    summary: 'List all claims',
    description: 'Retrieves a list of all claims across all campaigns.',
  })
  @ApiPaginatedResponse(CreateClaimDto)
  async findAll(@Pagination() pagination: PaginationParams) {
    const result = await this.claimsService.findAll(pagination);
    return ApiResponseDto.ok(result, 'Claims fetched successfully');
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'ClaimsController_findOne_v1',
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
    const result = await this.claimsService.findOne(id);
    return ApiResponseDto.ok(result, 'Claim details retrieved successfully');
  }

  @Post(':id/verify')
  @Roles(AppRole.operator, AppRole.admin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'ClaimsController_verify_v1',
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
    const result = await this.claimsService.verify(id);
    return ApiResponseDto.ok(result, 'Claim verified successfully');
  }

  @Post(':id/approve')
  @Roles(AppRole.admin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'ClaimsController_approve_v1',
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
    const result = await this.claimsService.approve(id);
    return ApiResponseDto.ok(result, 'Claim approved successfully');
  }

  @Post(':id/disburse')
  @Roles(AppRole.admin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'ClaimsController_disburse_v1',
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
    const result = await this.claimsService.disburse(id);
    return ApiResponseDto.ok(result, 'Claim disbursed successfully');
  }

  @Patch(':id/archive')
  @ApiOperation({
    operationId: 'ClaimsController_archive_v1',
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
    const result = await this.claimsService.archive(id);
    return ApiResponseDto.ok(result, 'Claim archived successfully');
  }

  @Post(':id/notes')
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    operationId: 'ClaimsController_addNote_v1',
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
    const result = await this.internalNotesService.createNote('claim', id, authorId, dto);
    return ApiResponseDto.ok(result, 'Note added successfully');
  }

  @Get(':id/notes')
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    operationId: 'ClaimsController_getNotes_v1',
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
    const result = await this.internalNotesService.findNotesByEntity('claim', id);
    return ApiResponseDto.ok(result, 'Notes retrieved successfully');
  }

  @Post(':id/cancel')
  @Roles(AppRole.operator, AppRole.admin)
  @ApiOperation({
    operationId: 'ClaimsController_cancel_v1',
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
    operationId: 'ClaimsController_reissue_v1',
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
    operationId: 'ClaimsController_getReissueHistory_v1',
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
}
