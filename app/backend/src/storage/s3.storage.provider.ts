import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageProvider } from './storage.provider';

@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private s3Client: S3Client;
  private bucket: string;

  constructor(@Optional() private readonly configService: ConfigService) {
    const region = configService?.get<string>(
      'EVIDENCE_STORAGE_REGION',
      'us-east-1',
    ) || 'us-east-1';
    const endpoint = configService?.get<string>('EVIDENCE_STORAGE_ENDPOINT');
    const accessKeyId = configService?.get<string>(
      'EVIDENCE_STORAGE_ACCESS_KEY_ID',
    );
    const secretAccessKey = configService?.get<string>(
      'EVIDENCE_STORAGE_SECRET_ACCESS_KEY',
    );
    const bucket = configService?.get<string>('EVIDENCE_STORAGE_BUCKET');

    if (!bucket) {
      throw new Error('Storage provider not initialized: EVIDENCE_STORAGE_BUCKET is not set');
    }

    this.bucket = bucket;
    this.s3Client = new S3Client({
      region,
      endpoint,
      credentials:
        accessKeyId && secretAccessKey
          ? {
              accessKeyId,
              secretAccessKey,
            }
          : undefined,
      forcePathStyle: configService?.get<boolean>(
        'EVIDENCE_STORAGE_FORCE_PATH_STYLE',
        false,
      ) ?? false,
    });

    this.logger.log('S3 Storage Provider initialized');
  }

  async signPresignedUrl(
    key: string,
    options?: { contentType?: string; expiresIn?: number },
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options?.contentType,
    });

    const expiresIn = options?.expiresIn || 3600; // 1 hour default

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async signPresignedDownloadUrl(
    key: string,
    options?: { expiresIn?: number },
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const expiresIn = options?.expiresIn || 3600; // 1 hour default

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async fileExists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      await this.s3Client.send(command);
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'NotFound') {
        return false;
      }
      throw err;
    }
  }

  async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.s3Client.send(command);
  }
}
