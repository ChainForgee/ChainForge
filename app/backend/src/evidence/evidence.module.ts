import { Module } from '@nestjs/common';
import { EvidenceService } from './evidence.service';
import { EvidenceController } from './evidence.controller';
import { UploadSessionService } from './upload-session.service';
import { UploadSessionController } from './upload-session.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../common/encryption/encryption.module';
import { AuditModule } from '../audit/audit.module';
import { FingerprintService } from './fingerprint.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [PrismaModule, EncryptionModule, AuditModule, StorageModule],
  controllers: [EvidenceController, UploadSessionController],
  providers: [EvidenceService, FingerprintService, UploadSessionService],
  exports: [FingerprintService],
})
export class EvidenceModule {}
