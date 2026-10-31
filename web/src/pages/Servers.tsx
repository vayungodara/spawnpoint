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
  const [mem, setMem] = useState<number | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const { data: available } = useQuery({
    queryKey: ['loaders'],
    queryFn: async () => (await (await fetch('/api/loaders')).json()) as { loaders: string[]; hostMemGb?: number },
  })
  // half the machine, 2 to 6 GB: enough for a modded pack, and room left for the mod test's second copy
  const host = available?.hostMemGb ?? 8
  const memMax = Math.max(2, Math.min(12, host - 1))
  const memGb = mem ?? Math.min(6, Math.max(2, Math.floor(host / 2)))

  const { data: catalog, isFetching: loadingVersions } = useQuery({
    queryKey: ['loader-versions', loader],
    queryFn: async () => {
      const r = await fetch(`/api/loaders/versions?loader=${loader}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'could not load versions')
      // verified/testedChanges are present only when Spawnpoint installs the server itself
      return j as { versions: string[]; verified?: string[]; testedChanges?: 'all' | string[] }
    },
    staleTime: 60 * 60_000,
  })
  const versions = catalog?.versions
  const tested = catalog?.testedChanges
  const testedHere = tested === 'all' || !!tested?.includes(mc)
  useEffect(() => {
    if (versions?.length && !versions.includes(mc)) setMc(versions[0])
  }, [versions, mc])

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/servers/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, loader, mc, memGb }),
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

  // the new server belongs in the sidebar, under its real runtime, before anyone presses Start
  useEffect(() => {
    if (job?.done) void qc.invalidateQueries()
  }, [job?.done, qc])

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
            {(versions ?? []).map((v) => (
              <option key={v} value={v}>{catalog?.verified ? `${v}${catalog.verified.includes(v) ? '' : ' · untested'}` : v}</option>
            ))}
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
          <span className="hud">MEMORY · {memGb} GB</span>
          <input
            type="range"
            min={2}
            max={memMax}
            step={1}
            value={memGb}
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

      {tested && mc && !testedHere && (
        <p className="text-text-dim text-xs mt-3 max-w-[68ch]">
          {tested.length
            ? `Panel mod changes on ${LOADERS.find((l) => l.key === loader)?.label} need its tested profile (${tested.join(', ')}). On ${mc} the panel refuses them; start from a modpack to bring mods.`
            : `${LOADERS.find((l) => l.key === loader)?.label} servers don't get tested changes: ${loader === 'quilt' ? 'mods' : loader === 'vanilla' ? 'datapacks' : 'plugins'} install after a restart without a boot or join test.`}
        </p>
      )}

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
                  onClick={async () => {
                    // the first thing everyone does next is press Start: the
                    // server page presses it, so its button shows Starting…
                    await qc.invalidateQueries() // servers and runtime ownership both changed
                    navigate(job.serverId ? `/s/${job.serverId}` : '/', { state: { start: !!job.serverId } })
                  }}
                  autoFocus
                  className="btn btn-emerald px-4 py-1.5 ml-auto"
                >
                  Start it
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
