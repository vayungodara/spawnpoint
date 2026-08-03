// minecraft.wiki, read directly through its MediaWiki API.
//
// The genie used to reach the wiki through the model's own WebSearch/WebFetch
// tools, which meant every build wish sat in a multi-minute agentic tool loop
// before it emitted a single command — and a 5-minute budget died there with
// nothing built. Fetching the page HERE instead keeps each model turn short:
// it asks for a page, we hand back the text, it thinks once and builds.

const API = 'https://minecraft.wiki/api.php';
const UA = 'Spawnpoint-Panel/0.1 (private Minecraft server panel)';

async function api(params: Record<string, string>): Promise<any> {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`wiki ${r.status}`);
  return r.json();
}

/** Search the wiki and return the plain text of the best-matching page. */
export async function wikiLookup(query: string, maxChars = 7000): Promise<string> {
  let title = query;
  try {
    const s = await api({ action: 'query', list: 'search', srsearch: query, srlimit: '3' });
    const hits: { title: string }[] = s?.query?.search ?? [];
    if (hits.length === 0) return `WIKI "${query}": no page found`;
    title = hits[0].title;
  } catch (e) {
    return `WIKI "${query}": search failed (${String(e).slice(0, 80)})`;
  }

  try {
    const p = await api({
      action: 'query',
      prop: 'extracts',
      explaintext: '1',
      redirects: '1',
      titles: title,
    });
    const pages = p?.query?.pages ?? {};
    const first: any = Object.values(pages)[0];
    const text: string = (first?.extract ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return `WIKI "${query}" → "${title}": page has no readable text`;
    return `WIKI "${query}" → page "${title}" (https://minecraft.wiki/w/${encodeURIComponent(title)}):\n${text.slice(0, maxChars)}`;
  } catch (e) {
    return `WIKI "${query}": fetch failed (${String(e).slice(0, 80)})`;
  }
}
