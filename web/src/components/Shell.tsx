import { useEffect, useRef, useState } from 'react'
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useServers, useSetActive } from '../api'
import { PixelDefs, Pi, loaderIcon } from './PixelIcons'

// PIN gate: when Settings has a PIN, everything waits behind this screen.
// The cookie lasts 30 days, so it's a once-per-device ritual.
function PinGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('')
  const [err, setErr] = useState(false)
  const submit = async () => {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    if (r.ok) onUnlocked()
    else { setErr(true); setPin('') }
  }
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--color-bedrock)', backgroundImage: 'var(--noise-dense)' }}>
      <div className="block bg-block p-8 w-full max-w-sm text-center">
        <div className="flex items-center justify-center gap-2.5 mb-1.5">
          <Pi i="flag" className="pi pi-l" />
          <span className="font-px text-[15px] tracking-[0.04em] font-bold">SPAWNPOINT</span>
        </div>
        <div className="hud mb-6">LOCKED · ENTER PIN</div>
        <input
          autoFocus
          value={pin}
          onChange={(e) => { setErr(false); setPin(e.target.value.replace(/\D/g, '').slice(0, 8)) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 4) submit() }}
          type="password"
          inputMode="numeric"
          placeholder="••••"
          className={`field w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] ${err ? 'border-redstone!' : ''}`}
        />
        {err && <div className="font-px text-[10px] text-redstone mt-2">WRONG PIN</div>}
        <button
          onClick={submit}
          disabled={pin.length < 4}
          className="btn btn-emerald w-full py-2.5 text-sm mt-4"
        >
          Unlock
        </button>
      </div>
    </div>
  )
}

// block-targeting reticle from the landing: a dashed outline that glides
// to whatever interactive block you aim at. Mouse-only, honors reduced motion.
const TGT_SEL = '.btn, .lever, .strata, .pb, .apanel-tabs .tab, .xp, .place-tile'

function Targeter() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fine = matchMedia('(pointer: fine)').matches
    const prm = matchMedia('(prefers-reduced-motion: reduce)').matches
    const tgt = ref.current
    if (!fine || prm || !tgt) return

    let cur: Element | null = null
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(TGT_SEL)
      if (!el || el === cur) return
      cur = el
      const r = el.getBoundingClientRect()
      const pad = el.classList.contains('strata') ? 8 : 6
      // clamp to the viewport so edge-hugging targets (sidebar strata) don't clip
      const left = Math.max(r.left - pad, 3)
      const top = Math.max(r.top - pad, 3)
      const right = Math.min(r.right + pad, innerWidth - 3)
      const bottom = Math.min(r.bottom + pad, innerHeight - 3)
      tgt.style.width = `${right - left}px`
      tgt.style.height = `${bottom - top}px`
      tgt.style.transform = `translate(${left}px, ${top}px)`
      tgt.classList.add('on')
    }
    const out = (e: PointerEvent) => {
      if (cur && !(e.relatedTarget as Element | null)?.closest?.(TGT_SEL)) {
        cur = null
        tgt.classList.remove('on')
      }
    }
    const off = () => { cur = null; tgt.classList.remove('on') }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out)
    addEventListener('scroll', off, { passive: true, capture: true })
    document.addEventListener('pointerdown', off) // clicks re-layout things; let it re-acquire
    return () => {
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', out)
      removeEventListener('scroll', off, { capture: true })
      document.removeEventListener('pointerdown', off)
    }
  }, [])

  return <div id="tgt" ref={ref} aria-hidden />
}

// the sidebar is a world cross-section: each destination is a stratum.
// bg/fg are the material; the teeth edge feeds into the band below.
const nav = [
  { to: '/', label: 'Servers', tag: 'Y 63 · SURFACE', icon: 'globe', bg: '#7cc24f', fg: 'var(--color-ink)', dim: 'oklch(24% 0.02 255 / .62)' },
  { to: '/dashboard', label: 'Dashboard', tag: 'Y 11 · CONTROL', icon: 'anvil', bg: '#5c3f28', fg: 'var(--color-paper)', dim: 'oklch(96% 0.012 95 / .6)' },
  { to: '/config', label: 'Config', tag: 'Y 5 · REDSTONE', icon: 'bolt', bg: '#453b33', fg: 'var(--color-paper)', dim: 'oklch(96% 0.012 95 / .6)' },
  { to: '/content', label: 'Content', tag: 'Y -32 · MINES', icon: 'crate', bg: '#262b33', fg: 'var(--color-paper)', dim: 'oklch(96% 0.012 95 / .6)' },
  { to: '/files', label: 'Files', tag: 'Y -44 · ARCHIVE', icon: 'gem', bg: '#20252d', fg: 'var(--color-paper)', dim: 'oklch(96% 0.012 95 / .6)' },
  { to: '/backups', label: 'Backups', tag: 'Y -50 · VAULT', icon: 'chest', bg: '#1d222b', fg: 'var(--color-paper)', dim: 'oklch(96% 0.012 95 / .6)' },
  { to: '/settings', label: 'Settings', tag: 'Y -59 · BEDROCK', icon: 'shield', bg: '#16191f', fg: 'var(--color-paper)', dim: 'oklch(96% 0.012 95 / .6)' },
]

export default function Shell() {
  const qc = useQueryClient()
  const { data: auth } = useQuery({
    queryKey: ['auth'],
    queryFn: async () => (await (await fetch('/api/auth/check')).json()) as { required: boolean; ok: boolean },
    staleTime: 5 * 60_000,
  })
  // fresh install (no Crafty token yet) — hand the whole first visit to the
  // wizard; a configured box answers {active:false} and never routes there
  const { data: wiz, isLoading: wizLoading } = useQuery({
    queryKey: ['wizard'],
    queryFn: async () => (await (await fetch('/api/wizard/status')).json()) as { active: boolean },
    staleTime: 60_000,
  })
  const { data } = useServers()
  const { data: layoutRoot } = useQuery({
    queryKey: ['layout-root'],
    queryFn: async () => {
      const r = await fetch('/api/settings/summary')
      if (!r.ok) return ''
      return ((await r.json()).root ?? '') as string
    },
    staleTime: Infinity,
  })
  const setActive = useSetActive()
  const navigate = useNavigate()
  const active = data?.servers.find((s) => s.active)

  // hold the first paint until we know: otherwise a fresh install flashes the
  // panel (with failing queries) for one round-trip before redirecting
  if (wizLoading) return <div className="min-h-screen" style={{ background: 'var(--color-bedrock)' }} />
  if (wiz?.active) return <Navigate to="/setup" replace />

  if (auth && auth.required && !auth.ok) {
    return (
      <>
        <PixelDefs />
        <PinGate onUnlocked={() => qc.invalidateQueries()} />
      </>
    )
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <PixelDefs />
      <Targeter />
      <aside className="w-full md:w-64 shrink-0 bg-panel border-b-2 md:border-b-0 md:border-r-[3px] border-ink flex flex-col md:sticky md:top-0 md:h-screen">
        <div className="px-5 py-5" style={{ background: 'var(--color-bedrock)' }}>
          <div className="flex items-center gap-2.5">
            <Pi i="flag" className="pi pi-l" />
            <span className="font-px text-[15px] tracking-[0.04em] font-bold">SPAWNPOINT</span>
          </div>
          <div className="hud mt-2">SERVER PANEL v0.2</div>
        </div>

        <div className="px-4 py-4 border-y-2 border-ink" style={{ background: 'var(--color-bedrock)' }}>
          <div className="hud mb-2">ACTIVE SERVER</div>
          <div className="flex items-center gap-2">
            {active && <Pi i={loaderIcon(active.detection.loader)} className="pi shrink-0" />}
            <select
              className="field w-full min-w-0 px-3 py-2 text-sm font-semibold"
              value={active?.id ?? ''}
              onChange={(e) => {
                setActive.mutate(e.target.value)
                navigate('/dashboard')
              }}
            >
              {!active && <option value="">— pick —</option>}
              {data?.servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.detection.loader} {s.detection.mc ?? ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* strata nav: desktop = vertical cross-section with teeth edges */}
        <nav className="flex-1 hidden md:flex md:flex-col">
          {nav.map((n, i) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className="strata block h-[64px] shrink-0"
              style={{
                background: n.bg,
                backgroundImage: 'var(--noise)',
                color: n.fg,
                ['--next' as string]: nav[i + 1]?.bg ?? n.bg,
                ['--tile' as string]: i % 2 === 0 ? 'var(--mask-a)' : 'var(--mask-b)',
                ['--eh' as string]: '12px',
              }}
            >
              {({ isActive }) => (
                <div
                  className="h-full px-4 py-3 flex flex-col justify-center transition-[filter] duration-150"
                  style={{ filter: isActive ? 'none' : 'brightness(0.62) saturate(0.85)' }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.filter = 'brightness(0.82) saturate(0.95)' }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.filter = 'brightness(0.62) saturate(0.85)' }}
                >
                  <div className="flex items-center gap-2.5">
                    <Pi i={n.icon} className="pi" />
                    <span className="text-sm font-bold">{n.label}</span>
                  </div>
                  {isActive && (
                    <div className="font-px text-[10px] tracking-[0.08em] mt-1 ml-[30px]" style={{ color: n.dim }}>
                      {n.tag}
                    </div>
                  )}
                </div>
              )}
            </NavLink>
          ))}
          {/* the world continues down: bedrock filler below the last stratum */}
          <div className="flex-1" style={{ background: '#16191f', backgroundImage: 'var(--noise-dense)' }} />
        </nav>

        {/* mobile: horizontal material chips */}
        <nav className="flex md:hidden gap-2 px-3 py-3 overflow-x-auto" style={{ background: 'var(--color-bedrock)' }}>
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className="shrink-0 border-2 border-ink px-3 py-2 flex items-center gap-2"
              style={({ isActive }) => ({
                background: n.bg,
                color: n.fg,
                filter: isActive ? 'none' : 'brightness(0.62) saturate(0.85)',
                boxShadow: '0 3px 0 var(--color-ink)',
              })}
            >
              <Pi i={n.icon} className="pi pi-s" />
              <span className="text-xs font-bold">{n.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="px-5 py-4 border-t-2 border-ink hidden md:block" style={{ background: '#16191f' }}>
          {/* the real layout root, not a hardcoded path — every install shows its own */}
          <div className="hud truncate" title={layoutRoot}>{(layoutRoot || 'SPAWNPOINT').toUpperCase()}</div>
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-4 sm:p-6 md:p-8 max-w-6xl">
        {/* key on pathname: strata switches crossfade instead of hard-cutting */}
        <div key={useLocation().pathname} className="route-in">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
