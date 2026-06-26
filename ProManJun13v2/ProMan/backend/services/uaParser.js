/**
 * uaParser — tiny User-Agent → "Browser / OS" formatter for the Audit Logs
 * "Device Information" column (e.g. "Chrome 124 / Windows 11"). Deliberately
 * dependency-free and best-effort: unknown agents fall back to "Unknown device".
 */

function parseBrowser(ua) {
  // Order matters: Edge/Opera/Brave masquerade as Chrome, so test them first.
  const tests = [
    [/Edg(?:A|iOS)?\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/FxiOS\/(\d+)/, 'Firefox'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+).*Safari/, 'Safari'],
    [/MSIE (\d+)/, 'Internet Explorer'],
    [/Trident.*rv:(\d+)/, 'Internet Explorer'],
  ];
  for (const [re, name] of tests) {
    const m = ua.match(re);
    if (m) return m[1] ? `${name} ${m[1]}` : name;
  }
  return '';
}

function parseOS(ua) {
  if (/Windows NT 10\.0/.test(ua)) return 'Windows 10/11';
  if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
  if (/Windows NT 6\.1/.test(ua)) return 'Windows 7';
  if (/Windows/.test(ua)) return 'Windows';
  if (/iPhone|iPad|iPod/.test(ua)) {
    const m = ua.match(/OS (\d+[_\d]*)/);
    return 'iOS' + (m ? ' ' + m[1].replace(/_/g, '.') : '');
  }
  if (/Mac OS X/.test(ua)) {
    const m = ua.match(/Mac OS X (\d+[_\d]*)/);
    return 'macOS' + (m ? ' ' + m[1].replace(/_/g, '.') : '');
  }
  if (/Android/.test(ua)) {
    const m = ua.match(/Android (\d+(?:\.\d+)?)/);
    return 'Android' + (m ? ' ' + m[1] : '');
  }
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

/**
 * @param {string} ua raw User-Agent header
 * @returns {string} e.g. "Chrome 124 / Windows 10/11" or "Unknown device"
 */
function describe(ua) {
  if (!ua || typeof ua !== 'string') return 'Unknown device';
  const browser = parseBrowser(ua);
  const os = parseOS(ua);
  const label = [browser, os].filter(Boolean).join(' / ');
  return label || 'Unknown device';
}

module.exports = { describe };
