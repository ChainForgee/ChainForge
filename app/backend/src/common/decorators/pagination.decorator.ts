import {
  SetMetadata,
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  Type,
} from '@nestjs/common';
import {
  ApiQuery,
  ApiProperty,
  ApiPropertyOptional,
  ApiOkResponse,
  getSchemaPath,
  ApiExtraModels,
} from '@nestjs/swagger';

export const PAGINATION_DEFAULTS_KEY = 'pagination_defaults';

export interface PaginationDefaultsOptions {
  default?: number;
  max?: number;
}

export interface PaginationParams {
  limit: number;
  cursor?: string;
}

export class PaginatedResult<T> {
  @ApiProperty({ type: [Object], description: 'The array of records for the current page.' })
  data!: T[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Cursor to retrieve the next page of results, or null if there is no next page.',
  })
  nextCursor?: string | null;
}

/**
 * Decorator to set route-specific pagination defaults and max caps.
 * It also adds OpenAPI query parameters to Swagger.
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
      description: `Number of items to return (default: ${defaultLimit}, max: ${maxLimit})`,
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
 * Parameter decorator to inject parsed pagination options (limit, cursor).
 */
export const Pagination = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): PaginationParams => {
    const request = ctx.switchToHttp().getRequest();
    return request.pagination || { limit: 25 };
  },
);

/**
 * Helper to dynamically generate the paginated Swagger response definition.
 */
export const ApiPaginatedResponse = <TModel extends Type<any>>(model: TModel) => {
  return applyDecorators(
    ApiExtraModels(PaginatedResult, model),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(PaginatedResult) },
          {
            properties: {
              data: {
                type: 'array',
                items: { $ref: getSchemaPath(model) },
              },
            },
          },
        ],
      },
    }),
  );
};
