import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useServers } from '../api'
import bandVault from '../assets/band-vault.png'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json() as Promise<T>
}

interface BackupInfo { file: string; sizeMb: number; createdAt: string; slot?: number; restorable?: boolean }
interface AutoBackupCfg { enabled: boolean; hour: number; keep: number }

// nightly automatic backups, storage-light: only worlds that changed since
// their newest backup get zipped, and only the newest N zips are kept
function AutoBackupRow() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['autobackup'],
    queryFn: () => api<AutoBackupCfg>('/api/autobackup'),
  })
  const set = useMutation({
    mutationFn: (cfg: Partial<AutoBackupCfg>) =>
      api('/api/autobackup', { method: 'PUT', body: JSON.stringify(cfg) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['autobackup'] }),
  })
  if (!data) return null
  return (
    <div className="block px-4 py-3 flex items-center gap-4 flex-wrap">
      <button
        className="lever"
        data-on={data.enabled}
        disabled={set.isPending}
        onClick={() => set.mutate({ enabled: !data.enabled })}
        aria-label="Toggle automatic backups"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold">Automatic nightly backups <span className="hud">ALL SERVERS</span></div>
        <div className="text-text-dim text-xs mt-0.5">
          {data.enabled
            ? `every night at ${String(data.hour).padStart(2, '0')}:00 — skips worlds nobody touched, keeps the newest ${data.keep} per server`
            : 'off — only manual backups are made'}
        </div>
      </div>
      {data.enabled && (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className="hud">AT</span>
            <input
              type="number" min={0} max={23} value={data.hour}
              onChange={(e) => set.mutate({ hour: Number(e.target.value) })}
              className="field w-14 px-2 py-1.5 text-sm font-mono text-center"
            />
            <span className="hud">:00</span>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="hud">KEEP</span>
            <input
              type="number" min={1} max={10} value={data.keep}
              onChange={(e) => set.mutate({ keep: Number(e.target.value) })}
              className="field w-14 px-2 py-1.5 text-sm font-mono text-center"
            />
          </label>
        </div>
      )}
    </div>
  )
}

export default function Backups() {
  const { data: serversData } = useServers()
  const active = serversData?.servers.find((s) => s.active)
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)
  const note = (m: string, ms = 8000) => { setMsg(m); setTimeout(() => setMsg(null), ms) }

  const { data } = useQuery({
    queryKey: ['backups', active?.id],
    queryFn: () => api<{ backups: BackupInfo[] }>(`/api/servers/${active?.id}/backups`),
    enabled: !!active,
  })

  const create = useMutation({
    mutationFn: () => api<BackupInfo | { error: string }>(`/api/servers/${active?.id}/backups`, { method: 'POST', body: '{}' }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['backups', active?.id] })
      note('error' in r ? `✗ ${r.error}` : `✓ Backup created: ${r.file} (${r.sizeMb} MB)`)
    },
    onError: (e) => note(`✗ ${String(e)}`),
  })

  const restore = useMutation({
    mutationFn: (file: string) =>
      api<{ ok: boolean; error?: string }>(`/api/servers/${active?.id}/backups/restore`, {
        method: 'POST',
        body: JSON.stringify({ file }),
      }),
    onSuccess: (r) => note(r.ok ? '✓ World restored — server restarting' : `✗ ${r.error}`, 10000),
    onError: (e) => note(`✗ ${String(e)}`),
  })

  const del = useMutation({
    mutationFn: (file: string) =>
      api(`/api/servers/${active?.id}/backups?file=${encodeURIComponent(file)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups', active?.id] }),
  })

  if (!active)
    return (
      <div>
        <div className="hud mb-3">Y -50 · VAULT</div>
        <p className="text-text-dim">No active server — pick one on the Servers page.</p>
      </div>
    )

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <div className="vista mb-6">
          <img src={bandVault} alt="" />
          <span className="vista-tag">Y -50 · VAULT</span>
        </div>
        <h1 className="text-3xl">Backups — {active.name}</h1>
        <p className="text-text-dim text-sm mt-1 max-w-[68ch]">
          Snapshots of the world folder (terrain + players + everything). Newest 10 are kept.
          Safe while the server runs — chunks are flushed first.
        </p>
      </div>

      {msg && <div className="block border-emerald! px-4 py-2.5 text-sm font-semibold">{msg}</div>}

      <AutoBackupRow />

      <button
        onClick={() => create.mutate()}
        disabled={create.isPending}
        className="btn btn-emerald px-5 py-2.5 text-sm"
      >
        {create.isPending ? 'Backing up… (can take a minute)' : 'Create backup now'}
      </button>

      <div className="space-y-2.5">
        {(data?.backups ?? []).map((b) => (
          <div key={b.file} className="block flex items-center gap-4 px-4 py-3">
            <div className="flex-1 min-w-0">
              <div className="font-bold font-mono text-sm truncate">
                {b.file}
                {b.slot !== undefined && <span className="hud ml-2">WORLD {b.slot} — ARCHIVE</span>}
              </div>
              <div className="text-xs text-text-dim">
                {new Date(b.createdAt).toLocaleString()} · {b.sizeMb} MB
                {b.slot !== undefined && ' · a reset world slot, kept forever — switch to that slot to play it'}
              </div>
            </div>
            {b.restorable !== false && (
              <button
                onClick={() => {
                  if (confirm(`Restore ${b.file}?\n\nThe CURRENT world will be replaced (server restarts). This cannot be undone unless you back up first.`))
                    restore.mutate(b.file)
                }}
                disabled={restore.isPending}
                className="btn btn-block px-3 py-1.5 text-xs"
              >
                {restore.isPending ? 'restoring…' : 'Restore'}
              </button>
            )}
            <button
              onClick={() => { if (confirm(`Delete backup ${b.file}?`)) del.mutate(b.file) }}
              className="text-xs font-bold text-redstone/90 hover:text-redstone"
            >
              delete
            </button>
          </div>
        ))}
        {data?.backups.length === 0 && (
          <div className="text-text-dim text-sm">No backups yet — make your first one above.</div>
        )}
      </div>
    </div>
  )
}
