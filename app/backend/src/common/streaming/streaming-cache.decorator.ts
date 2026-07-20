import { SetMetadata } from '@nestjs/common';

export const HTTP_STREAMING_CACHE = 'http_cache:streaming';

/**
 * Opt in to deferred ETag computation for large JSON GET / HEAD responses.
 *
 * The cache interceptor emits `ETag: W/"pending"` immediately and schedules
 * canonical hashing after the response path has yielded.
 */
export const UseStreamingCache = (): MethodDecorator & ClassDecorator =>
  SetMetadata(HTTP_STREAMING_CACHE, true);
