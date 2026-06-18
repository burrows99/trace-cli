import { createReadStream, statSync } from "node:fs";
import type { ArtifactStore, UploadedArtifact } from "./ArtifactStore.js";
import { logger } from "../shared/logger.js";

const log = logger.child({ component: "s3" });

interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBase: string;
}

const publicReadPolicy = (bucket: string): string => JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: "*", Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${bucket}/*`] }],
});

/**
 * S3ArtifactStore — an ArtifactStore backed by the S3 API (AWS SDK). Vendor-neutral: points at real AWS S3
 * in production and the local `mock-aws` container in dev via `S3_ENDPOINT` — same code. Returns null when
 * S3 isn't configured (the caller falls back to a local path; a recording is never fatal to a trace).
 */
export class S3ArtifactStore implements ArtifactStore {
  #config(): S3Config | null {
    const endpoint = process.env.S3_ENDPOINT || process.env.AWS_S3_ENDPOINT;
    if (!endpoint) return null;
    return {
      endpoint,
      region: process.env.AWS_REGION || "us-east-1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "minioadmin",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "minioadmin",
      bucket: process.env.S3_BUCKET || "traces",
      publicBase: (process.env.S3_PUBLIC_URL || endpoint).replace(/\/+$/, ""),
    };
  }

  isConfigured(): boolean { return !!(process.env.S3_ENDPOINT || process.env.AWS_S3_ENDPOINT); }

  async upload(filePath: string, key: string, contentType = "application/octet-stream"): Promise<UploadedArtifact | null> {
    const c = this.#config();
    if (!c) return null;
    try {
      const { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand, PutObjectCommand } =
        await import("@aws-sdk/client-s3");
      const s3 = new S3Client({
        endpoint: c.endpoint, region: c.region, forcePathStyle: true,
        credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
      });
      try {
        await s3.send(new HeadBucketCommand({ Bucket: c.bucket }));
      } catch {
        try { await s3.send(new CreateBucketCommand({ Bucket: c.bucket })); } catch { /* exists/race */ }
        try { await s3.send(new PutBucketPolicyCommand({ Bucket: c.bucket, Policy: publicReadPolicy(c.bucket) })); } catch { /* policy denied */ }
      }
      const bytes = statSync(filePath).size;
      await s3.send(new PutObjectCommand({
        Bucket: c.bucket, Key: key, Body: createReadStream(filePath), ContentLength: bytes, ContentType: contentType,
      }));
      log.info("uploaded artifact", { bucket: c.bucket, key, bytes });
      return { url: `${c.publicBase}/${c.bucket}/${key}`, bucket: c.bucket, key, bytes };
    } catch (e: any) {
      log.error("upload failed", { key, err: e });
      return null;
    }
  }
}
