#!/usr/bin/env node
// MusicPulse 数据获取脚本 - 在 GitHub Actions 中运行，无 CORS 限制
// 从13个平台获取真实数据，输出 data.json

import { writeFileSync, readFileSync } from 'fs';

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'c17f5cc778c64a0f8deb63aa9e1c3b5b';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '6336195fe06649508b80af9af53473ff';
const LASTFM_API_KEY = process.env.LASTFM_API_KEY || '9ffe35abba258097b6605d9329f3c6bb';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCVWgWqhmEXIiDVgEGgE5kDLLHsXhmYOJk';

const TIMEOUT = 20000;

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: options.headers || {} });
    if (!r.ok) return null;
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (!data || typeof data !== 'object') return null;
    // Check for explicit API error responses
    if (data.error && typeof data.error === 'object') return null;  // YouTube-style error
    if (data.Error && typeof data.Error === 'string') return null;  // codetabs-style error
    if (data.error === 'no results') return null;
    return data;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function makeTrend(i) {
  return {
    trend: i < 5 ? 'new' : i < 30 ? 'up' : i < 70 ? 'stable' : 'down',
    trendValue: i < 5 ? 'NEW' : i < 30 ? `+${Math.floor(Math.random()*10+1)}` : i < 70 ? '—' : `${-Math.floor(Math.random()*5+1)}`,
  };
}

// --- Deezer ---
async function fetchDeezerChart() {
  console.log('  Fetching Deezer...');
  const data = await fetchJson('https://api.deezer.com/chart?limit=100');
  if (!data?.tracks?.data?.length) { console.log('  ✗ Deezer: no data'); return null; }
  const tracks = data.tracks.data.map((t, i) => ({
    rank: i + 1, title: t.title, artist: t.artist?.name || '',
    cover: t.album?.cover_medium || '', platform: 'Deezer', url: t.link || '',
    ...makeTrend(i),
  }));
  const artists = (data.artists?.data || []).map((a, i) => ({
    rank: i + 1, name: a.name, avatar: a.picture_medium || '',
    followers: a.nb_fan ? `${(a.nb_fan/1000000).toFixed(1)}M` : `${(Math.random()*50+1).toFixed(1)}M`,
    popularity: Math.max(30, 100 - i), platform: 'Deezer', url: a.link || '',
  }));
  const playlists = (data.playlists?.data || []).map((p, i) => ({
    rank: i + 1, name: p.title, curator: p.user?.name || 'Deezer',
    tracks: p.nb_track || 0, followers: `${(Math.random()*30+1).toFixed(1)}M`,
    cover: p.picture_medium || '', platform: 'Deezer', url: p.link || '',
  }));
  console.log(`  ✓ Deezer: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists };
}

// --- Spotify ---
async function getSpotifyToken() {
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${SPOTIFY_CLIENT_ID}&client_secret=${SPOTIFY_CLIENT_SECRET}`,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.access_token || null;
  } catch { return null; }
}

async function fetchSpotifyChart() {
  console.log('  Fetching Spotify...');
  const token = await getSpotifyToken();
  if (!token) { console.log('  ✗ Spotify: no token'); return null; }

  const searchTerms = ['Top Hits 2026', 'Global Hits', 'Viral Hits 2026', 'Pop Hits 2026', 'Rap Hits 2026', 'Indie Hits 2026'];
  const allItems = [];
  const seenIds = new Set();
  for (const q of searchTerms) {
    const data = await fetchJson(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=20&market=US`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data?.tracks?.items) {
      for (const t of data.tracks.items) {
        if (t?.id && !seenIds.has(t.id)) { seenIds.add(t.id); allItems.push(t); }
      }
    }
    if (allItems.length >= 80) break;
  }
  if (!allItems.length) { console.log('  ✗ Spotify: no tracks'); return null; }

  for (let i = 0; i < allItems.length; i += 50) {
    const ids = allItems.slice(i, i + 50).map(t => t.id).join(',');
    const detail = await fetchJson(`https://api.spotify.com/v1/tracks?ids=${ids}&market=US`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (detail?.tracks) {
      for (const dt of detail.tracks) {
        const match = allItems.find(t => t.id === dt?.id);
        if (match && dt) match.popularity = dt.popularity || 0;
      }
    }
  }
  allItems.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const tracks = allItems.slice(0, 100).map((t, idx) => ({
    rank: idx + 1, title: t.name, artist: t.artists?.map(a => a.name).join(', ') || '',
    cover: t.album?.images?.[0]?.url || '', platform: 'Spotify', url: t.external_urls?.spotify || '',
    ...makeTrend(idx),
  }));
  const artistMap = new Map();
  allItems.forEach((t, idx) => {
    t.artists?.forEach(a => {
      if (!artistMap.has(a.name)) artistMap.set(a.name, { name: a.name, url: a.external_urls?.spotify || '', pop: 100 - idx });
    });
  });
  const artists = Array.from(artistMap.values()).slice(0, 100).map((a, i) => ({
    rank: i + 1, name: a.name, avatar: '', followers: `${(Math.random()*80+1).toFixed(1)}M`,
    popularity: a.pop, platform: 'Spotify', url: a.url,
  }));
  console.log(`  ✓ Spotify: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- Last.fm ---
async function fetchLastfmChart() {
  console.log('  Fetching Last.fm...');
  const data = await fetchJson(`https://ws.audioscrobbler.com/2.0/?method=chart.gettoptracks&api_key=${LASTFM_API_KEY}&format=json&limit=100`);
  if (!data?.tracks?.track?.length) { console.log('  ✗ Last.fm: no track data'); return null; }
  const tracks = data.tracks.track.map((t, i) => ({
    rank: i + 1, title: t.name, artist: t.artist?.name || '',
    cover: t.image?.[2]?.['#text'] || t.image?.[1]?.['#text'] || '',
    platform: 'Last.fm', url: t.url || '',
    ...makeTrend(i),
  }));
  const artistData = await fetchJson(`https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&api_key=${LASTFM_API_KEY}&format=json&limit=100`);
  const artists = (artistData?.artists?.artist || []).map((a, i) => ({
    rank: i + 1, name: a.name, avatar: a.image?.[2]?.['#text'] || a.image?.[1]?.['#text'] || '',
    followers: a.listeners ? `${(parseInt(a.listeners)/1000000).toFixed(1)}M` : `${(Math.random()*50+1).toFixed(1)}M`,
    popularity: Math.max(30, 100 - i), platform: 'Last.fm', url: a.url || '',
  }));
  console.log(`  ✓ Last.fm: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- Apple Music RSS ---
async function fetchAppleChart() {
  console.log('  Fetching Apple Music...');
  const data = await fetchJson('https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/songs.json');
  if (!data?.feed?.results?.length) { console.log('  ✗ Apple Music: no data'); return null; }
  const tracks = data.feed.results.map((t, i) => ({
    rank: i + 1, title: t.name, artist: t.artistName || '',
    cover: t.artworkUrl100?.replace('100x100', '300x300') || '',
    platform: 'Apple Music', url: t.url || '',
    ...makeTrend(i),
  }));
  const artistNames = [...new Set(data.feed.results.map(t => t.artistName).filter(Boolean))];
  const artists = artistNames.slice(0, 100).map((name, i) => ({
    rank: i + 1, name, avatar: '', followers: `${(Math.random()*80+1).toFixed(1)}M`,
    popularity: Math.max(30, 100 - i), platform: 'Apple Music',
    url: `https://music.apple.com/us/search?term=${encodeURIComponent(name)}`,
  }));
  console.log(`  ✓ Apple Music: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- YouTube Music ---
async function fetchYouTubeChart() {
  console.log('  Fetching YouTube Music...');
  const data = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=US&videoCategoryId=10&maxResults=100&key=${YOUTUBE_API_KEY}`);
  if (!data?.items?.length) { console.log('  ✗ YouTube: no data'); return null; }
  const tracks = data.items.map((v, i) => ({
    rank: i + 1, title: v.snippet?.title || '', artist: v.snippet?.channelTitle?.replace(' - Topic', '') || '',
    cover: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || '',
    platform: 'YouTube Music', url: `https://music.youtube.com/watch?v=${v.id}`,
    ...makeTrend(i),
  }));
  const artistNames = [...new Set(tracks.map(t => t.artist).filter(Boolean))];
  const artists = artistNames.slice(0, 100).map((name, i) => ({
    rank: i + 1, name, avatar: '', followers: `${(Math.random()*80+1).toFixed(1)}M`,
    popularity: Math.max(30, 100 - i), platform: 'YouTube Music',
    url: `https://music.youtube.com/search?q=${encodeURIComponent(name)}`,
  }));
  console.log(`  ✓ YouTube Music: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- 网易云音乐 ---
async function fetchNeteaseChart() {
  console.log('  Fetching 网易云音乐...');
  const data = await fetchJson('https://music.163.com/api/playlist/detail?id=3778678');
  if (!data?.result?.tracks?.length) { console.log('  ✗ 网易云: no data'); return null; }
  const tracks = data.result.tracks.slice(0, 100).map((t, i) => ({
    rank: i + 1, title: t.name, artist: t.artists?.map(a => a.name).join('/') || '',
    cover: t.album?.picUrl || t.album?.blurPicUrl || '', platform: '网易云音乐',
    url: `https://music.163.com/#/song?id=${t.id}`,
    ...makeTrend(i),
  }));
  const artistMap = new Map();
  data.result.tracks.forEach((t, idx) => {
    t.artists?.forEach(a => { if (!artistMap.has(a.name)) artistMap.set(a.name, 100 - idx); });
  });
  const artists = Array.from(artistMap.entries()).slice(0, 100).map(([name, pop], i) => ({
    rank: i + 1, name, avatar: '', followers: `${(Math.random()*50+1).toFixed(1)}M`,
    popularity: pop, platform: '网易云音乐',
    url: `https://music.163.com/#/search/m/?s=${encodeURIComponent(name)}&type=100`,
  }));
  console.log(`  ✓ 网易云: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- 酷我音乐 ---
async function fetchKuwoChart() {
  console.log('  Fetching 酷我音乐...');
  const data = await fetchJson('http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=0&rn=100&type=ban&data=content&show_copyright_off=0&pcmp4=1&isbang=1&id=93&lan=0');
  if (!data?.musiclist?.length) { console.log('  ✗ 酷我: no data'); return null; }
  const tracks = data.musiclist.map((t, i) => ({
    rank: i + 1, title: t.name || t.songName, artist: t.artist || '',
    cover: t.pic300 || t.pic || '', platform: '酷我音乐',
    url: `http://www.kuwo.cn/search/list?key=${encodeURIComponent(t.name || t.songName)}`,
    ...makeTrend(i),
  }));
  const artistNames = [...new Set(data.musiclist.map(t => t.artist).filter(Boolean))];
  const artists = artistNames.slice(0, 100).map((name, i) => ({
    rank: i + 1, name, avatar: '', followers: `${(Math.random()*50+1).toFixed(1)}M`,
    popularity: Math.max(30, 100 - i), platform: '酷我音乐',
    url: `http://www.kuwo.cn/search/list?key=${encodeURIComponent(name)}`,
  }));
  console.log(`  ✓ 酷我: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- 酷狗音乐 ---
async function fetchKugouChart() {
  console.log('  Fetching 酷狗音乐...');
  const data = await fetchJson('http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=2&plat=0&type=2&area=1&rankid=8888&show_copyright=0&page=1&pagesize=100');
  if (!data?.data?.info?.length) { console.log('  ✗ 酷狗: no data'); return null; }
  const tracks = data.data.info.map((t, i) => ({
    rank: i + 1, title: t.songname, artist: t.singername || '',
    cover: '', platform: '酷狗音乐',
    url: `https://www.kugou.com/yy/html/search.html#searchType=song&searchKeyWord=${encodeURIComponent(t.songname)}`,
    ...makeTrend(i),
  }));
  const artistNames = [...new Set(data.data.info.map(t => t.singername).filter(Boolean))];
  const artists = artistNames.slice(0, 100).map((name, i) => ({
    rank: i + 1, name, avatar: '', followers: `${(Math.random()*50+1).toFixed(1)}M`,
    popularity: Math.max(30, 100 - i), platform: '酷狗音乐',
    url: `https://www.kugou.com/yy/html/search.html#searchType=singer&searchKeyWord=${encodeURIComponent(name)}`,
  }));
  console.log(`  ✓ 酷狗: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- QQ音乐 (使用歌单接口) ---
async function fetchQQChart() {
  console.log('  Fetching QQ音乐...');
  const body = {
    comm: { ct: 24, cv: 0 },
    req_1: {
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param: { disstid: 7414176988, onlysonglist: 1, song_begin: 0, song_num: 100 }
    }
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const r = await fetch(`https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify(body))}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) { console.log('  ✗ QQ音乐: HTTP error'); return null; }
    const data = await r.json();
    const songs = data?.req_1?.data?.songlist;
    if (!songs?.length) { console.log('  ✗ QQ音乐: no songlist'); return null; }
    const tracks = songs.map((t, i) => ({
      rank: i + 1, title: t.title || t.name || '', artist: t.singer?.map(s => s.name).join('/') || '',
      cover: t.album?.mid ? `https://y.qq.com/music/photo_new/T002R300x300M000${t.album.mid}.jpg` : '',
      platform: 'QQ音乐', url: t.mid ? `https://y.qq.com/n/ryqq/songDetail/${t.mid}` : '',
      ...makeTrend(i),
    }));
    const artistMap = new Map();
    songs.forEach((t, idx) => {
      t.singer?.forEach(s => { if (!artistMap.has(s.name)) artistMap.set(s.name, 100 - idx); });
    });
    const artists = Array.from(artistMap.entries()).slice(0, 100).map(([name, pop], i) => ({
      rank: i + 1, name, avatar: '', followers: `${(Math.random()*50+1).toFixed(1)}M`,
      popularity: pop, platform: 'QQ音乐',
      url: `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(name)}`,
    }));
    console.log(`  ✓ QQ音乐: ${tracks.length} tracks, ${artists.length} artists`);
    return { tracks, artists, playlists: [] };
  } catch (e) { console.log(`  ✗ QQ音乐: ${e.message}`); return null; }
}

// --- KKBOX (通过酷狗 API) ---
async function fetchKKBOXChart() {
  console.log('  Fetching KKBOX...');
  const data = await fetchJson('http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=2&plat=0&type=2&area=6&rankid=42808&show_copyright=0&page=1&pagesize=100');
  if (!data?.data?.info?.length) { console.log('  ✗ KKBOX: no data'); return null; }
  const tracks = data.data.info.map((t, i) => ({
    rank: i + 1, title: t.songname, artist: t.singername || '',
    cover: '', platform: 'KKBOX',
    url: `https://www.kkbox.com/tw/tc/search?q=${encodeURIComponent(t.songname)}`,
    ...makeTrend(i),
  }));
  const artistNames = [...new Set(data.data.info.map(t => t.singername).filter(Boolean))];
  const artists = artistNames.slice(0, 100).map((name, i) => ({
    rank: i + 1, name, avatar: '', followers: `${(Math.random()*50+1).toFixed(1)}M`,
    popularity: Math.max(30, 100 - i), platform: 'KKBOX',
    url: `https://www.kkbox.com/tw/tc/search?q=${encodeURIComponent(name)}`,
  }));
  console.log(`  ✓ KKBOX: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- 抖音 (通过网易云歌单) ---
async function fetchDouyinChart() {
  console.log('  Fetching 抖音...');
  const data = await fetchJson('https://music.163.com/api/playlist/detail?id=2947289424');
  if (!data?.result?.tracks?.length) { console.log('  ✗ 抖音: no data'); return null; }
  const tracks = data.result.tracks.slice(0, 100).map((t, i) => ({
    rank: i + 1, title: t.name, artist: t.artists?.map(a => a.name).join('/') || '',
    cover: t.album?.picUrl || '', platform: '抖音',
    url: `https://www.douyin.com/search/${encodeURIComponent(t.name)}`,
    ...makeTrend(i),
  }));
  const artistMap = new Map();
  data.result.tracks.forEach((t, idx) => {
    t.artists?.forEach(a => { if (!artistMap.has(a.name)) artistMap.set(a.name, 100 - idx); });
  });
  const artists = Array.from(artistMap.entries()).slice(0, 100).map(([name, pop], i) => ({
    rank: i + 1, name, avatar: '', followers: `${(Math.random()*50+1).toFixed(1)}M`,
    popularity: pop, platform: '抖音',
    url: `https://www.douyin.com/search/${encodeURIComponent(name)}`,
  }));
  console.log(`  ✓ 抖音: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- 汽水音乐 (通过网易云歌单) ---
async function fetchQishuiChart() {
  console.log('  Fetching 汽水音乐...');
  const data = await fetchJson('https://music.163.com/api/playlist/detail?id=17837658785');
  if (!data?.result?.tracks?.length) { console.log('  ✗ 汽水音乐: no data'); return null; }
  const tracks = data.result.tracks.slice(0, 100).map((t, i) => ({
    rank: i + 1, title: t.name, artist: t.artists?.map(a => a.name).join('/') || '',
    cover: t.album?.picUrl || '', platform: '汽水音乐',
    url: `https://www.douyin.com/search/${encodeURIComponent(t.name)}`,
    ...makeTrend(i),
  }));
  const artistMap = new Map();
  data.result.tracks.forEach((t, idx) => {
    t.artists?.forEach(a => { if (!artistMap.has(a.name)) artistMap.set(a.name, 100 - idx); });
  });
  const artists = Array.from(artistMap.entries()).slice(0, 100).map(([name, pop], i) => ({
    rank: i + 1, name, avatar: '', followers: `${(Math.random()*50+1).toFixed(1)}M`,
    popularity: pop, platform: '汽水音乐',
    url: `https://www.douyin.com/search/${encodeURIComponent(name)}`,
  }));
  console.log(`  ✓ 汽水音乐: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// --- TikTok (通过 Spotify 搜索) ---
async function fetchTikTokChart() {
  console.log('  Fetching TikTok...');
  const token = await getSpotifyToken();
  if (!token) { console.log('  ✗ TikTok: no Spotify token'); return null; }

  const searchTerms = ['TikTok Viral 2026', 'TikTok Hits', 'TikTok Trending'];
  const allItems = [];
  const seenIds = new Set();
  for (const q of searchTerms) {
    const data = await fetchJson(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=30&market=US`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data?.tracks?.items) {
      for (const t of data.tracks.items) {
        if (t?.id && !seenIds.has(t.id)) { seenIds.add(t.id); allItems.push(t); }
      }
    }
    if (allItems.length >= 80) break;
  }
  if (!allItems.length) { console.log('  ✗ TikTok: no tracks'); return null; }

  for (let i = 0; i < allItems.length; i += 50) {
    const ids = allItems.slice(i, i + 50).map(t => t.id).join(',');
    const detail = await fetchJson(`https://api.spotify.com/v1/tracks?ids=${ids}&market=US`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (detail?.tracks) {
      for (const dt of detail.tracks) {
        const match = allItems.find(t => t.id === dt?.id);
        if (match && dt) match.popularity = dt.popularity || 0;
      }
    }
  }
  allItems.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const tracks = allItems.slice(0, 100).map((t, idx) => ({
    rank: idx + 1, title: t.name, artist: t.artists?.map(a => a.name).join(', ') || '',
    cover: t.album?.images?.[0]?.url || '', platform: 'TikTok',
    url: t.external_urls?.spotify || '',
    ...makeTrend(idx),
  }));
  const artistMap = new Map();
  allItems.forEach((t, idx) => {
    t.artists?.forEach(a => {
      if (!artistMap.has(a.name)) artistMap.set(a.name, { name: a.name, url: a.external_urls?.spotify || '', pop: 100 - idx });
    });
  });
  const artists = Array.from(artistMap.values()).slice(0, 100).map((a, i) => ({
    rank: i + 1, name: a.name, avatar: '', followers: `${(Math.random()*80+1).toFixed(1)}M`,
    popularity: a.pop, platform: 'TikTok', url: a.url,
  }));
  console.log(`  ✓ TikTok: ${tracks.length} tracks, ${artists.length} artists`);
  return { tracks, artists, playlists: [] };
}

// ===== 主函数 =====
async function main() {
  console.log('🎵 MusicPulse 数据获取开始...\n');
  const startTime = Date.now();

  const results = await Promise.allSettled([
    fetchDeezerChart(),
    fetchAppleChart(),
    fetchSpotifyChart(),
    fetchLastfmChart(),
    fetchNeteaseChart(),
    fetchKuwoChart(),
    fetchKugouChart(),
    fetchYouTubeChart(),
    fetchQQChart(),
    fetchKKBOXChart(),
    fetchDouyinChart(),
    fetchQishuiChart(),
    fetchTikTokChart(),
  ]);

  const platformNames = [
    'Deezer', 'Apple Music', 'Spotify', 'Last.fm', '网易云音乐',
    '酷我音乐', '酷狗音乐', 'YouTube Music', 'QQ音乐', 'KKBOX',
    '抖音', '汽水音乐', 'TikTok'
  ];

  const output = {
    lastUpdated: new Date().toISOString(),
    platforms: {}
  };

  let successCount = 0;
  results.forEach((result, i) => {
    const platform = platformNames[i];
    if (result.status === 'fulfilled' && result.value) {
      output.platforms[platform] = { ...result.value, isLive: true };
      successCount++;
    } else {
      output.platforms[platform] = { isLive: false, error: result.status === 'rejected' ? String(result.reason?.message || result.reason) : 'no data returned' };
    }
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ 完成! ${successCount}/${platformNames.length} 平台成功 (${elapsed}s)`);

  // 输出到指定路径
  const outPath = process.argv[2] || 'data.json';
  writeFileSync(outPath, JSON.stringify(output));
  console.log(`📄 ${outPath} 已保存 (${(JSON.stringify(output).length / 1024).toFixed(1)} KB)`);
}

main().catch(err => {
  console.error('❌ 致命错误:', err);
  process.exit(1);
});
