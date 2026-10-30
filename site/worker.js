// Static assets answer a Range request with the whole file (200), so a
// browser can't seek into the tour video before it has downloaded it, and
// Safari won't play it at all. /media/* runs through this Worker first
// (run_worker_first in wrangler.jsonc), which answers one byte range with
// 206. The files are a few MB, so slicing a buffered copy is fine.
export default {
  async fetch(request, env) {
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("Accept-Ranges", "bytes");
    const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    // A range of an older copy (If-Range names another version) would mix
    // two files, so that gets the whole current file instead.
    const ifRange = request.headers.get("If-Range");
    const stale = ifRange !== null && (ifRange !== asset.headers.get("ETag") || ifRange.startsWith("W/"));
    // No range, several ranges, HEAD, 304, 404 or an encoded body: pass the asset through.
    if (request.method !== "GET" || asset.status !== 200 || !m || m[1] + m[2] === "" || stale
        || asset.headers.has("Content-Encoding"))
      return new Response(asset.body, { status: asset.status, headers });

    const body = await asset.arrayBuffer();
    const size = body.byteLength;
    const suffix = m[1] === "";   // bytes=-N: the last N bytes
    const start = suffix ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    const end = suffix || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (!suffix && m[2] !== "" && Number(m[2]) < start)   // invalid, so ignored (RFC 9110 14.1.1)
      return new Response(body, { headers });
    headers.delete("Content-Length");
    if (start >= size) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    return new Response(body.slice(start, end + 1), { status: 206, headers });
  },
};
