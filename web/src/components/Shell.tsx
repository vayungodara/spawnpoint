import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRuntime, useServers, type Stats } from '../api'
import { PixelDefs, Pi } from './PixelIcons'
import Sheet from './Sheet'
import { statusOf } from './status'

// PIN gate: everything waits behind this screen. The session lasts 30 days.
function PinGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const submit = async () => {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    if (r.ok) onUnlocked()
    else { setErr(r.status === 429 ? 'TOO MANY TRIES · WAIT A MINUTE' : 'WRONG PIN'); setPin('') }
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
          onChange={(e) => { setErr(''); setPin(e.target.value.replace(/\D/g, '').slice(0, 12)) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 4) submit() }}
          type="password"
          inputMode="numeric"
          placeholder="PIN"
          className={`field w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] ${err ? 'border-redstone!' : ''}`}
        />
        {err && <div className="font-px text-[10px] text-redstone mt-2">{err}</div>}
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
const TGT_SEL = '.btn, .lever, .srv, .srv-new, .wtab, .pb, .xp, .place-tile'

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
      const pad = el.classList.contains('srv') ? 8 : el.classList.contains('wtab') ? 3 : 6
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

// the sidebar is a world cross-section, and every server is one stratum of it:
// grass on top, then dirt, tuff and deeper stone. Teeth feed into the next band.
const MATERIALS = [
  { bg: '#7cc24f', fg: 'var(--color-ink)' },
  { bg: '#5c3f28', fg: 'var(--color-paper)' },
  { bg: '#453b33', fg: 'var(--color-paper)' },
  { bg: '#363c47', fg: 'var(--color-paper)' },
  { bg: '#2a2f38', fg: 'var(--color-paper)' },
  { bg: '#23272f', fg: 'var(--color-paper)' },
]
const BEDROCK = '#16191f'

interface CreateJobInfo { id: string; status: string; done: boolean; error: string | null; packName: string | null }

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useServers()
  const { data: runtime } = useRuntime()
  const servers = data?.servers ?? []
  const native = new Set(runtime?.native.map((n) => n.id))
  // one light stats poll per server keeps every lamp honest; the workspace
  // shares the same query for the open server
  const stats = useQueries({
    queries: servers.map((s) => ({
      queryKey: ['stats', s.id],
      queryFn: async () => (await (await fetch(`/api/servers/${s.id}/stats`)).json()) as Stats,
      refetchInterval: 10_000,
    })),
  })
  // a server being built shows up as a stratum in progress
  const { data: jobs } = useQuery({
    queryKey: ['create-jobs'],
    queryFn: async () => (await (await fetch('/api/create-jobs')).json()) as { jobs: CreateJobInfo[] },
    refetchInterval: (q) => ((q.state.data?.jobs ?? []).some((j) => !j.done) ? 3000 : 60_000),
  })
  const building = (jobs?.jobs ?? []).filter((j) => !j.done)
  const { data: layoutRoot } = useQuery({
    queryKey: ['layout-root'],
    queryFn: async () => {
      const r = await fetch('/api/settings/summary')
      if (!r.ok) return ''
      return ((await r.json()).root ?? '') as string
    },
    staleTime: Infinity,
  })

  return (
    <div className="relative flex flex-col h-full min-h-0" style={{ background: BEDROCK }}>
      {onNavigate && <button onClick={onNavigate} className="absolute top-3 right-2 text-sm" aria-label="Close servers and settings">✕</button>}
      <NavLink to="/" onClick={onNavigate} className="px-5 pt-5 pb-4 block" aria-label="Spawnpoint home">
        <div className="flex items-center gap-2.5">
          <Pi i="flag" className="pi pi-l" />
          <span className="font-px text-[15px] tracking-[0.04em] font-bold">SPAWNPOINT</span>
        </div>
        <div className="hud mt-2">SERVER PANEL v{__APP_VERSION__}</div>
      </NavLink>

      <div className="hud px-5 pb-2 pt-1 border-t-2 border-ink pt-3">SERVERS · {servers.length}</div>
      <nav aria-label="Servers" className="flex flex-col min-h-0 overflow-y-auto scroll-px">
        {servers.map((s, i) => {
          const m = MATERIALS[i % MATERIALS.length]
          const next = i + 1 < servers.length ? MATERIALS[(i + 1) % MATERIALS.length].bg : BEDROCK
          const st = stats[i]?.data
          const status = statusOf(st)
          const sub = [
            // only worth saying when Crafty and Spawnpoint servers sit side by side
            runtime && !native.has(s.id) && (native.size > 0 || runtime.mode === 'standalone') ? 'CRAFTY' : null,
            `${s.detection.loader.toUpperCase()} ${s.detection.mc ?? ''}`.trim(),
            st?.phase === 'ready' ? `${st.online}/${st.max}` : status.label === 'RUNNING' ? null : status.label,
          ].filter(Boolean).join(' · ')
          return (
            <NavLink
              key={s.id}
              to={`/s/${s.id}`}
              onClick={onNavigate}
              className={({ isActive }) => `strata srv ${isActive ? 'active' : ''}`}
              style={{
                background: m.bg, backgroundImage: 'var(--noise)', color: m.fg,
                '--next': next, '--tile': i % 2 === 0 ? 'var(--mask-a)' : 'var(--mask-b)', '--eh': '10px',
              } as CSSProperties}
            >
              <div className="srv-in">
                <span className={`lamp ${status.lamp}`} aria-label={status.label} />
                <span className="srv-name">{s.name}</span>
                <span className="srv-sub">{sub}</span>
              </div>
            </NavLink>
          )
        })}
        {building.map((j) => (
          <div key={j.id} className="srv-new !border-gold !text-gold" role="status">
            <span className="lamp lamp-starting" />
            <span className="min-w-0 truncate">{j.packName ?? 'New server'}: {j.status}</span>
          </div>
        ))}
        <NavLink to="/new" onClick={onNavigate} className={({ isActive }) => `srv-new ${isActive ? 'active' : ''}`}>
          <Pi i="plus" className="pi pi-s" /> New server
        </NavLink>
      </nav>

      <div className="flex-1 min-h-6" style={{ backgroundImage: 'var(--noise-dense)' }} />
      <nav aria-label="Panel" className="py-2 border-t-2 border-ink">
        <NavLink to="/settings" onClick={onNavigate} className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <Pi i="shield" className="pi pi-s" /> Panel settings
        </NavLink>
      </nav>
      <div className="px-5 py-3 border-t-2 border-ink">
        {/* the real layout root, not a hardcoded path — every install shows its own */}
        <div className="hud truncate" title={layoutRoot}>{(layoutRoot || 'SPAWNPOINT').toUpperCase()}</div>
      </div>
    </div>
  )
}

/** Panel-level pages (settings, new server) sit in a padded column. */
export function Pad() {
  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl">
      <Outlet />
    </div>
  )
}

export default function Shell() {
  const qc = useQueryClient()
  const { data: auth } = useQuery({
    queryKey: ['auth'],
    queryFn: async () => (await (await fetch('/api/auth/check')).json()) as { ok: boolean },
    staleTime: 5 * 60_000,
  })
  // until an owner is connected and a PIN is set, the wizard owns the first visit
  const { data: wiz, isLoading: wizLoading } = useQuery({
    queryKey: ['wizard'],
    queryFn: async () => (await (await fetch('/api/wizard/status')).json()) as { active: boolean },
    staleTime: 60_000,
  })
  const { data } = useServers()
  const { pathname } = useLocation()
  const [menu, setMenu] = useState(false)
  // switching servers or panel pages crossfades; workspace tabs animate inside
  const topKey = pathname.split('/').slice(0, 3).join('/')

  // hold the first paint until we know: otherwise a fresh install flashes the
  // panel (with failing queries) for one round-trip before redirecting
  if (wizLoading) return <div className="min-h-screen" style={{ background: 'var(--color-bedrock)' }} />
  if (wiz?.active) return <Navigate to="/setup" replace />

  if (auth && !auth.ok) {
    return (
      <>
        <PixelDefs />
        <PinGate onUnlocked={() => qc.invalidateQueries()} />
      </>
    )
  }

  return (
    <div className="min-h-screen md:flex">
      <PixelDefs />
      <Targeter />
      <aside className="hidden md:block w-64 shrink-0 sticky top-0 h-screen border-r-[3px] border-ink">
        <Sidebar />
      </aside>

      {/* phone: a slim bar, servers live in a drawer */}
      <header className="phone-bar md:hidden sticky top-0 z-30 flex items-center gap-3 px-4 border-b-[3px] border-ink" style={{ background: BEDROCK }}>
        <Pi i="flag" className="pi" />
        <span className="font-px text-[13px] tracking-[0.04em] font-bold">SPAWNPOINT</span>
        <button onClick={() => setMenu(true)} className="btn btn-block ml-auto px-3 py-1.5 text-xs flex items-center gap-2" aria-label="Open servers and settings">
          <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M0 1h14v2H0zM0 6h14v2H0zM0 11h14v2H0z" /></svg>
          Servers
        </button>
      </header>
      <Sheet open={menu} onClose={() => setMenu(false)} side="left" label="Servers and settings">
        <Sidebar onNavigate={() => setMenu(false)} />
      </Sheet>

      <main className="flex-1 min-w-0">
        {data?.warning && <p role="status" className="block mx-4 md:mx-8 mt-4 px-4 py-3 text-sm">{data.warning} Import recovery remains available in Server → Runtime.</p>}
        <div key={topKey} className="route-in">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
