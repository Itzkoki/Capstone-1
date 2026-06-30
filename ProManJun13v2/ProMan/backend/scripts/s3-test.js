// One-shot S3 connectivity test. Proves the .env credentials, region, bucket
// name, and IAM policy all work together BEFORE we wire S3 into the report flow.
//
// Run from backend/:  node scripts/s3-test.js
//
// It uploads a tiny text object, fetches it back through a presigned URL, then
// deletes it. If every step prints OK, your AWS setup is correct.
require('dotenv').config();
const s3 = require('../services/s3Storage');

(async () => {
  console.log('AWS_REGION :', process.env.AWS_REGION || '(missing)');
  console.log('S3_BUCKET  :', process.env.S3_BUCKET || '(missing)');
  console.log('Key set    :', !!process.env.AWS_ACCESS_KEY_ID, '/ secret set:', !!process.env.AWS_SECRET_ACCESS_KEY);

  if (!s3.isConfigured()) {
    console.error('\n❌ S3 is not fully configured. Fill all four vars in backend/.env.');
    process.exit(1);
  }

  const key = `diagnostics/s3-test-${Date.now()}.txt`;
  const body = Buffer.from('ProMan S3 connectivity test — safe to delete.');

  try {
    console.log('\n1/3 PUT  →', key);
    await s3.putObject(key, body, 'text/plain');
    console.log('    ✅ upload OK');

    console.log('2/3 GET  → presigned URL (60s)');
    const url = await s3.getPresignedUrl(key, 60);
    const res = await fetch(url); // Node 18+ has global fetch
    const text = await res.text();
    if (res.ok && text === body.toString()) {
      console.log('    ✅ presigned download OK, bytes match');
    } else {
      throw new Error(`download mismatch (status ${res.status})`);
    }

    console.log('3/3 DELETE→', key);
    await s3.deleteObject(key);
    console.log('    ✅ delete OK');

    console.log('\n🎉 All good — credentials, region, bucket, and policy are correct.');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ FAILED:', err.name || '', err.message);
    if (/AccessDenied/i.test(err.message || err.name || '')) {
      console.error('   → IAM policy/bucket-name mismatch. Check the Resource ARNs match S3_BUCKET exactly.');
    } else if (/NoSuchBucket/i.test(err.message || err.name || '')) {
      console.error('   → S3_BUCKET name is wrong, or AWS_REGION ≠ the bucket\'s region.');
    } else if (/InvalidAccessKeyId|SignatureDoesNotMatch/i.test(err.message || err.name || '')) {
      console.error('   → Access key / secret is wrong (or was rotated). Re-copy them into .env.');
    } else if (/Could not load credentials|Resolved credential/i.test(err.message || '')) {
      console.error('   → Credentials not being read. Check the var names in .env.');
    }
    process.exit(1);
  }
})();
