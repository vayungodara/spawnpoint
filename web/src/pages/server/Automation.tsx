import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAutostop, useCurrentServer, useSetAutostop } from '../../api'
import { Pi } from '../../components/PixelIcons'

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

// task scheduler: daily/interval automations (restart, announce, command,
// start/stop) driven by a 30s tick on the panel
interface SchedTask { id: string; enabled: boolean; serverId: string; kind: string; arg?: string; schedule: { type: 'daily' | 'interval'; time?: string; minutes?: number }; lastRun?: string }
const KIND_LABEL: Record<string, string> = {
  restart: 'restart server', announce: 'announce', command: 'run command',
  start: 'start server', stop: 'stop server (if empty)',
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
      {tasks.length === 0 && !adding && (
        <div className="text-text-dim text-xs mt-2">nothing scheduled — try a daily 04:00 restart, it keeps modded servers healthy</div>
      )}
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

// stop empty servers after a while; one setting for every server
function AutoStopRow({ serverId }: { serverId: string }) {
  const { data: autostop } = useAutostop()
  const setAutostop = useSetAutostop()
  const idle = autostop?.enabled ? autostop.idle.find((i) => i.id === serverId) : undefined
  return (
    <div className="block px-4 py-3 flex items-center gap-4 flex-wrap">
      <button
        className="lever"
        data-on={autostop?.enabled ?? false}
        disabled={setAutostop.isPending || !autostop}
        onClick={() => autostop && setAutostop.mutate({ enabled: !autostop.enabled, idleMinutes: autostop.idleMinutes })}
        aria-label="Toggle auto-stop"
      />
      <div className="min-w-0">
        <div className="text-sm font-bold flex items-center gap-2"><Pi i="bed" className="pi pi-s" /> Auto-stop when empty <span className="hud">ALL SERVERS</span></div>
        <div className="text-text-dim text-xs mt-0.5">
          {autostop?.enabled
            ? `each server stops after ${autostop.idleMinutes} min with no players — start it again from here`
            : 'servers keep running while empty'}
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
  )
}

export default function Automation() {
  const s = useCurrentServer()
  if (!s) return null
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-xl">On a timer</h2>
          <p className="text-sm text-text-dim mt-0.5">Restarts, announcements and idle shutdown run from the panel, even with nobody watching.</p>
        </div>
        <SchedulerCard serverId={s.id} />
        <AutoStopRow serverId={s.id} />
      </section>
      <section className="space-y-3">
        <div>
          <h2 className="text-xl">In the game</h2>
          <p className="text-sm text-text-dim mt-0.5">Optional helpers players use from chat. All of them start switched off.</p>
        </div>
        <GenieRow serverId={s.id} />
        <BuildLibraryCard />
        <IngameHudRow />
      </section>
    </div>
  )
}
