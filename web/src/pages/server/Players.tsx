import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, useCurrentServer, useStats } from '../../api'
import { Pi } from '../../components/PixelIcons'
import { ConfirmButton } from './Workspace'

interface Player { name: string; uuid: string; whitelisted: boolean; op: boolean }

// live players: RCON-truth list with one-click actions. Chips only render
// while the server is joinable.
export function PlayersLiveCard({ serverId, running }: { serverId: string; running: boolean }) {
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

/** Who may join and who is an operator: whitelist.json and ops.json. */
function Crew({ id }: { id: string }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const { data } = useQuery({
    queryKey: ['players', id],
    queryFn: () => api<{ players: Player[] }>(`/api/servers/${id}/players`),
  })
  const upsert = useMutation({
    mutationFn: (vars: { name: string; whitelist: boolean; op: boolean }) =>
      api(`/api/servers/${id}/players`, { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['players', id] }),
  })
  const remove = useMutation({
    mutationFn: (who: string) => api(`/api/servers/${id}/players/${encodeURIComponent(who)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['players', id] }),
  })
  return (
    <section className="block px-4 sm:px-5 py-4">
      <h2 className="text-lg font-extrabold">Whitelist and operators</h2>
      <p className="text-xs text-text-dim mt-0.5">Applies straight away on a running server.</p>
      <form
        className="flex gap-3 py-3.5 border-b-2 border-line/40"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) upsert.mutate({ name: name.trim(), whitelist: true, op: false })
          setName('')
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Minecraft username" aria-label="Minecraft username" className="field flex-1 min-w-0 px-3 py-1.5 text-sm" />
        <button className="btn btn-emerald px-4 py-1.5 text-sm">Add</button>
      </form>
      {data?.players.map((pl) => (
        <div key={pl.name} className="flex items-center gap-3 py-3 border-b-2 border-line/40 last:border-0">
          <span className="text-sm font-bold font-mono flex-1 min-w-0 truncate">{pl.name}</span>
          {pl.op && <span className="chip text-gold">OP</span>}
          <button onClick={() => upsert.mutate({ name: pl.name, whitelist: pl.whitelisted, op: !pl.op })} className="text-xs font-bold text-text-dim hover:text-text">
            {pl.op ? 'remove op' : 'make op'}
          </button>
          <ConfirmButton onConfirm={() => remove.mutate(pl.name)} confirmLabel="sure?" className="text-xs font-bold text-redstone/90 hover:text-redstone">
            remove
          </ConfirmButton>
        </div>
      ))}
      {data?.players.length === 0 && <div className="py-3 text-sm text-text-dim">Nobody on the whitelist yet.</div>}
    </section>
  )
}

function ResetProgress({ id }: { id: string }) {
  const [msg, setMsg] = useState<string | null>(null)
  const reset = useMutation({
    mutationFn: () => api<{ ok: boolean; wiped: string[]; restarted: boolean; error?: string }>(`/api/servers/${id}/reset-players`, { method: 'POST', body: '{}' }),
    onSuccess: (r) => setMsg(r.ok ? `✓ Player progress wiped (${r.wiped.join(', ')})${r.restarted ? '. The server is restarting.' : ''}` : `✗ ${r.error}`),
    onError: (e) => setMsg(`✗ ${String(e)}`),
  })
  return (
    <section className="block px-4 sm:px-5 py-4">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold text-crimson">Reset all player progress</h2>
          <p className="text-xs text-text-dim mt-0.5 max-w-[60ch]">Wipes everyone’s inventory, ender chest, XP, position, advancements and stats. Terrain, seed and mods stay. The server stops and starts again.</p>
        </div>
        <ConfirmButton onConfirm={() => reset.mutate()} disabled={reset.isPending} confirmLabel="Click again to wipe" className="btn btn-redstone px-4 py-2 text-sm shrink-0 min-w-[10rem]">
          {reset.isPending ? 'Resetting…' : 'Reset players'}
        </ConfirmButton>
      </div>
      {msg && <p role="status" className="text-sm font-semibold mt-3">{msg}</p>}
    </section>
  )
}

export default function Players() {
  const s = useCurrentServer()
  const { data: stats } = useStats(s?.id)
  if (!s) return null
  const ready = stats?.phase === 'ready' || (!!stats?.running && !stats.phase)
  return (
    <div className="space-y-6">
      {ready ? <PlayersLiveCard serverId={s.id} running /> : (
        <p className="block px-4 py-3 text-sm text-text-dim">Start the server to see who is online and message, heal or kick them from here.</p>
      )}
      <Crew id={s.id} />
      <ResetProgress id={s.id} />
    </div>
  )
}
