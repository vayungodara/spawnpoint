import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { changeNeedsOwner, useChange, useRuntime, useServerAction, useServers, useSetActive, useStats, type ServerInfo, type Stats } from '../../api'
import { Pi } from '../../components/PixelIcons'
import { ReviewSheet } from '../../components/Change'
import { PLUGIN_LOADERS, changeVisible, copyText, joinAddress, statusOf } from '../../components/status'
import bandSurface from '../../assets/band-surface.webp'
import bandControl from '../../assets/band-control.webp'
import bandMines from '../../assets/band-mines.webp'
import bandRedstone from '../../assets/band-redstone.webp'
import bandVault from '../../assets/band-vault.webp'

// every server gets its own place, picked from its id so it never shuffles
const BANDS = [bandSurface, bandControl, bandMines, bandRedstone, bandVault]
const bandFor = (id: string) => BANDS[[...id].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7) % BANDS.length]

export function JoinChip({ s, className = '' }: { s: ServerInfo; className?: string }) {
  const [copied, setCopied] = useState(false)
  const addr = joinAddress(s)
  return (
    <button
      onClick={() => copyText(addr).then(() => { setCopied(true); window.dispatchEvent(new Event('sp-invited')); setTimeout(() => setCopied(false), 2200) })}
      className={`btn btn-block px-3.5 py-2 text-left flex items-center gap-3 min-w-0 ${className}`}
      title="Copy the address friends join with"
    >
      <span className="font-mono text-sm font-bold truncate">{addr}</span>
      <span key={String(copied)} className={`hud !opacity-100 shrink-0 pop-in ${copied ? 'text-emerald' : ''}`}>{copied ? 'COPIED' : 'COPY'}</span>
    </button>
  )
}

/** Start/stop/restart with an honest in-between state. Restart starts from
    "running", so it only settles after the server was seen going down. */
function usePower(id: string, stats: Stats | undefined) {
  const action = useServerAction(id)
  const qc = useQueryClient()
  const [transition, setTransition] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sawDown = useRef(false)
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null)
  const running = stats?.running ?? false
  const booting = running && stats?.phase === 'starting'
  useEffect(() => {
    if (transition === 'starting…' && running && !booting) setTransition(null)
    if (transition === 'stopping…' && stats && !running) setTransition(null)
    if (transition === 'restarting…') {
      if (!running) sawDown.current = true
      else if (sawDown.current && !booting) setTransition(null)
    }
  }, [running, booting, stats, transition])
  useEffect(() => () => { if (watchdog.current) clearTimeout(watchdog.current) }, [])
  useEffect(() => { setTransition(null); setError(null) }, [id])
  const act = (a: 'start' | 'stop' | 'restart') => {
    const label = a === 'start' ? 'starting…' : a === 'stop' ? 'stopping…' : 'restarting…'
    if (a === 'restart') sawDown.current = false
    setTransition(label)
    setError(null)
    // never wedge: if the runtime silently ignores the action, release the UI,
    // but only the transition this press armed
    if (watchdog.current) clearTimeout(watchdog.current)
    watchdog.current = setTimeout(() => { watchdog.current = null; setTransition((cur) => (cur === label ? null : cur)) }, 150_000)
    action.mutate(a, {
      onError: (e) => { setTransition(null); setError(`${a} failed: ${String(e).replace(/^Error: \d+: /, '')}`) },
      onSuccess: () => {
        const iv = setInterval(() => qc.invalidateQueries({ queryKey: ['stats', id] }), 1500)
        setTimeout(() => clearInterval(iv), 30_000)
      },
    })
  }
  return { act, transition: transition ?? (booting ? 'starting…' : null), busy: action.isPending || transition !== null, error, running }
}

/** A destructive button that asks on the button itself instead of a browser dialog. */
export function ConfirmButton({ onConfirm, children, confirmLabel, className, disabled }: {
  onConfirm: () => void; children: React.ReactNode; confirmLabel: string; className: string; disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      className={`${className} ${armed ? 'shake-once' : ''}`}
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={() => { if (armed) { setArmed(false); onConfirm() } else setArmed(true) }}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}

function uptime(started: string | undefined): string | null {
  if (!started) return null
  // Crafty reports a local date string, the supervisor epoch milliseconds
  const t = /^\d+$/.test(started) ? Number(started) : new Date(started.replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return `up since ${started}`
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000))
  return m < 60 ? `up ${m} min` : `up ${Math.floor(m / 60)} h ${m % 60} min`
}

function Hero({ s }: { s: ServerInfo }) {
  const { data: stats } = useStats(s.id)
  const { data: runtime } = useRuntime()
  const power = usePower(s.id, stats)
  const status = statusOf(stats, power.transition)
  const native = runtime?.native.some((n) => n.id === s.id)
  const loader = s.detection.loader === 'unknown' ? 'Unknown loader' : s.detection.loader[0].toUpperCase() + s.detection.loader.slice(1)
  const sub = [
    `${loader} ${s.detection.mc ?? ''}`.trim(),
    runtime ? (native ? 'Spawnpoint service' : 'Crafty Controller') : null,
    stats?.phase === 'ready' ? uptime(stats.started) : null,
  ].filter(Boolean).join(' · ')
  const fenced = !!stats?.maintenance
  return (
    <header className="hero">
      <img src={bandFor(s.id)} alt="" />
      <div className="hero-plate px-4 sm:px-6 md:px-8 py-4">
        <div className="flex items-end gap-x-6 gap-y-3 flex-wrap">
          <div className="min-w-0 flex-[1_1_18rem]">
            <div className={`hud no-pip !opacity-100 ${status.cls}`}>
              <span className={`lamp ${status.lamp}`} aria-hidden /> {status.label}
            </div>
            <h1 className="hero-name mt-1.5 line-clamp-2 break-words">{s.name}</h1>
            <p className="text-sm mt-1.5" style={{ color: 'oklch(88% 0.012 95)' }}>{sub}</p>
          </div>
          {/* phone: address on its own row, the two power buttons share the next */}
          <div className="grid grid-cols-2 gap-3 w-full sm:w-auto sm:flex sm:items-center">
            <JoinChip s={s} className="col-span-2 max-w-full justify-between sm:justify-start" />
            {power.running || power.transition === 'stopping…' ? (
              <>
                <button onClick={() => power.act('restart')} disabled={power.busy || fenced} className="btn btn-block px-4 py-2 text-sm">
                  {power.transition === 'restarting…' ? 'Restarting…' : 'Restart'}
                </button>
                <ConfirmButton onConfirm={() => power.act('stop')} disabled={power.busy || fenced} confirmLabel="Click to stop" className="btn btn-redstone px-4 py-2 text-sm sm:min-w-[7.5rem]">
                  {power.transition === 'stopping…' ? 'Stopping…' : 'Stop'}
                </ConfirmButton>
              </>
            ) : (
              <button onClick={() => power.act('start')} disabled={power.busy || fenced} className="btn btn-emerald col-span-2 px-6 py-2 text-sm">
                {power.transition === 'starting…' ? 'Starting…' : 'Start'}
              </button>
            )}
          </div>
        </div>
        {power.error && <p role="alert" className="text-sm font-semibold text-redstone mt-2 pop-in">✗ {power.error}</p>}
      </div>
    </header>
  )
}

/** Every tab that shows pack state refetches when the open change moves a step,
    so Undo, history and the installed list never show the state before it. */
function useChangeSettles(id: string) {
  const qc = useQueryClient()
  const { data } = useChange(id)
  const step = data ? `${data.candidate?.status}:${data.candidate?.updatedAt}:${data.promotion?.action ?? ''}:${data.promotion?.restarting ?? ''}` : null
  const seen = useRef<string | null>(null)
  useEffect(() => {
    // the first reading is the state the tabs already fetched
    if (seen.current !== null && step !== seen.current) {
      for (const key of ['revisions', 'last-change', 'installed']) qc.invalidateQueries({ queryKey: [key, id] })
    }
    seen.current = step
  }, [qc, id, step])
}

function TabBar({ s }: { s: ServerInfo }) {
  const { data } = useChange(s.id)
  const c = data?.candidate
  const needs = changeNeedsOwner(c, data?.promotion)
  const moving = changeVisible(c) && !needs && c.status !== 'applied'
  const plugins = PLUGIN_LOADERS.includes(s.detection.loader)
  const tabs = [
    { to: '', label: 'Overview', icon: 'eblock' },
    { to: 'console', label: 'Console', icon: 'anvil' },
    { to: 'changes', label: 'Changes', icon: 'shield' },
    { to: 'mods', label: plugins ? 'Plugins' : 'Mods', icon: 'crate' },
    { to: 'players', label: 'Players', icon: 'heart' },
    { to: 'worlds', label: 'Worlds', icon: 'globe' },
    { to: 'automation', label: 'Automation', icon: 'bolt' },
    { to: 'files', label: 'Files', icon: 'gem' },
    { to: 'server', label: 'Server', icon: 'pick' },
  ]
  const { pathname } = useLocation()
  const row = useRef<HTMLElement>(null)
  const bar = useRef<HTMLSpanElement>(null)
  // the emerald edge glides to the active tab instead of jumping
  useLayoutEffect(() => {
    const el = row.current?.querySelector<HTMLElement>('.wtab.active')
    if (!el || !bar.current) return
    bar.current.style.width = `${el.offsetWidth}px`
    bar.current.style.transform = `translateX(${el.offsetLeft}px)`
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [pathname])
  return (
    <nav ref={row} className="wtabs" aria-label={`${s.name} sections`}>
      <span ref={bar} className="wtab-bar" aria-hidden />
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to ? `/s/${s.id}/${t.to}` : `/s/${s.id}`} end={!t.to} className={({ isActive }) => `wtab ${isActive ? 'active' : ''}`}>
          <Pi i={t.icon} className="pi" />
          {t.label}
          {t.to === 'changes' && needs && <span className="badge" aria-label="needs you">1</span>}
          {t.to === 'changes' && moving && <span className="badge badge-sky" role="img" aria-label="in progress" />}
        </NavLink>
      ))}
    </nav>
  )
}

export default function Workspace() {
  const { id = '' } = useParams()
  const { data, isLoading, error } = useServers()
  const s = data?.servers.find((x) => x.id === id)
  const setActive = useSetActive()
  const { pathname } = useLocation()
  // remember the last server opened, so the panel reopens there
  // once per visit: another window opening a different server must not start
  // a tug of war over which one is active
  useEffect(() => {
    if (s && !s.active) setActive.mutate(s.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.id])

  useChangeSettles(id)
  if (!s) {
    return (
      <div className="p-4 sm:p-6 md:p-8">
        {isLoading ? <p className="text-text-dim text-sm">Finding this server…</p>
          : error ? <div className="block px-5 py-4 border-redstone!"><b>Can’t reach the server runtime.</b> <span className="text-text-dim text-sm">Check Panel settings → Server runtime. The panel reconnects by itself.</span></div>
            : <div className="block px-5 py-4"><b>This server no longer exists.</b> <NavLink to="/" className="text-emerald underline underline-offset-2 ml-1">Back to your servers</NavLink></div>}
      </div>
    )
  }
  return (
    <div>
      <Hero s={s} />
      <TabBar s={s} />
      <div className="px-4 sm:px-6 md:px-8 py-6 max-w-6xl">
        <div key={pathname} className="route-in">
          <Outlet />
        </div>
      </div>
      <ReviewSheet id={s.id} />
    </div>
  )
}
