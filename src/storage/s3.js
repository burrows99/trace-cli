// Object-storage tier. Vendor-neutral on the S3 API (via the official AWS SDK), so it points at real
// AWS S3 in production and a local S3-compatible mock (the `mock-aws` container in docker-compose) in dev —
// the code never changes, only `S3_ENDPOINT`. Used to store trace artifacts (the Chrome debug-replay video)
// and hand back a durable link that rides along in the envelope instead of a local file path.
//
// Config (env): S3_ENDPOINT (presence enables uploads; e.g. http://localhost:9000) · AWS_ACCESS_KEY_ID ·
// AWS_SECRET_ACCESS_KEY · AWS_REGION (default us-east-1) · S3_BUCKET (default "traces") · S3_PUBLIC_URL
// (public base for links; default = endpoint).

import { createReadStream, statSync } from "node:fs";

function cfg() {
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

// s3Configured() → whether uploads are possible (an endpoint is set). doctor reports this.
export const s3Configured = () => !!(process.env.S3_ENDPOINT || process.env.AWS_S3_ENDPOINT);

const publicReadPolicy = (bucket) => JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: "*", Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${bucket}/*`] }],
});

// uploadFile(filePath, key, contentType) → { url, bucket, key, bytes } or null if S3 isn't configured or
// the upload fails (caller falls back to the local path — recording is never fatal to a trace).
export async function uploadFile(filePath, key, contentType = "application/octet-stream") {
  const c = cfg();
  if (!c) return null;
  try {
    const { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand, PutObjectCommand } =
      await import("@aws-sdk/client-s3");
    const s3 = new S3Client({
      endpoint: c.endpoint, region: c.region, forcePathStyle: true,   // path-style for S3-compatible mocks
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: c.bucket }));
    } catch {
      try { await s3.send(new CreateBucketCommand({ Bucket: c.bucket })); } catch {}
      try { await s3.send(new PutBucketPolicyCommand({ Bucket: c.bucket, Policy: publicReadPolicy(c.bucket) })); } catch {}
    }
    const bytes = statSync(filePath).size;
    await s3.send(new PutObjectCommand({
      Bucket: c.bucket, Key: key, Body: createReadStream(filePath), ContentLength: bytes, ContentType: contentType,
    }));
    return { url: `${c.publicBase}/${c.bucket}/${key}`, bucket: c.bucket, key, bytes };
  } catch (e) {
    process.stderr.write(`[trace] s3 upload failed: ${e.message}\n`);
    return null;
  }
}
