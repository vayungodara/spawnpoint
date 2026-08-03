import { gzipSync, gunzipSync } from 'node:zlib';

// Minimal Java-NBT codec (big-endian), just enough for schematic conversion.
// Values are tagged so a parse → serialize round-trip is lossless:
//   { t: TagId, v: payload }         — scalars, arrays, compound (v = record)
//   { t: 9, of: TagId, v: Tag[] }    — lists remember their element type
// Longs are BigInt (litematic bit-packing needs all 64 bits).

export const TAG = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
} as const;

export interface Tag { t: number; of?: number; v: unknown }
export type Compound = Record<string, Tag>;

// ---- constructors (used when building structure NBT) ----
export const nByte = (v: number): Tag => ({ t: TAG.Byte, v });
export const nInt = (v: number): Tag => ({ t: TAG.Int, v });
export const nString = (v: string): Tag => ({ t: TAG.String, v });
export const nList = (of: number, v: Tag[]): Tag => ({ t: TAG.List, of, v });
export const nCompound = (v: Compound): Tag => ({ t: TAG.Compound, v });

class Reader {
  pos = 0;
  constructor(private buf: Buffer) {}
  u8() { return this.buf.readUInt8(this.pos++); }
  i8() { return this.buf.readInt8(this.pos++); }
  i16() { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u16() { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  f32() { const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f64() { const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  str() { const n = this.u16(); const s = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return s; }
  bytes(n: number) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}

function readPayload(r: Reader, t: number): Tag {
  switch (t) {
    case TAG.Byte: return { t, v: r.i8() };
    case TAG.Short: return { t, v: r.i16() };
    case TAG.Int: return { t, v: r.i32() };
    case TAG.Long: return { t, v: r.i64() };
    case TAG.Float: return { t, v: r.f32() };
    case TAG.Double: return { t, v: r.f64() };
    case TAG.ByteArray: { const n = r.i32(); return { t, v: Buffer.from(r.bytes(n)) }; }
    case TAG.String: return { t, v: r.str() };
    case TAG.List: {
      const of = r.u8(); const n = r.i32();
      const v: Tag[] = [];
      for (let i = 0; i < n; i++) v.push(readPayload(r, of));
      return { t, of, v };
    }
    case TAG.Compound: {
      const v: Compound = {};
      for (;;) {
        const ct = r.u8();
        if (ct === TAG.End) break;
        const name = r.str();
        v[name] = readPayload(r, ct);
      }
      return { t, v };
    }
    case TAG.IntArray: { const n = r.i32(); const v = new Int32Array(n); for (let i = 0; i < n; i++) v[i] = r.i32(); return { t, v }; }
    case TAG.LongArray: { const n = r.i32(); const v = new BigInt64Array(n); for (let i = 0; i < n; i++) v[i] = r.i64(); return { t, v }; }
    default: throw new Error(`NBT: unknown tag ${t} at ${r.pos}`);
  }
}

/** Parse an NBT file (gzip or raw). Returns the root compound's payload plus its name. */
export function parseNbt(data: Buffer): { name: string; root: Tag } {
  const buf = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data;
  const r = new Reader(buf);
  const t = r.u8();
  if (t !== TAG.Compound) throw new Error('NBT: root is not a compound — not an NBT file');
  const name = r.str();
  return { name, root: readPayload(r, TAG.Compound) };
}

class Writer {
  private chunks: Buffer[] = [];
  push(b: Buffer) { this.chunks.push(b); }
  u8(v: number) { this.push(Buffer.from([v & 0xff])); }
  i16(v: number) { const b = Buffer.alloc(2); b.writeInt16BE(v); this.push(b); }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16BE(v); this.push(b); }
  i32(v: number) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.push(b); }
  i64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64BE(v); this.push(b); }
  f32(v: number) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.push(b); }
  f64(v: number) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.push(b); }
  str(s: string) { const b = Buffer.from(s, 'utf8'); this.u16(b.length); this.push(b); }
  out() { return Buffer.concat(this.chunks); }
}

function writePayload(w: Writer, tag: Tag): void {
  switch (tag.t) {
    case TAG.Byte: w.u8(Number(tag.v) & 0xff); break;
    case TAG.Short: w.i16(Number(tag.v)); break;
    case TAG.Int: w.i32(Number(tag.v)); break;
    case TAG.Long: w.i64(BigInt(tag.v as bigint)); break;
    case TAG.Float: w.f32(Number(tag.v)); break;
    case TAG.Double: w.f64(Number(tag.v)); break;
    case TAG.ByteArray: { const b = tag.v as Buffer; w.i32(b.length); w.push(Buffer.from(b)); break; }
    case TAG.String: w.str(String(tag.v)); break;
    case TAG.List: {
      const items = tag.v as Tag[];
      w.u8(tag.of ?? (items[0]?.t ?? TAG.End));
      w.i32(items.length);
      for (const it of items) writePayload(w, it);
      break;
    }
    case TAG.Compound: {
      for (const [name, child] of Object.entries(tag.v as Compound)) {
        w.u8(child.t);
        w.str(name);
        writePayload(w, child);
      }
      w.u8(TAG.End);
      break;
    }
    case TAG.IntArray: { const a = tag.v as Int32Array; w.i32(a.length); for (const v of a) w.i32(v); break; }
    case TAG.LongArray: { const a = tag.v as BigInt64Array; w.i32(a.length); for (const v of a) w.i64(v); break; }
    default: throw new Error(`NBT: cannot write tag ${tag.t}`);
  }
}

/** Serialize a root compound to an NBT file. Gzipped by default (structures,
    level.dat) — pass compress:false for the few uncompressed ones (servers.dat). */
export function writeNbt(root: Tag, rootName = '', compress = true): Buffer {
  const w = new Writer();
  w.u8(TAG.Compound);
  w.str(rootName);
  writePayload(w, root);
  return compress ? gzipSync(w.out()) : w.out();
}

// ---- ergonomic getters for navigating parsed trees ----
export function comp(tag: Tag | undefined): Compound {
  if (!tag || tag.t !== TAG.Compound) throw new Error('NBT: expected compound');
  return tag.v as Compound;
}
export function num(tag: Tag | undefined, fallback?: number): number {
  if (!tag) { if (fallback !== undefined) return fallback; throw new Error('NBT: missing number'); }
  return Number(tag.v);
}
export function str(tag: Tag | undefined, fallback?: string): string {
  if (!tag) { if (fallback !== undefined) return fallback; throw new Error('NBT: missing string'); }
  return String(tag.v);
}
export function list(tag: Tag | undefined): Tag[] {
  if (!tag || tag.t !== TAG.List) return [];
  return tag.v as Tag[];
}
