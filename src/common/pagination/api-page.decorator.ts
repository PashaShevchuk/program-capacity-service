import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

import { CursorPageDto } from './cursor-pagination.dto';
import { PageDto } from './pagination.dto';

/** Documents a cursor-paged response with the real item schema. */
export function ApiCursorPage<T extends Type<unknown>>(item: T) {
  return applyDecorators(
    ApiExtraModels(CursorPageDto, item),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(CursorPageDto) },
          { properties: { items: { type: 'array', items: { $ref: getSchemaPath(item) } } } },
        ],
      },
    }),
  );
}

/** Documents an offset-paged response with the real item schema. */
export function ApiOffsetPage<T extends Type<unknown>>(item: T) {
  return applyDecorators(
    ApiExtraModels(PageDto, item),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(PageDto) },
          { properties: { items: { type: 'array', items: { $ref: getSchemaPath(item) } } } },
        ],
      },
    }),
  );
}
