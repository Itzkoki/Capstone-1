// ── Twilio Group Recording → S3 ──────────────────────────────────────────────
// Server-side teleconference recording that is CONSENT-GATED and lands the
// finished MP4 in S3 (barcarse-proman-files/recordings/). Flow:
//
//   1. ensureGroupRoom()  – create a server-owned GROUP room (recording off).
//   2. startRecording()   – called when the client consents; Recording Rules
//                           begin capturing every track.
//   3. (room ends)        – Twilio calls /twilio/room-status → createComposition()
//                           builds ONE mp4 of the whole session.
//   4. (mp4 ready)        – Twilio calls /twilio/composition-status →
//                           storeCompositionInS3() downloads it and PUTs it to S3.
//
// Group Rooms + Recording + Compositions require a PAID Twilio account.
//
// Env:
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN            (already set)
//   PUBLIC_BASE_URL   public https base of THIS backend, e.g. https://bpservices.site
//                     — required so Twilio's webhooks can reach us. Without it,
//                     recording still runs but nothing auto-composes/uploads.
const twilio = require('twilio');
const s3 = require('./s3Storage');

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const configured = () => !!(SID && TOKEN);
let _client = null;
const client = () => (_client || (_client = twilio(SID, TOKEN)));

const cbUrl = (path) => (PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${path}` : undefined);

/**
 * Ensure a server-owned GROUP room exists for this session so recording is
 * possible (client-auto-created rooms use the account default type and can't be
 * reliably recorded). Recording starts OFF — no capture until consent.
 * Idempotent: if the room already exists (another participant created it), the
 * existing room's SID is returned. Returns null if Twilio isn't configured.
 */
async function ensureGroupRoom(session) {
  if (!configured()) return null;
  const uniqueName = session.twilio_room_name;
  try {
    const room = await client().video.v1.rooms.create({
      uniqueName,
      type: 'group',
      recordParticipantsOnConnect: false,
      statusCallback: cbUrl('/api/teleconference/twilio/room-status'),
      statusCallbackMethod: 'POST',
    });
    return room.sid;
  } catch (e) {
    // 53113 = room exists; fall back to fetching it by uniqueName.
    if (e && (e.code === 53113 || e.status === 409)) {
      try { return (await client().video.v1.rooms(uniqueName).fetch()).sid; }
      catch (_) { return null; }
    }
    throw e;
  }
}

/** Begin recording every track in the room (called on client consent). */
async function startRecording(roomSid) {
  if (!configured() || !roomSid) return;
  await client().video.v1.rooms(roomSid).recordingRules.update({
    rules: [{ type: 'include', all: true }],
  });
}

/** Stop recording (consent withdrawn / stop button). */
async function stopRecording(roomSid) {
  if (!configured() || !roomSid) return;
  await client().video.v1.rooms(roomSid).recordingRules.update({
    rules: [{ type: 'exclude', all: true }],
  });
}

/**
 * Build a single composited MP4 of the whole room. Twilio processes it async and
 * calls the composition-status webhook (with ?sessionId=) when the file is ready.
 * Returns the composition SID, or null if not configured.
 */
async function createComposition(roomSid, sessionId) {
  if (!configured() || !roomSid) return null;
  const comp = await client().video.v1.compositions.create({
    roomSid,
    audioSources: '*',
    videoLayout: { grid: { video_sources: ['*'] } },
    format: 'mp4',
    statusCallback: cbUrl(`/api/teleconference/twilio/composition-status?sessionId=${sessionId}`),
    statusCallbackMethod: 'POST',
  });
  return comp.sid;
}

/**
 * Download a finished composition's media from Twilio and store it in S3 under
 * recordings/session-{id}/{compositionSid}.mp4. Returns the S3 key.
 * The Media subresource returns a short-lived redirect to the actual file.
 */
async function storeCompositionInS3(compositionSid, sessionId) {
  if (!configured()) throw new Error('Twilio not configured');
  if (!s3.isConfigured()) throw new Error('S3 not configured');

  const auth = Buffer.from(`${SID}:${TOKEN}`).toString('base64');
  const metaRes = await fetch(
    `https://video.twilio.com/v1/Compositions/${compositionSid}/Media?Ttl=3600`,
    { headers: { Authorization: `Basic ${auth}` }, redirect: 'manual' }
  );
  let mediaUrl = metaRes.headers.get('location');
  if (!mediaUrl) {
    try { mediaUrl = (await metaRes.json()).redirect_to; } catch (_) {}
  }
  if (!mediaUrl) throw new Error(`no media URL for composition ${compositionSid} (status ${metaRes.status})`);

  const fileRes = await fetch(mediaUrl);
  if (!fileRes.ok) throw new Error(`composition media download failed: ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  const key = `recordings/session-${sessionId}/${compositionSid}.mp4`;
  await s3.putObject(key, buf, 'video/mp4', { sessionId: String(sessionId), compositionSid });
  return key;
}

/**
 * Validate a Twilio webhook signature. Returns true if valid (or if validation
 * is disabled / not configurable). Set TWILIO_VALIDATE_WEBHOOKS=false to bypass
 * during early setup.
 */
function validateWebhook(req) {
  if (process.env.TWILIO_VALIDATE_WEBHOOKS === 'false') return true;
  if (!TOKEN || !PUBLIC_BASE_URL) return true; // can't validate without a known public URL
  const signature = req.headers['x-twilio-signature'];
  const url = `${PUBLIC_BASE_URL}${req.originalUrl}`;
  return twilio.validateRequest(TOKEN, signature, url, req.body || {});
}

module.exports = {
  configured, ensureGroupRoom, startRecording, stopRecording,
  createComposition, storeCompositionInS3, validateWebhook,
  PUBLIC_BASE_URL,
};
