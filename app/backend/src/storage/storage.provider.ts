export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

export interface StorageProvider {
  /**
   * Sign a presigned URL for uploading a file
   */
  signPresignedUrl(key: string, options?: { contentType?: string; expiresIn?: number }): Promise<string>;
  
  /**
   * Sign a presigned URL for downloading a file
   */
  signPresignedDownloadUrl(key: string, options?: { expiresIn?: number }): Promise<string>;
  
  /**
   * Check if a file exists at the given key
   */
  fileExists(key: string): Promise<boolean>;
  
  /**
   * Delete a file at the given key
   */
  deleteFile(key: string): Promise<void>;
}
