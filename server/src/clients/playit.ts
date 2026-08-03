import { readFileSync, existsSync } from 'node:fs';

// Reads the local playit agent secret and asks the playit API which tunnel
// address players should join. Cached: the address almost never changes.
// Candidate config locations: Windows service, Linux system service, Linux
// per-user agent — first one that exists wins.
const TOML_CANDIDATES =
  process.platform === 'win32'
    ? ['C:\\ProgramData\\playit_gg\\playit.toml']
    : ['/etc/playit/playit.toml', `${process.env.HOME ?? '/root'}/.config/playit_gg/playit.toml`];

let cache: { at: number; address: string | null } | null = null;
const TTL = 5 * 60_000;

export async function getJoinAddress(): Promise<string | null> {
  if (cache && Date.now() - cache.at < TTL) return cache.address;
  let address: string | null = null;
  try {
    const tomlPath = TOML_CANDIDATES.find((p) => existsSync(p));
    if (tomlPath) {
      const m = /secret_key\s*=\s*"([^"]+)"/.exec(readFileSync(tomlPath, 'utf8'));
      if (m) {
        const res = await fetch('https://api.playit.gg/tunnels/list', {
          method: 'POST',
          headers: { authorization: `agent-key ${m[1]}`, 'content-type': 'application/json' },
          body: '{}',
        });
        if (res.ok) {
          const json = (await res.json()) as {
            data?: { tunnels?: { alloc?: { data?: { assigned_domain?: string; port_start?: number } } }[] };
          };
          const t = json.data?.tunnels?.[0]?.alloc?.data;
          if (t?.assigned_domain) address = `${t.assigned_domain}:${t.port_start}`;
        }
      }
    }
  } catch {
    /* offline or API change — return null, UI hides the chip */
  }
  cache = { at: Date.now(), address };
  return address;
}
