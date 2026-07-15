import { IsString, IsInt, IsIn } from 'class-validator';
import { ALLOWED_MIME_TYPES } from './file-validation';

export class InitiatePresignedUploadDto {
  @IsString()
  fileName: string;

  @IsIn(ALLOWED_MIME_TYPES as unknown as string[])
  mimeType: string;

  @IsInt()
  totalSize: number;
}

export class CompletePresignedUploadDto {
  @IsString()
  fileHash: string;
}
