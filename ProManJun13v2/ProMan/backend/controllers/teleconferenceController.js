const crypto = require('crypto');
const securityEvents = require('../services/securityEvents');
const TeleconferenceSession = require('../models/TeleconferenceSession');
const TeleconferenceInvitation = require('../models/TeleconferenceInvitation');
const TeleconfClearance = require('../models/TeleconfClearance');
const Meeting = require('../models/Meeting');
const User = require('../models/User');
const Staff = require('../models/Staff');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const twilioRecording = require('../services/twilioRecording');
const s3 = require('../services/s3Storage');
const db = require('../config/db');

// Twilio setup
const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;

// Base URL of the static frontend, used to build invitation links.
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5000';
// How long a single-use invitation link stays valid.
const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Twilio Access Token lifetime — kept short so a leaked token expires quickly.
const TWILIO_TOKEN_TTL_SEC = 3600; // 1h
// A live seat is "active" only while heartbeats arrive within this window.
const SEAT_FRESHNESS_MS = 30000; // 30s
// After the last heartbeat, the seat is HELD (grace window) so an accidentally
// disconnected user can reclaim it. During grace a different device is blocked;
// after it, the seat frees (a new join still needs OTP).
const SEAT_GRACE_MS = parseInt(process.env.TELECONF_SEAT_GRACE_MS || '180000', 10); // 3 min
// Whether the OTP clearance is enforced server-side before issuing a Twilio
// token. Default on; can be disabled for local testing.
const REQUIRE_OTP = (process.env.TELECONF_REQUIRE_OTP || 'true') !== 'false';

const isStaff = (role) => role && role !== 'client';

// Enforce that the caller holds a fresh server-side OTP clearance. Returns true
// if access may proceed; otherwise writes the 403 response and returns false.
async function ensureOtpClearance(req, res, sessionId) {
  if (!REQUIRE_OTP) return true;
  if (sessionId && await TeleconfClearance.isFresh(req.user.id, req.user.type === 'staff', sessionId)) return true;
  if (sessionId) {
    await TeleconferenceSession.addLog(
      sessionId, 'otp_clearance_missing', req.user.id,
      `Join/reconnect denied — no fresh OTP clearance (ip=${reqMeta(req).ip})`
    ).catch(() => {});
  }
  res.status(403).json({
    success: false, code: 'NEEDS_OTP',
    message: 'Please verify your identity with the teleconference code before joining.',
  });
  return false;
}

// Resolve the display identity for the video call. Clients live in `users`
// (full_name); staff live in `staff` — for them we show "FirstName (Role)" and
// NEVER the bare staff_id. Falls back to a generic label only if neither table
// has the id.
const prettyRole = (role) =>
  String(role || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

const staffLabel = (st) => {
  const first = st.first_name || (st.full_name ? String(st.full_name).split(' ')[0] : '') || 'Staff';
  return st.role ? `${first} (${prettyRole(st.role)})` : first;
};

// `user` may be the full req.user ({ id, role, type }) or a bare id. We use the
// role/type to pick the correct table FIRST, because a staff_id and a users.id
// can be the same number (they're separate sequences).
async function resolveIdentity(user) {
  const id = (user && typeof user === 'object') ? user.id : user;
  const looksStaff = user && typeof user === 'object' &&
    (user.type === 'staff' || (user.role && user.role !== 'client'));

  if (looksStaff) {
    const st = await Staff.findById(id);
    if (st) return staffLabel(st);
    const u = await User.findById(id); // legacy staff stored in users
    if (u && u.full_name) return u.full_name;
  } else {
    const u = await User.findById(id);
    if (u && u.full_name) return u.full_name;
    const st = await Staff.findById(id); // fallback if not a user
    if (st) return staffLabel(st);
  }
  return `User-${id}`;
}

// Force-terminate a Twilio Video room. Completing the room immediately
// disconnects EVERY connected participant and invalidates their in-room access.
// Best-effort: rooms addressed by SID or by uniqueName (the room name). A 404
// (room never started / already completed) is treated as success.
async function completeTwilioRoom(roomIdOrName) {
  if (!roomIdOrName || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    await client.video.v1.rooms(roomIdOrName).update({ status: 'completed' });
  } catch (e) {
    if (e && e.status === 404) return; // nothing live to terminate
    throw e;
  }
}

// Extract caller IP + user-agent for audit logging.
const reqMeta = (req) => ({
  ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
        .toString().split(',')[0].trim(),
  userAgent: (req.headers['user-agent'] || '').slice(0, 500),
});

/**
 * Returns true if a NEW connection for this user must be DENIED because they
 * already hold an active live-call seat on a DIFFERENT device. A reconnect from
 * the same device (matching connection token) or a stale/dropped seat is
 * allowed. Falls back to an authoritative Twilio participant lookup when a room
 * SID and credentials are available.
 */
async function isDuplicateLiveEntry(session, userId, presentedToken) {
  const p = await TeleconferenceSession.getParticipant(session.id, userId);
  // The seat is "held" for the whole grace window after the last heartbeat, so a
  // brief disconnect does not let a different device slip in.
  const seatHeld = p && p.joined_at && p.last_heartbeat &&
    (Date.now() - new Date(p.last_heartbeat).getTime()) < SEAT_GRACE_MS;

  if (seatHeld) {
    const sameDevice = presentedToken && p.connection_token &&
      presentedToken === p.connection_token;
    return !sameDevice; // held by another device → block
  }

  // No active local seat — best-effort authoritative check against Twilio.
  if (session.twilio_room_sid && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    try {
      const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      const identity = await resolveIdentity({
        id: userId,
        type: (p && p.participant_role && p.participant_role !== 'client') ? 'staff' : 'client',
      });
      const connected = await client.video.v1.rooms(session.twilio_room_sid)
        .participants.list({ status: 'connected', limit: 50 });
      if (connected.some((x) => x.identity === identity)) return true;
    } catch (_) { /* lookup failed — fall through and allow */ }
  }
  return false;
}

/**
 * Mint a short-lived Twilio Video Access Token, claim the live-call seat, and
 * return the join payload. Shared by the waiting-room join and the
 * invite-redeem flows so both apply identical seat + audit logic.
 */
async function issueRoomAccess(session, reqUser, source) {
  if (session.session_status === 'scheduled') {
    await TeleconferenceSession.updateStatus(session.id, 'active');
  }

  // Ensure a server-owned GROUP room exists so consent-gated recording is
  // possible. Best-effort: if Twilio room creation fails, the client still
  // connects (to an auto-created room) — only recording is unavailable.
  if (!session.twilio_room_sid && twilioRecording.configured()) {
    try {
      const sid = await twilioRecording.ensureGroupRoom(session);
      if (sid) {
        await TeleconferenceSession.updateTwilioRoom(session.id, sid, session.twilio_room_name);
        session.twilio_room_sid = sid;
        await TeleconferenceSession.addLog(session.id, 'twilio_room_created', reqUser.id, `Group room provisioned (${sid}).`).catch(() => {});
      }
    } catch (e) {
      console.error('Twilio group room creation failed (recording disabled for this session):', e.message);
    }
  }

  const identity = await resolveIdentity(reqUser);
  const connectionToken = crypto.randomBytes(32).toString('hex');
  // Durable reconnect secret: returned to the device (stored in localStorage),
  // only its hash is persisted. Lets the SAME device reclaim its seat after an
  // accidental disconnect without re-running OTP.
  const reconnectToken = crypto.randomBytes(32).toString('hex');
  const reconnectTokenHash = crypto.createHash('sha256').update(reconnectToken).digest('hex');

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_SECRET,
    { identity, ttl: TWILIO_TOKEN_TTL_SEC }
  );
  token.addGrant(new VideoGrant({ room: session.twilio_room_name }));

  await TeleconferenceSession.markJoined(session.id, reqUser.id);
  await TeleconferenceSession.claimSeat(session.id, reqUser.id, connectionToken, reconnectTokenHash);
  // Keep THIS participant's OTP clearance for THIS session alive for the call.
  await TeleconfClearance.extend(reqUser.id, reqUser.type === 'staff', session.id).catch(() => {});

  await TeleconferenceSession.addLog(
    session.id, 'participant_joined', reqUser.id,
    `${identity} (${reqUser.role}) joined the session via ${source}`
  );
  await TeleconferenceSession.addLog(
    session.id, 'twilio_token_issued', reqUser.id,
    `Access token issued for "${identity}" (ttl ${TWILIO_TOKEN_TTL_SEC}s)`
  );

  // Security event: the encrypted-session fingerprint presented to this user.
  const securityEmojis = TeleconferenceSession.securityEmojis(session.access_token);
  await TeleconferenceSession.addLog(
    session.id, 'secure_session_verified', reqUser.id,
    `Secure session fingerprint presented: ${securityEmojis.join(' ')}`
  );

  const safeSession = { ...session, security_emojis: securityEmojis };
  delete safeSession.access_token;

  return {
    token: token.toJwt(),
    connectionToken,
    reconnectToken,
    roomName: session.twilio_room_name,
    identity,
    session: safeSession,
  };
}

// A user must have a VERIFIED account before they can be assigned to a
// teleconference. Returns { user } when eligible, or { error } with a message.
async function getEligibleClientOrError(clientId) {
  const client = await User.findById(clientId);
  if (!client) {
    return { error: 'The selected client could not be found.' };
  }
  if (!client.is_verified) {
    return {
      error: `${client.full_name || 'This client'} is not verified yet. Only verified users can be assigned to a teleconference.`,
    };
  }
  return { user: client };
}

// ── POST /api/teleconference — create session ──
const createSession = async (req, res, next) => {
  try {
    const { title, client_id, additional_staff, appointment_id } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, message: 'Session title is required.' });
    }
    if (!client_id) {
      return res.status(400).json({ success: false, message: 'Assigning a client is required to create a session.' });
    }

    // Eligibility: the assigned client's account must be verified.
    const eligibility = await getEligibleClientOrError(client_id);
    if (eligibility.error) {
      return res.status(400).json({ success: false, message: eligibility.error });
    }

    const staffList = Array.isArray(additional_staff) ? additional_staff.filter(Boolean) : [];
    if (staffList.length > 3) {
      return res.status(400).json({ success: false, message: 'You can add up to 3 additional staff members.' });
    }

    // Create the meeting record first
    const meeting = await Meeting.create(req.user.id, title);

    // Create Twilio room name
    const roomName = `barcarse-session-${meeting.id}-${Date.now()}`;

    // Create the teleconference session
    const session = await TeleconferenceSession.create({
      meetingId: meeting.id,
      psychologistId: req.user.id,
      clientId: client_id,
      twilioRoomSid: null,
      twilioRoomName: roomName,
      appointmentId: appointment_id || null,
    });

    // ── Provision participants ──
    // Host (the creator) is auto-admitted and bypasses the waiting room.
    await TeleconferenceSession.addParticipant(session.id, req.user.id, 'host', 'admitted');

    // Invited participants start as 'invited' (Not in the Meeting). They are
    // NOT placed in the waiting room until they actually try to join.
    await TeleconferenceSession.addParticipant(session.id, client_id, 'client', 'invited');

    // Additional staff (up to 3) are also invited (not waiting) until they join.
    for (const staffId of staffList) {
      if (parseInt(staffId, 10) === req.user.id) continue; // creator already added as host
      await TeleconferenceSession.addParticipant(session.id, staffId, 'staff', 'invited');
    }

    // Log session creation
    await TeleconferenceSession.addLog(session.id, 'session_created', req.user.id, `Session "${title}" created (Meeting ID ${session.meeting_code})`);

    // ── Single-use invitation token for the client ──
    // Bound to this session, the appointment (meeting) and the patient, with a
    // hard expiry. Only the hash is stored; the raw token goes out in the email.
    // The client's single-use invite link is delivered IN-APP via the
    // notification's "Join Meeting" button (no email). Staff still use the normal
    // join deep-link. clientInviteLink stays null if invite creation fails, in
    // which case the client falls back to the normal join link too.
    let clientInviteLink = null;
    try {
      const inviteExpiry = new Date(Date.now() + INVITE_TTL_MS);
      const { raw, invitation } = await TeleconferenceInvitation.create({
        sessionId: session.id,
        meetingId: meeting.id,
        clientId: client_id,
        expiresAt: inviteExpiry,
        createdBy: req.user.id,
      });
      // Include join=<id> so the notification's Join-Meeting modal can still load
      // the meeting details, plus the single-use invite token the modal's button
      // uses to actually enter.
      clientInviteLink = `meetings.html?join=${session.id}&invite=${encodeURIComponent(raw)}`;
      await TeleconferenceSession.addLog(
        session.id, 'invite_generated', req.user.id,
        `Single-use invite #${invitation.id} for client ${client_id}, expires ${inviteExpiry.toISOString()}`
      );
    } catch (err) {
      // Non-fatal: the session still exists; the client can use the normal join.
      console.error('Invitation generation failed:', err.message);
    }

    // ── Send a single "meeting has started" notification to each participant ──
    // The notification renders a "Join Meeting" button (notifications.html). The
    // CLIENT's button carries the single-use invite token; staff get the normal
    // join deep-link.
    const joinLink = `meetings.html?join=${session.id}`;
    const invited = [client_id, ...staffList.filter(s => parseInt(s, 10) !== req.user.id)];
    for (const participantId of invited) {
      if (participantId == null) continue; // skip a missing client_id (staff-only room)
      const isClient = parseInt(participantId, 10) === parseInt(client_id, 10);
      const link = (isClient && clientInviteLink) ? clientInviteLink : joinLink;
      // Invited STAFF get an explicit invitation message; the CLIENT keeps the
      // "your meeting has started" wording. Both fire immediately on creation.
      const notifTitle = isClient
        ? 'Your scheduled meeting has started'
        : 'You have been invited to a teleconference';
      const notifBody = isClient
        ? 'Click to join your scheduled consultation meeting.'
        : `You've been invited to the teleconference "${title}". Click to join.`;
      try {
        await notificationService.notifyUser(participantId, 'teleconference', notifTitle, notifBody, link, isClient ? 'user' : 'staff');
      } catch (err) { console.error('Meeting notification failed:', err.message); }
    }

    // Fetch full session with names
    const fullSession = await TeleconferenceSession.findById(session.id);

    return res.status(201).json({ success: true, data: fullSession });
  } catch (error) { next(error); }
};

/**
 * Build the participant-facing view of a session: the full participant
 * roster (no passwords), plus the requesting user's own password and status.
 */
async function buildSessionView(session, userId, role) {
  const participants = await TeleconferenceSession.getParticipants(session.id);
  const me = participants.find(p => p.user_id === userId) || null;

  const safeParticipants = participants.map(p => ({
    user_id: p.user_id,
    full_name: p.full_name,
    email: p.email,
    participant_role: p.participant_role,
    admit_status: p.admit_status,
    joined_at: p.joined_at,
  }));

  const amIHost = session.psychologist_id === userId;

  // Derive the secure-session emoji fingerprint from the session key, then drop
  // the raw key from the payload — the key is never exposed to clients.
  const security_emojis = TeleconferenceSession.securityEmojis(session.access_token);
  const view = {
    ...session,
    participants: safeParticipants,
    waiting_count: safeParticipants.filter(p => p.admit_status === 'waiting').length,
    my_admit_status: me ? me.admit_status : (amIHost ? 'admitted' : null),
    am_i_host: amIHost,
    security_emojis,
  };
  delete view.access_token;
  return view;
}

// ── GET /api/teleconference/my-sessions — user's sessions ──
const getMySessions = async (req, res, next) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const sessions = await TeleconferenceSession.findByParticipant(req.user.id, {
      status, limit: parseInt(limit), offset: parseInt(offset),
    });
    return res.json({ success: true, data: sessions });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference — sessions the user is invited to ──
const getAllSessions = async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    // Only invited participants (host, client, or added staff) can see a meeting.
    // Non-invited users — including other staff — see nothing.
    const sessions = await TeleconferenceSession.findByParticipant(req.user.id, {
      status, limit: parseInt(limit), offset: parseInt(offset),
    });
    return res.json({ success: true, data: sessions });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/:id — session detail ──
const getSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Access check: psychologist (host), client, staff, or any listed participant
    const myParticipant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id &&
        !myParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const view = await buildSessionView(session, req.user.id, req.user.role);
    return res.json({ success: true, data: view });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/:id/poll — lightweight state for clients/participants ──
const pollSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const myParticipant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id &&
        !myParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const view = await buildSessionView(session, req.user.id, req.user.role);
    return res.json({
      success: true,
      data: {
        id: view.id,
        session_status: view.session_status,
        started_at: view.started_at,
        recording_enabled: view.recording_enabled,
        recording_requested: view.recording_requested,
        recording_consent_given: view.recording_consent_given,
        recording_response: view.recording_response,
        my_admit_status: view.my_admit_status,
        am_i_host: view.am_i_host,
        waiting_count: view.waiting_count,
        participants: view.participants,
        security_emojis: view.security_emojis,
      },
    });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/join — join session & get Twilio token ──
const joinSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Must be a provisioned participant of this session
    const participant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (!participant) {
      securityEvents.record({
        module: 'teleconference', eventType: 'unauthorized_join_attempt',
        userId: req.user.id, subjectKind: req.user.type === 'staff' ? 'staff' : 'user', ip: req.ip,
        targetType: 'session', targetId: session.id,
        details: `Non-participant attempted to join session #${session.id}.`,
      });
      return res.status(403).json({ success: false, message: 'You are not a participant of this session.' });
    }

    if (session.session_status === 'ended' || session.session_status === 'cancelled') {
      return res.status(400).json({ success: false, code: 'SESSION_ENDED', message: 'This session has already ended.' });
    }

    const isHost = session.psychologist_id === req.user.id || participant.participant_role === 'host';

    // ── Waiting room gating (host bypasses) ──
    if (!isHost) {
      if (participant.admit_status === 'denied') {
        return res.status(403).json({ success: false, message: 'The host has not admitted you to this session.' });
      }
      if (participant.admit_status !== 'admitted') {
        if (participant.admit_status !== 'waiting') {
          await TeleconferenceSession.setAdmitStatus(session.id, req.user.id, 'waiting');
        }
        await TeleconferenceSession.addLog(session.id, 'participant_waiting', req.user.id, 'Entered the waiting room.');
        return res.json({ success: true, waiting: true, message: 'Please wait for the host to admit you.' });
      }
    }

    // ── OTP clearance (server-enforced) ──
    // The Twilio token is only issued to someone who actually passed OTP. This
    // is the boundary the browser-only gate could not provide.
    if (!await ensureOtpClearance(req, res, session.id)) return;

    // ── Device-binding gate (time-limited) ──
    // When a device claims this session, the seat is BOUND to the reconnect token
    // it holds (participant.reconnect_token_hash). While the binding is "held" —
    // i.e. within SEAT_GRACE_MS of the device last being seen (live heartbeat, or
    // the moment it left) — only that device, presenting the matching token, may
    // join or rejoin. A second device on the same account has no token and is
    // denied DURING that window. Once the grace window lapses (the original device
    // has been gone longer than SEAT_GRACE_MS), the binding is treated as expired
    // and another device may claim the seat.
    const presentedReconnect = (req.body && req.body.reconnectToken) || null;
    const presentedHash = presentedReconnect
      ? crypto.createHash('sha256').update(presentedReconnect).digest('hex')
      : null;

    const heldUntil = participant.last_heartbeat
      ? new Date(participant.last_heartbeat).getTime() + SEAT_GRACE_MS
      : 0;
    const bindingStillHeld = Date.now() < heldUntil;

    if (participant.reconnect_token_hash &&
        presentedHash !== participant.reconnect_token_hash &&
        bindingStillHeld) {
      const secsLeft = Math.max(1, Math.ceil((heldUntil - Date.now()) / 1000));
      await TeleconferenceSession.addLog(
        session.id, 'bound_device_blocked', req.user.id,
        `Join blocked — seat bound to another device for ~${secsLeft}s more (ip=${reqMeta(req).ip})`
      );
      return res.status(403).json({
        success: false, code: 'BOUND_TO_OTHER_DEVICE',
        message: 'This meeting is currently open on the device that started it. Please try again in a few minutes.',
      });
    }

    // First claim, the bound device returning, OR the binding has expired (the
    // previous device was gone past the grace window) → issue the short-lived
    // Twilio token + (re)claim the seat, which rotates the binding to this device.
    const joinData = await issueRoomAccess(session, req.user, 'waiting_room');
    return res.json({ success: true, waiting: false, data: joinData });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/invite/redeem — redeem a single-use invite link ──
// Body: { token }. The caller MUST be authenticated as the invited patient.
// Validates the token, blocks duplicate room entry, atomically consumes the
// token, then issues a Twilio Access Token.
const redeemInvite = async (req, res, next) => {
  const meta = reqMeta(req);
  try {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, message: 'Invitation token is required.' });
    }

    const invite = await TeleconferenceInvitation.findByRawToken(token);

    // 1. Token exists?
    if (!invite) {
      return res.status(404).json({ success: false, code: 'INVALID_TOKEN', message: 'This invitation link is invalid.' });
    }

    const logDeny = (event, details) =>
      TeleconferenceSession.addLog(invite.session_id, event, req.user.id, `${details} (ip=${meta.ip})`).catch(() => {});

    // 2. Not previously used / revoked?
    if (invite.status !== 'active') {
      await logDeny('invite_reuse_blocked', `Token #${invite.id} status=${invite.status}`);
      return res.status(409).json({ success: false, code: 'TOKEN_USED', message: 'This invitation link has already been used.' });
    }

    // 3. Not expired?
    if (new Date() > new Date(invite.expires_at)) {
      await TeleconferenceInvitation.markExpired(invite.id);
      await logDeny('invite_expired', `Token #${invite.id} expired`);
      return res.status(410).json({ success: false, code: 'TOKEN_EXPIRED', message: 'This invitation link has expired.' });
    }

    // 4. Bound to the invited patient — defeats link sharing / theft.
    if (invite.client_id !== req.user.id) {
      await logDeny('invite_wrong_user', `Token #${invite.id} bound to ${invite.client_id}, attempted by ${req.user.id}`);
      return res.status(403).json({ success: false, code: 'WRONG_USER', message: 'This invitation is not associated with your account.' });
    }

    const session = await TeleconferenceSession.findById(invite.session_id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }
    if (session.session_status === 'ended' || session.session_status === 'cancelled') {
      return res.status(400).json({ success: false, code: 'SESSION_ENDED', message: 'This session has already ended.' });
    }

    // 4b. OTP clearance — the client must have verified their identity (the
    // teleconference email OTP) BEFORE we consume the token or connect them. The
    // single-use token proves the invite is theirs; OTP proves it's them right
    // now. The frontend runs OTP first, then redeems.
    if (!await ensureOtpClearance(req, res, session.id)) return;

    // 5. Duplicate room-entry check BEFORE issuing a Twilio token.
    if (await isDuplicateLiveEntry(session, req.user.id, null)) {
      await logDeny('duplicate_join_blocked', `Token #${invite.id}: client already connected`);
      return res.status(409).json({ success: false, code: 'ALREADY_IN_ROOM', message: "You're already inside the room." });
    }

    // 6. Atomically consume the invite (replay-proof single use).
    const claimed = await TeleconferenceInvitation.claim(invite.id, meta);
    if (!claimed) {
      await logDeny('invite_reuse_blocked', `Token #${invite.id} lost the claim race`);
      return res.status(409).json({ success: false, code: 'TOKEN_USED', message: 'This invitation link has already been used.' });
    }
    await TeleconferenceSession.addLog(session.id, 'invite_used', req.user.id, `Token #${invite.id} consumed (ip=${meta.ip})`);

    // The invitation IS the admission: ensure the participant row is admitted.
    await TeleconferenceSession.addParticipant(session.id, req.user.id, 'client', 'admitted');

    // 7. Issue the Twilio Access Token + claim the live seat.
    const joinData = await issueRoomAccess(session, req.user, 'invite');
    return res.json({ success: true, waiting: false, data: joinData });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/heartbeat — keep the live-call seat alive ──
// The connected device calls this periodically with its connection token. A
// device without the matching token cannot keep (or steal) the seat.
const heartbeat = async (req, res, next) => {
  try {
    const { connectionToken } = req.body || {};
    if (!connectionToken) {
      return res.status(400).json({ success: false, message: 'connectionToken is required.' });
    }
    const ok = await TeleconferenceSession.touchHeartbeat(req.params.id, req.user.id, connectionToken);
    if (!ok) {
      return res.status(409).json({ success: false, code: 'SEAT_LOST', message: 'Your seat is no longer active.' });
    }
    // Slide THIS participant's OTP clearance forward so an active call never
    // expires mid-session.
    await TeleconfClearance.extend(req.user.id, req.user.type === 'staff', req.params.id).catch(() => {});
    return res.json({ success: true });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/reconnect — reclaim a seat after a drop ──
// Body: { reconnectToken }. Lets the SAME device that joined reclaim its seat
// after an accidental disconnect/refresh/crash. Requires the durable reconnect
// token (proves it is the original device) AND a fresh OTP clearance. A device
// without the token is told to do a full join (which re-runs OTP), so an
// intruder cannot reclaim the seat.
const reconnectSession = async (req, res, next) => {
  const meta = reqMeta(req);
  try {
    const { reconnectToken } = req.body || {};
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }
    if (session.session_status === 'ended' || session.session_status === 'cancelled') {
      return res.status(400).json({ success: false, code: 'SESSION_ENDED', message: 'This session has already ended.' });
    }

    // Identity boundary still applies on reconnect.
    if (!await ensureOtpClearance(req, res, session.id)) return;

    const participant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (!participant) {
      return res.status(403).json({ success: false, message: 'You are not a participant of this session.' });
    }

    // Validate the durable reconnect token against the stored hash.
    const presentedHash = reconnectToken
      ? crypto.createHash('sha256').update(reconnectToken).digest('hex')
      : null;
    const tokenMatches = presentedHash && participant.reconnect_token_hash &&
      presentedHash === participant.reconnect_token_hash;

    if (!tokenMatches) {
      // No proof this is the original device → must do a full join (re-OTP).
      await TeleconferenceSession.addLog(
        session.id, 'reconnect_denied', req.user.id,
        `Reconnect without valid token (ip=${meta.ip})`
      );
      return res.status(403).json({
        success: false, code: 'NEEDS_REJOIN',
        message: 'Could not verify your previous session. Please rejoin.',
      });
    }

    // Same device → reclaim. issueRoomAccess rotates both tokens, so the old
    // reconnect token is now dead (single-use per reclaim).
    const joinData = await issueRoomAccess(session, req.user, 'reconnect');
    await TeleconferenceSession.addLog(
      session.id, 'reconnect_success', req.user.id,
      `Seat reclaimed after disconnect (ip=${meta.ip})`
    );
    return res.json({ success: true, waiting: false, data: joinData });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/admit — host admits or denies a waiting participant ──
const admitParticipant = async (req, res, next) => {
  try {
    const { user_id, admit } = req.body || {};
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Only the host may admit/deny
    if (session.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the host can manage the waiting room.' });
    }

    const status = admit ? 'admitted' : 'denied';
    const updated = await TeleconferenceSession.setAdmitStatus(session.id, parseInt(user_id, 10), status);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Participant not found in this session.' });
    }

    await TeleconferenceSession.addLog(
      session.id, admit ? 'participant_admitted' : 'participant_denied', req.user.id,
      `Host ${admit ? 'admitted' : 'denied'} participant (user ${user_id}).`
    );

    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/leave — participant leaves the call (can rejoin) ──
const leaveSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }
    const participant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (!participant) {
      return res.json({ success: true }); // not a participant — nothing to do
    }
    // Clear joined_at so they drop out of the "In this meeting" roster. Keep
    // admit_status (admitted) + the device binding so they can rejoin within the
    // grace period without host re-approval (room stays active for others).
    // markLeft stamps last_heartbeat = NOW(), which starts THIS participant's
    // 3-minute seat/binding grace from the exact moment they leave.
    await TeleconferenceSession.markLeft(session.id, req.user.id);

    // Start this participant's OTP grace from the EXACT leave time too: extend
    // their (still-fresh) per-session clearance to leave + window. Rejoin within
    // the grace → no OTP; after it the clearance is gone → OTP required. This is
    // per (user, session), so each participant's timer is fully independent.
    await TeleconfClearance.extend(req.user.id, req.user.type === 'staff', session.id).catch(() => {});

    await TeleconferenceSession.addLog(
      session.id, 'participant_left', req.user.id,
      `Left the room (role=${req.user.role || participant.participant_role || 'participant'}, ip=${reqMeta(req).ip}). 3-min grace started.`
    );
    return res.json({ success: true });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/remove — host removes a participant from the meeting ──
const removeParticipant = async (req, res, next) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Only the host may remove participants
    if (session.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the host can remove participants.' });
    }

    // The host cannot remove themselves
    if (parseInt(user_id, 10) === req.user.id) {
      return res.status(400).json({ success: false, message: 'The host cannot remove themselves.' });
    }

    const updated = await TeleconferenceSession.removeParticipant(session.id, parseInt(user_id, 10));
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Participant not found in this session.' });
    }

    await TeleconferenceSession.addLog(
      session.id, 'participant_removed', req.user.id,
      `Host removed participant (user ${user_id}) from the meeting.`
    );

    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/start-recording — psychologist starts recording ──
const startRecording = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    if (session.psychologist_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the psychologist can start recording.' });
    }

    // Do NOT start recording here — only request it. Recording begins only once
    // the client approves (see consentRecording).
    const updated = await TeleconferenceSession.requestRecording(session.id);

    await TeleconferenceSession.addLog(
      session.id, 'recording_requested', req.user.id,
      'Psychologist requested recording. Waiting for client consent.'
    );

    return res.json({ success: true, message: 'Recording requested. Awaiting client consent.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/consent-recording — client grants/denies consent ──
const consentRecording = async (req, res, next) => {
  try {
    const { consent } = req.body;
    if (consent === undefined) {
      return res.status(400).json({ success: false, message: 'consent (true/false) is required.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Only client or staff can give consent
    if (session.client_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the client can provide recording consent.' });
    }

    const approved = consent === true || consent === 'true' || consent === 1 || consent === '1';
    const updated = await TeleconferenceSession.setRecordingResponse(session.id, approved);

    // Consent is the boundary that actually starts (or blocks) Twilio recording.
    // Best-effort: a Twilio hiccup must not fail the consent write.
    if (session.twilio_room_sid && twilioRecording.configured()) {
      try {
        if (approved) await twilioRecording.startRecording(session.twilio_room_sid);
        else await twilioRecording.stopRecording(session.twilio_room_sid);
      } catch (e) {
        console.error('Twilio recording rule update failed:', e.message);
        await TeleconferenceSession.addLog(session.id, 'recording_rule_error', req.user.id, `Failed to ${approved ? 'start' : 'stop'} recording: ${e.message}`).catch(() => {});
      }
    }

    await TeleconferenceSession.addLog(
      session.id, approved ? 'recording_consented' : 'recording_denied', req.user.id,
      approved ? 'Client approved recording (stored as 1).' : 'Client rejected recording (stored as 0).'
    );

    return res.json({
      success: true,
      message: approved ? 'Recording consent granted.' : 'Recording consent denied.',
      data: updated,
    });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/end — "End Call for All" (HOST ONLY) ──
// Terminates the teleconference for every participant: marks the room ended,
// completes the Twilio room (force-disconnects everyone), releases all seats +
// device bindings, and revokes outstanding invites.
const endSession = async (req, res, next) => {
  const meta = reqMeta(req);
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // ── RBAC: ONLY the Host (the staff member who owns/created the room) may end
    // the call for everyone. Co-hosts, other clinic staff, and clients are denied
    // — and the denied attempt is audited. ──
    const isHost = session.psychologist_id === req.user.id;
    if (!isHost) {
      await TeleconferenceSession.addLog(
        session.id, 'end_call_denied', req.user.id,
        `Denied "End Call for All" — not the host (role=${req.user.role || 'unknown'}, ip=${meta.ip})`
      ).catch(() => {});
      return res.status(403).json({
        success: false, code: 'NOT_HOST',
        message: 'Only the host can end the call for everyone.',
      });
    }

    if (session.session_status === 'ended') {
      return res.json({ success: true, message: 'Session already ended.', data: session });
    }

    // 1. Mark the room Ended (this is what every participant's poll detects).
    const updated = await TeleconferenceSession.updateStatus(session.id, 'ended');

    // 2. Revoke outstanding invitation links.
    try { await TeleconferenceInvitation.revokeBySession(session.id); } catch (e) {}

    // 3. Release every seat + device binding so no token can reconnect.
    try { await TeleconferenceSession.releaseAllSeats(session.id); } catch (e) {}

    // 4. Force-terminate the Twilio room — disconnects all connected participants
    //    immediately and invalidates their in-room access.
    try { await completeTwilioRoom(session.twilio_room_sid || session.twilio_room_name); }
    catch (e) { console.error('Twilio room completion failed:', e.message); }

    // 5. End the linked meeting if active.
    if (session.meeting_id) {
      try { await Meeting.endMeeting(session.meeting_id); } catch (e) {}
    }

    await TeleconferenceSession.addLog(
      session.id, 'session_ended', req.user.id,
      `"End Call for All" by host (role=${req.user.role || 'host'}, ip=${meta.ip}). Room terminated; all seats + invites revoked.`
    );

    return res.json({ success: true, message: 'Call ended for all participants.', data: updated });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/:id/logs — session audit trail (staff only) ──
const getSessionLogs = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Only the host can view the session logs
    if (session.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the host can view the session logs.' });
    }

    const logs = await TeleconferenceSession.getLogs(session.id);
    return res.json({ success: true, data: logs });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/:id/messages — chat history ──
const getMessages = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const myParticipant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id &&
        !myParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const sinceId = parseInt(req.query.since, 10) || 0;
    const messages = await TeleconferenceSession.getMessages(session.id, sinceId);
    return res.json({ success: true, data: messages });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/messages — send a chat message ──
const postMessage = async (req, res, next) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const myParticipant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id &&
        !myParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const saved = await TeleconferenceSession.addMessage(session.id, req.user.id, String(message).trim().slice(0, 2000));
    return res.status(201).json({ success: true, data: saved });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/assign-client — assign a client to a session ──
const assignClient = async (req, res, next) => {
  try {
    const { client_id } = req.body;
    if (!client_id) {
      return res.status(400).json({ success: false, message: 'client_id is required.' });
    }

    // Eligibility: the assigned client's account must be verified.
    const eligibility = await getEligibleClientOrError(client_id);
    if (eligibility.error) {
      return res.status(400).json({ success: false, message: eligibility.error });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const db = require('../config/db');
    const result = await db.query(
      `UPDATE teleconference_sessions SET client_id = $1 WHERE id = $2 RETURNING *`,
      [client_id, session.id]
    );

    await TeleconferenceSession.addLog(
      session.id, 'client_assigned', req.user.id,
      `Client ID ${client_id} assigned to session.`
    );

    const updated = await TeleconferenceSession.findById(session.id);
    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/clients — list clients for assignment ──
const getClients = async (req, res, next) => {
  try {
    const clients = await User.findByRole('client');
    return res.json({ success: true, data: clients });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/staff — list staff for assignment ──
// Sourced from Staff Management (the `staff` table): only active staff with a
// clinical role are assignable. Shape matches the meetings UI ({id, full_name,
// role, specialization}); `id` is the staff_id used as the participant id.
const getStaffList = async (req, res, next) => {
  try {
    const staff = await Staff.findAssignable({});
    const data = staff
      // The creator is the host of the room they're about to make — never offer
      // them as an "additional staff" option. Enforced server-side so it holds
      // regardless of any client-side id type mismatch.
      .filter((s) => s.staff_id !== req.user.id)
      .map((s) => ({
        id: s.staff_id,
        full_name: [s.first_name, s.last_name].filter(Boolean).join(' ').trim(),
        role: s.role,
        specialization: s.specialization || null,
      }));
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/stop-recording — stop recording ──
const stopRecording = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    if (!isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only staff can stop recording.' });
    }

    // Stop the live Twilio capture (best-effort), then clear the flags.
    if (session.twilio_room_sid && twilioRecording.configured()) {
      try { await twilioRecording.stopRecording(session.twilio_room_sid); }
      catch (e) { console.error('Twilio stop-recording failed:', e.message); }
    }
    await TeleconferenceSession.resetRecording(session.id);

    await TeleconferenceSession.addLog(
      session.id, 'recording_stopped', req.user.id,
      'Recording stopped by psychologist.'
    );

    return res.json({ success: true, message: 'Recording stopped.' });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/twilio/room-status — Twilio room lifecycle webhook ──
// Unauthenticated (Twilio can't send a JWT); protected by signature validation.
// On 'room-ended', if the session was recorded, kick off the single-MP4
// composition (Twilio then calls composition-status when the file is ready).
const roomStatusWebhook = async (req, res) => {
  try {
    if (!twilioRecording.validateWebhook(req)) return res.status(403).send('invalid signature');
    const event = req.body.StatusCallbackEvent;
    const roomSid = req.body.RoomSid;
    res.status(200).send('ok'); // ack Twilio immediately; work continues async

    if (event !== 'room-ended' || !roomSid) return;
    const session = await TeleconferenceSession.findByRoomSid(roomSid);
    if (!session) return;
    if (Number(session.recording_response) !== 1) return; // nothing was recorded

    const compSid = await twilioRecording.createComposition(roomSid, session.id);
    await TeleconferenceSession.addLog(session.id, 'composition_requested', null, `Composition ${compSid} requested for room ${roomSid}.`).catch(() => {});
  } catch (e) {
    console.error('room-status webhook error:', e.message);
  }
};

// ── POST /api/teleconference/twilio/composition-status — Twilio composition webhook ──
// On 'composition-available', download the finished MP4 and store it in S3, then
// record the S3 key on the session (recording_url).
const compositionStatusWebhook = async (req, res) => {
  try {
    if (!twilioRecording.validateWebhook(req)) return res.status(403).send('invalid signature');
    const event = req.body.StatusCallbackEvent;
    const compositionSid = req.body.CompositionSid;
    const sessionId = req.query.sessionId;
    res.status(200).send('ok');

    if (event !== 'composition-available' || !compositionSid || !sessionId) return;
    const key = await twilioRecording.storeCompositionInS3(compositionSid, sessionId);
    await TeleconferenceSession.setRecordingUrl(sessionId, key);
    await TeleconferenceSession.addLog(sessionId, 'recording_stored', null, `Recording stored in S3: ${key}`).catch(() => {});
  } catch (e) {
    console.error('composition-status webhook error:', e.message);
  }
};

// ── GET /api/teleconference/:id/recording — presigned playback URL (host/staff) ──
const getRecording = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found.' });

    const isHost = session.psychologist_id === req.user.id;
    if (!isHost && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only staff can access the recording.' });
    }
    if (!session.recording_url) {
      return res.status(404).json({ success: false, code: 'NO_RECORDING', message: 'No recording is available for this session yet.' });
    }
    if (!s3.isConfigured()) {
      return res.status(503).json({ success: false, message: 'Recording storage is not configured.' });
    }
    const url = await s3.getPresignedUrl(session.recording_url, 300, `recording-session-${session.id}.mp4`);
    await TeleconferenceSession.addLog(session.id, 'recording_accessed', req.user.id, `Recording playback link issued.`).catch(() => {});
    return res.json({ success: true, data: { url } });
  } catch (error) { next(error); }
};

module.exports = {
  createSession, getMySessions, getAllSessions, getSession, pollSession,
  joinSession, redeemInvite, heartbeat, reconnectSession, admitParticipant, removeParticipant, leaveSession,
  startRecording, consentRecording, endSession,
  getSessionLogs, getMessages, postMessage, assignClient, getClients, getStaffList, stopRecording,
  roomStatusWebhook, compositionStatusWebhook, getRecording,
};
