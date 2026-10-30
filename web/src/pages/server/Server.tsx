import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useCurrentServer, useStats } from '../../api'
import CrashSweepRow from '../../components/CrashSweep'
import { Pi } from '../../components/PixelIcons'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json() as Promise<T>
}

interface PortRow { id: string; name: string; gamePort: number; rconPort: number; queryPort: number | null }
interface PortAudit {
  rows: PortRow[]
  gameCollisions: number[]
  rconCollisions: number[]
  panelConflicts: string[]
  clean: boolean
}

// Mirrors server/src/services/ports.ts RCON_OFFSET (rcon = game + 10000; query = game).
// Keep in step with the server — the preview label lied when this was left at +10.
const RCON_OFFSET = 10000
const PANEL_PORT = 25570

function Lever({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      data-on={on}
      onClick={() => onChange(!on)}
      className="lever"
    />
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row flex items-center justify-between gap-6 py-3.5 border-b-2 border-line/40 last:border-0">
      <div>
        <div className="text-sm font-bold">{label}</div>
        {hint && <div className="text-xs text-text-dim mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Section({ tag, title, children }: { tag: string; title: string; children: React.ReactNode }) {
  return (
    <div className="block px-5 py-4">
      <div className="hud">{tag}</div>
      <div className="text-base font-extrabold mt-1 mb-1">{title}</div>
      {children}
    </div>
  )
}

function RuntimeSection({ id }: { id: string }) {
  const qc = useQueryClient()
  const [approve, setApprove] = useState(false)
  const [craftyStopped, setCraftyStopped] = useState(false)
  const { data: runtime, error } = useQuery({
    queryKey: ['server-runtime', id],
    queryFn: () => api<{ owner: 'crafty' | 'standalone'; autoStart?: boolean; blocked?: string; transfer: { phase: string; revision: string } | null }>(`/api/servers/${id}/runtime`),
    refetchInterval: 5000,
  })
  const change = useMutation({
    mutationFn: (body: { autoStart: boolean } | { action: string; revision?: string; approve: boolean; craftyStopped?: boolean }) =>
      api(`/api/servers/${id}/runtime${'action' in body ? '/import' : ''}`, { method: 'action' in body ? 'POST' : 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { setApprove(false); setCraftyStopped(false); qc.invalidateQueries() },
  })
  return (
    <div className="block px-5 py-4">
      <h2 className="font-extrabold mb-2">Server runtime</h2>
      {!runtime && <p className="text-sm">{error ? error.message : 'Checking ownership…'}</p>}
      {runtime?.owner === 'standalone' && !runtime.transfer ? <>
        <p className="text-text-dim text-sm max-w-[68ch]">Spawnpoint owns this server independently of the panel. Crafty is never used as a fallback.</p>
        <label className="flex items-start gap-3 text-sm mt-3">
          <input type="checkbox" className="mt-1" checked={runtime.autoStart === true} disabled={change.isPending}
            onChange={(e) => change.mutate({ autoStart: e.target.checked })} />
          <span>Start when the supervisor service starts<br /><span className="text-xs text-text-dim">Includes OS startup and service restarts. Interrupted transactions still block boot.</span></span>
        </label>
        {runtime.blocked && <p role="alert" className="text-sm mt-3">Automatic start paused: {runtime.blocked}. Resolve this, then press Start at the top of the page.</p>}
      </> : runtime && <>
        <p className="text-text-dim text-sm max-w-[68ch]">
          Import a stopped, revision-certified Crafty server. Its UUID, exact pack and world stay intact;
          the directory moves into native storage on the same filesystem. No world restore occurs.
        </p>
        {runtime.transfer && <div className="mt-3 text-sm space-y-2">
          <p className="font-bold">{runtime.transfer.phase === 'preparing' ? 'Freeze interrupted — cancel and retry preparation.' : runtime.transfer.phase === 'committing' ? 'Commit interrupted — complete forward recovery.' : 'Crafty launch settings frozen. Stop the entire local Crafty service before committing.'}</p>
          <p className="text-text-dim">Stopping Crafty also stops its other servers. It can be restarted after this server has moved.</p>
          <p className="break-all font-mono text-xs">Revision: {runtime.transfer.revision}</p>
        </div>}
        <label className="flex items-start gap-3 text-sm mt-4 max-w-[68ch]">
          <input type="checkbox" className="mt-1" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
          <span>{runtime.transfer ? 'I approve importing this exact revision and leaving this server disabled in Crafty.' : 'I approve freezing this stopped server’s Crafty launch settings for transfer.'}</span>
        </label>
        {runtime.transfer && <label className="flex items-start gap-3 text-sm mt-3 max-w-[68ch]">
          <input type="checkbox" className="mt-1" checked={craftyStopped} onChange={(e) => setCraftyStopped(e.target.checked)} />
          <span>I checked that the entire Crafty service or container and its workers have exited. A closed web port is not enough.</span>
        </label>}
        <div className="flex flex-wrap gap-3 mt-3">
          <button className="btn btn-emerald px-4 py-2 text-sm" disabled={!approve || change.isPending || runtime.transfer?.phase === 'preparing' || (!!runtime.transfer && !craftyStopped)}
            onClick={() => change.mutate({ action: runtime.transfer ? 'commit' : 'prepare', approve: true, revision: runtime.transfer?.revision, craftyStopped })}>
            {change.isPending ? 'Saving transfer…' : runtime.transfer ? 'Commit exact revision' : 'Prepare Crafty import'}
          </button>
          {runtime.transfer && runtime.transfer.phase !== 'committing' && <button className="btn btn-block px-4 py-2 text-sm" disabled={change.isPending}
            onClick={() => change.mutate({ action: 'abort', approve: true })}>Cancel and restore Crafty settings</button>}
        </div>
      </>}
      {change.error && <p role="alert" className="text-sm mt-3 break-words">{change.error.message}</p>}
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
    onSuccess: async (j) => {
      // the list must drop the deleted server first, or "/" sends you back to it
      await qc.invalidateQueries({ queryKey: ['servers'] })
      qc.invalidateQueries()
      navigate('/')
      window.setTimeout(() => window.alert(`Server deleted.${j.backedUp ? ' A final world backup was saved in the panel’s backups folder.' : ' No backup was kept — the world is gone.'}`), 50)
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

export default function ServerSettings() {
  const active = useCurrentServer()
  const id = active?.id
  const { data: stats } = useStats(id)
  const running = !!stats?.running
  const qc = useQueryClient()

  const { data } = useQuery({
    queryKey: ['properties', id],
    queryFn: () => api<{ properties: Record<string, string>; restartRequired: boolean }>(`/api/servers/${id}/properties`),
    enabled: !!id,
  })
  const { data: jvm } = useQuery({
    queryKey: ['jvm', id],
    queryFn: () => api<{ minGb: number | null; maxGb: number | null }>(`/api/servers/${id}/jvm`),
    enabled: !!id,
  })
  const { data: audit } = useQuery({
    queryKey: ['ports-audit'],
    queryFn: () => api<PortAudit>('/api/ports/audit'),
    refetchOnWindowFocus: true,
  })

  const [draft, setDraft] = useState<Record<string, string>>({})
  const [ram, setRam] = useState<number | null>(null)
  useEffect(() => setDraft({}), [id])

  const p = { ...(data?.properties ?? {}), ...draft }
  const dirty = Object.keys(draft).length > 0 || (ram !== null && ram !== jvm?.maxGb)
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }))

  const save = useMutation({
    mutationFn: async () => {
      if (Object.keys(draft).length)
        await api(`/api/servers/${id}/properties`, { method: 'PATCH', body: JSON.stringify(draft) })
      if (ram !== null && ram !== jvm?.maxGb)
        await api(`/api/servers/${id}/jvm`, { method: 'PUT', body: JSON.stringify({ gb: ram }) })
      setDraft({}); setRam(null)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['properties', id] })
      // the RAM slider reads ['jvm', id]. Without this the cached pre-save heap
      // stayed put, so setRam(null) snapped the slider straight back to the old
      // value and the hint under it reported the heap you had NOT just saved.
      qc.invalidateQueries({ queryKey: ['jvm', id] })
    },
  })
  const [applied, setApplied] = useState(false)
  // the restart-to-apply bar is dismissible: not every saved change deserves an
  // immediate restart. Editing anything brings it back.
  const [restartDismissed, setRestartDismissed] = useState(false)
  useEffect(() => {
    if (dirty) setRestartDismissed(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty])
  const applyRestart = useMutation({
    mutationFn: () => api(`/api/servers/${id}/apply-restart`, { method: 'POST', body: '{}' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['properties', id] })
      setApplied(true)
      setTimeout(() => setApplied(false), 6000)
    },
  })
  const preset = useMutation({
    mutationFn: (preset: 'hardcore' | 'survival') =>
      api(`/api/servers/${id}/preset`, { method: 'POST', body: JSON.stringify({ preset }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['properties', id] })
      qc.invalidateQueries({ queryKey: ['players', id] })
    },
  })
  const onlineMode = useMutation({
    mutationFn: (online: boolean) =>
      api(`/api/servers/${id}/online-mode`, { method: 'POST', body: JSON.stringify({ online }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['properties', id] }),
  })
  const [portInput, setPortInput] = useState('')
  const [portMsg, setPortMsg] = useState<string | null>(null)
  const changePort = useMutation({
    mutationFn: async (port: number) => {
      // this endpoint answers 409 with { error } for a running server / collision,
      // so read the body either way rather than letting api() swallow the reason
      const r = await fetch(`/api/servers/${id}/port`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      })
      const j = (await r.json()) as { ok: boolean; error?: string; gamePort: number; rconPort: number }
      if (!r.ok || !j.ok) throw new Error(j.error ?? `${r.status}`)
      return j
    },
    onSuccess: (r) => {
      setPortInput('')
      setPortMsg(`✓ Moved to game ${r.gamePort} · rcon ${r.rconPort} — start the server to bind it`)
      qc.invalidateQueries({ queryKey: ['properties', id] })
      qc.invalidateQueries({ queryKey: ['ports-audit'] })
      setTimeout(() => setPortMsg(null), 12000)
    },
    onError: (e) => { setPortMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`); setTimeout(() => setPortMsg(null), 12000) },
  })
  const suggestPort = useMutation({
    mutationFn: () => api<{ port: number }>(`/api/servers/${id}/port/suggest`),
    onSuccess: (r) => setPortInput(String(r.port)),
    onError: (e) => { setPortMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`); setTimeout(() => setPortMsg(null), 8000) },
  })
  // Guard client-side so known-bad ports never leave the browser (the server also
  // rejects them with a 409, but this is a clearer, instant signal).
  const submitPort = () => {
    const n = parseInt(portInput, 10)
    if (Number.isInteger(n) && n >= 1024 && n <= 65535 && n !== PANEL_PORT) changePort.mutate(n)
    else { setPortMsg('✗ enter a port between 1024 and 65535 (not 25570)'); setTimeout(() => setPortMsg(null), 8000) }
  }

  if (!active) return null

  // server-side flag only — refetched after every mutation, cleared by apply-restart
  const restartRequired = data?.restartRequired ?? false

  return (
    <div className="max-w-3xl space-y-6 pb-28">
      <RuntimeSection key={id} id={id!} />

      <p className="text-text-dim text-sm max-w-[68ch]">
        Game rules and limits below save to server.properties. Most take effect after a restart.
      </p>

      {audit && !audit.clean && (
        // Danger banner idiom (matches Servers.tsx / Dashboard.tsx): the red is
        // carried by `border-redstone!` (the `!` is required — `.block` sets an
        // unlayered ink border that plain `border-redstone` can't override), never
        // by red text (which fails contrast on the dark surface). role="alert" so
        // it's announced when the async audit flips it on.
        <div role="alert" className="block px-5 py-4 border-redstone!">
          <div className="hud">PORT COLLISION</div>
          <div className="text-base font-extrabold mt-1 mb-2">
            {audit.gameCollisions.length + audit.rconCollisions.length > 0
              ? 'Two servers share a port'
              : 'A server is on the panel’s port'}
          </div>
          <p className="text-sm text-text-dim mb-2 max-w-[68ch]">
            {audit.gameCollisions.length + audit.rconCollisions.length > 0
              ? "Servers that share a port can't run at the same time, and a shared RCON port lets a command reach the wrong world. Give each its own port — open the colliding server, then Server → Network → Move."
              : 'A server is bound to 25570, the panel’s own port. Open it and use Server → Network → Move to give it a free one.'}
          </p>
          <ul className="text-sm font-semibold space-y-1">
            {audit.gameCollisions.map((port) => (
              <li key={`g${port}`}>
                <span className="font-mono">game {port}</span>{' '}
                — {audit.rows.filter((r) => r.gamePort === port).map((r) => r.name).join(', ')}
              </li>
            ))}
            {audit.rconCollisions.map((port) => (
              <li key={`r${port}`}>
                <span className="font-mono">rcon {port}</span>{' '}
                — {audit.rows.filter((r) => r.rconPort === port).map((r) => r.name).join(', ')}
              </li>
            ))}
            {audit.panelConflicts.map((cid) => (
              <li key={`p${cid}`}>
                <span className="font-mono">panel port 25570</span>{' '}
                — {audit.rows.find((r) => r.id === cid)?.name ?? cid}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => { if (confirm('Hardcore: 1 life, hard difficulty, no cheats, de-ops EVERYONE. Apply?')) preset.mutate('hardcore') }}
          className="btn btn-redstone px-4 py-2 text-sm"
        >
          Hardcore preset
        </button>
        <button
          onClick={() => { if (confirm('Survival: normal difficulty, no cheats, de-ops EVERYONE. Apply?')) preset.mutate('survival') }}
          className="btn btn-block px-4 py-2 text-sm"
        >
          Survival preset
        </button>
      </div>

      <Section tag="RULES" title="Gameplay">
        <Row label="Gamemode">
          <select className="field px-3 py-1.5 text-sm font-semibold" value={p['gamemode'] ?? 'survival'} onChange={(e) => set('gamemode', e.target.value)}>
            {['survival', 'creative', 'adventure', 'spectator'].map((g) => <option key={g}>{g}</option>)}
          </select>
        </Row>
        <Row label="Difficulty">
          <select className="field px-3 py-1.5 text-sm font-semibold" value={p['difficulty'] ?? 'normal'} onChange={(e) => set('difficulty', e.target.value)}>
            {['peaceful', 'easy', 'normal', 'hard'].map((g) => <option key={g}>{g}</option>)}
          </select>
        </Row>
        <Row label="Hardcore" hint="one life, world locks on death">
          <Lever on={p['hardcore'] === 'true'} onChange={(v) => set('hardcore', String(v))} />
        </Row>
        <Row label="Force gamemode" hint="players always rejoin in the server gamemode">
          <Lever on={p['force-gamemode'] === 'true'} onChange={(v) => set('force-gamemode', String(v))} />
        </Row>
        <Row label="Command blocks">
          <Lever on={p['enable-command-block'] === 'true'} onChange={(v) => set('enable-command-block', String(v))} />
        </Row>
        <Row label="PvP">
          <Lever on={p['pvp'] !== 'false'} onChange={(v) => set('pvp', String(v))} />
        </Row>
      </Section>

      <Section tag="GATE" title="Access">
        <Row label="Online mode" hint="OFF = cracked/TLauncher can join (whitelist forced on for safety)">
          <Lever
            on={p['online-mode'] !== 'false'}
            onChange={(v) => { if (confirm(v ? 'Require premium accounts only?' : 'Allow cracked clients? Whitelist will be forced ON.')) onlineMode.mutate(v) }}
          />
        </Row>
        <Row
          label="Whitelist"
          hint={p['online-mode'] === 'false' ? 'locked ON while cracked mode is on — otherwise anyone could join as any name' : undefined}
        >
          <Lever
            on={p['white-list'] === 'true'}
            onChange={(v) => {
              if (!v && p['online-mode'] === 'false') {
                alert('Whitelist stays ON while cracked mode is active.\n\nWithout account verification, anyone who finds the address could join using any username (including yours). Switch Online mode ON first if you want an open server.')
                return
              }
              set('white-list', String(v))
            }}
          />
        </Row>
        <Row label="Max players">
          <input type="number" className="field w-20 px-3 py-1.5 text-sm font-mono" value={p['max-players'] ?? '20'} onChange={(e) => set('max-players', e.target.value)} />
        </Row>
        <Row label="MOTD" hint="use § codes for color (e.g. §aGreen §lBold)">
          <input className="field w-72 px-3 py-1.5 text-sm" value={p['motd'] ?? ''} onChange={(e) => set('motd', e.target.value)} />
        </Row>
      </Section>

      <Section tag="ENGINE" title="World & performance">
        <Row label="View distance" hint={`${p['view-distance'] ?? 10} chunks`}>
          <input type="range" min={4} max={16} value={p['view-distance'] ?? 10} onChange={(e) => set('view-distance', e.target.value)} className="xp w-48" />
        </Row>
        <Row label="Simulation distance" hint={`${p['simulation-distance'] ?? 10} chunks`}>
          <input type="range" min={4} max={16} value={p['simulation-distance'] ?? 10} onChange={(e) => set('simulation-distance', e.target.value)} className="xp w-48" />
        </Row>
        <Row label="RAM" hint={`${ram ?? jvm?.maxGb ?? '?'} GB of memory for the server · leave room for the rest of the machine`}>
          <input type="range" min={2} max={12} value={ram ?? jvm?.maxGb ?? 6} onChange={(e) => setRam(+e.target.value)} className="xp w-48" />
        </Row>
        <Row label="Spawn protection" hint="radius nobody can build in (0 = off)">
          <input type="number" className="field w-20 px-3 py-1.5 text-sm font-mono" value={p['spawn-protection'] ?? '16'} onChange={(e) => set('spawn-protection', e.target.value)} />
        </Row>
      </Section>


      <Section tag="PORT" title="Network">
        <Row
          label="Game port"
          hint={p['server-port'] === '25565' ? 'your public relay forwards here — keep this server on 25565' : 'the port players connect to'}
        >
          <span className="font-mono text-sm font-bold">{p['server-port'] ?? '—'}</span>
        </Row>
        <Row label="RCON port" hint="how the panel & genie send commands — must be unique per server">
          <span className="font-mono text-sm font-bold">{p['rcon.port'] ?? '—'}</span>
        </Row>
        <form className="flex items-center gap-3 py-3.5 flex-wrap" onSubmit={(e) => { e.preventDefault(); submitPort() }}>
          <input
            id="new-game-port"
            aria-label="New game port"
            type="number"
            min={1024}
            max={65535}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            placeholder="new game port"
            className="field w-40 px-3 py-1.5 text-sm font-mono"
          />
          <button type="submit" disabled={!portInput || changePort.isPending} className="btn btn-block px-4 py-1.5 text-sm">
            {changePort.isPending ? 'Moving…' : portInput ? `Move → rcon ${(parseInt(portInput, 10) || 0) + RCON_OFFSET}` : 'Move'}
          </button>
          <button
            type="button"
            onClick={() => suggestPort.mutate()}
            disabled={suggestPort.isPending}
            className="text-xs font-bold text-text-dim hover:text-text"
          >
            {suggestPort.isPending ? 'finding…' : 'suggest free port'}
          </button>
        </form>
        <p className="text-xs text-text-dim max-w-[68ch]">
          Stop the server first. The rcon port follows automatically (game&nbsp;+&nbsp;{RCON_OFFSET.toLocaleString()}) and the
          query port matches the game port; a .bak of server.properties is kept.
        </p>
        {portMsg && <div role="status" className="py-2 text-sm font-semibold">{portMsg}</div>}
      </Section>

      <h2 className="text-xl pt-4">Version and upkeep</h2>
      {/* In-place version switching swaps in a Fabric launcher, so it is offered on Fabric only */}
      {active.detection.loader === 'fabric' ? (
        <VersionCard serverId={active.id} running={running} />
      ) : (
        <div className="block px-4 py-3.5">
          <div className="hud mb-1">VERSION</div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="font-extrabold">Minecraft {active.detection.mc ?? '?'}</span>
            <span className="text-xs text-text-dim">
              In-place version changes work on Fabric only. To move this {active.detection.loader} server to another version,
              create a new server on that version and move the world in.
            </span>
          </div>
        </div>
      )}
      <CleanerRow />
      {!running && <CrashSweepRow serverId={active.id} />}
      <DangerZoneRow serverId={active.id} name={active.name} running={running} />

      {(dirty || applyRestart.isPending || ((restartRequired || applied) && !restartDismissed)) && (
        <div className="save-bar fixed bottom-6 left-4 right-4 md:left-72 md:right-8 max-w-3xl block px-5 py-3.5 flex items-center gap-4 z-10">
          <span className="text-sm font-bold flex-1">
            {applyRestart.isPending
              ? 'Restarting the server…'
              : applied
                ? '✓ Restart sent — changes are going live'
                : dirty
                  ? 'Unsaved changes'
                  : 'Saved — restart to apply'}
          </span>
          {dirty && !applyRestart.isPending && (
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn btn-emerald px-5 py-2 text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
          {!dirty && restartRequired && !applied && (
            <button onClick={() => applyRestart.mutate()} disabled={applyRestart.isPending} className="btn btn-emerald px-5 py-2 text-sm">
              {applyRestart.isPending ? 'Restarting…' : 'Apply & Restart'}
            </button>
          )}
          {!dirty && !applyRestart.isPending && (
            <button
              onClick={() => setRestartDismissed(true)}
              aria-label="Dismiss — restart later"
              title="Dismiss — the change applies on the next restart"
              className="btn btn-block px-3 py-2 text-sm"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}
