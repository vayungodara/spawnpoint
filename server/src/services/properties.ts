import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { serverDir } from './servers.js';

// Line-preserving server.properties editor. Comments, ordering and unknown
// keys survive round-trips; only patched keys change. A .bak of the previous
// file is kept on every write.

type Line = { kind: 'kv'; key: string; value: string } | { kind: 'raw'; text: string };

function propsPath(uuid: string): string {
  return join(serverDir(uuid), 'server.properties');
}

function parse(text: string): Line[] {
  return text.split(/\r?\n/).map((line): Line => {
    if (/^\s*[#!]/.test(line) || line.trim() === '') return { kind: 'raw', text: line };
    const i = line.indexOf('=');
    if (i < 0) return { kind: 'raw', text: line };
    return { kind: 'kv', key: line.slice(0, i).trim(), value: line.slice(i + 1) };
  });
}

/** Unescape java-properties style values (MOTD § arrives as §).
    Single left-to-right pass: a two-pass version collapsed `\\=` wrongly (it
    unescaped the `=` first, then ate the backslash) and mangled the value. */
function unescapeValue(v: string): string {
  return v.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, esc: string) => {
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc === 'n') return '\n';
    if (esc === 'r') return '\r';
    if (esc === 't') return '\t';
    return esc; // \\ \: \= and anything else: the character itself
  });
}

/** Escape a value the way java.util.Properties expects.
    Non-ASCII (§, emoji) → \uXXXX; and the structural characters a value must
    never contain raw: a newline in an MOTD used to write a SECOND physical
    line, injecting a whole extra property into server.properties. Emoji are
    astral-plane: iterating code points but reading charCodeAt(0) emitted a
    lone high surrogate and dropped the rest — encode both halves. */
function escapeValue(v: string): string {
  let out = '';
  for (const ch of v) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '=' || ch === ':') out += `\\${ch}`;
    else if (code > 126) {
      // \uXXXX is UTF-16-based: anything above the BMP needs its surrogate pair
      for (let i = 0; i < ch.length; i++) {
        out += '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0');
      }
    } else out += ch;
  }
  return out;
}

export function readProperties(uuid: string): Record<string, string> {
  const file = propsPath(uuid);
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const l of parse(readFileSync(file, 'utf8'))) {
    if (l.kind === 'kv') out[l.key] = unescapeValue(l.value);
  }
  return out;
}

export function patchProperties(uuid: string, patch: Record<string, string>): void {
  const file = propsPath(uuid);
  const lines = existsSync(file) ? parse(readFileSync(file, 'utf8')) : [];
  const pending = new Map(Object.entries(patch));

  const next = lines.map((l) => {
    if (l.kind === 'kv' && pending.has(l.key)) {
      const value = escapeValue(pending.get(l.key)!);
      pending.delete(l.key);
      return { ...l, value };
    }
    return l;
  });
  // append keys that didn't exist yet
  for (const [key, value] of pending) next.push({ kind: 'kv', key, value: escapeValue(value) });

  const text = next
    .map((l) => (l.kind === 'kv' ? `${l.key}=${l.value}` : l.text))
    .join('\n');

  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}
