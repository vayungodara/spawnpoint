import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, fmtWhen, txnDate, useChange, useCurrentServer, useLogs, useRevisions, useRuntime, useStats,
  type ServerInfo, type Stats,
} from '../../api'
import { ChangeCard, Rejections, TestChips, UndoWaitingBanner } from '../../components/Change'
import CrashSweepRow from '../../components/CrashSweep'
import { changeVisible, copyText, fmtMem, joinAddress } from '../../components/status'
import { JoinChip } from './Workspace'

const MOD_LOADERS = ['fabric', 'forge', 'neoforge']

/** A server another operation owns, or one a panel restart left mid-operation. */
function MaintenanceBanner({ id, m }: { id: string; m: NonNullable<Stats['maintenance']> }) {
  const qc = useQueryClient()
  const clear = useMutation({
    mutationFn: () => fetch(`/api/servers/${id}/maintenance/clear`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stats', id] }),
  })
  if (!m.interrupted) {
    return (
      <div className="block border-sky! px-4 py-3 text-sm" role="status">
        <span className="hud !opacity-100 !inline-flex mr-2 text-sky">BUSY</span>
        {m.op === 'mod update' ? 'Finishing a mod change.' : `${m.op[0].toUpperCase()}${m.op.slice(1)} in progress.`} Start and stop are paused until it finishes.
      </div>
    )
  }
  return (
    <div role="alert" className="block border-gold! px-4 py-3 text-sm space-y-3">
      <div>
        <span className="hud !opacity-100 !inline-flex mr-2 text-gold">NEEDS YOU</span>
        A <b>{m.op}</b> {m.note ? <>stopped part-way: {m.note}.</> : 'was cut short when the panel restarted.'} Start and stop stay paused until you have checked the server's files.
      </div>
      <button onClick={() => clear.mutate()} disabled={clear.isPending} className="btn btn-block px-4 py-2 text-sm">I've checked it, allow starts again</button>
    </div>
  )
}

// CPU samples survive tab switches: the overview remounts, the history should not
const cpuHistory = new Map<string, number[]>()

function Spark({ values, max, color }: { values: number[]; max: number; color: string }) {
  if (values.length < 2) return <svg aria-hidden viewBox="0 0 64 20" />
  const pts = values.map((v, i) => `${(i * 64) / (values.length - 1)},${(19 - (Math.min(v, max) / max) * 17).toFixed(1)}`).join(' ')
  return <svg aria-hidden viewBox="0 0 64 20" preserveAspectRatio="none"><polyline points={pts} style={{ stroke: color }} /></svg>
}

function Tiles({ id, stats }: { id: string; stats: Stats | undefined }) {
  const running = !!stats?.running
  const ready = stats?.phase === 'ready' || (running && !stats?.phase)
  const [cpu, setCpu] = useState<number[]>(() => cpuHistory.get(id) ?? [])
  useEffect(() => {
    const next = running && stats ? [...(cpuHistory.get(id) ?? []).slice(-23), stats.cpu] : []
    cpuHistory.set(id, next)
    setCpu(next)
  }, [id, stats, running])
  const { data: tps } = useQuery({
    queryKey: ['tps', id],
    queryFn: () => api<{ samples: { t: number; mspt: number; tps: number }[] }>(`/api/servers/${id}/tps`),
    refetchInterval: 20_000,
    enabled: ready,
  })
  const { data: jvm } = useQuery({
    queryKey: ['jvm', id],
    queryFn: () => api<{ minGb: number | null; maxGb: number | null }>(`/api/servers/${id}/jvm`),
    staleTime: 5 * 60_000,
  })
  const tpsNow = tps?.samples.at(-1)
  const tpsColor = !tpsNow ? 'var(--color-emerald)' : tpsNow.tps >= 19 ? 'var(--color-emerald)' : tpsNow.tps >= 15 ? 'var(--color-gold)' : 'var(--color-redstone)'
  // a runtime that cannot measure memory reports 0; show a dash, not "0.0 GB"
  const memGb = running && typeof stats?.mem === 'number' && stats.mem > 0 ? stats.mem / 1e9 : null
  const memPct = memGb !== null && jvm?.maxGb ? Math.min(100, (memGb / jvm.maxGb) * 100) : 0
  const dash = <span className="text-text-dim">—</span>
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <div className="block stat">
        <span className="hud">PLAYERS</span>
        <span className="stat-v">{ready ? <>{stats?.online ?? 0}<small>/ {stats?.max ?? '?'}</small></> : dash}</span>
        <span className="text-xs text-text-dim truncate">{ready ? (stats?.online ? 'online now' : 'nobody on yet') : 'server offline'}</span>
      </div>
      <div className="block stat" title={tpsNow ? `${tpsNow.mspt} ms per tick` : undefined}>
        <span className="hud">TPS</span>
        <span className="stat-v" style={{ color: tpsNow ? tpsColor : undefined }}>{ready && tpsNow ? tpsNow.tps.toFixed(1) : dash}</span>
        <Spark values={(tps?.samples ?? []).slice(-24).map((s) => s.tps)} max={20} color={tpsColor} />
      </div>
      <div className="block stat">
        <span className="hud">RAM</span>
        <span className="stat-v">{memGb !== null ? <>{memGb.toFixed(1)}<small>/ {jvm?.maxGb ?? '?'} GB</small></> : running && typeof stats?.mem === 'string' && stats.mem ? fmtMem(stats.mem) : dash}</span>
        <div className="meter h-3"><div className="meter-fill bg-diamond" style={{ width: `${memPct}%` }} /></div>
      </div>
      <div className="block stat">
        <span className="hud">CPU</span>
        <span className="stat-v">{running && stats ? <>{Math.round(stats.cpu)}<small>%</small></> : dash}</span>
        <Spark values={cpu} max={100} color="var(--color-emerald)" />
      </div>
    </div>
  )
}

/** What is in the live pack, by name: the owner's answer to "what did I install?". */
function PackMods({ id }: { id: string }) {
  const { data } = useQuery({
    queryKey: ['installed', id],
    queryFn: () => api<{ items?: { file: string; title?: string; enabled: boolean }[] }>(`/api/servers/${id}/installed`),
  })
  const names = (data?.items ?? []).filter((i) => i.enabled).map((i) => i.title ?? i.file)
  if (!names.length) return null
  const shown = names.slice(0, 12)
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm" aria-label="Mods in the pack">
      {shown.map((n) => (
        <li key={n} className="flex items-center gap-2"><span className="w-1.5 h-1.5 bg-emerald shrink-0" aria-hidden />{n}</li>
      ))}
      {names.length > shown.length && <li className="text-text-dim">+{names.length - shown.length} more</li>}
    </ul>
  )
}

function PackCard({ s }: { s: ServerInfo }) {
  const modded = MOD_LOADERS.includes(s.detection.loader)
  const { data } = useRevisions(modded ? s.id : undefined)
  const live = data?.revisions.find((r) => r.id === (data.published ?? data.active))
  return (
    <section className="block p-4 sm:p-5 flex flex-col gap-3">
      <h2 className="hud">THE PACK</h2>
      {!modded ? (
        <p className="text-sm text-text-dim">
          {s.detection.loader === 'unknown' ? 'Spawnpoint could not tell which loader this server runs.' : `This ${s.detection.loader} server takes plugins and datapacks directly. Tested pack revisions cover Fabric, Forge and NeoForge.`}
        </p>
      ) : live?.id.endsWith('-baseline') ? (
        <div>
          <div className="text-lg font-extrabold">Starting pack recorded</div>
          <p className="text-sm text-text-dim mt-0.5 max-w-[60ch]">
            Spawnpoint sealed the {live.requested === 1 ? 'mod' : `${live.requested} mods`} this server had before its first change, so Undo can return to it. Changes from here on are tested before they go live.
          </p>
        </div>
      ) : live ? (
        <>
          <div>
            <div className="text-lg font-extrabold">{data?.published === live.id ? 'Friends have the tested pack' : 'Tested pack active, not synced to friends yet'}</div>
            <div className="text-sm text-text-dim mt-0.5">
              Sealed {fmtWhen(txnDate(live.id))} · {live.requested} {live.requested === 1 ? 'mod' : 'mods'} you picked · {live.dependencies} {live.dependencies === 1 ? 'dependency' : 'dependencies'}
            </div>
          </div>
          <TestChips tests={live.tests} />
          <PackMods id={s.id} />
        </>
      ) : (
        <div>
          <div className="text-lg font-extrabold">No tested revision yet</div>
          <p className="text-sm text-text-dim mt-0.5 max-w-[60ch]">
            Install a mod and Spawnpoint checks the whole pack, boots it on a copy and only then lets it go live.
          </p>
        </div>
      )}
      <div className="flex gap-3 flex-wrap mt-auto pt-1">
        <Link to={`/s/${s.id}/mods`} className="btn btn-emerald px-4 py-2 text-sm">{modded ? 'Browse mods' : 'Browse content'}</Link>
        {modded && <Link to={`/s/${s.id}/changes`} className="btn btn-block px-4 py-2 text-sm">History and undo</Link>}
      </div>
    </section>
  )
}

async function downloadStarter(id: string, format?: 'curseforge') {
  const res = await fetch(`/api/servers/${id}/starterpack${format ? '?format=curseforge' : ''}`)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? (format ? 'starter-curseforge.zip' : 'starter.mrpack')
  a.click()
  URL.revokeObjectURL(a.href)
}

/** The one-time code a friend's AutoModpack asks for on their first join. */
function Fingerprint({ id }: { id: string }) {
  const { data } = useQuery({
    queryKey: ['fingerprint', id],
    queryFn: () => api<{ fingerprint: string | null }>(`/api/servers/${id}/automodpack/fingerprint`),
    staleTime: 60_000,
    // the first boot prints it; keep asking until it has
    refetchInterval: (q) => (q.state.data?.fingerprint ? false : 15_000),
  })
  const [copied, setCopied] = useState(false)
  const fp = data?.fingerprint
  if (!data) return null
  if (!fp) return <p className="text-xs text-text-dim">Start the server once: friends will need the fingerprint it prints.</p>
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-sm">On their first join, AutoModpack asks for this server's fingerprint:</span>
      <button
        onClick={() => copyText(fp).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2200) })}
        className="btn btn-block px-3 py-1.5 flex items-center gap-2.5 min-w-0"
        title={fp}
      >
        <span className="font-mono text-xs">{fp.slice(0, 8)}…{fp.slice(-8)}</span>
        <span key={String(copied)} className={`hud !opacity-100 pop-in ${copied ? 'text-emerald' : ''}`}>{copied ? 'COPIED' : 'COPY'}</span>
      </button>
    </div>
  )
}

function InviteCard({ s }: { s: ServerInfo }) {
  const synced = [...MOD_LOADERS, 'quilt'].includes(s.detection.loader)
  const [msg, setMsg] = useState<string | null>(null)
  const get = useMutation({
    mutationFn: (format?: 'curseforge') => downloadStarter(s.id, format),
    onSuccess: () => { setMsg('Downloaded. Send that one file to your friends.'); window.dispatchEvent(new Event('sp-invited')) },
    onError: (e) => setMsg(`Starter pack failed: ${e instanceof Error ? e.message : String(e)}`),
  })
  return (
    <section className="block p-4 sm:p-5 flex flex-col gap-3">
      <h2 className="hud">INVITE FRIENDS</h2>
      <JoinChip s={s} className="self-start max-w-full" />
      {synced ? (
        <ol className="text-sm space-y-2 list-none">
          <li className="flex gap-2.5"><b className="font-px text-[11px] text-emerald mt-0.5">1</b><span>Send them the starter pack. It is tiny and only needed once.</span></li>
          <li className="flex gap-2.5"><b className="font-px text-[11px] text-emerald mt-0.5">2</b><span>They import it in Modrinth App, Prism or the CurseForge app and press Play.</span></li>
          <li className="flex gap-2.5"><b className="font-px text-[11px] text-emerald mt-0.5">3</b><span>They join <span className="font-mono">{joinAddress(s)}</span>. AutoModpack syncs the tested pack on join, now and after every change.</span></li>
        </ol>
      ) : (
        <p className="text-sm text-text-dim">Friends join with a normal Minecraft {s.detection.mc ?? ''} client at this address. Nothing to install.</p>
      )}
      {synced && <Fingerprint id={s.id} />}
      {synced && (
        <div className="flex gap-3 flex-wrap mt-auto pt-1">
          <button onClick={() => get.mutate(undefined)} disabled={get.isPending} className="btn btn-emerald px-4 py-2 text-sm">{get.isPending ? 'Building…' : 'Download starter pack'}</button>
          <button onClick={() => get.mutate('curseforge')} disabled={get.isPending} className="btn btn-block px-4 py-2 text-sm">CurseForge version</button>
        </div>
      )}
      {msg && <p role="status" className="text-xs font-semibold pop-in">{msg}</p>}
      <p className="text-xs text-text-dim">Only forward the game port. Keep this panel on your LAN or a VPN.</p>
    </section>
  )
}

function ConsolePreview({ s, running }: { s: ServerInfo; running: boolean }) {
  const { data } = useLogs(s.id, true)
  const lines = data?.lines.slice(-8) ?? []
  return (
    <section className="apanel">
      <div className="apanel-head">
        <i className={`ph-dot ${running ? '' : 'ph-dot-off'}`} />
        <b>Console</b>
        <Link to={`/s/${s.id}/console`} className="ml-auto text-[12px] text-emerald hover:underline underline-offset-2">Open console →</Link>
      </div>
      <div className="console px-4 py-3 text-[#cfd6db] min-h-32">
        {lines.length ? lines.map((l, i) => <p key={`${data!.lines.length - 8 + i}`} className="cline whitespace-pre-wrap break-all">{l}</p>)
          : <p className="opacity-50">No output yet. Start the server and its log appears here.</p>}
      </div>
    </section>
  )
}

/** First-run checklist: start → add a mod → invite. Ticks itself off from real
    state and goes away once all three are done, or when dismissed. */
function FirstSteps({ s, stats }: { s: ServerInfo; stats: Stats | undefined }) {
  const key = `sp-first-steps-${s.id}`
  const [hidden, setHidden] = useState(() => localStorage.getItem(key) === 'done')
  const modded = MOD_LOADERS.includes(s.detection.loader)
  const { data: revs } = useRevisions(modded ? s.id : undefined)
  const [invited, setInvited] = useState(() => localStorage.getItem(`${key}-invite`) === '1')
  useEffect(() => {
    const mark = () => { localStorage.setItem(`${key}-invite`, '1'); setInvited(true) }
    window.addEventListener('sp-invited', mark)
    return () => window.removeEventListener('sp-invited', mark)
  }, [key])
  const running = stats?.phase === 'ready' || (!!stats?.running && !stats?.phase)
  const steps = [
    { done: running || !!revs?.revisions.length, label: 'Start the server', hint: stats?.phase === 'starting' ? 'Booting… the first start takes about a minute.' : 'Press Start at the top. Java downloads itself the first time.' },
    ...(modded ? [{ done: !!revs?.revisions.some((r) => !r.id.endsWith('-baseline')), label: 'Add a mod', hint: 'Pick one in Mods. Spawnpoint tests it on a copy, then asks you before it goes live.', to: `/s/${s.id}/mods` }] : []),
    { done: invited, label: 'Invite a friend', hint: modded ? 'Copy the address and send the starter pack below.' : 'Copy the address below and send it.' },
  ]
  const all = steps.every((x) => x.done)
  if (hidden || (all && (!modded || revs !== undefined))) return null
  const next = steps.findIndex((x) => !x.done)
  return (
    <section className="block p-4 sm:p-5 rise-in" aria-label="First steps">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="hud !opacity-100 text-emerald">FIRST STEPS · {steps.filter((x) => x.done).length}/{steps.length}</h2>
        <button onClick={() => { localStorage.setItem(key, 'done'); setHidden(true) }} className="ml-auto text-xs text-text-dim hover:text-text underline underline-offset-2">Hide</button>
      </div>
      <ol className="grid sm:grid-cols-3 gap-3">
        {steps.map((x, i) => (
          <li key={x.label} className={`flex gap-3 p-3 border-2 ${i === next ? 'border-emerald bg-block-2' : 'border-line/60'}`}>
            <span aria-hidden className={`w-6 h-6 shrink-0 grid place-items-center border-2 border-ink font-px text-[11px] ${x.done ? 'bg-emerald text-ink' : 'bg-bedrock'}`}>{x.done ? '✓' : i + 1}</span>
            <span className="min-w-0">
              <b className={`text-sm flex ${x.done ? 'text-text-dim line-through decoration-2' : ''}`}>
                {'to' in x && x.to && !x.done && i === next ? <Link to={x.to} className="underline underline-offset-2">{x.label}</Link> : x.label}
              </b>
              {!x.done && <span className="text-xs text-text-dim flex mt-0.5">{x.hint}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export default function Overview() {
  const s = useCurrentServer()
  const { data: stats } = useStats(s?.id)
  const { data: change } = useChange(s?.id)
  const { data: runtime } = useRuntime()
  if (!s) return null
  const c = change?.candidate
  const crafty = runtime?.supervisor && !runtime.native.some((n) => n.id === s.id)
  return (
    <div className="space-y-6">
      {stats?.maintenance && <MaintenanceBanner id={s.id} m={stats.maintenance} />}
      {stats?.crashed && !stats.running && <CrashSweepRow serverId={s.id} />}
      {change?.promotion?.action === 'undo' && <UndoWaitingBanner id={s.id} p={change.promotion} />}
      {changeVisible(c) && <ChangeCard id={s.id} c={c} p={change?.promotion?.action === 'apply' ? change.promotion : null} />}
      {/* a turned-away change leaves the card; say so where the owner was watching */}
      {!changeVisible(c) && <Rejections id={s.id} />}
      <FirstSteps s={s} stats={stats} />
      {/* a stopped server has no numbers worth a row of dashes; the hero says it is stopped */}
      {stats?.running && <Tiles id={s.id} stats={stats} />}
      <div className="grid lg:grid-cols-2 gap-6">
        <PackCard s={s} />
        <InviteCard s={s} />
      </div>
      <ConsolePreview s={s} running={!!stats?.running} />
      {crafty && (
        <p className="text-sm text-text-dim">
          Crafty Controller runs this server. When you are ready, move it into Spawnpoint’s own service from{' '}
          <Link to={`/s/${s.id}/server`} className="text-emerald underline underline-offset-2">Server → Runtime</Link>. The world and server ID stay the same.
        </p>
      )}
    </div>
  )
}
