/**
 * Cloudflare Pages Functions Handler (Catch-all for /api/*)
 * Runs on Cloudflare's Edge network on your *.pages.dev domain.
 * 
 * Features:
 * - /api/probe: Health check endpoint with platform identification
 * - /api/proxy: VOD & Live stream proxying with Range seek support
 * - Automatic .mp4 / .mkv candidate resolution for Xtream & M3U VOD
 * - Manual 301/302 redirect following preserving Range, Cookie, & Auth
 * - Gzip/Brotli content-encoding strip to prevent ERR_CONTENT_DECODING_FAILED
 * - Video MIME type correction (video/mp4) preventing application/octet-stream errors
 * - M3U8 manifest URI rewriting (TS chunks & encryption keys)
 * - 206 Partial Content synthesis for video seeking
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Date, Server, Transfer-Encoding',
  'Access-Control-Max-Age': '86400',
};

function detectVideoMimeType(urlStr, contentType) {
  const ct = (contentType || '').toLowerCase().trim();
  if (ct.startsWith('video/') || ct.startsWith('audio/')) {
    return contentType;
  }
  const clean = (urlStr || '').toLowerCase().split('?')[0];
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return 'video/mp4';
  if (clean.endsWith('.mkv')) return 'video/x-matroska';
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.ts')) return 'video/mp2t';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.avi')) return 'video/x-msvideo';
  if (clean.endsWith('.flv')) return 'video/x-flv';
  if (clean.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (/\/(movie|series|vod)\//i.test(urlStr)) return 'video/mp4';
  return 'video/mp4';
}

function parseXtreamParams(targetUrl, searchParams) {
  let server = searchParams.get('xtreamServer') || '';
  let username = searchParams.get('xtreamUser') || '';
  let password = searchParams.get('xtreamPass') || '';
  let streamId = searchParams.get('xtreamStreamId') || '';
  let streamType = searchParams.get('xtreamType') || '';

  if (!username || !password) {
    try {
      const u = new URL(targetUrl);
      server = server || u.origin;
      const m = u.pathname.match(/\/(movie|series|live)\/([^/]+)\/([^/]+)\/(\d+)(?:\.([a-zA-Z0-9]+))?/i);
      if (m) {
        streamType = streamType || m[1].toLowerCase();
        username = username || decodeURIComponent(m[2]);
        password = password || decodeURIComponent(m[3]);
        streamId = streamId || m[4];
      }
    } catch {
      // ignore
    }
  }
  return { server, username, password, streamId, streamType };
}

function getVodCandidateUrls(targetUrl, xtream) {
  const candidates = [];
  const pushUnique = (u) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };

  const isVod =
    /\.(mp4|mkv|avi|mov|webm|ts|m4v)(\?|$)/i.test(targetUrl) ||
    /\/(movie|series|vod)\//i.test(targetUrl) ||
    xtream.streamType === 'movie' ||
    xtream.streamType === 'series';

  if (!isVod) {
    return [targetUrl];
  }

  // Priority 1 for Xtream VOD: request the .mp4 container endpoint first!
  // Browsers natively play MP4 without transcoding, whereas MKV fails natively in HTML5 <video>
  if (xtream.server && xtream.username && xtream.password && xtream.streamId) {
    const base = xtream.server.replace(/\/+$/, '');
    const sType = xtream.streamType || 'movie';
    const u = encodeURIComponent(xtream.username);
    const p = encodeURIComponent(xtream.password);
    const id = encodeURIComponent(xtream.streamId);
    pushUnique(`${base}/${sType}/${u}/${p}/${id}.mp4`);
    pushUnique(`${base}/${sType}/${u}/${p}/${id}.mkv`);
  }

  // If target has .mkv or .ts, prioritize .mp4 equivalent
  if (/\.(mkv|avi|wmv)(\?|$)/i.test(targetUrl)) {
    pushUnique(targetUrl.replace(/\.(mkv|avi|wmv)(\?|$)/i, '.mp4$1'));
  }
  if (/\.ts(\?|$)/i.test(targetUrl)) {
    pushUnique(targetUrl.replace(/\.ts(\?|$)/i, '.mp4$1'));
  }

  // Original target URL
  pushUnique(targetUrl);

  // If target had no extension but has /movie/ or /series/, add .mp4 and .mkv
  if (!/\.[a-zA-Z0-9]{2,5}(\?|$)/.test(targetUrl) && /\/(movie|series)\//i.test(targetUrl)) {
    const parts = targetUrl.split('?');
    pushUnique(`${parts[0]}.mp4${parts[1] ? '?' + parts[1] : ''}`);
    pushUnique(`${parts[0]}.mkv${parts[1] ? '?' + parts[1] : ''}`);
  }

  return candidates;
}

async function fetchWithRedirects(targetUrl, baseHeaders, maxRedirects = 5) {
  let currentUrl = targetUrl;
  const headers = new Headers(baseHeaders);
  const cookies = [];
  const initialCookie = headers.get('Cookie');
  if (initialCookie) cookies.push(initialCookie);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safeUrl = currentUrl.trim().replace(/ /g, '%20');
    if (cookies.length > 0) {
      headers.set('Cookie', cookies.join('; '));
    }

    const res = await fetch(safeUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      cf: {
        cacheEverything: false,
        cacheTtl: 0,
        mirage: false,
        polish: 'off',
      },
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0]?.trim();
      if (pair && !cookies.includes(pair)) cookies.push(pair);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (loc && hop < maxRedirects) {
        try {
          currentUrl = new URL(loc.trim().replace(/ /g, '%20'), currentUrl).href;
          continue;
        } catch {
          // ignore
        }
      }
    }

    return { res, finalUrl: currentUrl };
  }

  throw new Error('Too many redirects');
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // 1. Health check / probe endpoint
  if (
    url.pathname.endsWith('/probe') ||
    url.pathname.endsWith('/health') ||
    url.pathname.endsWith('/ping')
  ) {
    return new Response(
      JSON.stringify({ status: 'ok', proxy: 'cloudflare-pages', time: Date.now() }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }

  // 2. Extract target URL from query parameter or path
  let rawTargetUrl = url.searchParams.get('url') || url.searchParams.get('target');
  if (!rawTargetUrl) {
    const match = url.pathname.match(/^\/api\/(?:proxy|stream|m3u8-proxy)\/(https?:\/.+)$/i);
    if (match) {
      rawTargetUrl = match[1].replace(/^(https?:\/)(?=[^/])/, '$1/');
    }
  }

  if (!rawTargetUrl || !/^https?:\/\//i.test(rawTargetUrl.trim())) {
    return new Response(
      JSON.stringify({
        status: 'ok',
        service: 'Cloudflare Pages IPTV Proxy',
        usage: '/api/proxy?url=http://example.com/movie.mp4',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }

  const targetUrl = rawTargetUrl.trim();
  const xtream = parseXtreamParams(targetUrl, url.searchParams);

  // 3. Extract custom IPTV headers & authentication
  const customUa =
    url.searchParams.get('ua') ||
    url.searchParams.get('userAgent') ||
    request.headers.get('User-Agent') ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  const customRef = url.searchParams.get('ref') || url.searchParams.get('referer');
  const customMac = url.searchParams.get('mac') || url.searchParams.get('macAddress');
  const customCookie = url.searchParams.get('cookie') || url.searchParams.get('cookies');
  const customAuth = url.searchParams.get('auth') || url.searchParams.get('authToken');

  const upstreamHeaders = new Headers();
  upstreamHeaders.set('User-Agent', customUa);
  upstreamHeaders.set('Accept', '*/*');
  if (customRef) {
    upstreamHeaders.set('Referer', customRef);
  }

  // Authorization header (Basic auth for Xtream or Bearer token for Stalker)
  if (customAuth) {
    upstreamHeaders.set(
      'Authorization',
      /^(?:Bearer|Basic)\s+/i.test(customAuth.trim())
        ? customAuth.trim()
        : `Bearer ${customAuth.trim()}`
    );
  } else if (xtream.username && xtream.password) {
    try {
      const basicStr = btoa(`${xtream.username}:${xtream.password}`);
      upstreamHeaders.set('Authorization', `Basic ${basicStr}`);
    } catch {
      // ignore
    }
  }

  // Assemble cookies
  const cookieParts = [];
  if (customMac) {
    cookieParts.push(`mac=${customMac}`);
    cookieParts.push(`stb_sn=${customMac.replace(/[^a-zA-Z0-9]/g, '')}`);
  }
  if (customAuth) {
    cookieParts.push(`token=${customAuth}`);
  }
  if (customCookie) {
    cookieParts.push(customCookie);
  }
  if (cookieParts.length > 0) {
    upstreamHeaders.set('Cookie', cookieParts.join('; '));
  }

  // Forward Range header for video seeking & scrub
  const clientRange = request.headers.get('Range');
  if (clientRange) {
    upstreamHeaders.set('Range', clientRange);
  }

  const candidateUrls = getVodCandidateUrls(targetUrl, xtream);

  let lastResponse = null;
  let lastFinalUrl = targetUrl;
  let lastError = null;

  for (const candidate of candidateUrls) {
    try {
      const { res, finalUrl } = await fetchWithRedirects(candidate, upstreamHeaders, 5);
      const status = res.status;

      if (status >= 200 && status < 300) {
        lastResponse = res;
        lastFinalUrl = finalUrl;
        break;
      }

      // If Xtream server returned 401/403, try warming up session with player_api.php
      if (
        (status === 401 || status === 403) &&
        xtream.server &&
        xtream.username &&
        xtream.password
      ) {
        try {
          const authApi = `${xtream.server.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(
            xtream.username
          )}&password=${encodeURIComponent(xtream.password)}`;
          const authRes = await fetch(authApi, {
            headers: { 'User-Agent': 'IPTVSmartersPlayer' },
          });
          const setC = authRes.headers.get('set-cookie');
          if (setC) {
            const pair = setC.split(';')[0]?.trim();
            if (pair) {
              upstreamHeaders.set(
                'Cookie',
                cookieParts.length > 0 ? `${cookieParts.join('; ')}; ${pair}` : pair
              );
              const retry = await fetchWithRedirects(candidate, upstreamHeaders, 4);
              if (retry.res.status >= 200 && retry.res.status < 300) {
                lastResponse = retry.res;
                lastFinalUrl = retry.finalUrl;
                break;
              }
            }
          }
        } catch {
          // ignore
        }
      }

      lastResponse = res;
      lastFinalUrl = finalUrl;
    } catch (err) {
      lastError = err;
    }
  }

  if (!lastResponse) {
    return new Response(
      JSON.stringify({
        error: 'Proxy Fetch Error',
        message: lastError?.message || String(lastError),
        targetUrl,
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }

  const responseHeaders = new Headers(lastResponse.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(k, v);
  }

  // CRITICAL: Strip content-encoding!
  // Cloudflare's fetch automatically decompresses gzip/brotli streams in memory.
  // If content-encoding: gzip is left in the response headers, Chrome fails with ERR_CONTENT_DECODING_FAILED!
  responseHeaders.delete('content-encoding');

  const contentType = (lastResponse.headers.get('content-type') || '').toLowerCase();
  const isM3u8 =
    lastFinalUrl.includes('.m3u8') ||
    contentType.includes('application/vnd.apple.mpegurl') ||
    contentType.includes('application/x-mpegurl') ||
    url.pathname.includes('/m3u8-proxy');

  // 4. M3U8 Manifest Rewriting
  if (isM3u8 && lastResponse.ok && request.method !== 'HEAD') {
    const manifestText = await lastResponse.text();
    const origin = url.origin;
    const proxyEndpoint = `${origin}/api/proxy`;

    const authParams = [];
    if (customUa) authParams.push(`ua=${encodeURIComponent(customUa)}`);
    if (customRef) authParams.push(`ref=${encodeURIComponent(customRef)}`);
    if (customMac) authParams.push(`mac=${encodeURIComponent(customMac)}`);
    if (customCookie) authParams.push(`cookie=${encodeURIComponent(customCookie)}`);
    if (customAuth) authParams.push(`auth=${encodeURIComponent(customAuth)}`);
    const qsExtra = authParams.length > 0 ? `&${authParams.join('&')}` : '';

    const rewritten = manifestText
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Rewrite Encryption Keys
        if (trimmed.startsWith('#EXT-X-KEY:')) {
          return trimmed.replace(/URI=["']([^"']+)["']/i, (_match, keyUri) => {
            try {
              const absKey = new URL(keyUri, lastFinalUrl).href;
              return `URI="${proxyEndpoint}?url=${encodeURIComponent(absKey)}${qsExtra}"`;
            } catch {
              return `URI="${keyUri}"`;
            }
          });
        }

        // Preserve tags / comments
        if (trimmed.startsWith('#')) return line;

        // Rewrite segment URI
        try {
          const absSegment = new URL(trimmed, lastFinalUrl).href;
          return `${proxyEndpoint}?url=${encodeURIComponent(absSegment)}${qsExtra}`;
        } catch {
          return line;
        }
      })
      .join('\n');

    responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
    responseHeaders.delete('content-length');
    return new Response(rewritten, {
      status: lastResponse.status,
      headers: responseHeaders,
    });
  }

  // 5. Binary Media Stream Forwarding (VOD MP4/MKV/TS/WebM)
  // Ensure browser-compatible video MIME type so HTML5 <video> never throws on application/octet-stream
  const finalMime = detectVideoMimeType(lastFinalUrl, contentType);
  responseHeaders.set('Content-Type', finalMime);
  responseHeaders.set('Content-Disposition', 'inline');
  responseHeaders.set('Accept-Ranges', 'bytes');
  responseHeaders.set('X-Accel-Buffering', 'no');
  responseHeaders.set('Cache-Control', 'no-cache, no-store');

  let finalStatus = lastResponse.status;
  const cl = lastResponse.headers.get('content-length');
  const cr = lastResponse.headers.get('content-range');

  // If client requested Range starting at 0 and upstream returned 200 with Content-Length,
  // synthesize 206 Partial Content so browser video engine enables HTTP byte-range seeking
  if (
    finalStatus === 200 &&
    clientRange &&
    /^bytes=0-/i.test(clientRange.trim()) &&
    cl &&
    !cr
  ) {
    const totalLen = parseInt(cl, 10);
    if (Number.isFinite(totalLen) && totalLen > 0) {
      responseHeaders.set('Content-Range', `bytes 0-${totalLen - 1}/${totalLen}`);
      finalStatus = 206;
    }
  }

  return new Response(lastResponse.body, {
    status: finalStatus,
    statusText: lastResponse.statusText,
    headers: responseHeaders,
  });
}
