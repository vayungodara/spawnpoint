import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PATHS } from '../config.js';
import { IS_WIN, KILLABLE_SPAWN_OPTS, killTree } from './platform.js';

// Reading a tutorial the way a player would. For redstone and farm designs the
// good material is on YouTube, not in prose — so the genie can ask for a video
// and get its transcript back as text.
//
// Why yt-dlp and not fetch(): YouTube's /api/timedtext now answers a plain
// request with "200 OK" and an EMPTY BODY unless the caller carries a
// proof-of-origin token from a real browser session. Scraping the watch page,
// and the InnerTube player API on the iOS/Android/TV clients, all hit the same
// wall. yt-dlp does the token dance; nothing else here does.

const YTDLP = IS_WIN ? join(PATHS.root, 'Tools', 'yt-dlp.exe') : join(PATHS.root, 'Tools', 'yt-dlp');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export interface Video { id: string; title: string }

/** Search results come off the public results page — no API key, no quota. */
export async function searchYoutube(query: string, limit = 4): Promise<Video[]> {
  const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const ids: string[] = [];
  const titles = new Map<string, string>();
  // ids and titles appear interleaved in ytInitialData; pair them by order
  const idMatches = [...html.matchAll(/"videoId":"([\w-]{11})"/g)].map((m) => m[1]);
  const titleMatches = [...html.matchAll(/"title":\{"runs":\[\{"text":"(.*?)"\}\]/g)].map((m) => m[1]);
  for (const id of idMatches) {
    if (ids.includes(id)) continue;
    titles.set(id, titleMatches[ids.length] ?? '');
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids.map((id) => ({ id, title: (titles.get(id) ?? '').replace(/\\u[\dA-Fa-f]{4}/g, '') }));
}

function run(cmd: string, args: string[], ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, KILLABLE_SPAWN_OPTS);
    const watchdog = setTimeout(() => {
      if (child.pid) killTree(child.pid);
      reject(new Error('yt-dlp timed out'));
    }, ms);
    child.on('close', () => { clearTimeout(watchdog); resolve(); });
    child.on('error', (e) => { clearTimeout(watchdog); reject(e); });
  });
}

/** Pull a video's captions (manual if present, else auto-generated) as plain
    text. Returns '' when the video simply has none. */
export async function transcript(videoId: string, maxChars = 6000): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sp-yt-'));
  try {
    await run(
      YTDLP,
      [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        'en.*',
        '--sub-format',
        'json3',
        '--no-warnings',
        '--quiet',
        '-o',
        join(dir, 'cap'),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      60_000,
    );
    // prefer the human-written track over the auto one when both landed
    const files = readdirSync(dir).filter((f) => f.endsWith('.json3'));
    const pick = files.find((f) => !f.includes('-orig')) ?? files[0];
    if (!pick) return '';
    const j = JSON.parse(readFileSync(join(dir, pick), 'utf8'));
    const text: string = (j.events ?? [])
      .flatMap((e: { segs?: { utf8: string }[] }) => (e.segs ?? []).map((s) => s.utf8))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, maxChars);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One call for the genie: search, then read the best transcript we can get.
    Videos with captions disabled are skipped rather than reported as failure. */
export async function youtubeResearch(query: string): Promise<string> {
  let hits: Video[];
  try {
    hits = await searchYoutube(query);
  } catch (e) {
    return `YOUTUBE ${query}: search failed (${String(e).slice(0, 80)})`;
  }
  if (hits.length === 0) return `YOUTUBE ${query}: no results`;

  for (const v of hits) {
    try {
      const text = await transcript(v.id);
      if (text.length > 200) {
        return [
          `YOUTUBE "${query}" → "${v.title}" (https://youtu.be/${v.id})`,
          `Transcript (auto-captions, so block names may be misspelled — use judgement):`,
          text,
        ].join('\n');
      }
    } catch {
      // try the next result
    }
  }
  return `YOUTUBE ${query}: found ${hits.map((v) => v.title).join(' | ')} — but none had usable captions`;
}
