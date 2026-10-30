import { useSearchParams } from 'react-router'
import type { Candidate, ServerInfo, StagedFile, Stats } from '../api'

/** One reading of a server's state for lamps and labels everywhere. */
export function statusOf(st: Stats | undefined, transition?: string | null): { lamp: string; label: string; cls: string } {
  if (transition) return { lamp: 'lamp-starting', label: transition.toUpperCase(), cls: 'text-gold' }
  if (!st) return { lamp: 'lamp-off', label: 'CHECKING…', cls: 'text-text-dim' }
  if (st.maintenance && !st.maintenance.interrupted) return { lamp: 'lamp-starting', label: 'BUSY', cls: 'text-sky' }
  if (st.phase === 'ready' || (st.running && !st.phase)) return { lamp: 'lamp-on', label: 'RUNNING', cls: 'text-emerald' }
  if (st.phase === 'starting') return { lamp: 'lamp-starting', label: 'STARTING…', cls: 'text-gold' }
  if (st.crashed) return { lamp: 'lamp-crash', label: 'CRASHED', cls: 'text-redstone' }
  return { lamp: 'lamp-off', label: 'STOPPED', cls: 'text-text-dim' }
}

export function fmtMem(mem: number | string): string {
  if (typeof mem === 'string') return mem
  if (mem > 1e9) return `${(mem / 1e9).toFixed(1)} GB`
  if (mem > 1e6) return `${(mem / 1e6).toFixed(0)} MB`
  return `${mem}`
}

/** Paper-family servers load plugins, everything else here loads mods. */
export const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia']

/** Friends join at the host this browser reached the panel by, on the server's
    port. On localhost that host means nothing to them, so use the LAN address. */
export function joinAddress(s: ServerInfo): string {
  const local = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname)
  const host = local && s.lan ? s.lan : location.hostname
  return s.port === 25565 ? host : `${host}:${s.port}`
}

export const titleOf = (f: StagedFile): string => f.entry?.title ?? f.path ?? f.file

/** "Waystones + Balm", capped so a modpack-sized change stays one line. */
export function changeName(c: Candidate): string {
  // generated config proposals ride along; the name is the mods themselves
  const jars = c.files.filter((f) => !f.path)
  const names = (jars.length ? jars : c.files).map(titleOf)
  return names.length > 3 ? `${names.slice(0, 3).join(' + ')} + ${names.length - 3} more` : names.join(' + ') || 'Mod change'
}

/** Is this change still worth showing outside the history? */
export function changeVisible(c: Candidate | null | undefined): c is Candidate {
  if (!c || c.status === 'rejected') return false
  return c.status !== 'applied' || Date.now() - new Date(c.updatedAt).getTime() < 10 * 60_000
}

/** The review sheet opens from any tab with ?review, so links and Back work. */
export function useReviewParam(): [boolean, (open: boolean) => void] {
  const [params, setParams] = useSearchParams()
  return [params.has('review'), (open) => setParams((p) => { if (open) p.set('review', '1'); else p.delete('review'); return p }, { replace: !open })]
}

/** Copy that also works over plain http on a LAN, where the Clipboard API is missing. */
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
  legacyCopy(text)
  return Promise.resolve()
}
function legacyCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } finally { document.body.removeChild(ta) }
}
