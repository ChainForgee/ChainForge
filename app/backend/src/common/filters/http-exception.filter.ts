import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ValidationError } from 'class-validator';
import { LoggerService } from '../../logger/logger.service';
import { ErrorCode } from '../errors/codes';

export interface ErrorResponse {
  code: number;
  message: string;
  details?: any;
  traceId?: string;
  timestamp: string;
  path: string;
  /**
   * Cross-service taxonomy identifier (Issue #249).  Same identifier is
   * emitted by the AI service's `ErrorEnvelope.code` so callers can
   * match errors across stacks.  See `src/common/errors/codes.ts` for
   * the canonical list and `docs/errors.yaml` for the source of truth.
   */
  errorCode?: ErrorCode;
}

@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: any, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const traceId = request.headers['x-request-id'] as string | undefined;

    // Log the error
    this.logger.error(
      `Trace ID: ${traceId ?? 'N/A'} | ${exception.constructor?.name ?? 'UnknownError'} | Status: ${
        exception.status || HttpStatus.INTERNAL_SERVER_ERROR
      } | Message: ${exception.message} | Path: ${request.url}`,
      exception.stack,
      'AllExceptionsFilter',
    );

    let errorResponse: ErrorResponse;

    if (exception instanceof HttpException) {
      errorResponse = this.handleHttpException(exception, request, traceId);
    } else if (this.isPrismaError(exception)) {
      errorResponse = this.handlePrismaError(exception, request, traceId);
    } else if (
      Array.isArray(exception) &&
      exception.some(e => e instanceof ValidationError)
    ) {
      errorResponse = this.handleValidationErrors(exception, request, traceId);
    } else {
      errorResponse = this.handleGenericError(exception, request, traceId);
    }

    response.status(errorResponse.code).json(errorResponse);
  }

  private handleHttpException(
    exception: HttpException,
    request: Request,
    traceId?: string,
  ): ErrorResponse {
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as any).message || exception.message;

    return {
      code: status,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      details:
        typeof exceptionResponse === 'object' ? exceptionResponse : undefined,
      errorCode: statusToErrorCode(status),
      traceId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };
  }

  private isPrismaError(exception: any): boolean {
    return (
      exception?.constructor?.name?.includes('Prisma') ||
      exception?.clientVersion ||
      exception?.meta?.target
    );
  }

  private handlePrismaError(
    exception: any,
    request: Request,
    traceId?: string,
  ): ErrorResponse {
    let code = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Database error occurred';
    let details: any = null;
    // Cross-service taxonomy code (Issue #249). Defaulted below per branch.
    let errorCode: ErrorCode = ErrorCode.INTERNAL_SERVER_ERROR;

    // Map common Prisma errors
    if (exception.code === 'P2002') {
      // Unique constraint failed
      code = HttpStatus.CONFLICT;
      message = 'Unique constraint violation';
      errorCode = ErrorCode.CONFLICT;
      details = {
        target: exception.meta?.target,
        field: Array.isArray(exception.meta?.target)
          ? exception.meta.target.join(', ')
          : exception.meta?.target,
      };
    } else if (exception.code === 'P2025') {
      // Record not found
      code = HttpStatus.NOT_FOUND;
      message = 'Record not found';
      errorCode = ErrorCode.NOT_FOUND;
      details = {
        cause: exception.meta?.cause,
      };
    } else if (exception.code === 'P2003') {
      // Foreign key constraint failed
      code = HttpStatus.BAD_REQUEST;
      message = 'Foreign key constraint violation';
      errorCode = ErrorCode.BAD_REQUEST;
      details = {
        field_name: exception.meta?.field_name,
      };
    } else if (exception.code === 'P2000') {
      // Value too long for column
      code = HttpStatus.BAD_REQUEST;
      message = 'Value too long for column';
      errorCode = ErrorCode.BAD_REQUEST;
      details = {
        column_name: exception.meta?.column_name,
      };
    } else {
      details = {
        code: exception.code,
        meta: exception.meta,
      };
    }

    return {
      code,
      message,
      details,
      errorCode,
      traceId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };
  }

  private handleValidationErrors(
    exceptions: ValidationError[],
    request: Request,
    traceId?: string,
  ): ErrorResponse {
    const validationErrors = exceptions.map(error => ({
      property: error.property,
      value: error.value,
      constraints: error.constraints,
      children: error.children?.length
        ? this.formatChildren(error.children)
        : undefined,
    }));

    return {
      code: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'Validation failed',
      details: {
        errors: validationErrors,
      },
      errorCode: ErrorCode.VALIDATION_ERROR,
      traceId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };
  }

  private formatChildren(children: ValidationError[]): any[] {
    return children.map(child => ({
      property: child.property,
      value: child.value,
      constraints: child.constraints,
      children: child.children?.length
        ? this.formatChildren(child.children)
        : undefined,
    }));
  }

  private handleGenericError(
    exception: any,
    request: Request,
    traceId?: string,
  ): ErrorResponse {
    return {
      code: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception.message || 'Internal server error',
      details: {
        error_type: exception.constructor?.name,
        ...(typeof process !== 'undefined' &&
          process.env.NODE_ENV === 'development' && {
            stack: exception.stack,
          }),
      },
      errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
      traceId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };
  }
}

/**
 * Maps an HTTP status code to a shared `ErrorCode` for the new
 * cross-service taxonomy (Issue #249).  Stable mapping; never invents
 * a new identifier at runtime.
 */
function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.BAD_REQUEST;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 408:
      return ErrorCode.UPSTREAM_TIMEOUT;
    case 409:
      return ErrorCode.CONFLICT;
    case 413:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case 422:
      return ErrorCode.VALIDATION_ERROR;
    case 429:
      return ErrorCode.RATE_LIMIT_EXCEEDED;
    case 500:
      return ErrorCode.INTERNAL_SERVER_ERROR;
    case 501:
      return ErrorCode.UPSTREAM_ERROR;
    case 502:
      return ErrorCode.UPSTREAM_ERROR;
    case 503:
      return ErrorCode.UPSTREAM_UNAVAILABLE;
    case 504:
      return ErrorCode.UPSTREAM_TIMEOUT;
    default:
      if (status >= 400 && status < 500) {
        return ErrorCode.BAD_REQUEST;
      }
      if (status >= 500 && status < 600) {
        return ErrorCode.UPSTREAM_ERROR;
      }
      return ErrorCode.INTERNAL_SERVER_ERROR;
  }
}
