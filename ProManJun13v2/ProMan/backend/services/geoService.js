/**
 * geoService — IP geolocation via the local MaxMind GeoLite2-City database.
 * ─────────────────────────────────────────────────────────────────────────
 * Replaces the paid criminalip.io dependency. Lookups are fully offline:
 * the .mmdb file lives in backend/geo/ and no client IP ever leaves the server
 * (important for a clinic handling sensitive data). If the DB file is missing
 * or an IP is private/unresolvable, lookups degrade gracefully to a label
 * rather than throwing.
 *
 * DB refresh: re-download GeoLite2-City.mmdb periodically (MaxMind updates it
 * roughly twice a week) into backend/geo/. No code change needed.
 */
const path = require('path');
const fs = require('fs');
const https = require('https');

const DB_PATH = path.join(__dirname, '..', 'geo', 'GeoLite2-City.mmdb');

let readerPromise = null;

// ── Server public-IP cache ──────────────────────────────────────────────────
// In local development the client connects over loopback (::1 / 127.0.0.1), which
// has no gelocation. To still show a real IP + location on the Audit Logs, we
// resolve the SERVER's own public IP once (the network the app runs on) and use
// it as the fallback for any private/loopback request. Cached for 1 hour.
let publicIpCache = { ip: null, at: 0 };
const PUBLIC_IP_TTL = 60 * 60 * 1000;

function fetchPublicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).ip || null); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function ensurePublicIp() {
  if (publicIpCache.ip && (Date.now() - publicIpCache.at) < PUBLIC_IP_TTL) return publicIpCache.ip;
  const ip = await fetchPublicIp();
  if (ip) publicIpCache = { ip, at: Date.now() };
  return ip;
}

/**
 * Lazily open the GeoLite2 reader once and cache the promise.
 * Returns null (and logs once) if the DB or the library is unavailable.
 */
function getReader() {
  if (readerPromise) return readerPromise;
  readerPromise = (async () => {
    try {
      if (!fs.existsSync(DB_PATH)) {
        console.warn('🌍 geoService: GeoLite2-City.mmdb not found at', DB_PATH, '— geolocation disabled.');
        return null;
      }
      const { Reader } = require('@maxmind/geoip2-node');
      const reader = await Reader.open(DB_PATH);
      console.log('🌍 geoService: GeoLite2-City database loaded.');
      return reader;
    } catch (err) {
      console.warn('🌍 geoService: failed to open GeoLite2 DB —', err.message);
      return null;
    }
  })();
  return readerPromise;
}

/** True for loopback / private / link-local addresses that GeoLite2 can't resolve. */
function isPrivate(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.')) return true;
  if (ip === 'localhost' || ip === 'unknown') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^(::ffff:)?fc|^fe80:/i.test(ip)) return true;
  return false;
}

/** Normalize an IP string (strip IPv4-mapped IPv6 prefix, take first XFF hop). */
function normalizeIp(ip) {
  if (!ip) return '';
  let v = String(ip).split(',')[0].trim();
  if (v.startsWith('::ffff:')) v = v.slice(7);
  return v;
}

/**
 * Resolve an IP to a human-readable location string, e.g. "Quezon City, Philippines".
 * @param {string} ip
 * @returns {Promise<string>} location label ('' for private/unknown)
 */
async function lookup(ip) {
  const v = normalizeIp(ip);
  if (isPrivate(v)) return 'Local network';
  const reader = await getReader();
  if (!reader) return '';
  try {
    const r = reader.city(v);
    const city = r.city && r.city.names && r.city.names.en;
    const region = r.subdivisions && r.subdivisions[0] && r.subdivisions[0].names && r.subdivisions[0].names.en;
    const country = r.country && r.country.names && r.country.names.en;
    // Prefer "City, Country"; fall back to "Region, Country" when no city.
    return [city || region, country].filter(Boolean).join(', ') || '';
  } catch (_) {
    return ''; // address not found in DB
  }
}

/**
 * Resolve an IP to BOTH a display IP and a location. For private/loopback
 * addresses (local dev), substitutes the server's public IP so the Audit Logs
 * show a real address + geographic location instead of "::1 / Local network".
 * @returns {Promise<{ip:string, location:string}>}
 */
async function locate(rawIp) {
  const v = normalizeIp(rawIp);
  if (!isPrivate(v)) {
    return { ip: v, location: await lookup(v) };
  }
  // Private/loopback → try the server's public IP.
  const pub = await ensurePublicIp();
  if (pub) {
    const loc = await lookup(pub);
    return { ip: pub, location: loc || 'Local network' };
  }
  return { ip: v || 'unknown', location: 'Local network' };
}

/** Batch helper: resolve many raw IPs → Map(rawIp -> {ip, location}). Deduplicates. */
async function locateMany(ips) {
  const unique = [...new Set((ips || []).filter(Boolean))];
  const out = new Map();
  await Promise.all(unique.map(async (ip) => { out.set(ip, await locate(ip)); }));
  return out;
}

/** Batch helper: resolve many IPs, returns a Map(ip -> label). Deduplicates. */
async function lookupMany(ips) {
  const unique = [...new Set((ips || []).filter(Boolean))];
  const out = new Map();
  await Promise.all(unique.map(async (ip) => { out.set(ip, await lookup(ip)); }));
  return out;
}

module.exports = { lookup, lookupMany, locate, locateMany, normalizeIp, isPrivate };
