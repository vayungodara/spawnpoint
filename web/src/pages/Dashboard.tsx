import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useServers, useStats, useLogs, useServerAction, useSendCommand, useAutostop, useSetAutostop } from '../api'
import { Pi } from '../components/PixelIcons'
import bandControl from '../assets/band-control.png'

function fallbackCopy(text: string, onDone: () => void) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
    onDone()
  } finally {
    document.body.removeChild(ta)
  }
}

// in-game HUD: opt-in SPAWNPOINT boss bar, per player via /trigger hud
interface HudCfg { enabled: boolean }

function IngameHudRow() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['ingamehud'],
    queryFn: async () => (await (await fetch('/api/ingamehud')).json()) as HudCfg,
  })
  const set = useMutation({
    mutationFn: (cfg: HudCfg) =>
      fetch('/api/ingamehud', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ingamehud'] }),
  })
  if (!data) return null
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-4 flex-wrap">
        <button
          className="lever"
          data-on={data.enabled}
          disabled={set.isPending}
          onClick={() => set.mutate({ enabled: !data.enabled })}
          aria-label="Toggle in-game stats HUD"
        />
        <div className="min-w-0">
          <div className="text-sm font-bold flex items-center gap-2"><Pi i="heart" className="pi pi-s" /> In-game stats HUD <span className="hud">OPT-IN</span></div>
          <div className="text-text-dim text-xs mt-0.5">
            hidden by default — any player types <span className="font-mono text-text">/trigger hud</span> in
            chat to show/hide the SPAWNPOINT bar (verdict · RAM · CPU) at the top of their screen
          </div>
        </div>
      </div>
    </div>
  )
}

// offline-only rescue row: parse the newest crash report, disable the
// client-only mods it names, invite a retry
function CrashSweepRow({ serverId }: { serverId: string }) {
  const [msg, setMsg] = useState<string | null>(null)
  const sweep = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/servers/${serverId}/sweep-crash`, { method: 'POST' })
      if (!r.ok) throw new Error(await r.text())
      return r.json() as Promise<{ disabled: string[]; alreadyDisabled: string[]; report: string | null; reportAgeMin: number | null }>
    },
    onSuccess: (r) => {
      if (!r.report) setMsg('No crash reports found — the last stop was clean.')
      else if (r.disabled.length === 0) setMsg(`Newest crash report (${r.reportAgeMin} min ago) names no failed mods${r.alreadyDisabled.length ? ' that are not already disabled' : ''} — check the console log instead.`)
      else setMsg(`✓ Disabled ${r.disabled.length} crashing mod(s): ${r.disabled.join(', ')} — hit Start to try again (re-enable any in Content → Installed)`)
    },
    onError: (e) => setMsg(`✗ ${String(e)}`),
  })
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold flex items-center gap-2"><Pi i="shield" className="pi pi-s" /> Crashed on boot?</div>
          <div className="text-text-dim text-xs mt-0.5">
            modpacks often include client-only mods that kill the server — this reads the newest
            crash report and disables exactly the mods it blames
          </div>
        </div>
        <button
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          className="btn btn-block px-4 py-2 text-sm shrink-0"
        >
          {sweep.isPending ? 'sweeping…' : 'Disable crashing mods'}
        </button>
      </div>
      {msg && <div className="text-xs font-semibold mt-2.5 pt-2.5 border-t-2 border-line/40">{msg}</div>}
    </div>
  )
}

// the chat genie: say "server <wish>" in game, an AI turns it into commands
interface GenieCfg { enabled: boolean; players: string[]; servers: Record<string, boolean> }

function GenieRow({ serverId }: { serverId: string }) {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['chatgenie'],
    queryFn: async () => (await (await fetch('/api/chatgenie')).json()) as GenieCfg,
  })
  const set = useMutation({
    mutationFn: (cfg: Partial<GenieCfg>) =>
      fetch('/api/chatgenie', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chatgenie'] }),
  })
  if (!data) return null
  const on = !!data.servers[serverId] && data.enabled
  return (
    <div className="block px-4 py-3 flex items-center gap-4 flex-wrap">
      <button
        className="lever"
        data-on={on}
        disabled={set.isPending}
        onClick={() => set.mutate({ enabled: true, servers: { [serverId]: !on } })}
        aria-label="Toggle the chat genie on this server"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold flex items-center gap-2">
          <Pi i="spark" className="pi pi-s" /> Chat genie <span className="hud">THIS SERVER</span>
        </div>
        <div className="text-text-dim text-xs mt-0.5">
          {on
            ? <>say <span className="font-mono text-text">server &lt;anything&gt;</span> in game chat — it runs commands, answers questions, and knows your inventory</>
            : 'off — in-game "server …" messages are ignored'}
        </div>
      </div>
      {on && (
        <span className="hud !opacity-100 text-emerald shrink-0">
          {data.players.join(', ') || 'nobody'} ONLY
        </span>
      )}
    </div>
  )
}

// live players: RCON-truth list with one-click actions. Chips only render
// while the server is joinable.
function PlayersLiveCard({ serverId, running }: { serverId: string; running: boolean }) {
  const [msgFor, setMsgFor] = useState<string | null>(null)
  const [msgText, setMsgText] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const { data } = useQuery({
    queryKey: ['players-live', serverId],
    queryFn: async () =>
      (await (await fetch(`/api/servers/${serverId}/players/live`)).json()) as { online: number; max: number; players: string[]; offline?: boolean },
    refetchInterval: 10_000,
    enabled: running,
  })
  const act = useMutation({
    mutationFn: async (p: { name: string; action: string; arg?: string }) => {
      const r = await fetch(`/api/servers/${serverId}/players/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'failed')
      return r.json()
    },
    onSuccess: (_r, p) => { setNote(`✓ ${p.action} ${p.name}`); setMsgFor(null); setMsgText(''); setTimeout(() => setNote(null), 4000) },
    // errors used to pin forever — clear them like successes
    onError: (e) => { setNote(`✗ ${String(e)}`); setTimeout(() => setNote(null), 8000) },
  })
  if (!running || !data || data.offline) return null
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-2">
        <Pi i="heart" className="pi pi-s" />
        <span className="text-sm font-bold">Players online</span>
        <span className="hud">{data.online}/{data.max}</span>
        {note && <span className="text-xs font-semibold ml-auto">{note}</span>}
      </div>
      {data.players.length === 0 ? (
        <div className="text-text-dim text-xs mt-2">nobody on right now</div>
      ) : (
        <div className="mt-2.5 space-y-2">
          {data.players.map((name) => (
            <div key={name} className="flex items-center gap-2 flex-wrap border-2 border-line/40 px-3 py-2">
              <span className="text-sm font-bold font-mono">{name}</span>
              <div className="flex gap-1.5 ml-auto flex-wrap">
                <button className="btn btn-block px-2.5 py-1 text-xs" onClick={() => { setMsgFor(msgFor === name ? null : name); setMsgText('') }}>msg</button>
                <button className="btn btn-block px-2.5 py-1 text-xs" onClick={() => act.mutate({ name, action: 'heal' })}>heal</button>
                <button className="btn btn-block px-2.5 py-1 text-xs" onClick={() => act.mutate({ name, action: 'op' })}>op</button>
                <button className="btn btn-block px-2.5 py-1 text-xs" onClick={() => act.mutate({ name, action: 'deop' })}>deop</button>
                <button className="btn btn-block px-2.5 py-1 text-xs !text-gold" onClick={() => { if (confirm(`Kick ${name}?`)) act.mutate({ name, action: 'kick' }) }}>kick</button>
                <button className="btn btn-block px-2.5 py-1 text-xs !text-crimson" onClick={() => { if (confirm(`BAN ${name}? They cannot rejoin until pardoned.`)) act.mutate({ name, action: 'ban' }) }}>ban</button>
              </div>
              {msgFor === name && (
                <form
                  className="w-full flex gap-1.5"
                  onSubmit={(e) => { e.preventDefault(); if (msgText.trim()) act.mutate({ name, action: 'msg', arg: msgText.trim() }) }}
                >
                  <input autoFocus value={msgText} onChange={(e) => setMsgText(e.target.value)} placeholder={`private message to ${name}…`} className="field px-2 py-1 text-xs flex-1 min-w-0" />
                  <button className="btn btn-block px-3 py-1 text-xs shrink-0">send</button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// task scheduler: daily/interval automations (restart, announce, command,
// start/stop, loud/quiet) driven by a 30s tick on the panel
interface SchedTask { id: string; enabled: boolean; serverId: string; kind: string; arg?: string; schedule: { type: 'daily' | 'interval'; time?: string; minutes?: number }; lastRun?: string }

const KIND_LABEL: Record<string, string> = {
  restart: 'restart server', announce: 'announce', command: 'run command',
  start: 'start server', stop: 'stop server (if empty)', loud: 'PC loud mode', quiet: 'PC quiet mode',
}

function SchedulerCard({ serverId }: { serverId: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState('restart')
  const [schedType, setSchedType] = useState<'daily' | 'interval'>('daily')
  const [time, setTime] = useState('04:00')
  const [minutes, setMinutes] = useState(120)
  const [arg, setArg] = useState('')
  const { data } = useQuery({
    queryKey: ['scheduler'],
    queryFn: async () => (await (await fetch('/api/scheduler')).json()) as { tasks: SchedTask[] },
  })
  // /api/scheduler returns EVERY server's tasks. This card is per-server, so an
  // unfiltered list showed the Forge server's 04:00 restart on the Fabric
  // server's dashboard — and its ✕ deleted it, with nothing naming the owner.
  const tasks = (data?.tasks ?? []).filter((t) => t.serverId === serverId)
  const save = useMutation({
    mutationFn: (t: Partial<SchedTask>) =>
      fetch('/api/scheduler', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduler'] }); setAdding(false); setArg('') },
  })
  const del = useMutation({
    mutationFn: (id: string) => fetch(`/api/scheduler?id=${id}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduler'] }),
  })
  if (!data) return null
  const needsArg = kind === 'announce' || kind === 'command'
  const fmtSched = (s: SchedTask['schedule']) => (s.type === 'daily' ? `daily at ${s.time}` : `every ${s.minutes} min`)
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-2">
        <Pi i="bolt" className="pi pi-s" />
        <span className="text-sm font-bold">Schedules</span>
        <span className="hud">{tasks.filter((t) => t.enabled).length} ACTIVE</span>
        <button className="btn btn-block px-3 py-1 text-xs ml-auto" onClick={() => setAdding(!adding)}>
          {adding ? 'cancel' : '+ Add'}
        </button>
      </div>
      {tasks.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-3 text-xs border-2 border-line/40 px-3 py-2 flex-wrap">
              <button className="lever" data-on={t.enabled} onClick={() => save.mutate({ id: t.id, enabled: !t.enabled })} aria-label="toggle schedule" />
              <span className="font-bold">{KIND_LABEL[t.kind] ?? t.kind}</span>
              {t.arg && <span className="text-text-dim font-mono truncate max-w-48">{t.arg}</span>}
              <span className="hud">{fmtSched(t.schedule)}</span>
              {t.lastRun && <span className="text-text-dim">last: {new Date(t.lastRun).toLocaleTimeString()}</span>}
              <button className="text-text-dim hover:text-crimson ml-auto" onClick={() => del.mutate(t.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <form
          className="mt-2.5 pt-2.5 border-t-2 border-line/40 flex items-center gap-2 flex-wrap text-xs"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({
              serverId,
              kind,
              arg: needsArg ? arg : undefined,
              schedule: schedType === 'daily' ? { type: 'daily', time } : { type: 'interval', minutes },
            })
          }}
        >
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="field px-2 py-1.5">
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {needsArg && <input value={arg} onChange={(e) => setArg(e.target.value)} placeholder={kind === 'announce' ? 'message…' : 'command…'} className="field px-2 py-1.5 flex-1 min-w-32" />}
          <select value={schedType} onChange={(e) => setSchedType(e.target.value as 'daily' | 'interval')} className="field px-2 py-1.5">
            <option value="daily">daily at</option>
            <option value="interval">every</option>
          </select>
          {schedType === 'daily' ? (
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="field px-2 py-1 font-mono" />
          ) : (
            <label className="flex items-center gap-1.5">
              <input type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 60)} className="field w-16 px-2 py-1 font-mono text-center" />
              <span className="hud">MIN</span>
            </label>
          )}
          <button className="btn btn-block px-3 py-1.5" disabled={save.isPending || (needsArg && !arg.trim())}>Save</button>
        </form>
      )}
      {data.tasks.length === 0 && !adding && (
        <div className="text-text-dim text-xs mt-2">nothing scheduled — try a daily 04:00 restart, it keeps modded servers healthy</div>
      )}
    </div>
  )
}

// Realms-style world slots: up to 3 worlds per server, exactly one live.
// Switching = stop → two directory renames → start; the outgoing world is
// backed up first, so every move is reversible.
interface SlotView { n: number; name: string; active: boolean; exists: boolean; sizeMb: number; createdAt?: string; lastPlayed?: string }

const fmtWorld = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`)
const fmtAgo = (iso?: string) => {
  if (!iso) return null
  const h = (Date.now() - new Date(iso).getTime()) / 36e5
  if (h < 1) return 'just now'
  if (h < 24) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

function WorldsCard({ serverId, running }: { serverId: string; running: boolean }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [seedFor, setSeedFor] = useState<number | null>(null)
  const [seed, setSeed] = useState('')
  const [confirmReset, setConfirmReset] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: ['worlds', serverId],
    queryFn: async () => (await (await fetch(`/api/servers/${serverId}/worlds`)).json()) as { active: number; slots: SlotView[] },
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['worlds', serverId] })
    qc.invalidateQueries({ queryKey: ['stats'] })
  }
  const rename = useMutation({
    mutationFn: (p: { n: number; name: string }) =>
      fetch(`/api/servers/${serverId}/worlds/name`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p),
      }).then((r) => r.json()),
    onSuccess: refresh,
  })
  const switcher = useMutation({
    mutationFn: async (p: { n: number; seed?: string }) => {
      const r = await fetch(`/api/servers/${serverId}/worlds/switch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n: p.n, start: running, seed: p.seed || undefined }),
      })
      return (await r.json()) as { ok: boolean; error?: string; fresh?: boolean; restarted?: boolean }
    },
    onSuccess: (r) => {
      setMsg(r.ok ? `✓ switched${r.fresh ? ' — fresh world will generate on start' : ''}${r.restarted ? ' · starting…' : ''}` : `✗ ${r.error}`)
      setSeedFor(null); setSeed('')
      refresh()
    },
    onError: (e) => setMsg(`✗ ${String(e)}`),
  })
  const [resetSeed, setResetSeed] = useState('')
  const reset = useMutation({
    mutationFn: async (n: number) => {
      const r = await fetch(`/api/servers/${serverId}/worlds/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n, seed: resetSeed.trim() || undefined }),
      })
      return (await r.json()) as { ok: boolean; error?: string }
    },
    onSuccess: (r) => {
      setMsg(r.ok ? '✓ world reset — a backup zip was saved first (see Backups)' : `✗ ${r.error}`)
      setConfirmReset(null)
      refresh()
    },
    onError: (e) => setMsg(`✗ ${String(e)}`),
  })

  const busy = switcher.isPending || reset.isPending
  // live server-side progress: also catches ops started elsewhere (genie,
  // another device). The record self-clears ~12s after done — the bar's
  // disappearance is driven by the backend, so it can never get stuck.
  const { data: opData } = useQuery({
    queryKey: ['worldop', serverId],
    queryFn: async () =>
      (await (await fetch(`/api/servers/${serverId}/worlds/progress`)).json()) as {
        progress: { op: string; phase: string; pct: number; done: boolean; error?: string } | null
      },
    refetchInterval: (q) => (q.state.data?.progress || busy ? 1200 : 8000),
  })
  const op = opData?.progress ?? null
  const opDone = op?.done ?? false
  useEffect(() => {
    if (opDone) refresh() // world list + stats reflect the fresh/absent world immediately
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opDone])

  if (!data) return null

  return (
    <div className="block p-4">
      <div className="flex items-center gap-2 mb-3">
        <Pi i="pick" className="pi pi-s" />
        <span className="text-sm font-bold">Worlds</span>
        <span className="hud">{data.slots.filter((s) => s.exists).length}/3 SLOTS</span>
        {(op || busy) && (
          <span key={op ? `${op.done}-${op.error ?? ''}` : 'local'} className={`hud !opacity-100 ml-auto pop-in ${op?.error ? 'text-redstone' : op?.done ? 'text-emerald' : 'text-gold'}`}>
            {op?.error
              ? `✗ ${op.op.toUpperCase()} FAILED`
              : op?.done
                ? `✓ ${op.op.toUpperCase()} COMPLETE`
                : `${(op?.op ?? (switcher.isPending ? 'switch' : 'reset')) === 'switch' ? 'SWITCHING' : 'RESETTING'}… ${op?.phase ?? 'starting…'}`}
          </span>
        )}
      </div>
      {op && !op.done && (
        <div className="meter h-4 mb-3">
          <div className="meter-fill working bg-gold" style={{ width: `${op.pct}%` }} />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {data.slots.map((s) => (
          <div
            key={s.n}
            className={`border-2 ${s.exists ? 'border-line' : 'border-dashed border-line/50'} ${s.active ? 'shadow-[0_0_0_2px_var(--color-emerald)]' : ''}`}
          >
            {/* grass strip: alive worlds get turf, empty slots get bare dirt */}
            <div
              className="h-2.5"
              style={
                s.exists
                  ? { background: 'linear-gradient(180deg, var(--color-emerald) 0 45%, #7a5b3a 45%)' }
                  : { background: 'repeating-linear-gradient(90deg, #4a4139 0 8px, #3a332c 8px 16px)' }
              }
            />
            <div className="p-3">
              <div className="flex items-center gap-2 min-h-6">
                {editing === s.n ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => { rename.mutate({ n: s.n, name: draft }); setEditing(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    className="field px-2 py-0.5 text-sm font-bold w-full"
                  />
                ) : (
                  <button
                    className="text-sm font-bold truncate hover:underline decoration-dotted"
                    title="click to rename"
                    onClick={() => { setEditing(s.n); setDraft(s.name) }}
                  >
                    {s.name}
                  </button>
                )}
                {s.active && <span className="hud !opacity-100 text-emerald shrink-0">ACTIVE</span>}
              </div>
              <div className="text-text-dim text-xs mt-1">
                {s.exists ? (
                  <>{fmtWorld(s.sizeMb)}{!s.active && s.lastPlayed ? ` · played ${fmtAgo(s.lastPlayed)}` : ''}</>
                ) : (
                  'no world yet — generates on first start'
                )}
              </div>

              <div className="mt-2.5 flex flex-col gap-1.5">
                {!s.active && s.exists && (
                  <button
                    className="btn btn-block px-3 py-1.5 text-xs"
                    disabled={busy}
                    onClick={() => {
                      if (!running || confirm('Switching stops the server, swaps worlds, and starts it again. Players will be disconnected. Continue?'))
                        switcher.mutate({ n: s.n })
                    }}
                  >
                    {running ? 'Stop & switch' : 'Switch to this world'}
                  </button>
                )}

                {!s.exists && s.active && (
                  <div className="text-xs text-text-dim">
                    press <b className="text-text">Start</b> on the server and this world generates itself
                  </div>
                )}
                {!s.exists && !s.active && (seedFor === s.n ? (
                  <div className="flex gap-1.5">
                    <input
                      autoFocus
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                      placeholder="seed (optional)"
                      className="field px-2 py-1 text-xs font-mono min-w-0 flex-1"
                    />
                    <button className="btn btn-block px-2.5 py-1 text-xs shrink-0" disabled={busy} onClick={() => switcher.mutate({ n: s.n, seed })}>
                      Create
                    </button>
                  </div>
                ) : (
                  <button className="btn btn-block px-3 py-1.5 text-xs" disabled={busy} onClick={() => { setSeedFor(s.n); setSeed('') }}>
                    + New world
                  </button>
                ))}

                {s.exists && (confirmReset === s.n ? (
                  <div className="flex flex-col gap-1.5 text-xs">
                    <input
                      value={resetSeed}
                      onChange={(e) => setResetSeed(e.target.value)}
                      placeholder="new seed (blank = random)"
                      className="field px-2 py-1 text-xs font-mono"
                    />
                    <div className="flex items-center gap-1.5">
                      <span className="text-crimson font-bold shrink-0">sure?</span>
                      <button className="btn btn-block px-2.5 py-1 text-xs !text-crimson" disabled={busy} onClick={() => reset.mutate(s.n)}>
                        Yes, reset
                      </button>
                      <button className="btn btn-block px-2.5 py-1 text-xs" onClick={() => { setConfirmReset(null); setResetSeed('') }}>No</button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="text-left text-xs text-text-dim hover:text-crimson w-fit"
                    disabled={busy}
                    onClick={() => { setConfirmReset(s.n); setResetSeed('') }}
                  >
                    reset world…
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="text-text-dim text-xs mt-3">
        one world is live at a time — mods are shared, each world keeps its own gamerules and progress.
        the outgoing world is backed up before every switch or reset.
      </div>
      {msg && <div className="text-xs font-semibold mt-2">{msg}</div>}
    </div>
  )
}

// storage cleaner: dry-run scan → shows exactly what is reclaimable
// (render caches, loader caches, archived logs, crash reports — never the
// world, mods, or configs), then cleans what the scan showed
interface CleanScan {
  servers: { serverId: string; serverName: string; running: boolean; items: { key: string; label: string; bytes: number }[]; totalBytes: number }[]
  totalBytes: number
}

const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

// change the server's Minecraft version in place: compatibility report first,
// then a guarded apply that boot-verifies and rolls back on failure
interface ModPlan { file: string; title: string; status: 'ok' | 'update' | 'incompatible' | 'unknown'; targetVersionNumber?: string; note?: string }
interface SwitchPlan {
  from: { mc: string; loader: string }; to: { mc: string; loader: string }
  downgrade: boolean; worldWarning?: string; mods: ModPlan[]
  counts: { ok: number; update: number; incompatible: number; unknown: number }
}
const STATUS_STYLE: Record<ModPlan['status'], string> = {
  ok: 'text-emerald',
  update: 'text-gold',
  incompatible: 'text-redstone',
  unknown: 'text-text-dim',
}

function VersionCard({ serverId, running }: { serverId: string; running: boolean }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState('')
  const [plan, setPlan] = useState<SwitchPlan | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [ack, setAck] = useState(false)

  const { data: targets } = useQuery({
    queryKey: ['version-targets'],
    queryFn: async () => (await (await fetch('/api/versions/targets')).json()) as { versions: string[]; loader: string | null },
    staleTime: 60 * 60_000,
  })
  const { data: snap } = useQuery({
    queryKey: ['version-snapshot', serverId],
    queryFn: async () => (await (await fetch(`/api/servers/${serverId}/version/snapshot`)).json()) as { snapshot: { at: string; from: { mc: string }; to: { mc: string } } | null },
  })

  const doPlan = useMutation({
    mutationFn: async (mc: string) => {
      const r = await fetch(`/api/servers/${serverId}/version/plan?mc=${encodeURIComponent(mc)}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? j.message ?? r.statusText)
      return j as SwitchPlan
    },
    onSuccess: (p) => { setPlan(p); setAck(false); setMsg(null) },
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error: /, '')}`),
  })
  const doApply = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/servers/${serverId}/version/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mc: target, acceptDowngrade: ack, disableIncompatible: true }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? r.statusText)
      return j as { updated: string[]; disabled: string[]; backup?: string }
    },
    onSuccess: (r) => {
      setMsg(`✓ Now running ${target} — ${r.updated.length} mods updated${r.disabled.length ? `, ${r.disabled.length} disabled (${r.disabled.join(', ')})` : ''}. Server booted and verified.${r.backup ? ` World backed up as ${r.backup}.` : ''}`)
      setPlan(null)
      qc.invalidateQueries({ queryKey: ['version-snapshot', serverId] })
      qc.invalidateQueries({ queryKey: ['stats', serverId] })
    },
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error: /, '')}`),
  })
  const doRollback = useMutation({
    mutationFn: async () => (await fetch(`/api/servers/${serverId}/version/rollback`, { method: 'POST' })).json(),
    onSuccess: () => { setMsg('✓ Rolled back to the previous mods + loader — press Start.'); qc.invalidateQueries({ queryKey: ['stats', serverId] }) },
  })

  const busy = doPlan.isPending || doApply.isPending
  const blocked = plan?.downgrade && !ack
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold flex items-center gap-2"><Pi i="spark" className="pi pi-s" /> Minecraft version</div>
          <div className="text-text-dim text-xs mt-0.5">
            change version in place — every mod is checked, updated and re-verified. the server must boot
            or everything rolls back. the world is backed up first
          </div>
        </div>
        <select
          value={target}
          onChange={(e) => { setTarget(e.target.value); setPlan(null); setMsg(null) }}
          disabled={busy}
          className="field px-3 py-2 text-sm font-mono shrink-0"
        >
          <option value="">target version…</option>
          {(targets?.versions ?? []).slice(0, 30).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <button
          onClick={() => doPlan.mutate(target)}
          disabled={!target || busy}
          className="btn btn-block px-4 py-2 text-sm shrink-0"
        >
          {doPlan.isPending ? 'checking mods…' : 'Check compatibility'}
        </button>
      </div>

      {plan && (
        <div className="mt-2.5 pt-2.5 border-t-2 border-line/40 space-y-2">
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <span className="hud">{plan.from.mc} → {plan.to.mc}</span>
            <span className="text-emerald font-bold">{plan.counts.ok} fine</span>
            <span className="text-gold font-bold">{plan.counts.update} to update</span>
            {plan.counts.incompatible > 0 && <span className="text-redstone font-bold">{plan.counts.incompatible} will be disabled</span>}
            {plan.counts.unknown > 0 && <span className="text-text-dim font-bold">{plan.counts.unknown} unknown</span>}
          </div>

          <div className="max-h-52 overflow-y-auto space-y-0.5 pr-1">
            {plan.mods.map((m) => (
              <div key={m.file} className="flex items-center gap-2 text-xs">
                <span className={`font-bold w-24 shrink-0 ${STATUS_STYLE[m.status]}`}>{m.status}</span>
                <span className="truncate font-semibold">{m.title}</span>
                <span className="text-text-dim truncate">
                  {m.status === 'update' ? `→ ${m.targetVersionNumber}` : m.note ?? ''}
                </span>
              </div>
            ))}
          </div>

          {plan.worldWarning && (
            <label className="flex items-start gap-2 text-xs text-redstone font-semibold cursor-pointer">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
              <span>{plan.worldWarning}</span>
            </label>
          )}
          {running && <div className="text-xs text-gold font-semibold">the server will be stopped and restarted automatically</div>}

          <button
            onClick={() => {
              const bad = plan.counts.incompatible + plan.counts.unknown
              if (confirm(`Switch to ${plan.to.mc}?\n\n${plan.counts.update} mods update${bad ? `, ${bad} get disabled` : ''}.\nThe world is backed up first, and everything rolls back if the server doesn't boot.`))
                doApply.mutate()
            }}
            disabled={busy || blocked}
            className="btn btn-emerald px-4 py-2 text-sm"
          >
            {doApply.isPending ? 'switching… (backing up, updating, booting)' : `Switch to ${plan.to.mc}`}
          </button>
        </div>
      )}

      {snap?.snapshot && (
        <div className="mt-2.5 pt-2.5 border-t-2 border-line/40 flex items-center gap-3 flex-wrap text-xs">
          <span className="text-text-dim">
            last switch {new Date(snap.snapshot.at).toLocaleString()} · {snap.snapshot.from.mc} → {snap.snapshot.to.mc}
          </span>
          <button onClick={() => { if (confirm('Roll back to the previous mods + loader?')) doRollback.mutate() }} className="btn btn-block px-3 py-1 ml-auto shrink-0">
            Roll back
          </button>
        </div>
      )}
      {msg && <div className="text-xs font-semibold mt-2.5">{msg}</div>}
    </div>
  )
}

// pro builds (.schem / .litematic / .nbt) → converted to vanilla structure
// templates the genie stamps in-world with "server place the <name> at x y z"
function BuildLibraryCard() {
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)
  type Schem = { name: string; source: string; format: string; size: [number, number, number]; blocks: number; tiles: unknown[]; createdAt: string }
  const { data } = useQuery({
    queryKey: ['schematics'],
    queryFn: async () => (await (await fetch('/api/schematics')).json()) as { schematics: Schem[] },
  })
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const buf = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      const r = await fetch('/api/schematics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, dataBase64: btoa(bin) }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? r.statusText)
      return j as Schem
    },
    onSuccess: (s) => {
      setMsg(`✓ "${s.name}" imported — ${s.size[0]}×${s.size[1]}×${s.size[2]}, ${s.blocks.toLocaleString()} blocks. Ask the genie: server place the ${s.name} at <x y z>`)
      qc.invalidateQueries({ queryKey: ['schematics'] })
    },
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error: /, '')}`),
  })
  const del = useMutation({
    mutationFn: async (name: string) => fetch(`/api/schematics?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => { setMsg(null); qc.invalidateQueries({ queryKey: ['schematics'] }) },
  })
  const items = data?.schematics ?? []
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold flex items-center gap-2"><Pi i="pick" className="pi pi-s" /> Build library</div>
          <div className="text-text-dim text-xs mt-0.5">
            drop in .schem / .litematic / .nbt files from Abfielder, GrabCraft or Litematica — the
            genie stamps them in-world, pixel-perfect: “server place the &lt;name&gt; at x y z”
          </div>
        </div>
        <label className="btn btn-block px-4 py-2 text-sm shrink-0 cursor-pointer">
          {upload.isPending ? 'importing…' : '+ Add build'}
          <input
            type="file"
            accept=".schem,.schematic,.litematic,.nbt"
            className="hidden"
            disabled={upload.isPending}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = '' }}
          />
        </label>
      </div>
      {items.length > 0 && (
        <div className="mt-2.5 pt-2.5 border-t-2 border-line/40 space-y-1.5">
          {items.map((s) => (
            <div key={s.name} className="flex items-center gap-3 flex-wrap text-xs">
              <span className="font-bold font-mono">{s.name}</span>
              <span className="hud">{s.size[0]}×{s.size[1]}×{s.size[2]}</span>
              <span className="text-text-dim">{s.blocks.toLocaleString()} blocks{s.tiles.length > 1 ? ` · ${s.tiles.length} tiles` : ''} · {s.format}</span>
              <button
                onClick={() => { if (confirm(`Remove "${s.name}" from the library?`)) del.mutate(s.name) }}
                className="btn btn-block px-3 py-1 ml-auto shrink-0"
              >Remove</button>
            </div>
          ))}
        </div>
      )}
      {msg && <div className="text-xs font-semibold mt-2.5">{msg}</div>}
    </div>
  )
}

function CleanerRow() {
  const [scan, setScan] = useState<CleanScan | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const doScan = useMutation({
    mutationFn: async () => (await (await fetch('/api/cleaner/scan')).json()) as CleanScan,
    onSuccess: (s) => { setScan(s); setMsg(null) },
  })
  const doClean = useMutation({
    mutationFn: async (s: CleanScan['servers'][number]) => {
      const r = await fetch('/api/cleaner/clean', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverId: s.serverId, keys: s.items.map((i) => i.key) }),
      })
      if (!r.ok) throw new Error(await r.text())
      return r.json() as Promise<{ freedBytes: number; skipped: string[] }>
    },
    onSuccess: (r) => {
      setMsg(`✓ freed ${fmtBytes(r.freedBytes)}${r.skipped.length ? ` (skipped while running: ${r.skipped.join(', ')})` : ''}`)
      doScan.mutate()
    },
    onError: (e) => setMsg(`✗ ${String(e)}`),
  })
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold flex items-center gap-2"><Pi i="chest" className="pi pi-s" /> Storage cleaner</div>
          <div className="text-text-dim text-xs mt-0.5">
            reclaims regenerable junk only — map render tiles, loader caches, archived logs, crash
            reports. never touches worlds, mods, or configs
          </div>
        </div>
        <button onClick={() => doScan.mutate()} disabled={doScan.isPending} className="btn btn-block px-4 py-2 text-sm shrink-0">
          {doScan.isPending ? 'scanning…' : scan ? 'Rescan' : 'Scan'}
        </button>
      </div>
      {scan && (
        <div className="mt-2.5 pt-2.5 border-t-2 border-line/40 space-y-2">
          {scan.servers.length === 0 && <div className="text-xs text-text-dim">nothing to reclaim — all clean ✨</div>}
          {scan.servers.map((s) => (
            <div key={s.serverId} className="flex items-center gap-3 flex-wrap text-xs">
              <span className="font-bold">{s.serverName}</span>
              <span className="text-text-dim">
                {s.items.map((i) => `${i.label} ${fmtBytes(i.bytes)}`).join(' · ')}
              </span>
              <button
                onClick={() => doClean.mutate(s)}
                disabled={doClean.isPending}
                className="btn btn-block px-3 py-1 ml-auto shrink-0"
              >
                {doClean.isPending ? 'cleaning…' : `Free ${fmtBytes(s.totalBytes)}`}
              </button>
            </div>
          ))}
        </div>
      )}
      {msg && <div className="text-xs font-semibold mt-2.5">{msg}</div>}
    </div>
  )
}

// host CPU profile: loud = full turbo, quiet = 90% cap + no boost. Same
// switches as the desktop "Loud/Quiet Mode" bats, now flippable remotely.
function PerfModeRow() {
  const qc = useQueryClient()
  const [err, setErr] = useState<string | null>(null)
  const { data } = useQuery({
    queryKey: ['perfmode'],
    queryFn: async () => (await (await fetch('/api/perfmode')).json()) as { mode: 'loud' | 'quiet' | 'unknown' },
  })
  const set = useMutation({
    mutationFn: async (loud: boolean) => {
      const r = await fetch('/api/perfmode', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loud }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? r.statusText)
      return j
    },
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['perfmode'] }) },
    onError: (e) => setErr(String(e).replace(/^Error: /, '')),
  })
  if (!data || data.mode === 'unknown') return null
  const loud = data.mode === 'loud'
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-4 flex-wrap">
        <button
          className="lever"
          data-on={loud}
          disabled={set.isPending}
          onClick={() => set.mutate(!loud)}
          aria-label="Toggle loud mode"
        />
        <div className="min-w-0">
          <div className="text-sm font-bold flex items-center gap-2">
            <Pi i="bolt" className="pi pi-s" /> Loud mode <span className="hud">PC · {loud ? 'FULL TURBO' : 'QUIET 90%'}</span>
          </div>
          <div className="text-text-dim text-xs mt-0.5">
            {loud
              ? 'full CPU speed + turbo boost — max performance, louder fans'
              : 'CPU capped at 90%, turbo off — cool and near-silent, ~5-15% slower peaks'}
          </div>
        </div>
      </div>
      {err && <div className="text-xs font-semibold text-redstone mt-2.5 pt-2.5 border-t-2 border-line/40">✗ {err}</div>}
    </div>
  )
}

function fmtMem(mem: number | string): string {
  if (typeof mem === 'string') return mem
  if (mem > 1e9) return `${(mem / 1e9).toFixed(1)} GB`
  if (mem > 1e6) return `${(mem / 1e6).toFixed(0)} MB`
  return `${mem}`
}

// deleting a server: the last thing that ever needed the Crafty UI. Stopped
// servers only; the exact name must be typed; the world gets a final backup.
function DangerZoneRow({ serverId, name, running }: { serverId: string; name: string; running: boolean }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [arming, setArming] = useState(false)
  const [typed, setTyped] = useState('')
  const [keepBackup, setKeepBackup] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const del = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/servers/${serverId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmName: typed, skipBackup: !keepBackup }),
      })
      const j = (await r.json()) as { ok?: boolean; error?: string; backedUp?: boolean }
      if (!j.ok) throw new Error(j.error ?? 'delete failed')
      return j
    },
    onSuccess: (j) => {
      qc.invalidateQueries()
      navigate('/')
      window.setTimeout(() => window.alert(`Server deleted.${j.backedUp ? ' A final world backup was saved (see Backups).' : ' No backup was kept — the world is gone.'}`), 50)
    },
    onError: (e) => setErr(String(e).replace(/^Error: /, '')),
  })
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold flex items-center gap-2 text-crimson"><Pi i="cross" className="pi pi-s" /> Delete this server</div>
          <div className="text-text-dim text-xs mt-0.5">
            {running
              ? 'stop the server first — a running server cannot be deleted'
              : 'removes it from the panel, Crafty and disk. The world is zipped into Backups first, so it stays restorable.'}
          </div>
        </div>
        {!arming ? (
          <button
            className="btn btn-block px-4 py-2 text-sm shrink-0 text-crimson"
            disabled={running}
            onClick={() => { setArming(true); setErr(null); setTyped(''); setKeepBackup(true) }}
          >
            Delete…
          </button>
        ) : (
          <span className="shake-once flex items-center gap-2 flex-wrap">
            <label
              className={`flex items-center gap-1.5 text-xs font-semibold cursor-pointer select-none ${keepBackup ? 'text-text-dim' : 'text-crimson'}`}
              title={keepBackup
                ? 'The world is zipped into Backups first (big worlds take minutes)'
                : 'No backup: deletion is instant and the world is UNRECOVERABLE'}
            >
              <input type="checkbox" checked={keepBackup} onChange={(e) => setKeepBackup(e.target.checked)} />
              {keepBackup ? 'keep a world backup' : 'NO backup — world gone forever'}
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`type "${name}"`}
              className="field px-3 py-2 text-sm w-52"
            />
            <button
              className="btn btn-redstone px-4 py-2 text-sm"
              disabled={typed.trim() !== name.trim() || del.isPending}
              onClick={() => del.mutate()}
            >
              {del.isPending ? 'deleting…' : 'Delete forever'}
            </button>
            <button className="btn btn-block px-3 py-2 text-sm" onClick={() => setArming(false)}>cancel</button>
          </span>
        )}
      </div>
      {err && <div key={err} className="pop-in text-xs font-semibold text-redstone mt-2.5 pt-2.5 border-t-2 border-line/40">✗ {err}</div>}
    </div>
  )
}

export default function Dashboard() {
  const { data: serversData, error: serversError } = useServers()
  const active = serversData?.servers.find((s) => s.active)
  const { data: stats } = useStats(active?.id)
  const { data: logs } = useLogs(active?.id, true)
  const action = useServerAction(active?.id)
  const sendCmd = useSendCommand(active?.id)
  const { data: autostop } = useAutostop()
  const setAutostop = useSetAutostop()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [cmd, setCmd] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [transition, setTransition] = useState<string | null>(null) // 'starting…' etc.
  const logRef = useRef<HTMLDivElement>(null)
  const cpuHist = useRef<number[]>([])

  const { data: playit } = useQuery({
    queryKey: ['playit'],
    queryFn: async () => (await fetch('/api/playit/address')).json() as Promise<{ address: string | null }>,
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  const running = stats?.running ?? false
  const booting = running && stats?.phase === 'starting'

  // cpu sparkline history (last ~24 samples ≈ 1.5 min at 4s polls)
  useEffect(() => {
    if (stats && running) {
      cpuHist.current = [...cpuHist.current.slice(-23), stats.cpu]
    } else if (!running) {
      cpuHist.current = []
    }
  }, [stats, running])
  const spark = cpuHist.current.length > 1
    ? cpuHist.current.map((v, i, a) => `${(i * (64 / Math.max(a.length - 1, 1))).toFixed(1)},${(19 - Math.min(v, 100) * 0.16).toFixed(1)}`).join(' ')
    : null

  // TPS: sampled by the panel over RCON (vanilla `tick query`, 20s cadence)
  const { data: tpsData } = useQuery({
    queryKey: ['tps', active?.id],
    queryFn: async () => (await (await fetch(`/api/servers/${active!.id}/tps`)).json()) as { samples: { t: number; mspt: number; tps: number }[] },
    refetchInterval: 20_000,
    enabled: !!active && !!running,
  })
  const tpsNow = tpsData?.samples.at(-1)
  const tpsSpark = (tpsData?.samples.length ?? 0) > 1
    ? tpsData!.samples
        .slice(-24)
        .map((s, i, a) => `${(i * (64 / Math.max(a.length - 1, 1))).toFixed(1)},${(19 - Math.min(s.tps, 20) * 0.8).toFixed(1)}`)
        .join(' ')
    : null

  // clear the transition banner once the server is genuinely joinable.
  // RESTART is special: it begins from running=true, so "running && !booting"
  // was already true on the very next render and the banner cleared instantly
  // (buttons re-enabled mid-restart). Wait until we have actually SEEN the
  // server go down, then come back up.
  const restartSawDown = useRef(false)
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (transition === 'starting…' && running && !booting) setTransition(null)
    if (transition === 'stopping…' && stats && !running) setTransition(null)
    if (transition === 'restarting…') {
      if (!running) restartSawDown.current = true
      else if (restartSawDown.current && !booting) setTransition(null)
    }
  }, [running, booting, stats, transition])

  const act = (a: 'start' | 'stop' | 'restart') => {
    if (a === 'restart') restartSawDown.current = false
    setTransition(a === 'start' ? 'starting…' : a === 'stop' ? 'stopping…' : 'restarting…')
    // never wedge: if Crafty silently ignores the action, release the UI.
    // The old timer was fire-and-forget, so a watchdog armed by an EARLIER action
    // could fire during a LATER one — press Start, then Restart 140s later, and
    // at t=150s the first timer cleared the restart banner and re-enabled the
    // power buttons while the server was still coming down. Cancel the previous
    // watchdog, and let this one only clear the transition it armed.
    if (watchdog.current) clearTimeout(watchdog.current)
    const mine = a
    watchdog.current = setTimeout(() => {
      watchdog.current = null
      setTransition((cur) => (cur === (mine === 'start' ? 'starting…' : mine === 'stop' ? 'stopping…' : 'restarting…') ? null : cur))
    }, 150_000)
    setNotice(`Sent ${a} — Crafty is working on it`)
    setTimeout(() => setNotice(null), 5000)
    action.mutate(a, {
      onError: (e) => {
        setTransition(null)
        setNotice(`✗ ${a} failed: ${String(e)}`)
      },
      onSuccess: () => {
        const iv = setInterval(() => qc.invalidateQueries({ queryKey: ['stats', active?.id] }), 1500)
        setTimeout(() => clearInterval(iv), 30000)
      },
    })
  }

  const copyJoin = () => {
    const text = active?.address ?? playit?.address
    if (!text) return
    const done = () => {
      setNotice('✓ Join address copied — send it to your friends')
      setTimeout(() => setNotice(null), 4000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
    } else {
      fallbackCopy(text, done)
    }
  }

  if (!active)
    return (
      <div>
        <div className="hud mb-3">Y 11 · CONTROL</div>
        {serversError ? (
          <div className="block px-5 py-4 border-redstone! flex items-center gap-3">
            <span className="lamp lamp-crash" />
            <div>
              <div className="font-bold text-sm">Can't reach Crafty</div>
              <div className="text-text-dim text-xs mt-0.5">It may still be starting — the panel reconnects by itself.</div>
            </div>
          </div>
        ) : (
          <p className="text-text-dim">No active server — pick one on the Servers page.</p>
        )}
      </div>
    )

  const busy = action.isPending || transition !== null
  const idle = autostop?.enabled ? autostop.idle.find((i) => i.id === active.id) : undefined

  return (
    <div className="space-y-6">
      <div className="vista">
        <img src={bandControl} alt="" />
        <span className="vista-tag">Y 11 · CONTROL ROOM</span>
      </div>

      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl flex items-center gap-3">
            {active.name}
            <span
              className={`lamp ${
                transition || booting
                  ? 'lamp-starting animate-pulse'
                  : running ? 'lamp-on' : stats?.crashed ? 'lamp-crash' : 'lamp-off'
              }`}
            />
            {(transition || booting) && (
              <span className="font-px text-xs text-gold">{(transition ?? 'starting…').toUpperCase()}</span>
            )}
          </h1>
          <p className="text-text-dim text-sm mt-1">
            {active.detection.loader} {active.detection.mc ?? ''} ·{' '}
            {transition ??
              (booting
                ? 'starting — world loading, not joinable yet'
                : running ? `up since ${stats?.started}` : stats?.crashed ? 'crashed' : 'stopped')}
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <button onClick={() => act('start')} disabled={running || busy} className="btn btn-emerald px-5 py-2.5 text-sm">
            {transition === 'starting…' ? 'Starting…' : 'Start'}
          </button>
          <button onClick={() => act('restart')} disabled={!running || busy} className="btn btn-block px-5 py-2.5 text-sm">
            {transition === 'restarting…' ? 'Restarting…' : 'Restart'}
          </button>
          <button
            onClick={() => { if (confirm(`Stop ${active.name}?`)) act('stop') }}
            disabled={!running || busy}
            className="btn btn-redstone px-5 py-2.5 text-sm"
          >
            {transition === 'stopping…' ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      </div>

      {notice && <div className="block border-emerald! px-4 py-2.5 text-sm font-semibold">{notice}</div>}

      {(active.address ?? playit?.address) && (
        <button onClick={copyJoin} className="btn btn-block w-full sm:w-auto px-5 py-3 text-left flex items-center gap-4" title="Click to copy">
          <span className="hud !opacity-100 text-emerald shrink-0">JOIN AT</span>
          <span className="font-mono text-sm font-bold truncate">{active.address ?? playit?.address}</span>
          <span className="hud shrink-0">CLICK TO COPY</span>
        </button>
      )}

      {/* ============ the Anvil ============ */}
      <div className="apanel">
        <div className="apanel-head">
          <i
            className={`ph-dot ${booting ? 'animate-pulse' : running ? '' : stats?.crashed ? 'ph-dot-crash' : 'ph-dot-off'}`}
            style={booting ? { background: 'var(--color-gold)', boxShadow: '0 0 8px var(--color-gold)' } : undefined}
          />
          <b>anvil</b>
          <span className="truncate">· {active.address ?? playit?.address ?? `${active.name}.local:25565`}</span>
          <span className="ml-auto shrink-0" style={{ color: 'var(--color-emerald)' }}>
            CPU <b style={{ color: 'inherit' }}>{running ? `${stats?.cpu ?? 0}%` : '—'}</b>
          </span>
        </div>
        <div className="apanel-tabs">
          <button className="tab on">Console</button>
          <button className="tab" onClick={() => navigate('/config')}>Players</button>
          <button className="tab" onClick={() => navigate('/backups')}>Backups</button>
          <button className="tab" onClick={() => navigate('/content')}>Mods</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_150px]">
          <div className="min-w-0">
            <div ref={logRef} className="console h-80 overflow-y-auto px-4 py-3 text-[#cfd6db]">
              {logs?.lines.length ? (
                logs.lines.map((l, i) => (
                  <p key={i} className={`cline whitespace-pre-wrap break-all ${i === logs.lines.length - 1 ? 'console-caret' : ''}`}>{l}</p>
                ))
              ) : (
                <p className="opacity-50 console-caret">no output</p>
              )}
            </div>
            <form
              className="flex border-t-2 border-black"
              onSubmit={(e) => {
                e.preventDefault()
                if (cmd.trim()) {
                  sendCmd.mutate(cmd.trim(), {
                    onSuccess: () => qc.invalidateQueries({ queryKey: ['logs', active.id] }),
                    onError: (err) => { setNotice(`✗ command failed: ${String(err)}`); setTimeout(() => setNotice(null), 6000) },
                  })
                }
                setCmd('')
              }}
            >
              <span className="pl-4 pr-2 py-2.5 font-px text-sm" style={{ color: 'var(--color-emerald)' }}>&gt;</span>
              <input
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                placeholder={running ? 'type a command…' : 'server is stopped'}
                disabled={!running}
                className="flex-1 bg-transparent py-2.5 pr-4 font-mono text-sm outline-none placeholder:text-[#cfd6db]/50"
              />
            </form>
          </div>
          <aside className="apanel-side grid content-start gap-3 border-t-2 sm:border-t-0 border-black grid-cols-2 sm:grid-cols-1">
            <div className="ps-row"><span>Players</span><b>{running ? `${stats?.online ?? 0} / ${stats?.max ?? '?'}` : '—'}</b></div>
            <div className="ps-row"><span>RAM</span><b>{running && stats ? fmtMem(stats.mem) : '—'}</b></div>
            <div className="ps-row"><span>World</span><b>{stats?.world_size || '—'}</b></div>
            <div className="ps-row ps-spark col-span-2 sm:col-span-1">
              <span>CPU</span>
              {spark ? (
                <svg viewBox="0 0 64 20" preserveAspectRatio="none"><polyline points={spark} /></svg>
              ) : (
                <b>—</b>
              )}
            </div>
            <div className="ps-row ps-spark col-span-2 sm:col-span-1" title={tpsNow ? `${tpsNow.mspt}ms per tick` : undefined}>
              <span>TPS {tpsNow ? <b style={{ color: tpsNow.tps >= 19 ? 'var(--color-emerald)' : tpsNow.tps >= 15 ? 'var(--color-gold)' : 'var(--color-crimson)' }}>{tpsNow.tps}</b> : null}</span>
              {tpsSpark ? (
                <svg viewBox="0 0 64 20" preserveAspectRatio="none"><polyline points={tpsSpark} /></svg>
              ) : (
                <b>—</b>
              )}
            </div>
            <div className="flex gap-1.5 mt-1 col-span-2 sm:col-span-1">
              {running ? (
                <>
                  <button className="pb pb-stop" disabled={busy} onClick={() => { if (confirm(`Stop ${active.name}?`)) act('stop') }}>Stop</button>
                  <button className="pb" disabled={busy} onClick={() => act('restart')}>Restart</button>
                </>
              ) : (
                <button className="pb pb-go" disabled={busy} onClick={() => act('start')}>Start</button>
              )}
            </div>
          </aside>
        </div>
      </div>

      {/* live players with actions */}
      <PlayersLiveCard serverId={active.id} running={!!running} />

      {/* Realms-style world slots */}
      <WorldsCard serverId={active.id} running={!!running} />

      {/* crashed boot rescue: CF packs ship client-only mods that kill the
          server — one click reads the crash report and disables them */}
      {!running && !transition && <CrashSweepRow serverId={active.id} />}

      {/* AI chat genie */}
      <GenieRow serverId={active.id} />

      {/* schematic build library the genie can PLACE */}
      <BuildLibraryCard />

      {/* In-place version switching is implemented for Fabric ONLY — it swaps in
          a Fabric launcher. Offering it on a Forge/Paper server would install
          Fabric over that server and break it, so don't show the control at all. */}
      {active.detection.loader === 'fabric' ? (
        <VersionCard serverId={active.id} running={!!running} />
      ) : (
        <div className="block px-4 py-3.5">
          <div className="hud mb-1">VERSION</div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="font-extrabold">Minecraft {active.detection.mc ?? '?'}</span>
            <span className="text-xs text-text-dim">
              In-place version switching works on Fabric only. This server is{' '}
              {active.detection.loader.toUpperCase()} — to change its version, create a new{' '}
              {active.detection.loader.toUpperCase()} server on the version you want and move the world in.
            </span>
          </div>
        </div>
      )}

      {/* in-game stats boss bar */}
      <IngameHudRow />

      {/* auto-stop */}
      <div className="block px-4 py-3 flex items-center gap-4 flex-wrap">
        <button
          className="lever"
          data-on={autostop?.enabled ?? false}
          disabled={setAutostop.isPending || !autostop}
          onClick={() => autostop && setAutostop.mutate({ enabled: !autostop.enabled, idleMinutes: autostop.idleMinutes })}
          aria-label="Toggle auto-stop"
        />
        <div className="min-w-0">
          <div className="text-sm font-bold flex items-center gap-2"><Pi i="bed" className="pi pi-s" /> Auto-stop when empty</div>
          <div className="text-text-dim text-xs mt-0.5">
            {autostop?.enabled
              ? `stops after ${autostop.idleMinutes} min with no players — start it again from here`
              : 'server keeps running while empty'}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {idle && (() => {
            const m = Math.floor(idle.stopsInSec / 60)
            const s = String(idle.stopsInSec % 60).padStart(2, '0')
            return <span className="hud !opacity-100 text-gold">EMPTY · STOPS IN {m}:{s}</span>
          })()}
          {autostop?.enabled && (
            <label className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={120}
                value={autostop.idleMinutes}
                onChange={(e) => {
                  const v = Math.min(120, Math.max(1, Number(e.target.value) || 5))
                  setAutostop.mutate({ enabled: true, idleMinutes: v })
                }}
                className="field w-16 px-2 py-1.5 text-sm font-mono text-center"
              />
              <span className="hud">MIN</span>
            </label>
          )}
        </div>
      </div>

      {/* PC loud/quiet mode (powercfg on the host) */}
      <PerfModeRow />

      {/* task scheduler */}
      <SchedulerCard serverId={active.id} />

      {/* storage cleaner (all servers) */}
      <CleanerRow />

      {/* danger zone — dead last, below everything routine */}
      <DangerZoneRow serverId={active.id} name={active.name} running={running} />
    </div>
  )
}
