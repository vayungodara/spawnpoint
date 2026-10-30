import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`)
  return r.json() as Promise<T>
}

interface Progress {
  running: boolean; paused: boolean; dimension: string | null
  chunks: number | null; percent: number | null
  etaText: string | null; rate: number | null; current: [number, number] | null
}
interface ChunkyConfig {
  radius: number; centerMode: 'spawn' | 'custom'; centerX: number; centerZ: number
  shape: string; dimensions: string[]; pauseWhenPlayersOnline: boolean
  schedule: { enabled: boolean; time: string }
}
interface DoneRecord {
  at: string; startedAt: string; chunks: number | null
  dimensions: string[]; radius: number; shape: string
}
interface Status {
  installed: boolean; running: boolean; loaded?: boolean; progress: Progress | null; config: ChunkyConfig
  lastDone?: DoneRecord | null
}

/** "2h", "14min", "40s" — pregen durations don't need more precision */
const durText = (ms: number) => {
  if (ms < 0 || !Number.isFinite(ms)) return null
  const m = Math.round(ms / 60000)
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (m < 90) return `${m}min`
  return `${(m / 60).toFixed(1)}h`
}
interface Options { shapes: string[]; dimensions: { id: string; label: string }[] }
interface BobbyStatus {
  bobbyInstalled: boolean; building: boolean; ready: boolean
  sizeBytes: number | null; builtAt: string | null; error: string | null
}

const dimLabel = (id: string) => id.replace('minecraft:', '').replace('the_', '').replace(/^\w/, (c) => c.toUpperCase())

/** World pre-generation, powered by Chunky. Renders nothing on a server that
    doesn't have Chunky installed — so it silently appears only where it works. */
export default function PregenSection({ serverId }: { serverId: string }) {
  const qc = useQueryClient()
  const { data: opts } = useQuery({
    queryKey: ['chunky-options'],
    queryFn: () => api<Options>('/api/chunky/options'),
    staleTime: Infinity,
  })
  const { data } = useQuery({
    queryKey: ['chunky', serverId],
    queryFn: () => api<Status>(`/api/servers/${serverId}/chunky`),
    enabled: !!serverId,
    // poll fast while a task is live so the bar moves; slow when idle
    refetchInterval: (q) => (q.state.data?.progress?.running || q.state.data?.progress?.paused ? 3000 : 15000),
  })

  const [draft, setDraft] = useState<Partial<ChunkyConfig> | null>(null)
  useEffect(() => setDraft(null), [serverId])
  const [msg, setMsg] = useState('')

  const cfg = { ...data?.config, ...draft } as ChunkyConfig
  const setCfg = (patch: Partial<ChunkyConfig>) => setDraft((d) => ({ ...(d ?? {}), ...patch }))

  const saveConfig = useMutation({
    mutationFn: (patch: Partial<ChunkyConfig>) =>
      api(`/api/servers/${serverId}/chunky/config`, { method: 'PUT', body: JSON.stringify(patch) }),
    // clear the edited keys so the draft overlay (and the "save" link) go away
    onSuccess: () => { setDraft(null); qc.invalidateQueries({ queryKey: ['chunky', serverId] }) },
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`),
  })
  const start = useMutation({
    mutationFn: () => {
      setMsg('')
      return api<{ message: string }>(`/api/servers/${serverId}/chunky/start`, {
        method: 'POST',
        body: JSON.stringify({
          radius: cfg.radius, centerMode: cfg.centerMode, centerX: cfg.centerX,
          centerZ: cfg.centerZ, shape: cfg.shape, dimensions: cfg.dimensions,
        }),
      })
    },
    onSuccess: (r) => { setMsg(`▶ ${r.message}`); setDraft(null); qc.invalidateQueries({ queryKey: ['chunky', serverId] }) },
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`),
  })
  const control = useMutation({
    mutationFn: (action: 'pause' | 'continue' | 'cancel' | 'trim') => { setMsg(''); return api(`/api/servers/${serverId}/chunky/${action}`, { method: 'POST', body: '{}' }) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chunky', serverId] }),
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`),
  })
  const { data: bobby } = useQuery({
    queryKey: ['bobby', serverId],
    queryFn: () => api<BobbyStatus>(`/api/servers/${serverId}/bobby`),
    enabled: !!serverId,
    refetchInterval: (q) => (q.state.data?.building ? 4000 : 60000),
  })
  const buildBobby = useMutation({
    mutationFn: () => { setMsg(''); return api(`/api/servers/${serverId}/bobby/build`, { method: 'POST', body: '{}' }) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bobby', serverId] }),
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`),
  })
  const restart = useMutation({
    mutationFn: () => { setMsg(''); return api(`/api/servers/${serverId}/action`, { method: 'POST', body: JSON.stringify({ action: 'restart' }) }) },
    onSuccess: () => { setMsg('▶ restarting — Chunky loads with the new boot'); qc.invalidateQueries({ queryKey: ['chunky', serverId] }) },
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`),
  })

  // hidden entirely unless Chunky is on this server
  if (!data) return null
  if (!data.installed) return null

  const prog = data.progress
  const notLoaded = data.running && data.loaded === false
  const busy = !!(prog?.running || prog?.paused)
  // server up but progress unreadable (RCON blip): don't fall back to the Start
  // form mid-task — hold with a placeholder until the next poll clears it
  const unknown = data.running && data.progress === null
  const pct = Math.min(100, Math.max(0, prog?.percent ?? 0))
  const dirty = draft && Object.keys(draft).some((k) => k !== 'schedule' && k !== 'pauseWhenPlayersOnline')
  const noDims = !(cfg.dimensions?.length)

  return (
    <div className="block px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="hud">PREGEN</div>
          <div className="text-base font-extrabold mt-1">World pre-generation</div>
        </div>
        <span
          className={`font-px text-[10px] border-2 px-2 py-1 ${
            notLoaded ? 'border-gold text-gold'
            : prog?.running ? 'border-emerald text-emerald'
            : prog?.paused ? 'border-gold text-gold'
            : data.running ? 'border-line text-text-dim'
            : 'border-line text-text-dim opacity-70'
          }`}
        >
          {notLoaded ? 'RESTART NEEDED' : prog?.running ? 'GENERATING' : prog?.paused ? 'PAUSED' : data.running ? 'IDLE' : 'SERVER OFF'}
        </span>
      </div>
      <p className="text-xs text-text-dim mt-1 max-w-[68ch]">
        Chunky builds the world ahead of time so exploring is instant and lag-free — no hitches when
        someone walks into fresh terrain. Generate once; it's saved to the world forever.
      </p>

      {/* ---- live progress ---- */}
      {busy && prog && (
        <div className="mt-4 space-y-2">
          <div className="meter h-7">
            <div
              className={`meter-fill ${prog.paused ? 'bg-gold' : 'working bg-emerald'}`}
              style={{ width: `${pct}%` }}
            />
            <span className="absolute inset-0 flex items-center justify-center text-xs font-extrabold text-paper mix-blend-difference">
              {pct.toFixed(1)}%{prog.dimension ? ` · ${dimLabel(prog.dimension)}` : ''}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-dim font-mono">
            {prog.chunks != null && <span>{prog.chunks.toLocaleString()} chunks</span>}
            {prog.etaText && <span>ETA {prog.etaText}</span>}
            {prog.rate != null && <span>{prog.rate.toFixed(0)} chunks/sec</span>}
            {prog.current && <span>at {prog.current[0]}, {prog.current[1]}</span>}
          </div>
          <div className="flex items-center gap-3 pt-1">
            {prog.paused ? (
              <button onClick={() => control.mutate('continue')} disabled={control.isPending} className="btn btn-emerald px-4 py-1.5 text-sm">Resume</button>
            ) : (
              <button onClick={() => control.mutate('pause')} disabled={control.isPending} className="btn btn-block px-4 py-1.5 text-sm">Pause</button>
            )}
            <button
              onClick={() => { if (confirm('Cancel this pre-generation? Progress so far stays saved; the task is discarded.')) control.mutate('cancel') }}
              disabled={control.isPending}
              className="btn btn-redstone px-4 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---- Chunky jar on disk but not in the running JVM ---- */}
      {notLoaded && (
        <div className="mt-4 border-2 border-gold px-4 py-3">
          <p className="text-sm font-bold text-gold">Chunky was installed while the server was running</p>
          <p className="text-xs text-text-dim mt-1 max-w-[60ch]">
            New mods load at boot, so the running server doesn't know the chunky command yet.
            Restart once and pre-generation is ready.
          </p>
          <button
            onClick={() => { if (confirm('Restart the server now? Anyone online will be disconnected.')) restart.mutate() }}
            disabled={restart.isPending}
            className="btn btn-emerald px-4 py-1.5 text-sm mt-3"
          >
            {restart.isPending ? 'Restarting…' : 'Restart server'}
          </button>
        </div>
      )}

      {/* ---- transient: server up but progress unreadable ---- */}
      {unknown && !busy && !notLoaded && (
        <p className="mt-4 text-xs text-text-dim italic">checking pre-generation status…</p>
      )}

      {/* ---- settings + start (only when idle) ---- */}
      {!busy && !unknown && !notLoaded && (
        <div className="mt-4 space-y-3.5">
          {data.lastDone && (
            <div className="border-2 border-emerald/60 px-4 py-2.5">
              <span className="font-px text-[10px] text-emerald">✓ DONE</span>
              <span className="text-xs text-text-dim ml-2.5">
                pre-generated {data.lastDone.chunks != null ? `${data.lastDone.chunks.toLocaleString()} chunks — ` : ''}
                a {data.lastDone.radius.toLocaleString()}-block {data.lastDone.shape} in {data.lastDone.dimensions.map(dimLabel).join(', ')}
                {' · '}finished {new Date(data.lastDone.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {durText(new Date(data.lastDone.at).getTime() - new Date(data.lastDone.startedAt).getTime()) ? ` · took ${durText(new Date(data.lastDone.at).getTime() - new Date(data.lastDone.startedAt).getTime())}` : ''}
                {' — '}saved into the world for good. Grow the radius any time and only the new ring generates.
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-6">
            <div>
              <div className="text-sm font-bold">Radius</div>
              <div className="text-xs text-text-dim mt-0.5">
                blocks from the center — a {cfg.radius?.toLocaleString()} radius is a {(cfg.radius * 2 / 1000).toFixed(1)}k×{(cfg.radius * 2 / 1000).toFixed(1)}k block area
              </div>
            </div>
            <input
              type="number" min={1} max={50000} value={cfg.radius ?? 2000}
              onChange={(e) => setCfg({ radius: parseInt(e.target.value, 10) || 0 })}
              className="field w-32 px-3 py-1.5 text-sm font-mono"
            />
          </div>

          <div className="flex items-center justify-between gap-6">
            <div className="text-sm font-bold">Center</div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <div className="flex border-2 border-ink">
                <button
                  onClick={() => setCfg({ centerMode: 'spawn' })}
                  className={`font-px text-[10px] px-3 py-1.5 ${cfg.centerMode === 'spawn' ? 'bg-emerald text-ink' : 'bg-panel text-text-dim'}`}
                >SPAWN</button>
                <button
                  onClick={() => setCfg({ centerMode: 'custom' })}
                  className={`font-px text-[10px] px-3 py-1.5 border-l-2 border-ink ${cfg.centerMode === 'custom' ? 'bg-emerald text-ink' : 'bg-panel text-text-dim'}`}
                >CUSTOM</button>
              </div>
              {cfg.centerMode === 'custom' && (
                <>
                  <input type="number" value={cfg.centerX ?? 0} onChange={(e) => setCfg({ centerX: parseInt(e.target.value, 10) || 0 })} placeholder="X" aria-label="Center X" className="field w-20 px-2 py-1.5 text-sm font-mono" />
                  <input type="number" value={cfg.centerZ ?? 0} onChange={(e) => setCfg({ centerZ: parseInt(e.target.value, 10) || 0 })} placeholder="Z" aria-label="Center Z" className="field w-20 px-2 py-1.5 text-sm font-mono" />
                </>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-6">
            <div className="text-sm font-bold">Shape</div>
            <select
              value={cfg.shape ?? 'square'}
              onChange={(e) => setCfg({ shape: e.target.value })}
              className="field px-3 py-1.5 text-sm capitalize"
            >
              {(opts?.shapes ?? ['square', 'circle']).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="flex items-center justify-between gap-6">
            <div className="text-sm font-bold">Dimensions</div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {(opts?.dimensions ?? [{ id: 'minecraft:overworld', label: 'Overworld' }]).map((d) => {
                const on = (cfg.dimensions ?? []).includes(d.id)
                return (
                  <button
                    key={d.id}
                    onClick={() => setCfg({ dimensions: on ? cfg.dimensions.filter((x) => x !== d.id) : [...(cfg.dimensions ?? []), d.id] })}
                    className={`font-px text-[10px] border-2 px-2.5 py-1.5 ${on ? 'border-emerald text-emerald' : 'border-line text-text-dim'}`}
                  >{d.label}</button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => start.mutate()}
              disabled={start.isPending || !data.running || noDims}
              className="btn btn-emerald px-5 py-2 text-sm"
            >
              {start.isPending ? 'Starting…' : 'Start pre-generation'}
            </button>
            {dirty && !noDims && (
              <button onClick={() => saveConfig.mutate({ radius: cfg.radius, centerMode: cfg.centerMode, centerX: cfg.centerX, centerZ: cfg.centerZ, shape: cfg.shape, dimensions: cfg.dimensions })} disabled={saveConfig.isPending} className="text-xs font-bold text-text-dim hover:text-text">save without starting</button>
            )}
            {noDims && <span className="text-xs text-gold">pick at least one dimension</span>}
            {!data.running && !noDims && <span className="text-xs text-text-dim">start the server to pre-generate</span>}
          </div>
        </div>
      )}

      {/* ---- Bobby fallback world: needs the Bobby mod in the pack AND a
           completed pregen of the CURRENT world — exporting an unpregenerated
           world would ship friends a mostly-empty fallback ---- */}
      {bobby?.bobbyInstalled && data.lastDone && (
        <div className="mt-4 pt-3 border-t-2 border-line/40">
          <div className="flex items-center justify-between gap-6">
            <div>
              <div className="text-sm font-bold">Bobby fallback world</div>
              <div className="text-xs text-text-dim mt-0.5 max-w-[58ch]">
                Bobby renders far beyond the server's view distance. Export the pre-generated world,
                unzip it into your instance's <span className="font-mono">saves/</span> folder
                (keep the folder name <span className="font-mono">bobby-fallback</span>) and the whole
                map is visible from your first login.
              </div>
            </div>
            <div className="flex items-center gap-3 flex-none">
              {bobby.building ? (
                <span className="text-xs text-gold font-bold">building…</span>
              ) : bobby.ready ? (
                <>
                  <a href={`/api/servers/${serverId}/bobby/download`} className="btn btn-emerald px-4 py-1.5 text-sm" download>
                    Download{bobby.sizeBytes != null ? ` (${(bobby.sizeBytes / 1e6).toFixed(0)} MB)` : ''}
                  </a>
                  <button onClick={() => buildBobby.mutate()} disabled={buildBobby.isPending} className="text-xs font-bold text-text-dim hover:text-text">rebuild</button>
                </>
              ) : (
                <button onClick={() => buildBobby.mutate()} disabled={buildBobby.isPending} className="btn btn-block px-4 py-1.5 text-sm">
                  Build fallback world
                </button>
              )}
            </div>
          </div>
          {bobby.ready && bobby.builtAt && !bobby.building && (
            <div className="text-xs text-text-dim mt-1.5">
              built {new Date(bobby.builtAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} — rebuild after growing the pregen radius
            </div>
          )}
          {bobby.error && !bobby.building && <div className="text-xs text-redstone mt-1.5">{bobby.error}</div>}
        </div>
      )}

      {/* ---- automation (always visible) ---- */}
      <div className="mt-4 pt-3 border-t-2 border-line/40 space-y-3.5">
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-bold">Pause while players are online</div>
            <div className="text-xs text-text-dim mt-0.5">auto-pause when someone joins, resume when the server empties</div>
          </div>
          <button
            role="switch" aria-checked={cfg.pauseWhenPlayersOnline ?? true} data-on={cfg.pauseWhenPlayersOnline ?? true}
            onClick={() => saveConfig.mutate({ pauseWhenPlayersOnline: !(cfg.pauseWhenPlayersOnline ?? true) })}
            className="lever"
          />
        </div>
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-bold">Auto-start daily</div>
            <div className="text-xs text-text-dim mt-0.5">kick off a pregen every day at this time (only when the server is empty)</div>
          </div>
          <div className="flex items-center gap-3">
            {cfg.schedule?.enabled && (
              <input
                type="time" value={cfg.schedule?.time ?? '04:00'}
                onChange={(e) => saveConfig.mutate({ schedule: { enabled: true, time: e.target.value } })}
                className="field px-2 py-1.5 text-sm font-mono"
              />
            )}
            <button
              role="switch" aria-checked={cfg.schedule?.enabled ?? false} data-on={cfg.schedule?.enabled ?? false}
              onClick={() => saveConfig.mutate({ schedule: { enabled: !(cfg.schedule?.enabled ?? false), time: cfg.schedule?.time ?? '04:00' } })}
              className="lever"
            />
          </div>
        </div>
      </div>

      {msg && <div role="status" className="mt-3 text-sm font-semibold">{msg}</div>}
    </div>
  )
}
