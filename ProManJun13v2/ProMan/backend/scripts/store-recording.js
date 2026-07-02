// Manually store a session's completed Twilio composition into S3.
// Recovery/backfill tool when the composition-status webhook didn't fire or
// failed — and a direct test of the download→S3 path.
// Usage:  node scripts/store-recording.js <sessionId>
require('dotenv').config();
const db = require('../config/db');
const twilio = require('twilio');
const twilioRecording = require('../services/twilioRecording');
const TeleconferenceSession = require('../models/TeleconferenceSession');

const sessionId = process.argv[2];
if (!sessionId) { console.error('Usage: node scripts/store-recording.js <sessionId>'); process.exit(1); }

(async () => {
  const r = await db.query('SELECT id, twilio_room_sid, recording_url FROM teleconference_sessions WHERE id = $1', [sessionId]);
  const s = r.rows[0];
  if (!s) { console.error('No session', sessionId); process.exit(1); }
  if (!s.twilio_room_sid) { console.error('Session has no Twilio room SID.'); process.exit(1); }
  if (s.recording_url) { console.log('Already stored:', s.recording_url); process.exit(0); }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const comps = await client.video.v1.compositions.list({ roomSid: s.twilio_room_sid, limit: 10 });
  const done = comps.find(c => c.status === 'completed' || c.status === 'available');
  if (!done) {
    console.error('No completed composition. Statuses:', comps.map(c => c.sid + '=' + c.status).join(', ') || '(none)');
    process.exit(1);
  }

  console.log('Downloading composition', done.sid, 'and uploading to S3...');
  const key = await twilioRecording.storeCompositionInS3(done.sid, sessionId);
  await TeleconferenceSession.setRecordingUrl(sessionId, key);
  await TeleconferenceSession.addLog(sessionId, 'recording_stored', null, 'Recording stored in S3 (manual): ' + key).catch(() => {});
  console.log('Stored to S3:', key);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
