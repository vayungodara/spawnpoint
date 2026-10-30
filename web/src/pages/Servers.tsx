import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pi, loaderIcon } from '../components/PixelIcons'
import bandSurface from '../assets/band-surface.webp'

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

function NewServerPanel() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [loader, setLoader] = useState('fabric')
  const [mc, setMc] = useState('')
  const [name, setName] = useState('')
  const [mem, setMem] = useState(6)
  const [jobId, setJobId] = useState<string | null>(null)
  const { data: available } = useQuery({
    queryKey: ['loaders'],
    queryFn: async () => (await (await fetch('/api/loaders')).json()) as { loaders: string[] },
  })

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
      status: string; done: boolean; error: string | null; warnings: string[]; serverId: string | null
    },
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.done ? false : 2000),
  })

  const busy = create.isPending || (!!jobId && !job?.done)

  return (
    <div className="block px-5 py-5">
      <h2 className="hud mb-3">LOADER</h2>

      {/* loader — the one choice that changes everything downstream */}
      <div className="flex flex-wrap gap-2 mb-4">
        {LOADERS.filter((l) => available?.loaders.includes(l.key)).map((l) => {
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
                <button
                  onClick={async () => { await qc.invalidateQueries({ queryKey: ['servers'] }); navigate(job.serverId ? `/s/${job.serverId}` : '/') }}
                  className="btn btn-emerald px-4 py-1.5 ml-auto"
                >
                  Open it
                </button>
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

export default function NewServer() {
  return (
    <div className="space-y-5 pb-10">
      <div className="vista">
        <img src={bandSurface} alt="" />
        <span className="vista-tag">Y 63 · SURFACE</span>
      </div>
      <div>
        <h1 className="text-3xl mb-1">New server</h1>
        <p className="text-text-dim text-sm max-w-[68ch]">
          Port, EULA, Java version and memory are set for you. Forge and NeoForge take a few minutes to install.{' '}
          <Link to="/new/modpack" className="text-emerald font-semibold underline underline-offset-2">Start from a modpack instead</Link>
        </p>
      </div>
      <NewServerPanel />
    </div>
  )
}
