import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useServers } from '../api'
import bandMines from '../assets/band-mines.png'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // only claim a JSON body when there actually is one (Fastify 400s otherwise)
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json() as Promise<T>
}

type ContentType = 'mod' | 'plugin' | 'resourcepack' | 'shader' | 'datapack' | 'modpack'
type Side = 'required' | 'optional' | 'unsupported' | 'unknown'

interface Hit {
  project_id: string
  slug: string
  title: string
  description: string
  icon_url: string | null
  downloads: number
  categories: string[]
  author: string
  url?: string
  source?: 'modrinth' | 'curseforge'
  client_side?: Side
  server_side?: Side
}
interface SearchPage { hits: Hit[]; offset: number; total_hits: number }
interface InstalledItem {
  clientOnly?: boolean
  file: string; enabled: boolean; title: string | null
  versionNumber: string | null; projectId: string | null; sizeMb: number
  group: 'performance' | 'support' | 'gameplay'
  via: 'direct' | 'dependency' | 'unknown'
  source: 'modrinth' | 'curseforge' | null
  pending?: 'disable' | 'enable' | 'delete'
}
interface UpdateInfo { file: string; title: string; from: string; to: string; projectId: string; versionId: string; changelog?: string }
interface ExpandInfo {
  description: string
  versions: { id: string; name: string; date: string; mc: string[]; downloadable: boolean }[]
}
interface InstallResult {
  installed?: { file: string; title: string; version: string; clientOnly?: boolean }[] | number
  skipped?: { projectId: string; reason: string }[]
  warnings?: string[]
  needsConfirm?: boolean
  reason?: string
  name?: string
  skippedClientOnly?: number
  manualDownloads?: { title: string; url: string }[]
  error?: string
}

const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia']

/* A server runs plugins OR mods, never both: Paper has no mods/ folder and
   Fabric has no plugins/ folder, so showing both tabs would just be offering
   jars the server physically cannot load. Follow the loader. */
function tabsFor(loader: string): { key: ContentType; label: string }[] {
  const jars: { key: ContentType; label: string }[] = PLUGIN_LOADERS.includes(loader)
    ? [{ key: 'plugin', label: 'Plugins' }]
    : [{ key: 'mod', label: 'Mods' }, { key: 'modpack', label: 'Modpacks' }]
  return [...jars, { key: 'datapack', label: 'Datapacks' }, { key: 'resourcepack', label: 'Resource Packs' }, { key: 'shader', label: 'Shaders' }]
}

/* Where a jar has to be installed to do anything. This is the single most
   common way a mod install "silently fails": a client-only mod (shaders, minimaps,
   most UI mods) sitting in mods/ is dead weight the server never loads. */
function sideOf(h: { client_side?: Side; server_side?: Side }):
  | { label: string; cls: string; tip: string }
  | null {
  const c = h.client_side, s = h.server_side
  // CF hits carry sides too now (borrowed from the same slug on Modrinth,
  // server-side); a CF-exclusive project with no Modrinth twin stays untagged
  if (!c || !s) return null
  const cOn = c === 'required' || c === 'optional'
  const sOn = s === 'required' || s === 'optional'
  if (c === 'required' && s === 'required')
    return { label: 'BOTH SIDES', cls: 'text-diamond border-diamond/50', tip: 'Needs installing on the server AND on every player’s PC — players without it may be unable to join.' }
  if (sOn && !cOn)
    return { label: 'SERVER', cls: 'text-emerald border-emerald/50', tip: 'Server-side only — install it here and every player gets it, nothing to install on their PC.' }
  if (cOn && !sOn)
    return { label: 'CLIENT ONLY', cls: 'text-gold border-gold/50', tip: 'Runs on each player’s PC. Installing it on the server does nothing — it will not load.' }
  if (cOn && sOn)
    return { label: 'EITHER SIDE', cls: 'text-text-dim border-line', tip: 'Optional on both sides — works on the server alone, and players may also install it.' }
  return null
}

const SORTS = [
  { key: 'relevance', label: 'Relevant' },
  { key: 'downloads', label: 'Downloads' },
  { key: 'updated', label: 'Updated' },
  { key: 'newest', label: 'Newest' },
]

function fmtDownloads(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

export default function Content() {
  const { data: serversData } = useServers()
  const active = serversData?.servers.find((s) => s.active)
  const qc = useQueryClient()

  // ?tab=modpack deep-links here from the Servers page's "start from a
  // modpack" hint (the guard effect below still corrects loader mismatches)
  const [params] = useSearchParams()
  const [tab, setTab] = useState<ContentType>(() => {
    const t = params.get('tab')
    return t && ['mod', 'plugin', 'resourcepack', 'shader', 'datapack', 'modpack'].includes(t) ? (t as ContentType) : 'mod'
  })
  const [q, setQ] = useState('')
  const [input, setInput] = useState('')
  const [sort, setSort] = useState('downloads')
  const [matchServer, setMatchServer] = useState(true)
  const [view, setView] = useState<'browse' | 'installed' | 'configs'>('browse')
  const [installMsg, setInstallMsg] = useState<string | null>(null)
  const [manual, setManual] = useState<{ title: string; url: string }[] | null>(null)
  const [source, setSource] = useState<'modrinth' | 'curseforge'>('modrinth')

  const { data: sources } = useQuery({
    queryKey: ['content-sources'],
    queryFn: () => api<{ modrinth: boolean; curseforge: boolean }>('/api/content/sources'),
    staleTime: 5 * 60_000,
  })
  const effSource = source

  const mc = matchServer ? active?.detection.mc ?? undefined : undefined
  const loader = matchServer && active?.detection.loader !== 'unknown' ? active?.detection.loader : undefined

  // no active server = modpack-browse-only mode: every pack row still has New
  // Server (which needs no active server), everything else needs one
  const TABS = active ? tabsFor(active.detection.loader) : [{ key: 'modpack' as ContentType, label: 'Modpacks' }]
  const jarTab = tab === 'mod' || tab === 'plugin' || tab === 'modpack'
  const jarWord = PLUGIN_LOADERS.includes(active?.detection.loader ?? '') ? 'plugin' : 'mod'
  // a running server locks its jars — the Installed view needs to know
  const { data: liveStats } = useQuery({
    queryKey: ['stats', active?.id],
    queryFn: () => api<{ running: boolean }>(`/api/servers/${active?.id}/stats`),
    enabled: !!active,
    refetchInterval: 10_000,
  })
  const serverRunning = !!liveStats?.running
  const restartNow = useMutation({
    mutationFn: () =>
      api(`/api/servers/${active?.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'restart' }) }),
    onSuccess: () => {
      setInstallMsg('↻ Restarting — your queued changes are applied while the server is down.')
      setTimeout(() => qc.invalidateQueries({ queryKey: ['installed', active?.id] }), 20000)
      setTimeout(() => setInstallMsg(null), 15000)
    },
    onError: (e) => {
      setInstallMsg(`✗ ${String(e).replace(/^Error: \d+: /, '')}`)
      setTimeout(() => setInstallMsg(null), 8000)
    },
  })
  // switching to a Paper server while the Mods tab is open would search a tab
  // that no longer exists — land on the loader's own jar tab instead
  useEffect(() => {
    if (!TABS.some((t) => t.key === tab)) setTab(TABS[0].key)
  }, [TABS, tab])

  const searchQuery = useInfiniteQuery({
    queryKey: ['content', tab, q, sort, mc, loader, effSource],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ type: tab, sort, offset: String(pageParam), source: effSource })
      if (q) p.set('q', q)
      if (mc) p.set('mc', mc)
      if (loader && jarTab) p.set('loader', loader)
      return api<SearchPage>(`/api/content/search?${p}`)
    },
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.offset + 20 < Math.min(last.total_hits, 200) ? last.offset + 20 : undefined,
    enabled: view === 'browse',
  })

  const installedQuery = useQuery({
    queryKey: ['installed', active?.id],
    queryFn: () => api<{ items: InstalledItem[]; rejections?: { at: string; jars: string[]; reason: string[] }[] }>(`/api/servers/${active?.id}/installed`),
    enabled: !!active,
  })
  const pendingCount = (installedQuery.data?.items ?? []).filter((i) => i.pending).length
  const rejections = installedQuery.data?.rejections ?? []

  const [expanded, setExpanded] = useState<string | null>(null)
  const [createJob, setCreateJob] = useState<string | null>(null)
  const createServer = useMutation({
    mutationFn: (vars: { projectId: string; name: string }) =>
      api<{ jobId: string }>('/api/servers/create-from-modpack', {
        method: 'POST',
        body: JSON.stringify({ ...vars, source: effSource }),
      }),
    onSuccess: (r) => setCreateJob(r.jobId),
    onError: (e) => {
      setInstallMsg(`✗ ${String(e).replace(/^Error: \d+: /, '')}`)
      setTimeout(() => setInstallMsg(null), 8000)
    },
  })
  const jobQuery = useQuery({
    queryKey: ['create-job', createJob],
    queryFn: () => api<{ status: string; done: boolean; error: string | null; packName: string | null; warnings: string[] }>(`/api/create-jobs/${createJob}`),
    enabled: !!createJob,
    refetchInterval: (q) => (q.state.data?.done ? false : 3000),
  })
  useEffect(() => {
    if (jobQuery.data?.done) qc.invalidateQueries({ queryKey: ['servers'] })
  }, [jobQuery.data?.done, qc])
  // the job banner lives at the top of the page — clicking "New server" deep
  // in a result list left it invisible and the build looked like nothing
  // happened (live 2026-07-27). Scroll to it when the first status arrives.
  const jobBannerRef = useRef<HTMLDivElement | null>(null)
  const bannerVisible = !!(createJob && jobQuery.data)
  useEffect(() => {
    if (bannerVisible) jobBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [bannerVisible])
  const install = useMutation({
    mutationFn: (vars: { projectId: string; versionId?: string; force?: boolean }) =>
      api<InstallResult>(`/api/servers/${active?.id}/install`, {
        method: 'POST',
        body: JSON.stringify({ ...vars, type: tab, source: effSource }),
      }),
    onSuccess: (res, vars) => {
      if (res.needsConfirm) {
        if (confirm(`${res.reason}\n\nInstall anyway? (loads on next restart)`)) {
          install.mutate({ ...vars, force: true })
        }
        return
      }
      if (res.error) {
        setInstallMsg(`✗ ${res.error}`)
        setTimeout(() => setInstallMsg(null), 10000)
        return
      }
      if (typeof res.installed === 'number') {
        const w = res.warnings?.length ? ` · ${res.warnings.join('; ')}` : ''
        setInstallMsg(`✓ Modpack "${res.name}": ${res.installed} files installed, ${res.skippedClientOnly} client-only skipped${w} — restart to load`)
        qc.invalidateQueries({ queryKey: ['installed', active?.id] })
        setTimeout(() => setInstallMsg(null), 12000)
        return
      }
      // CF author opt-out: a hard wall, not a hiccup. Show it as its own panel
      // with a real link instead of a warning string that scrolls past.
      if (res.manualDownloads?.length) {
        setManual(res.manualDownloads)
        qc.invalidateQueries({ queryKey: ['installed', active?.id] })
        return
      }
      const names = res.installed?.map((i) => `${i.title} ${i.version}${i.clientOnly ? ' → client shelf' : ''}`).join(', ') || 'nothing new'
      const extra = res.skipped?.length ? ` · skipped: ${res.skipped.map((s) => s.reason).join('; ')}` : ''
      const allShelf = !!res.installed?.length && res.installed.every((i) => i.clientOnly)
      setInstallMsg(`✓ Installed: ${names}${extra}${res.installed?.length ? (allShelf ? ' — in the friend pack, never loaded by the server' : ' — restart to load') : ''}`)
      if (vars.projectId) setJustInstalled((prev) => new Set(prev).add(String(vars.projectId)))
      qc.invalidateQueries({ queryKey: ['installed', active?.id] })
      setTimeout(() => setInstallMsg(null), 8000)
    },
    onError: (e) => {
      setInstallMsg(`✗ ${String(e)}`)
      setTimeout(() => setInstallMsg(null), 8000)
    },
  })

  // A running server holds its jars open (Windows), so the change is QUEUED and
  // applied the moment the server is down. Say so — a click that silently does
  // nothing is the thing that made this feature feel broken.
  const queuedMsg = (verb: string) => {
    setInstallMsg(
      `⏳ Queued: ${verb} will be applied as soon as the server stops — Windows won't let a running server's files be changed. Hit Restart on the Dashboard to apply now.`,
    )
    setTimeout(() => setInstallMsg(null), 12000)
  }
  const toggle = useMutation({
    mutationFn: (file: string) =>
      api<{ enabled: boolean; pending?: string }>(`/api/servers/${active?.id}/installed/toggle`, {
        method: 'POST',
        body: JSON.stringify({ file }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['installed', active?.id] })
      if (r.pending) queuedMsg(r.pending === 'disable' ? 'disabling it' : 'enabling it')
    },
    // this had NO error handler at all: the failure was invisible and the button looked dead
    onError: (e) => {
      setInstallMsg(`✗ ${String(e).replace(/^Error: \d+: /, '').replace(/^\{"error":"|"\}$/g, '')}`)
      setTimeout(() => setInstallMsg(null), 9000)
    },
  })
  const remove = useMutation({
    mutationFn: (file: string) =>
      api<{ ok: boolean; pending?: string }>(`/api/servers/${active?.id}/installed?file=${encodeURIComponent(file)}`, {
        method: 'DELETE',
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['installed', active?.id] })
      if (r.pending) queuedMsg('deleting it')
    },
    onError: (e) => {
      setInstallMsg(`✗ ${String(e).replace(/^Error: \d+: /, '')}`)
      setTimeout(() => setInstallMsg(null), 8000)
    },
  })

  const [installedFilter, setInstalledFilter] = useState('')
  const [perfOptional, setPerfOptional] = useState(false)
  const perfPack = useMutation({
    mutationFn: (vars: { includeOptional: boolean; force?: boolean }) =>
      api<InstallResult>(`/api/servers/${active?.id}/perf-pack`, {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: (res, vars) => {
      if (res.needsConfirm) {
        if (confirm(`${res.reason}\n\nInstall anyway? (loads on next restart)`)) {
          perfPack.mutate({ ...vars, force: true })
        }
        return
      }
      const n = Array.isArray(res.installed) ? res.installed.length : 0
      const skipped = res.skipped?.length ?? 0
      const w = res.warnings?.length ? ` · skipped: ${res.warnings.length} (no build for this version — normal)` : ''
      // "already installed" was a lie on a Paper server: none of the perf mods
      // have a Paper build, so every one landed in `skipped` and nothing was
      // installed — and the UI, which only ever read `installed`, called that success.
      setInstallMsg(
        n
          ? `✓ Perf pack: ${n} files installed${w} — restart to load`
          : skipped
            ? `✗ Perf pack: nothing installed — all ${skipped} mod(s) skipped: ${res.skipped!.slice(0, 3).map((s) => s.reason).join('; ')}${skipped > 3 ? '…' : ''}`
            : `Perf pack already installed${w}`,
      )
      qc.invalidateQueries({ queryKey: ['installed', active?.id] })
      setTimeout(() => setInstallMsg(null), 10000)
    },
    onError: (e) => {
      setInstallMsg(`✗ ${String(e)}`)
      setTimeout(() => setInstallMsg(null), 8000)
    },
  })
  const [updates, setUpdates] = useState<UpdateInfo[] | null>(null)
  const [changelogFor, setChangelogFor] = useState<string | null>(null)
  // both of these used to have NO error handler: a Modrinth 429 or a panel 500
  // flipped the button from "checking…" straight back to "Check for updates"
  // and said nothing at all, so the click looked like it did nothing
  const failMsg = (e: unknown) => {
    setInstallMsg(`✗ ${String(e).replace(/^Error: \d+: /, '')}`)
    setTimeout(() => setInstallMsg(null), 8000)
  }
  const checkUpdates = useMutation({
    mutationFn: () => api<{ updates: UpdateInfo[] }>(`/api/servers/${active?.id}/installed/updates`),
    onSuccess: (r) => setUpdates(r.updates),
    onError: failMsg,
  })
  const updateAll = useMutation({
    mutationFn: () => api<{ updated: string[]; warnings: string[] }>(`/api/servers/${active?.id}/installed/update-all`, { method: 'POST', body: '{}' }),
    onSuccess: (r) => {
      setUpdates(null)
      setInstallMsg(r.updated.length ? `✓ Updated: ${r.updated.join(', ')} — restart to load` : 'Everything already up to date')
      qc.invalidateQueries({ queryKey: ['installed', active?.id] })
      setTimeout(() => setInstallMsg(null), 10000)
    },
    onError: failMsg,
  })

  // optimistic: flip the INSTALLED badge the instant the install succeeds —
  // the installed-list refetch does liveness checks + hash lookups and can lag
  // seconds behind, which read as "it didn't install" (owner report)
  const [justInstalled, setJustInstalled] = useState<Set<string>>(new Set())
  // the badge bridge only needs to outlive the refetch LAG — once a fresh
  // installed list lands it is the truth, and a lingering bridge made a
  // DELETED mod read INSTALLED in browse until a hard reload (live
  // 2026-08-02: Valkyrien Skies; same phantom after a preflight rollback)
  useEffect(() => {
    setJustInstalled((prev) => (prev.size ? new Set() : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedQuery.dataUpdatedAt])
  const installedProjects = new Set(
    (installedQuery.data?.items ?? []).map((i) => i.projectId).filter(Boolean),
  )
  // Modrinth and CurseForge use different id spaces, so a mod installed from one
  // looked UNinstalled when browsing the other — offering an Install button that
  // would have put a second copy of the same mod in the folder. Titles are the
  // only identity the two sources share.
  // strip "[ETF]"-style bracket tags first: Modrinth titles carry them, CF
  // titles don't, and the mismatch made an installed mod look installable
  // from the other source's tab (live 2026-07-21)
  const titleKey = (t: string) => t.replace(/\[[^\]]*\]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const installedTitles = new Set(
    (installedQuery.data?.items ?? []).map((i) => (i.title ? titleKey(i.title) : '')).filter(Boolean),
  )
  const isInstalled = (h: Hit) => justInstalled.has(h.project_id) || installedProjects.has(h.project_id) || installedTitles.has(titleKey(h.title))

  // modpack browsing stays available with NO active server — the Servers
  // page's "start from a modpack" link lands here exactly when there is
  // nothing to be active yet (live 2026-07-28: the link dead-ended on the
  // "pick one" screen for a fresh panel)
  if (!active && tab !== 'modpack')
    return (
      <div>
        <div className="hud mb-3">Y -32 · MINES</div>
        <p className="text-text-dim">No active server — pick one on the Servers page.</p>
      </div>
    )

  const hits = searchQuery.data?.pages.flatMap((p) => p.hits) ?? []

  return (
    <div className="space-y-5 pb-10">
      <div className="vista">
        <img src={bandMines} alt="" />
        <span className="vista-tag">Y -32 · MINES</span>
      </div>
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl">Content — {active?.name ?? 'new server from a pack'}</h1>
          <p className="text-text-dim text-sm mt-1">
            Powered by the Modrinth &amp; CurseForge libraries · required dependencies install automatically
          </p>
        </div>
        {active && <div className="flex border-2 border-ink shadow-[0_4px_0_var(--color-ink)]">
          <button
            onClick={() => setView('browse')}
            className={`px-4 py-2 text-sm font-bold ${view === 'browse' ? 'bg-emerald text-ink' : 'bg-block text-text-dim'}`}
          >
            Browse
          </button>
          <button
            onClick={() => setView('installed')}
            className={`px-4 py-2 text-sm font-bold border-l-2 border-ink ${view === 'installed' ? 'bg-emerald text-ink' : 'bg-block text-text-dim'}`}
          >
            Installed
          </button>
          <button
            onClick={() => setView('configs')}
            className={`px-4 py-2 text-sm font-bold border-l-2 border-ink ${view === 'configs' ? 'bg-emerald text-ink' : 'bg-block text-text-dim'}`}
          >
            Configs
          </button>
        </div>}
      </div>

      {installMsg && (
        <div className="block border-emerald! px-4 py-2.5 text-sm font-semibold">{installMsg}</div>
      )}

      {active && rejections.length > 0 && (
        <div className="block border-gold! px-4 py-2.5 text-sm">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <b>Safety check removed {rejections.reduce((n, r) => n + r.jars.length, 0)} mod(s) in the last 48h</b> — they failed the real loader's boot test and were rolled back so the server can't crash:
              {rejections.map((r, i) => (
                <div key={i} className="mt-1 font-mono text-xs">
                  {new Date(r.at).toLocaleTimeString()} — {r.jars.join(', ')}: {r.reason[0] ?? 'see panel log'}
                </div>
              ))}
            </div>
            <button
              className="text-xs font-bold text-text-dim hover:text-text shrink-0"
              title="Handled — hide this until the next incident"
              onClick={() => {
                void fetch(`/api/servers/${active.id}/rejections`, { method: 'DELETE' }).then(() =>
                  qc.invalidateQueries({ queryKey: ['installed', active.id] }),
                )
              }}
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {/* CurseForge author opt-out — confirmed by CF returning no download URL.
          Nothing the panel can do; hand the player the exact link instead. */}
      {manual && (
        <div className="block border-gold! px-4 py-3 space-y-2">
          <div className="text-sm font-bold text-gold">⚠ This one has to be downloaded by hand</div>
          <div className="text-xs text-text-dim">
            The author blocked third-party downloads on CurseForge, so no panel (ours, Bisect, Apex) can fetch
            it automatically. Download the jar, then drop it in the server's <span className="font-mono">mods</span> folder
            and restart.
          </div>
          {manual.map((m) => (
            <div key={m.url} className="flex items-center gap-3 flex-wrap text-xs">
              <span className="font-bold">{m.title}</span>
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="btn btn-block px-3 py-1 ml-auto shrink-0"
              >
                Open on CurseForge ↗
              </a>
            </div>
          ))}
          <button onClick={() => setManual(null)} className="text-xs font-bold text-text-dim hover:text-text">
            dismiss
          </button>
        </div>
      )}

      {createJob && jobQuery.data && (
        <div ref={jobBannerRef} className={`block px-4 py-3 text-sm font-semibold ${jobQuery.data.error ? 'border-redstone!' : 'border-emerald!'}`}>
          <div className="flex items-center gap-3">
            {!jobQuery.data.done && <span className="lamp lamp-starting" />}
            {jobQuery.data.done && !jobQuery.data.error && <span className="lamp lamp-on" />}
            {jobQuery.data.error && <span className="lamp lamp-crash" />}
            <span className="min-w-0">
              {jobQuery.data.error
                ? `✗ Server creation failed: ${jobQuery.data.error}`
                : `${jobQuery.data.packName ? `${jobQuery.data.packName}: ` : ''}${jobQuery.data.status}`}
            </span>
            {jobQuery.data.done && (
              <button onClick={() => setCreateJob(null)} className="text-xs font-bold text-text-dim hover:text-text ml-auto shrink-0">
                dismiss
              </button>
            )}
          </div>
          {jobQuery.data.done && !jobQuery.data.error && jobQuery.data.warnings.length > 0 && (
            <div className="text-xs text-text-dim font-normal mt-2 pt-2 border-t-2 border-line/40">
              {jobQuery.data.warnings.slice(0, 6).map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </div>
      )}

      {view === 'browse' && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex border-2 border-ink">
              {TABS.map((t, i) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-3.5 py-2 text-sm font-bold ${i > 0 ? 'border-l-2 border-ink' : ''} ${
                    tab === t.key ? 'bg-block-2 text-text' : 'bg-panel text-text-dim'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <form
              className="flex-1 min-w-64"
              onSubmit={(e) => {
                e.preventDefault()
                setQ(input)
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={`Search ${TABS.find((t) => t.key === tab)?.label.toLowerCase()}…`}
                className="field w-full px-4 py-2 text-sm"
              />
            </form>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="field px-3 py-2 text-sm font-semibold"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            {active && <button
              onClick={() => setMatchServer(!matchServer)}
              className={`font-px text-[10px] border-2 px-3 py-1.5 ${
                matchServer ? 'border-emerald text-emerald' : 'border-line text-text-dim'
              }`}
            >
              {matchServer
                ? `${active.detection.mc ?? '?'} · ${active.detection.loader.toUpperCase()}`
                : 'ALL VERSIONS'}
            </button>}
            {sources?.curseforge && (
              <div className="flex border-2 border-ink">
                <button
                  onClick={() => setSource('modrinth')}
                  className={`font-px text-[10px] px-3 py-1.5 ${source === 'modrinth' ? 'bg-emerald text-ink' : 'bg-panel text-text-dim'}`}
                >
                  MODRINTH
                </button>
                <button
                  onClick={() => setSource('curseforge')}
                  className={`font-px text-[10px] px-3 py-1.5 border-l-2 border-ink ${source === 'curseforge' ? 'bg-gold text-ink' : 'bg-panel text-text-dim'}`}
                >
                  CURSEFORGE
                </button>
              </div>
            )}
          </div>

          {tab === 'modpack' && (
            <div className="border-2 border-diamond/50 bg-diamond/10 px-4 py-2.5 text-xs font-semibold text-diamond">
              {active
                ? `Installing a modpack adds all its server-side mods + configs to the ACTIVE server. The pack's loader must match (${active.detection.loader}) — packs for other loaders need a new server of that type first.`
                : 'No active server yet — pick any pack below and hit New Server: the panel builds the whole thing (loader, Java, memory, mods, friend-sync) in one click.'}
            </div>
          )}
          {active && tab === 'plugin' && (
            <div className="border-2 border-emerald/50 bg-emerald/10 px-4 py-2.5 text-xs font-semibold text-emerald">
              This is a {active.detection.loader.toUpperCase()} server, so it runs <b>plugins</b> (installed into{' '}
              <span className="font-mono">plugins/</span>), not Fabric/Forge mods — that's why there's no Mods tab.
              Plugins are server-side by design: players join with a vanilla client, nothing to install on their end.
            </div>
          )}
          {(tab === 'resourcepack' || tab === 'shader') && (
            <div className="border-2 border-gold/50 bg-gold/10 px-4 py-2.5 text-xs font-semibold text-gold">
              {tab === 'shader' ? 'Shaders' : 'Resource packs'} run on each player's PC, not the server —
              installing saves them to the panel's downloads collection for players to grab.
            </div>
          )}

          <div className="space-y-3">
            {hits.map((h) => (
              <div key={h.project_id} className="block p-4">
                <div className="flex items-center gap-4">
                  {h.icon_url ? (
                    <img src={h.icon_url} className="h-12 w-12 border-2 border-ink bg-bedrock object-cover" alt="" />
                  ) : (
                    <div className="h-12 w-12 border-2 border-ink bg-bedrock flex items-center justify-center font-px text-emerald">?</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2.5 flex-wrap">
                      <a
                        href={h.url ?? `https://modrinth.com/${tab === 'mod' ? 'mod' : tab}/${h.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-extrabold truncate hover:text-emerald hover:underline decoration-2 underline-offset-2"
                        title={h.source === 'curseforge' ? 'Open on CurseForge' : 'Open on Modrinth'}
                      >
                        {h.title}
                      </a>
                      <span className="text-xs text-text-dim shrink-0">by {h.author}</span>
                      <span className="font-px text-[10px] text-text-dim shrink-0">{fmtDownloads(h.downloads)} DL</span>
                      {(() => {
                        const side = sideOf(h)
                        return side ? (
                          <span
                            className={`font-px text-[10px] border-2 px-1.5 py-0.5 shrink-0 cursor-help ${side.cls}`}
                            title={side.tip}
                          >
                            {side.label}
                          </span>
                        ) : null
                      })()}
                    </div>
                    <div className="text-sm text-text-dim truncate">{h.description}</div>
                  </div>
                  <button
                    onClick={() => setExpanded(expanded === h.project_id ? null : h.project_id)}
                    className="text-xs font-bold text-text-dim hover:text-text shrink-0"
                  >
                    {expanded === h.project_id ? 'close' : 'details'}
                  </button>
                  {tab === 'modpack' && (
                    <button
                      onClick={() => {
                        const name = prompt(`Name for the new server?`, h.title)
                        if (name !== null) createServer.mutate({ projectId: h.project_id, name: name.trim() || h.title })
                      }}
                      disabled={createServer.isPending || (!!createJob && !jobQuery.data?.done)}
                      className="btn btn-block px-3 py-2 text-sm shrink-0"
                      title="Create a brand-new server running this pack"
                    >
                      New server
                    </button>
                  )}
                  {active && (isInstalled(h) ? (
                    <span className="font-px text-[10px] text-emerald border-2 border-emerald/50 px-3 py-2 shrink-0">INSTALLED</span>
                  ) : (
                    <button
                      onClick={() => {
                        // a client-only jar in mods/ never loads — stop the
                        // client-only Modrinth mods now auto-route to the
                        // client shelf (safe, in the pack, never loaded) — no
                        // scare dialog needed. CF-sourced ones still install
                        // into mods/, so those keep the warning.
                        if (jarTab && sideOf(h)?.label === 'CLIENT ONLY' && effSource === 'curseforge' &&
                          !confirm(`${h.title} is a CLIENT-side mod from CurseForge.\n\nIt will sit in the server's mods folder (the server may refuse to boot with it) — only the friend-pack export uses it.\n\nInstall anyway?`))
                          return
                        install.mutate({ projectId: h.project_id })
                      }}
                      disabled={install.isPending}
                      className="btn btn-emerald px-4 py-2 text-sm shrink-0"
                      title={tab === 'modpack' ? 'Install this pack into the ACTIVE server' : undefined}
                    >
                      {install.isPending && install.variables?.projectId === h.project_id
                        ? (tab === 'modpack' ? 'installing pack… (minutes)' : 'placing…')
                        : 'Install'}
                    </button>
                  ))}
                </div>
                {expanded === h.project_id && (
                  <HitExpand
                    projectId={h.project_id}
                    source={effSource}
                    mc={mc}
                    loader={jarTab ? loader : undefined}
                    installPending={install.isPending}
                    onInstall={(versionId) => {
                      if (!active) {
                        setInstallMsg('✗ installing needs an active server — use New Server to build one from this pack instead')
                        setTimeout(() => setInstallMsg(null), 6000)
                        return
                      }
                      install.mutate({ projectId: h.project_id, versionId })
                    }}
                  />
                )}
              </div>
            ))}
          </div>

          {searchQuery.hasNextPage && (
            <button
              onClick={() => searchQuery.fetchNextPage()}
              disabled={searchQuery.isFetchingNextPage}
              className="btn btn-block w-full py-2.5 text-sm"
            >
              {searchQuery.isFetchingNextPage ? 'mining…' : 'Load more'}
            </button>
          )}
          {searchQuery.isLoading && <div className="text-text-dim text-sm">mining…</div>}
          {!searchQuery.isLoading && hits.length === 0 && (
            <div className="text-text-dim text-sm">
              {active
                ? `No results for ${active.detection.mc}/${active.detection.loader} — try toggling to ALL VERSIONS.`
                : 'No results — try another search.'}
            </div>
          )}
          {/* few hits + active filter = the classic "search is broken" misread:
              the mod usually exists but has no build for THIS server. Say so. */}
          {active && !searchQuery.isLoading && q && matchServer && hits.length > 0 && hits.length < 5 && (
            <div className="text-text-dim text-xs italic">
              Missing a mod you expected? It probably has no {active.detection.loader} build for{' '}
              {active.detection.mc} — flip MATCH MY SERVER off to see it (its page then shows which
              versions it does support).
            </div>
          )}
        </>
      )}

      {active && view === 'installed' && (
        <div className="space-y-6">
          {/* The perf pack is Fabric/Forge mods — not one of them has a Paper build,
              so on a plugin server the button could only ever install nothing. */}
          {PLUGIN_LOADERS.includes(active.detection.loader) ? (
            <div className="border-2 border-line bg-block px-4 py-2.5 text-xs text-text-dim">
              The performance pack is a set of Fabric/Forge <b>mods</b>, so it cannot run on a{' '}
              {active.detection.loader.toUpperCase()} server. Paper is already fast by itself — for more, look
              for performance <b>plugins</b> (e.g. Chunky for pre-generation) in the Plugins tab.
            </div>
          ) : (
          <div className="block px-4 py-3.5">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="hud mb-1">ONE CLICK · CURATED</div>
                <div className="font-extrabold">Performance pack</div>
                <div className="text-xs text-text-dim mt-0.5">
                  Lithium, FerriteCore, ModernFix, Krypton, ServerCore, Noisium + 7 more — version-matched
                  to this server, deps auto-resolved, anything without a compatible build is skipped.
                </div>
              </div>
              <button
                onClick={() => perfPack.mutate({ includeOptional: perfOptional })}
                disabled={perfPack.isPending}
                className="btn btn-emerald px-4 py-2.5 text-sm shrink-0"
              >
                {perfPack.isPending ? 'Installing…' : 'Install perf pack'}
              </button>
            </div>
            <label className="flex items-center gap-3 mt-3 pt-3 border-t-2 border-line/40">
              <button
                className="lever"
                data-on={perfOptional}
                onClick={() => setPerfOptional(!perfOptional)}
                aria-label="Include experimental performance mods"
              />
              <span className="text-xs">
                <b>Include experimental extras</b>{' '}
                <span className="text-text-dim">
                  — C2ME (multithreaded chunks), VMP, ThreadTweak, Dynamic View. Big gains, small
                  compatibility risk: keep a backup and test with your mods.
                </span>
              </span>
            </label>
          </div>
          )}

          {/* Windows holds every loaded jar open, so a disable/delete cannot happen
              while the server runs. We queue it rather than refuse — but the player
              must know the change is waiting, not lost. */}
          {pendingCount > 0 && (
            <div className="border-2 border-gold/50 bg-gold/10 px-4 py-3 text-xs font-semibold text-gold flex items-center gap-3 flex-wrap">
              <span className="min-w-0">
                <b>{pendingCount} change{pendingCount > 1 ? 's' : ''} waiting</b> — the running server holds these{' '}
                {jarWord} files open, so they will be applied the moment it stops.
              </span>
              <button
                onClick={() => restartNow.mutate()}
                disabled={restartNow.isPending}
                className="btn btn-block px-3 py-1.5 ml-auto shrink-0"
              >
                {restartNow.isPending ? 'restarting…' : 'Restart now to apply'}
              </button>
            </div>
          )}
          {serverRunning && pendingCount === 0 && (
            <div className="border-2 border-line bg-block px-4 py-2.5 text-xs text-text-dim">
              The server is running, so Windows keeps its loaded {jarWord} files open. Disabling or deleting one
              still works — the panel queues it and applies it the next time the server stops.
            </div>
          )}

          <div className="flex gap-3 flex-wrap">
            <button
              onClick={() => checkUpdates.mutate()}
              disabled={checkUpdates.isPending}
              className="btn btn-block px-4 py-2 text-sm"
            >
              {checkUpdates.isPending ? 'checking…' : 'Check for updates'}
            </button>
            {updates && updates.length > 0 && (
              <button
                onClick={() => updateAll.mutate()}
                disabled={updateAll.isPending}
                className="btn btn-emerald px-4 py-2 text-sm"
              >
                {updateAll.isPending ? 'updating…' : `Update all (${updates.length})`}
              </button>
            )}
            {updates && updates.length === 0 && (
              <span className="font-px text-[10px] text-emerald self-center">ALL UP TO DATE</span>
            )}
            <input
              value={installedFilter}
              onChange={(e) => setInstalledFilter(e.target.value)}
              placeholder="Filter installed mods…"
              className="field flex-1 min-w-52 px-3 py-2 text-sm"
            />
          </div>

          {(
            [
              { key: 'clientonly', tag: 'CLIENT', label: 'Client only — not loaded', hint: 'ships in the friend pack; the server never sees these, so they can never crash a boot' },
              { key: 'gameplay', tag: 'GAMEPLAY', label: 'Gameplay mods', hint: 'the mods you chose' },
              { key: 'performance', tag: 'ENGINE', label: 'Performance pack', hint: 'keeps the server fast — leave these on' },
              { key: 'support', tag: 'SCAFFOLD', label: 'Support & libraries', hint: 'required by other mods — removing one breaks its dependents' },
            ] as const
          ).map((g) => {
            const q = installedFilter.toLowerCase()
            const items = (installedQuery.data?.items ?? []).filter(
              (m) =>
                (m.clientOnly ? 'clientonly' : (m.group ?? 'gameplay')) === g.key &&
                (!q || m.file.toLowerCase().includes(q) || (m.title ?? '').toLowerCase().includes(q)),
            )
            if (items.length === 0) return null
            return (
              <div key={g.key}>
                <div className="hud mb-1">{g.tag}</div>
                <div className="flex items-baseline gap-3 mb-2.5">
                  <span className="font-extrabold">{g.label}</span>
                  <span className="text-xs text-text-dim">{g.hint}</span>
                </div>
                <div className="space-y-2.5">
                  {items.map((m) => {
                    const upd = updates?.find((u) => u.file === m.file)
                    return (
                      <div key={m.file} className={`block px-4 py-3 ${m.enabled ? '' : 'opacity-60'}`}>
                      <div className="flex items-center gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="font-bold truncate">
                            {m.projectId ? (
                              <a
                                href={m.source === 'curseforge'
                                  ? `https://www.curseforge.com/projects/${m.projectId}`
                                  : `https://modrinth.com/mod/${m.projectId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-emerald hover:underline decoration-2 underline-offset-2"
                                title={m.source === 'curseforge' ? 'Open on CurseForge' : 'Open on Modrinth'}
                              >
                                {m.title ?? m.file}
                              </a>
                            ) : (
                              m.title ?? m.file
                            )}
                            {m.versionNumber && <span className="font-px text-[10px] text-text-dim ml-2">v{m.versionNumber}</span>}
                            {m.via === 'dependency' && <span className="font-px text-[10px] text-diamond ml-2">AUTO-DEP</span>}
                            {m.source === 'curseforge' && <span className="font-px text-[10px] text-gold ml-2">CF</span>}
                          </div>
                          <div className="text-xs text-text-dim truncate font-mono">{m.file} · {m.sizeMb} MB</div>
                        </div>
                        {upd && (
                          <button
                            onClick={() => setChangelogFor(changelogFor === m.file ? null : m.file)}
                            className="font-px text-[10px] text-gold border-2 border-gold/50 px-2 py-0.5 hover:bg-gold/10"
                            title={upd.changelog ? 'Show what changed' : 'No changelog provided'}
                          >
                            {upd.to} AVAILABLE{upd.changelog ? ' ▾' : ''}
                          </button>
                        )}
                        {!m.enabled && (
                          <span className="font-px text-[10px] text-stone-dark border-2 border-line px-2 py-0.5">OFF</span>
                        )}
                        {/* the click DID register — it's waiting on the server to let go of the file */}
                        {m.pending && (
                          <span
                            className="font-px text-[10px] text-gold border-2 border-gold/50 px-2 py-0.5 cursor-help"
                            title={`Queued: this ${jarWord} will be ${m.pending === 'delete' ? 'deleted' : m.pending + 'd'} the moment the server stops. Windows will not let a running server's files be changed.`}
                          >
                            {m.pending === 'delete' ? 'DELETE' : m.pending.toUpperCase()} ON RESTART
                          </span>
                        )}
                        {!m.clientOnly && (
                          <button onClick={() => toggle.mutate(m.file)} className="text-xs font-bold text-text-dim hover:text-text">
                            {m.enabled ? 'disable' : 'enable'}
                          </button>
                        )}
                        <button
                          onClick={() => { if (confirm(`Delete ${m.file}?${m.group === 'support' ? '\n\nWARNING: other mods may depend on this!' : ''}`)) remove.mutate(m.file) }}
                          className="text-xs font-bold text-redstone/90 hover:text-redstone"
                        >
                          delete
                        </button>
                      </div>
                      {upd?.changelog && changelogFor === m.file && (
                        <div className="mt-3 border-t-2 border-line/40 pt-3">
                          <div className="hud mb-1.5">CHANGELOG · {upd.from} → {upd.to}</div>
                          <pre className="text-xs text-text-dim whitespace-pre-wrap font-sans max-h-48 overflow-y-auto">{upd.changelog}</pre>
                        </div>
                      )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {installedQuery.data?.items.length === 0 && (
            <div className="text-text-dim text-sm">No mods installed on this server yet.</div>
          )}
          <div className="hud">CHANGES APPLY ON NEXT RESTART · DISABLED = .DISABLED SUFFIX</div>
        </div>
      )}

      {active && view === 'configs' && <ConfigsView serverId={active.id} />}
    </div>
  )
}

// in-place project expansion: long description + pickable versions, works
// for both sources (the /expand endpoint normalizes them)
/** Mod description, actually RENDERED. Modrinth bodies are markdown (often
    with inline HTML), CurseForge sends HTML — marked handles both shapes and
    DOMPurify strips anything active before it touches the DOM. Links open in
    a new tab (a mod page must never navigate the panel away). */
function MdBody({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false })
    // target/rel are set INSIDE the sanitizer's hook — post-sanitize string
    // surgery on purified HTML is exactly the mistake DOMPurify warns about
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noreferrer noopener')
      }
    })
    const clean = DOMPurify.sanitize(raw, { FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'video', 'audio'] })
    DOMPurify.removeHook('afterSanitizeAttributes')
    return clean
  }, [text])
  return (
    <div
      className="md-body text-xs text-text-dim max-h-64 overflow-y-auto pr-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function HitExpand({ projectId, source, mc, loader, installPending, onInstall }: {
  projectId: string
  source: 'modrinth' | 'curseforge'
  mc?: string
  loader?: string
  installPending: boolean
  onInstall: (versionId: string) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['expand', projectId, source, mc, loader],
    queryFn: () => {
      const p = new URLSearchParams({ projectId, source })
      if (mc) p.set('mc', mc)
      if (loader) p.set('loader', loader)
      return api<ExpandInfo>(`/api/content/expand?${p}`)
    },
    staleTime: 10 * 60_000,
  })
  if (isLoading) return <div className="mt-4 text-text-dim text-sm">mining details…</div>
  if (!data) return null
  return (
    <div className="mt-4 border-t-2 border-line/40 pt-4 grid md:grid-cols-2 gap-5">
      <div className="min-w-0">
        <div className="hud mb-1.5">ABOUT</div>
        <MdBody text={data.description} />
      </div>
      <div className="min-w-0">
        <div className="hud mb-1.5">VERSIONS{mc ? ` · FOR ${mc}` : ''}</div>
        <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
          {data.versions.map((v) => (
            <div key={v.id} className="flex items-center gap-3 border-2 border-line/40 px-3 py-1.5">
              <div className="flex-1 min-w-0">
                <span className="text-xs font-bold truncate block">{v.name}</span>
                <span className="text-[10px] text-text-dim font-mono">
                  {v.mc.slice(0, 4).join(' ')} · {v.date.slice(0, 10)}
                </span>
              </div>
              {v.downloadable ? (
                <button
                  onClick={() => onInstall(v.id)}
                  disabled={installPending}
                  className="text-xs font-bold text-emerald hover:underline decoration-2 underline-offset-2 shrink-0"
                >
                  install
                </button>
              ) : (
                <span className="text-[10px] text-text-dim shrink-0" title="Author disabled API downloads">site only</span>
              )}
            </div>
          ))}
          {data.versions.length === 0 && (
            <div className="text-xs text-text-dim">No builds match this server — try ALL VERSIONS.</div>
          )}
        </div>
      </div>
    </div>
  )
}

interface ConfigFileInfo { path: string; sizeKb: number; modifiedAt: string }

// Every mod's developer options live in text files under config/ — this is
// the only place they can be changed (there is no in-game UI on servers).
function ConfigsView({ serverId }: { serverId: string }) {
  const [filter, setFilter] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const files = useQuery({
    queryKey: ['configs', serverId],
    queryFn: () => api<{ files: ConfigFileInfo[] }>(`/api/servers/${serverId}/configs`),
  })

  const open = async (p: string) => {
    if (dirty && !confirm('Discard unsaved changes?')) return
    try {
      const r = await api<{ content: string; tooBig: boolean }>(
        `/api/servers/${serverId}/configs/file?path=${encodeURIComponent(p)}`,
      )
      if (r.tooBig) {
        setMsg('✗ File too large for the editor — edit it over SSH')
        setTimeout(() => setMsg(null), 6000)
        return
      }
      setSel(p)
      setText(r.content)
      setDirty(false)
    } catch (e) {
      setMsg(`✗ ${String(e)}`)
      setTimeout(() => setMsg(null), 6000)
    }
  }

  const save = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; backup: string }>(`/api/servers/${serverId}/configs/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: sel, content: text }),
      }),
    onSuccess: (r) => {
      setDirty(false)
      setMsg(`✓ Saved (backup: ${r.backup}) — restart the server to apply`)
      setTimeout(() => setMsg(null), 8000)
    },
    onError: (e) => {
      setMsg(`✗ ${String(e)}`)
      setTimeout(() => setMsg(null), 8000)
    },
  })

  const list = (files.data?.files ?? []).filter(
    (f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div className="text-text-dim text-xs max-w-[75ch]">
        Every server mod keeps its options in a file here (e.g. Tree Harvester →{' '}
        <span className="font-mono">config/treeharvester.json5</span>). Edits are backed up as{' '}
        <span className="font-mono">.bak</span> next to the file and apply on the next restart.
      </div>

      {msg && <div className="block border-emerald! px-4 py-2.5 text-sm font-semibold">{msg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 items-start">
        <div className="block">
          <div className="p-2.5 border-b-2 border-ink">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter configs…"
              className="field w-full px-3 py-1.5 text-sm"
            />
          </div>
          <div className="max-h-[30rem] overflow-y-auto scroll-px">
            {files.isLoading && <div className="px-3.5 py-3 text-text-dim text-sm">reading configs…</div>}
            {!files.isLoading && list.length === 0 && (
              <div className="px-3.5 py-3 text-text-dim text-sm">no config files found</div>
            )}
            {list.map((f) => (
              <button
                key={f.path}
                onClick={() => open(f.path)}
                className={`w-full text-left px-3.5 py-2 border-b border-line/30 hover:bg-block-2 ${
                  sel === f.path ? 'bg-block-2' : ''
                }`}
              >
                <div className="font-mono text-xs truncate">{f.path.replace(/^config\//, '')}</div>
                <div className="font-px text-[9px] text-text-dim mt-0.5">
                  {f.path.startsWith('config/') ? '' : f.path.split('/')[0].toUpperCase() + ' · '}
                  {f.sizeKb} KB
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="apanel">
          <div className="apanel-head">
            <i className={`ph-dot ${dirty ? '' : 'ph-dot-off'}`} style={dirty ? { background: 'var(--color-gold)', boxShadow: '0 0 8px var(--color-gold)' } : undefined} />
            <b className="truncate">{sel ?? 'pick a config file'}</b>
            {sel && (
              <button
                onClick={() => save.mutate()}
                disabled={!dirty || save.isPending}
                className="pb pb-go ml-auto shrink-0"
              >
                {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            )}
          </div>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setDirty(true) }}
            disabled={!sel}
            spellCheck={false}
            placeholder="select a file on the left"
            className="console w-full h-[28rem] p-4 outline-none resize-y text-[#cfd6db] disabled:opacity-50"
          />
        </div>
      </div>
    </div>
  )
}
