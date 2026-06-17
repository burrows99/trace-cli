/** An uploaded artifact's durable location. */
export interface UploadedArtifact {
  url: string;
  bucket: string;
  key: string;
  bytes: number;
}

/**
 * ArtifactStore — abstraction for where trace artifacts (the Chrome debug-replay video) live. The CLI
 * depends on this interface (DIP), so swapping the local S3 mock for real AWS — or for GCS/Azure later — is
 * a new implementation, not a CLI change.
 */
export interface ArtifactStore {
  isConfigured(): boolean;
  upload(filePath: string, key: string, contentType?: string): Promise<UploadedArtifact | null>;
}
