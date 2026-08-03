import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pi } from '../components/PixelIcons'
import bandBedrock from '../assets/band-bedrock.png'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? `${r.status}`)
  return j as T
}

interface Summary {
  pinEnabled: boolean
  curseforgeKeySet: boolean
  vercelTokenSet: boolean
  craftyUrl: string
  craftyOk: boolean
  craftyServers: number
  autobackup: { enabled: boolean; hour: number; keep: number }
}

export default function Settings() {
  const qc = useQueryClient()
  const [pin, setPin] = useState('')
  const [cfKey, setCfKey] = useState('')
  const [vToken, setVToken] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['settings-summary'],
    queryFn: () => api<Summary>('/api/settings/summary'),
  })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (_r, body) => {
      setMsg('pin' in body ? (body.pin === null ? '✓ PIN removed' : '✓ PIN set — this browser is logged in') : '✓ saved')
      setPin(''); setCfKey(''); setVToken('')
      qc.invalidateQueries({ queryKey: ['settings-summary'] })
      qc.invalidateQueries({ queryKey: ['content-sources'] })
      setTimeout(() => setMsg(null), 6000)
    },
    onError: (e) => { setMsg(`✗ ${String(e).replace(/^Error: /, '')}`); setTimeout(() => setMsg(null), 6000) },
  })

  if (!data) return <div className="text-text-dim text-sm">mining settings…</div>

  return (
    <div className="space-y-6 pb-10">
      <div className="vista">
        <img src={bandBedrock} alt="" />
        <span className="vista-tag">Y -59 · BEDROCK</span>
      </div>
      <div>
        <h1 className="text-3xl mb-1">Settings</h1>
        <p className="text-text-dim text-sm">Panel security and integrations. Server-specific options live on Config.</p>
      </div>

      {msg && <div className="block border-emerald! px-4 py-2.5 text-sm font-semibold">{msg}</div>}

      {/* PIN gate */}
      <div className="block px-5 py-4">
        <div className="flex items-center gap-2.5 mb-1">
          <Pi i="shield" className="pi pi-s" />
          <span className="font-extrabold">PIN lock</span>
          <span className={`hud !opacity-100 ${data.pinEnabled ? 'text-emerald' : ''}`}>
            {data.pinEnabled ? 'ENABLED' : 'OFF'}
          </span>
        </div>
        <p className="text-text-dim text-xs mb-3 max-w-[70ch]">
          Locks the whole panel behind a 4-8 digit PIN. Only matters for other people on your
          Tailscale network — the PC itself always has access.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder={data.pinEnabled ? 'new PIN' : '4-8 digits'}
            inputMode="numeric"
            className="field w-36 px-3 py-2 text-sm font-mono"
          />
          <button
            onClick={() => save.mutate({ pin })}
            disabled={save.isPending || pin.length < 4}
            className="btn btn-emerald px-4 py-2 text-sm"
          >
            {data.pinEnabled ? 'Change PIN' : 'Enable PIN'}
          </button>
          {data.pinEnabled && (
            <button
              onClick={() => { if (confirm('Remove the PIN lock?')) save.mutate({ pin: null }) }}
              disabled={save.isPending}
              className="text-xs font-bold text-redstone/90 hover:text-redstone"
            >
              remove
            </button>
          )}
        </div>
      </div>

      {/* CurseForge key */}
      <div className="block px-5 py-4">
        <div className="flex items-center gap-2.5 mb-1">
          <Pi i="crate" className="pi pi-s" />
          <span className="font-extrabold">CurseForge API key</span>
          <span className={`hud !opacity-100 ${data.curseforgeKeySet ? 'text-emerald' : ''}`}>
            {data.curseforgeKeySet ? 'CONFIGURED' : 'NOT SET'}
          </span>
        </div>
        <p className="text-text-dim text-xs mb-3 max-w-[70ch]">
          Powers the CURSEFORGE source in Content (mods, modpacks, packs, shaders). Free from
          console.curseforge.com.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={cfKey}
            onChange={(e) => setCfKey(e.target.value)}
            placeholder={data.curseforgeKeySet ? 'paste new key to replace' : 'paste key'}
            type="password"
            className="field flex-1 min-w-60 px-3 py-2 text-sm font-mono"
          />
          <button
            onClick={() => save.mutate({ curseforgeApiKey: cfKey })}
            disabled={save.isPending || cfKey.trim().length < 10}
            className="btn btn-emerald px-4 py-2 text-sm"
          >
            Save key
          </button>
          {data.curseforgeKeySet && (
            <button
              onClick={() => { if (confirm('Remove the CurseForge key? The CF source disappears from Content.')) save.mutate({ curseforgeApiKey: null }) }}
              disabled={save.isPending}
              className="text-xs font-bold text-redstone/90 hover:text-redstone"
            >
              remove
            </button>
          )}
        </div>
      </div>

      {/* Vercel token — powers automatic <name>.<your-domain> addresses */}
      <div className="block px-5 py-4">
        <div className="flex items-center gap-2.5 mb-1">
          <Pi i="crate" className="pi pi-s" />
          <span className="font-extrabold">Vercel API token</span>
          <span className={`hud !opacity-100 ${data.vercelTokenSet ? 'text-emerald' : ''}`}>
            {data.vercelTokenSet ? 'CONFIGURED' : 'NOT SET'}
          </span>
        </div>
        <p className="text-text-dim text-xs mb-3 max-w-[70ch]">
          Lets new servers get a portless <span className="font-mono">name.your-domain</span> address
          automatically (SRV record on Vercel DNS). Create one at vercel.com → Account Settings → Tokens.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={vToken}
            onChange={(e) => setVToken(e.target.value)}
            placeholder={data.vercelTokenSet ? 'paste new token to replace' : 'paste token'}
            type="password"
            className="field flex-1 min-w-60 px-3 py-2 text-sm font-mono"
          />
          <button
            onClick={() => save.mutate({ vercelToken: vToken })}
            disabled={save.isPending || vToken.trim().length < 10}
            className="btn btn-emerald px-4 py-2 text-sm"
          >
            Save token
          </button>
          {data.vercelTokenSet && (
            <button
              onClick={() => { if (confirm('Remove the Vercel token? New servers fall back to host:<port> addresses.')) save.mutate({ vercelToken: null }) }}
              disabled={save.isPending}
              className="text-xs font-bold text-redstone/90 hover:text-redstone"
            >
              remove
            </button>
          )}
        </div>
      </div>

      {/* Crafty connection */}
      <div className="block px-5 py-4">
        <div className="flex items-center gap-2.5 mb-1">
          <Pi i="anvil" className="pi pi-s" />
          <span className="font-extrabold">Crafty Controller</span>
          <span className={`lamp ${data.craftyOk ? 'lamp-on' : 'lamp-crash'}`} />
          <span className={`hud !opacity-100 ${data.craftyOk ? 'text-emerald' : 'text-redstone'}`}>
            {data.craftyOk ? `CONNECTED · ${data.craftyServers} SERVERS` : 'UNREACHABLE'}
          </span>
        </div>
        <p className="text-text-dim text-xs mb-3">
          {data.craftyUrl} — the panel drives everything through Crafty's API with a scoped token.
        </p>
        <button onClick={() => refetch()} disabled={isFetching} className="btn btn-block px-4 py-2 text-sm">
          {isFetching ? 'testing…' : 'Test connection'}
        </button>
      </div>
    </div>
  )
}
