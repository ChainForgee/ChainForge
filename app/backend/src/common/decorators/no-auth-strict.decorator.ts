import { SetMetadata } from '@nestjs/common';

export const NO_AUTH_STRICT_KEY = 'noAuthStrict';
export const NoAuthStrict = () => SetMetadata(NO_AUTH_STRICT_KEY, true);
