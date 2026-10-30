import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCurrentServer, useStats } from '../../api'
import { Pi } from '../../components/PixelIcons'
import BackupsSection from './BackupsSection'
import PregenSection from './PregenSection'

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

export default function Worlds() {
  const s = useCurrentServer()
  const { data: stats } = useStats(s?.id)
  if (!s) return null
  return (
    <div className="space-y-8">
      <WorldsCard serverId={s.id} running={!!stats?.running} />
      <BackupsSection active={s} />
      <PregenSection serverId={s.id} />
    </div>
  )
}
