import {
  createParamDecorator,
  ExecutionContext,
  applyDecorators,
  SetMetadata,
  Type,
} from '@nestjs/common';
import { ApiQuery, ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import 'reflect-metadata';
import { ApiResponseDto } from '../dto/api-response.dto';

export interface PaginationParams {
  limit: number;
  cursor?: string;
}

export interface PaginationDefaultsOptions {
  default?: number;
  max?: number;
}

export const PAGINATION_DEFAULTS_KEY = 'pagination_defaults';

/**
 * Decorator to define pagination defaults on a controller class or route handler.
 * It also automatically registers swagger query parameters for limit and cursor.
 */
export function PaginationDefaults(options: PaginationDefaultsOptions = {}) {
  const defaultLimit = options.default ?? 25;
  const maxLimit = options.max ?? 100;
  return applyDecorators(
    SetMetadata(PAGINATION_DEFAULTS_KEY, { default: defaultLimit, max: maxLimit }),
    ApiQuery({
      name: 'limit',
      required: false,
      type: Number,
      description: `Number of records to return (default: ${defaultLimit}, max: ${maxLimit})`,
    }),
    ApiQuery({
      name: 'cursor',
      required: false,
      type: String,
      description: 'Opaque cursor for pagination',
    }),
  );
}

/**
 * Custom parameter decorator to extract pagination parameters from the request query.
 * Caps the limit parameter to the configured maximum value.
 */
export const Pagination = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): PaginationParams => {
    const req = ctx.switchToHttp().getRequest();
    const handler = ctx.getHandler();
    const controllerClass = ctx.getClass();

    // Get pagination defaults from method metadata, class metadata, or fallbacks
    const defaults =
      Reflect.getMetadata(PAGINATION_DEFAULTS_KEY, handler) ||
      Reflect.getMetadata(PAGINATION_DEFAULTS_KEY, controllerClass) ||
      { default: 25, max: 100 };

    let limit = defaults.default;
    if (req.query.limit !== undefined) {
      const parsedLimit = parseInt(req.query.limit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        limit = Math.min(parsedLimit, defaults.max);
      }
    }

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    return { limit, cursor };
  },
);

/**
 * Central PaginatedResult schema for responses.
 */
export class PaginatedResult<T> {
  data!: T[];
  nextCursor?: string;
}

/**
 * Helper to generate OpenAPI Swagger documentation for generic PaginatedResult responses.
 */
export const ApiOkPaginatedResponse = <TModel extends Type<any>>(
  model: TModel,
) => {
  return applyDecorators(
    ApiExtraModels(ApiResponseDto, PaginatedResult, model),
    ApiOkResponse({
      description: 'Successfully retrieved paginated list',
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiResponseDto) },
          {
            properties: {
              data: {
                title: `PaginatedResultOf${model.name}`,
                properties: {
                  data: {
                    type: 'array',
                    items: { $ref: getSchemaPath(model) },
                  },
                  nextCursor: {
                    type: 'string',
                    nullable: true,
                    description: 'Opaque cursor for the next page, or null/undefined if no more pages exist.',
                  },
                },
                required: ['data'],
              },
            },
          },
        ],
      },
    }),
  );
};
