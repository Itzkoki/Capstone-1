// Recording diagnostic for one teleconference session.
// Usage:  node scripts/check-recording.js <sessionId>
// Prints the DB state, the Twilio composition status for the session's room,
// and whether the recording exists in S3 — so we can see exactly where the
// recording pipeline stopped, without pasting JS into the terminal.
require('dotenv').config();
const db = require('../config/db');
const s3 = require('../services/s3Storage');
const twilio = require('twilio');

const sessionId = process.argv[2];
if (!sessionId) { console.error('Usage: node scripts/check-recording.js <sessionId>'); process.exit(1); }

(async () => {
  const r = await db.query(
    'SELECT id, meeting_code, session_status, twilio_room_sid, recording_response, recording_url FROM teleconference_sessions WHERE id = $1',
    [sessionId]
  );
  if (!r.rowCount) { console.log('No session', sessionId); process.exit(0); }
  const s = r.rows[0];
  console.log('\n=== SESSION', s.id, `(${s.meeting_code}) ===`);
  console.log('  status            :', s.session_status);
  console.log('  recording_response:', s.recording_response, s.recording_response === 1 ? '(approved)' : '');
  console.log('  recording_url     :', s.recording_url || '(none)');
  console.log('  twilio_room_sid   :', s.twilio_room_sid || '(none)');

  // Twilio compositions for this room
  if (s.twilio_room_sid && process.env.TWILIO_ACCOUNT_SID) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    try {
      const comps = await client.video.v1.compositions.list({ roomSid: s.twilio_room_sid, limit: 10 });
      console.log('\n=== COMPOSITIONS for room (' + comps.length + ') ===');
      for (const c of comps) {
        console.log(`  ${c.sid}  status=${c.status}  duration=${c.duration}  size=${c.size}`);
      }
      if (!comps.length) console.log('  (none — no composition was created)');

      // Also show whether recordings exist at all
      const recs = await client.video.v1.recordings.list({ groupingSid: [s.twilio_room_sid], limit: 5 }).catch(() => []);
      console.log('\n=== RAW RECORDINGS for room (' + recs.length + ') ===');
      for (const rec of recs) console.log(`  ${rec.sid}  type=${rec.type}  status=${rec.status}`);
      if (!recs.length) console.log('  (none — recording rules may not have captured anything)');
    } catch (e) {
      console.log('  Twilio lookup error:', e.message);
    }
  }

  // S3 existence check
  if (s.recording_url && s3.isConfigured()) {
    const exists = await s3.objectExists(s.recording_url).catch(() => false);
    console.log('\n=== S3 ===\n  object exists:', exists ? 'YES ✅' : 'NO ❌', '(' + s.recording_url + ')');
  }

  console.log('');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
