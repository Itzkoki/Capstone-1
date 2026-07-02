// ── Encrypted database backup → S3 ───────────────────────────────────────────
// Produces a daily, AES-256-encrypted PostgreSQL dump and uploads it to the
// dedicated backup bucket. Standard tools are used on purpose (pg_dump + openssl)
// so a dump can be restored even without this script — important for disaster
// recovery. Upload uses the AWS SDK already configured for the app (no AWS CLI
// needed).
//
//   pg_dump -Fc  →  openssl enc -aes-256-cbc  →  temp .dump.enc  →  S3 upload
//
// Run:  node scripts/db-backup.js
// Env (backend/.env):
//   S3_BACKUP_BUCKET      target bucket, e.g. barcarse-proman-db-backups
//   BACKUP_ENCRYPTION_KEY strong passphrase used to encrypt the dump
//   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (already set)
//   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME       (already set)
//   PG_DUMP_PATH (optional) full path to pg_dump if not on PATH
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET = process.env.S3_BACKUP_BUCKET;
const REGION = process.env.AWS_REGION;
const PASSPHRASE = process.env.BACKUP_ENCRYPTION_KEY;
const PG_DUMP = process.env.PG_DUMP_PATH || 'pg_dump';
const OPENSSL = process.env.OPENSSL_PATH || 'openssl';

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

if (!BUCKET) fail('S3_BACKUP_BUCKET is not set in .env');
if (!PASSPHRASE) fail('BACKUP_ENCRYPTION_KEY is not set in .env');
if (!process.env.DB_NAME) fail('DB_NAME is not set in .env');
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) fail('AWS credentials are not set');

// A dated key so each day is its own restore point; the bucket lifecycle rule
// prunes anything older than the retention window.
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const filename = `proman_${stamp}.dump.enc`;
const tmpFile = path.join(os.tmpdir(), filename);
const key = `db-backups/${filename}`;

// Run a piped command chain, resolving when both children exit 0.
function run() {
  return new Promise((resolve, reject) => {
    // 1. pg_dump in PostgreSQL custom format (compressed, restorable with pg_restore).
    const dump = spawn(PG_DUMP, [
      '-Fc',
      '-h', process.env.DB_HOST || 'localhost',
      '-p', String(process.env.DB_PORT || 5432),
      '-U', process.env.DB_USER || 'postgres',
      process.env.DB_NAME,
    ], { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' } });

    // 2. Encrypt the dump stream with AES-256 (pbkdf2 key derivation + random salt).
    const enc = spawn(OPENSSL, [
      'enc', '-aes-256-cbc', '-pbkdf2', '-salt',
      '-pass', 'env:BACKUP_ENCRYPTION_KEY',
    ], { env: { ...process.env } });

    const out = fs.createWriteStream(tmpFile);
    let dumpErr = '', encErr = '';
    // Only judge success once ALL THREE have finished (pg_dump exit, openssl
    // exit, file fully written) — otherwise the stream "finish" can fire before
    // the process "close" registers its exit code and misreport a good backup.
    let dumpDone = false, encDone = false, outDone = false, settled = false;
    let dumpCode = null, encCode = null;

    const check = (err) => {
      if (settled) return;
      if (err) { settled = true; return reject(err); }
      if (!(dumpDone && encDone && outDone)) return;
      settled = true;
      if (dumpCode !== 0) reject(new Error(`pg_dump exited ${dumpCode}: ${dumpErr.trim()}`));
      else if (encCode !== 0) reject(new Error(`openssl exited ${encCode}: ${encErr.trim()}`));
      else resolve();
    };

    dump.stderr.on('data', d => (dumpErr += d));
    enc.stderr.on('data', d => (encErr += d));
    dump.on('error', e => check(new Error(`pg_dump failed to start: ${e.message} (is PostgreSQL client installed / PG_DUMP_PATH set?)`)));
    enc.on('error', e => check(new Error(`openssl failed to start: ${e.message} (is openssl on PATH?)`)));

    dump.stdout.pipe(enc.stdin);
    enc.stdout.pipe(out);

    dump.on('close', c => { dumpCode = c; dumpDone = true; check(); });
    enc.on('close', c => { encCode = c; encDone = true; check(); });
    out.on('finish', () => { outDone = true; check(); });
    out.on('error', e => check(e));
  });
}

(async () => {
  console.log(`Backing up "${process.env.DB_NAME}" → ${BUCKET}/${key}`);
  try {
    console.log('[1] pg_dump + encrypt...');
    await run();
    const size = fs.statSync(tmpFile).size;
    if (size === 0) throw new Error('produced an empty backup file — aborting.');
    console.log(`    ✅ encrypted dump ready (${(size / 1024 / 1024).toFixed(2)} MB)`);

    console.log('[2] uploading to S3...');
    const s3 = new S3Client({ region: REGION });
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fs.createReadStream(tmpFile),
      ContentLength: size,
      ContentType: 'application/octet-stream',
      Metadata: { database: process.env.DB_NAME, created: stamp },
    }));
    console.log('    ✅ uploaded');

    fs.unlinkSync(tmpFile); // remove the local temp copy
    console.log(`\n🎉 Backup complete: s3://${BUCKET}/${key}`);
    process.exit(0);
  } catch (e) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
    fail(`Backup failed: ${e.message}`);
  }
})();
