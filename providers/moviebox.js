/**
 * MovieBox H5 provider — works without TMDB_API_KEY.
 * Resolves title via TMDB HTML page (or API if key present), then
 * searches h5-api.aoneroom.com and returns playable MP4 qualities.
 */
const axios = require('axios');

const H5_API = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const HOSTS = [
  'moviebox.ph',
  'movie-box.co',
  'movieboxonline.net',
  'movieboxhd.net',
];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DUMMY = ['/other/', 'b164fbfb', 'please-update', 'please_update'];

let tokenCache = { token: null, exp: 0 };
let hostIndex = 0;

function pickHost() {
  return HOSTS[hostIndex % HOSTS.length];
}

function defaultHeaders(host) {
  return {
    'User-Agent': UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Client-Info': '{"timezone":"Asia/Kolkata"}',
    'X-Request-Lang': 'en',
    'X-Source': 'moviebox',
    Origin: `https://${host}`,
    Referer: `https://${host}/`,
  };
}

async function bootstrapToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const host = pickHost();
  const url = `${H5_API}/subject/trending?page=1&perPage=1`;
  const res = await axios.get(url, {
    headers: defaultHeaders(host),
    timeout: 15000,
    validateStatus: () => true,
  });
  const xUser = res.headers['x-user'] || res.headers['X-User'];
  if (!xUser) throw new Error('MovieBox bootstrap: no x-user header');
  const data = typeof xUser === 'string' ? JSON.parse(xUser) : xUser;
  const token = data.token || data.accessToken;
  if (!token) throw new Error('MovieBox bootstrap: empty token');
  tokenCache = { token, exp: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function h5Get(path, referer) {
  const host = pickHost();
  const token = await bootstrapToken();
  const url = path.startsWith('http') ? path : `${H5_API}${path}`;
  const headers = {
    ...defaultHeaders(host),
    Authorization: `Bearer ${token}`,
    Referer: referer || `https://${host}/`,
  };
  let res = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
  if (res.status === 401 || res.status === 441) {
    tokenCache = { token: null, exp: 0 };
    const t2 = await bootstrapToken();
    headers.Authorization = `Bearer ${t2}`;
    res = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
  }
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    res = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
  }
  if (res.status >= 400) {
    throw new Error(`H5 ${res.status}: ${String(res.data).slice(0, 120)}`);
  }
  return res.data;
}

async function h5Post(path, body) {
  const host = pickHost();
  const token = await bootstrapToken();
  const url = `${H5_API}${path}`;
  const headers = {
    ...defaultHeaders(host),
    Authorization: `Bearer ${token}`,
  };
  let res = await axios.post(url, body, { headers, timeout: 20000, validateStatus: () => true });
  if (res.status === 401 || res.status === 441) {
    tokenCache = { token: null, exp: 0 };
    headers.Authorization = `Bearer ${await bootstrapToken()}`;
    res = await axios.post(url, body, { headers, timeout: 20000, validateStatus: () => true });
  }
  if (res.status >= 400) {
    throw new Error(`H5 POST ${res.status}`);
  }
  return res.data;
}

/** Resolve movie/TV title without requiring TMDB API key. */
async function resolveTitle(tmdbId, mediaType) {
  // 1) Official API if key present
  try {
    const { getTmdbApiKey } = require('../utils/tmdbKey');
    const key = getTmdbApiKey();
    if (key && key !== 'your_tmdb_api_key' && String(key).length > 10) {
      const kind = mediaType === 'tv' ? 'tv' : 'movie';
      const { data } = await axios.get(
        `https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${key}&language=en-US`,
        { timeout: 10000 }
      );
      const title = data.title || data.name || data.original_title || data.original_name;
      if (title) return { title, year: (data.release_date || data.first_air_date || '').slice(0, 4) };
    }
  } catch (_e) {
    /* fall through */
  }

  // 2) Scrape TMDB public page
  try {
    const kind = mediaType === 'tv' ? 'tv' : 'movie';
    const page = await axios.get(`https://www.themoviedb.org/${kind}/${tmdbId}`, {
      timeout: 12000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      validateStatus: () => true,
    });
    const html = page.data || '';
    const m = String(html).match(/<title>([^<]+)<\/title>/i);
    if (m) {
      let raw = m[1]
        .replace(/&#\d+;/g, ' ')
        .replace(/&mdash;|&ndash;|—|–/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
      // "Pathaan (2023) - The Movie Database (TMDB)"
      raw = raw.replace(/\s*[-—]\s*The Movie Database.*$/i, '').trim();
      const ym = raw.match(/\((\d{4})\)\s*$/);
      const year = ym ? ym[1] : '';
      const title = raw.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      if (
        title &&
        !/moved permanently|not found|error|just a moment|attention required|cloudflare|access denied/i.test(title)
      ) {
        return { title, year };
      }
    }
  } catch (_e) {
    /* fall through */
  }

  return null;
}

function normalizeItems(raw) {
  const items =
    (raw && raw.data && (raw.data.items || raw.data.subjects || raw.data.list)) ||
    (raw && raw.items) ||
    [];
  return items
    .map((it) => {
      const sub = it.subject || it;
      return {
        subjectId: String(sub.subjectId || sub.id || ''),
        title: sub.title || sub.name || '',
        detailPath: sub.detailPath || sub.path || '',
        subjectType: sub.subjectType || sub.type || 1,
      };
    })
    .filter((x) => x.subjectId);
}

function scoreTitle(query, candidate) {
  const q = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const c = candidate.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (c === q) return 100;
  if (c.includes(q) || q.includes(c)) return 80;
  const qw = q.split(' ').filter(Boolean);
  const hit = qw.filter((w) => c.includes(w)).length;
  return Math.round((hit / Math.max(qw.length, 1)) * 60);
}

async function searchMovieBox(title) {
  // Try POST search
  try {
    const raw = await h5Post('/subject/search', {
      keyword: title,
      page: 1,
      perPage: 10,
      type: 0,
    });
    const items = normalizeItems(raw);
    if (items.length) return items;
  } catch (_e) {
    /* try GET */
  }
  try {
    const raw = await h5Get(
      `/subject/search?keyword=${encodeURIComponent(title)}&page=1&perPage=10`
    );
    return normalizeItems(raw);
  } catch (_e) {
    return [];
  }
}

async function getPlayStreams(subjectId, detailPath, se = 0, ep = 0) {
  const streams = [];
  const seen = new Set();
  for (let i = 0; i < HOSTS.length; i++) {
    const host = HOSTS[(hostIndex + i) % HOSTS.length];
    const playUrl =
      `${H5_API}/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}` +
      `&detailPath=${encodeURIComponent(detailPath)}&streamSignType=1` +
      `&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1`;
    const referer =
      `https://${host}/movies/${detailPath}?id=${subjectId}` +
      `&type=/movie/detail&detailSe=&detailEp=&lang=en`;
    try {
      const raw = await h5Get(playUrl, referer);
      const data = (raw && raw.data) || raw || {};
      const list = data.streams || data.streamList || data.downloads || [];
      for (const s of list) {
        const url = s.url || s.playUrl || '';
        if (!url || seen.has(url)) continue;
        if (DUMMY.some((d) => url.toLowerCase().includes(d))) continue;
        const duration = parseInt(s.duration || s.durationSec || 0, 10);
        if (duration && duration < 90) continue;
        const resRaw = s.resolutions || s.resolution || s.quality || s.height || 0;
        let resInt = parseInt(String(resRaw).replace(/p/gi, '').split('x').pop(), 10);
        if (isNaN(resInt)) resInt = 0;
        seen.add(url);
        streams.push({
          name: 'MovieBox',
          title: `MovieBox - ${resInt ? resInt + 'p' : 'Auto'}`,
          url,
          quality: resInt ? String(resInt) : 'Auto',
          provider: 'MovieBox',
          headers: {
            Referer: `https://${host}/`,
            Origin: `https://${host}`,
            'User-Agent': UA,
          },
        });
      }
      if (streams.length) {
        hostIndex = (hostIndex + i) % HOSTS.length;
        break;
      }
    } catch (_e) {
      /* try next host */
    }
  }
  streams.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
  return streams;
}

async function getMovieboxStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
  console.log(`[MovieBox] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
  try {
    const meta = await resolveTitle(tmdbId, mediaType);
    if (!meta || !meta.title) {
      console.log('[MovieBox] Could not resolve title for TMDB', tmdbId);
      return [];
    }
    console.log(`[MovieBox] Resolved title: ${meta.title} (${meta.year || '?'})`);

    // Prefer year-qualified search then plain
    const queries = [];
    if (meta.year) queries.push(`${meta.title} ${meta.year}`);
    queries.push(meta.title);

    let best = null;
    let bestScore = -1;
    for (const q of queries) {
      const items = await searchMovieBox(q);
      for (const it of items) {
        // Skip pure music/shorts type if looking for movie
        if (mediaType === 'movie' && it.subjectType === 6) continue;
        const sc = scoreTitle(meta.title, it.title);
        if (sc > bestScore) {
          bestScore = sc;
          best = it;
        }
      }
      if (bestScore >= 80) break;
    }

    if (!best || bestScore < 40) {
      console.log('[MovieBox] No good title match, bestScore=', bestScore);
      return [];
    }
    console.log(`[MovieBox] Match: ${best.title} (${best.subjectId}) score=${bestScore}`);

    const se = mediaType === 'tv' ? seasonNum || 1 : 0;
    const ep = mediaType === 'tv' ? episodeNum || 1 : 0;
    const streams = await getPlayStreams(best.subjectId, best.detailPath, se, ep);
    console.log(`[MovieBox] Got ${streams.length} stream(s)`);
    return streams;
  } catch (e) {
    console.log('[MovieBox] Error:', e.message);
    return [];
  }
}

module.exports = { getMovieboxStreams };
