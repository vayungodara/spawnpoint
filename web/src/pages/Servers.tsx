import { useEffect, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router'
import { useQueries, useQuery, useMutation } from '@tanstack/react-query'
import { useServers, useSetActive, type Stats, type ServerInfo } from '../api'
import { Pi, loaderIcon } from '../components/PixelIcons'
import bandSurface from '../assets/band-surface.png'

const loaderColors: Record<string, string> = {
  forge: 'bg-dirt text-paper',
  fabric: 'bg-diamond text-ink',
  neoforge: 'bg-gold text-ink',
  paper: 'bg-sky text-ink',
  vanilla: 'bg-stone text-ink',
  unknown: 'bg-stone-dark text-ink',
}

// Create a server without ever opening Crafty. The panel closes every trap a
// fresh server falls into: a free port, an EULA Crafty will actually accept,
// the right Java major at a space-free path, and the heap written to the file
// THIS loader really reads (Forge ignores the launch command's -Xmx).
const LOADERS: { key: string; label: string; blurb: string }[] = [
  { key: 'fabric', label: 'Fabric', blurb: 'light, fast, most mods' },
  { key: 'forge', label: 'Forge', blurb: 'the big classic modpacks' },
  { key: 'neoforge', label: 'NeoForge', blurb: 'modern Forge fork' },
  { key: 'quilt', label: 'Quilt', blurb: 'Fabric-compatible fork' },
  { key: 'paper', label: 'Paper', blurb: 'plugins, no mods' },
  { key: 'purpur', label: 'Purpur', blurb: 'Paper + more knobs' },
  { key: 'vanilla', label: 'Vanilla', blurb: 'pure Minecraft' },
]

function NewServerPanel({ onDone }: { onDone: () => void }) {
  const [loader, setLoader] = useState('fabric')
  const [mc, setMc] = useState('')
  const [name, setName] = useState('')
  const [mem, setMem] = useState(6)
  const [jobId, setJobId] = useState<string | null>(null)

  const { data: versions, isFetching: loadingVersions } = useQuery({
    queryKey: ['loader-versions', loader],
    queryFn: async () => {
      const r = await fetch(`/api/loaders/versions?loader=${loader}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'could not load versions')
      return j.versions as string[]
    },
    staleTime: 60 * 60_000,
  })
  useEffect(() => {
    if (versions?.length && !versions.includes(mc)) setMc(versions[0])
  }, [versions, mc])

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/servers/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, loader, mc, memGb: mem }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'create failed')
      return j as { jobId: string }
    },
    onSuccess: (j) => setJobId(j.jobId),
  })

  const { data: job } = useQuery({
    queryKey: ['create-job', jobId],
    queryFn: async () => (await (await fetch(`/api/create-jobs/${jobId}`)).json()) as {
      status: string; done: boolean; error: string | null; warnings: string[]
    },
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.done ? false : 2000),
  })

  const busy = create.isPending || (!!jobId && !job?.done)

  return (
    <div className="block px-5 py-4 mt-5">
      <div className="text-sm font-bold flex items-center gap-2 mb-1">
        <Pi i="pick" className="pi pi-s" /> New server
      </div>
      <p className="text-text-dim text-xs mb-4 max-w-[68ch]">
        Built, configured and made bootable here — port, EULA, Java version and memory are all set for
        you. Forge and NeoForge take a few minutes to install.
      </p>

      {/* loader — the one choice that changes everything downstream */}
      <div className="flex flex-wrap gap-2 mb-4">
        {LOADERS.map((l) => {
          const on = loader === l.key
          return (
            <button
              key={l.key}
              onClick={() => { setLoader(l.key); setMc('') }}
              disabled={busy}
              title={l.blurb}
              className={`btn px-3 py-2 text-xs flex items-center gap-2 ${on ? 'btn-emerald' : 'btn-block'}`}
            >
              <Pi i={loaderIcon(l.key)} className="pi pi-s" />
              {l.label}
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="hud">VERSION</span>
          <select
            value={mc}
            onChange={(e) => setMc(e.target.value)}
            disabled={busy || loadingVersions}
            className="field px-3 py-2 text-sm font-mono min-w-32"
          >
            {loadingVersions && <option>loading…</option>}
            {(versions ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 flex-1 min-w-48">
          <span className="hud">NAME</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder={`${LOADERS.find((l) => l.key === loader)?.label} ${mc || ''}`.trim()}
            maxLength={40}
            className="field px-3 py-2 text-sm w-full"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="hud">MEMORY · {mem} GB</span>
          <input
            type="range"
            min={2}
            max={12}
            step={1}
            value={mem}
            onChange={(e) => setMem(Number(e.target.value))}
            disabled={busy}
            aria-label="Server memory in gigabytes"
            className="xp w-44"
          />
        </label>

        <button
          onClick={() => create.mutate()}
          disabled={busy || !mc}
          className="btn btn-emerald px-5 py-2.5 text-sm"
        >
          {busy ? 'Building…' : 'Create server'}
        </button>
      </div>

      {(create.error || job) && (
        <div className="mt-4 pt-3 border-t-2 border-line/40 text-xs font-semibold">
          {create.error && <span className="text-redstone">✗ {String(create.error).replace(/^Error: /, '')}</span>}
          {job?.error && <span className="text-redstone">✗ {job.error}</span>}
          {job && !job.error && (
            <div className="flex items-center gap-3 flex-wrap">
              {!job.done && <span className="lamp lamp-starting animate-pulse" />}
              <span className={job.done ? 'text-emerald' : 'text-gold'}>
                {job.done ? '✓ ' : ''}{job.status}
              </span>
              {job.done && (
                <button onClick={onDone} className="btn btn-block px-3 py-1 ml-auto">Show it</button>
              )}
            </div>
          )}
          {job?.warnings?.length ? (
            <div className="text-text-dim mt-1.5">{job.warnings.join(' · ')}</div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function statusOf(st: Stats | undefined): { lamp: string; label: string; cls: string } {
  if (!st) return { lamp: 'lamp-off', label: 'CHECKING…', cls: 'text-text-dim' }
  if (st.phase === 'ready') return { lamp: 'lamp-on', label: 'ONLINE', cls: 'text-emerald' }
  if (st.phase === 'starting') return { lamp: 'lamp-starting', label: 'STARTING…', cls: 'text-gold' }
  if (st.crashed) return { lamp: 'lamp-crash', label: 'CRASHED', cls: 'text-redstone' }
  return { lamp: 'lamp-off', label: 'OFFLINE', cls: 'text-text-dim' }
}

function ServerCard({ s, st, onPick }: { s: ServerInfo; st: Stats | undefined; onPick: () => void }) {
  const status = statusOf(st)
  const online = st?.phase === 'ready'
  return (
    <button
      onClick={onPick}
      className={`btn text-left p-0 overflow-hidden flex flex-col h-full w-full ${
        s.active ? 'bg-block border-emerald! shadow-[0_4px_0_var(--color-emerald-dark)]!' : 'bg-block'
      }`}
    >
      {/* material strip: the server's loader as a stratum */}
      <div
        className={`px-5 py-2 border-b-2 border-ink flex items-center gap-2.5 w-full ${loaderColors[s.detection.loader] ?? loaderColors.unknown}`}
        style={{ backgroundImage: 'var(--noise)' }}
      >
        <Pi i={loaderIcon(s.detection.loader)} className="pi pi-s" />
        <span className="font-px text-[10px] tracking-[0.08em]">
          {s.detection.loader.toUpperCase()}{s.detection.mc ? ` · MC ${s.detection.mc}` : ''}
        </span>
        {s.active && <span className="font-px text-[10px] tracking-[0.08em] ml-auto">★ ACTIVE</span>}
      </div>

      <div className="p-5 w-full">
        <div className="text-lg font-extrabold mb-2.5 truncate">{s.name}</div>
        <div className="flex items-center gap-2.5 mb-3">
          <span className={`lamp ${status.lamp}`} />
          <span className={`font-px text-[10px] tracking-[0.08em] ${status.cls}`}>{status.label}</span>
          {online && (
            <span className="font-px text-[10px] text-text-dim">
              {st!.online}/{st!.max} PLAYER{st!.online === 1 ? '' : 'S'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {online && typeof st!.mem === 'number' && (st!.mem as number) > 0 && (
            <span className="text-[11px] font-px border-2 border-line px-2 py-0.5 text-text-dim">
              RAM {((st!.mem as number) / 1e9).toFixed(1)}G
            </span>
          )}
          {st?.world_size && (
            <span className="text-[11px] font-px border-2 border-line px-2 py-0.5 text-text-dim">
              WORLD {st.world_size}
            </span>
          )}
          <span className="text-[11px] font-px text-text-dim ml-auto">:{s.port}</span>
        </div>
      </div>
    </button>
  )
}

interface CreateJobInfo { id: string; status: string; done: boolean; error: string | null; packName: string | null }

export default function Servers() {
  const { data, isLoading, error, refetch, isFetching } = useServers()
  const setActive = useSetActive()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [dismissedJobs, setDismissedJobs] = useState<string[]>([])

  // creations started ANYWHERE (Content's modpack button, a dropped pack file)
  // surface here too — a server materializing with no visible progress read
  // as a bug. Poll fast only while something is actually building.
  const { data: jobsData } = useQuery({
    queryKey: ['create-jobs'],
    queryFn: async () => (await (await fetch('/api/create-jobs')).json()) as { jobs: CreateJobInfo[] },
    refetchInterval: (q) => ((q.state.data?.jobs ?? []).some((j) => !j.done) ? 3000 : 30_000),
  })
  const buildJobs = (jobsData?.jobs ?? []).filter((j) => !dismissedJobs.includes(j.id))
  useEffect(() => {
    if (jobsData?.jobs.some((j) => j.done)) refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsData?.jobs.filter((j) => j.done).length])

  // one lightweight stats poll per card — lamps stay live
  const statQueries = useQueries({
    queries: (data?.servers ?? []).map((s) => ({
      queryKey: ['stats', s.id],
      queryFn: async () => (await (await fetch(`/api/servers/${s.id}/stats`)).json()) as Stats,
      refetchInterval: 8_000,
    })),
  })
  const statsById = new Map((data?.servers ?? []).map((s, i) => [s.id, statQueries[i]?.data]))

  return (
    <div>
      <div className="vista mb-6">
        <img src={bandSurface} alt="" />
        <span className="vista-tag">Y 63 · SURFACE</span>
      </div>
      <h1 className="text-3xl mb-1">Servers</h1>
      <p className="text-text-dim text-sm mb-7 max-w-[68ch]">
        Pick a server to manage — every page targets the active one.
      </p>

      {isLoading && <div className="text-text-dim text-sm">scanning worlds…</div>}

      {error && (
        <div className="block px-5 py-4 mb-6 border-redstone!">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="lamp lamp-crash" />
            <div className="min-w-0">
              <div className="font-bold text-sm">Can't reach Crafty</div>
              <div className="text-text-dim text-xs mt-0.5">
                Crafty Controller isn't responding on this machine — it may still be starting up.
                The panel reconnects by itself once it's back.
              </div>
            </div>
            <button onClick={() => refetch()} disabled={isFetching} className="btn btn-block px-4 py-2 text-xs ml-auto">
              {isFetching ? 'Checking…' : 'Check again'}
            </button>
          </div>
        </div>
      )}

      {buildJobs.length > 0 && (
        <div className="space-y-2 mb-5">
          {buildJobs.map((j) => (
            <div key={j.id} className={`block px-4 py-3 text-xs font-semibold ${j.error ? 'border-redstone!' : ''}`}>
              <div className="flex items-center gap-2.5 flex-wrap">
                {!j.done && <span className="lamp lamp-starting animate-pulse" />}
                {j.done && !j.error && <span className="lamp lamp-on" />}
                {j.error && <span className="lamp lamp-crash" />}
                <span className={j.error ? 'text-redstone' : j.done ? 'text-emerald' : 'text-gold'}>
                  {j.packName ? `${j.packName}: ` : ''}
                  {j.error ? `✗ ${j.error}` : `${j.done ? '✓ ' : ''}${j.status}`}
                </span>
                {j.done && (
                  <button className="btn text-xs !py-0 ml-auto" onClick={() => setDismissedJobs((d) => [...d, j.id])}>
                    ok
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {data?.servers.map((s, i) => (
          <div key={s.id} className="rise-in" style={{ '--i': i } as CSSProperties}>
            <ServerCard
              s={s}
              st={statsById.get(s.id)}
              onPick={() => {
                setActive.mutate(s.id)
                navigate('/dashboard')
              }}
            />
          </div>
        ))}

        <div className="flex flex-col gap-2">
          <button
            onClick={() => setCreating((v) => !v)}
            className={`place-tile flex flex-1 flex-col items-center justify-center border-2 border-dashed p-5 transition-colors min-h-28 ${
              creating ? 'border-emerald text-emerald' : 'border-line text-text hover:border-emerald'
            }`}
          >
            <span className="font-px text-xl mb-1">+</span>
            <span className="text-sm font-bold">Place new server</span>
            <span className="hud mt-1">{creating ? 'CLOSE' : 'ANY LOADER · ANY VERSION'}</span>
          </button>
          <button
            onClick={() => navigate('/content?tab=modpack')}
            className="text-xs text-text-dim hover:text-emerald text-center transition-colors"
            title="Search Modrinth / CurseForge packs — every result has a New Server button"
          >
            …or start from a modpack →
          </button>
        </div>
      </div>

      {creating && <NewServerPanel onDone={() => { setCreating(false); refetch() }} />}
    </div>
  )
}
