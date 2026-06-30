// ── S3 storage service ───────────────────────────────────────────────────────
// Thin wrapper around the AWS SDK v3 for the ProMan app-files bucket. Holds the
// finished report PDFs (and later teleconference recordings) so they can be
// delivered to clients via short-lived presigned URLs instead of streaming
// base64 blobs through the app.
//
// Design contract for the rest of the app:
//   • The DATABASE remains the source of truth (reports are still stored there,
//     so the daily DB backup covers them). S3 is a *regenerable serving copy*.
//   • Nothing here makes objects public — the bucket has Block Public Access on.
//     Downloads happen only through getPresignedUrl(), which mints a temporary
//     signed link each time it's called.
//
// Env (backend/.env):
//   AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.S3_BUCKET;

// True only when all four required vars are present. Callers use this to fall
// back to the DB copy if S3 isn't configured (e.g. local dev without creds),
// so the app never hard-crashes on a missing bucket.
const isConfigured = () =>
  !!(REGION && BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

// Lazily build a single shared client. Credentials are read from the standard
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars by the SDK automatically.
let _client = null;
const client = () => {
  if (!_client) _client = new S3Client({ region: REGION });
  return _client;
};

/**
 * Upload a buffer to the bucket.
 * @param {string} key      object key, e.g. "reports/request-12/v1.pdf"
 * @param {Buffer} buffer   file bytes
 * @param {string} contentType  e.g. "application/pdf"
 * @param {object} [metadata]   optional small string metadata
 * @returns {Promise<{key:string}>}
 */
async function putObject(key, buffer, contentType, metadata = {}) {
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    Metadata: metadata,
  }));
  return { key };
}

/**
 * Download an object's full bytes (used when the app streams the file itself
 * instead of redirecting, and for regenerating from the DB if ever needed).
 * @returns {Promise<Buffer>}
 */
async function getObjectBuffer(key) {
  const out = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Mint a short-lived presigned GET URL for an object. Generated fresh on every
 * call — the expiry only has to cover the moment between generation and the
 * browser starting the download, so a client can never "miss their window":
 * each Download click produces a new link.
 * @param {string} key
 * @param {number} [ttlSec=60]  link lifetime in seconds
 * @param {string} [downloadName]  forces a "save as" filename in the browser
 */
async function getPresignedUrl(key, ttlSec = 60, downloadName = null) {
  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(downloadName
      ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, '')}"` }
      : {}),
  });
  return getSignedUrl(client(), cmd, { expiresIn: ttlSec });
}

/** Delete an object (best-effort; S3 versioning keeps a recoverable version). */
async function deleteObject(key) {
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/** True if the object exists. Used to decide DB-fallback vs S3 serving. */
async function objectExists(key) {
  try {
    await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) return false;
    throw e;
  }
}

module.exports = {
  isConfigured, putObject, getObjectBuffer, getPresignedUrl, deleteObject, objectExists,
  BUCKET, REGION,
};
