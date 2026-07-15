import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { S3StorageProvider } from './s3.storage.provider';
import { StorageProvider, STORAGE_PROVIDER } from './storage.provider';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useClass: S3StorageProvider,
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
