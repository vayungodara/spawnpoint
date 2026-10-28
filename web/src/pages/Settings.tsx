import { useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pi } from '../components/PixelIcons'
import bandBedrock from '../assets/band-bedrock.webp'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? `${r.status}`)
  return j as T
}

interface Summary {
  curseforgeKeySet: boolean
  anthropicKeySet: boolean
  craftyUrl: string
  craftyOk: boolean
  craftyServers: number
}

/** One secret in Settings: status, a paste field, save and remove. */
function KeyBlock({ icon, title, isSet, help, placeholder, onSave, onRemove, busy }: {
  icon: string
  title: string
  isSet: boolean
  help: ReactNode
  placeholder: string
  onSave: (v: string) => void
  onRemove: () => void
  busy: boolean
}) {
  const [v, setV] = useState('')
  return (
    <div className="block px-5 py-4">
      <div className="flex items-center gap-2.5 mb-1">
        <Pi i={icon} className="pi pi-s" />
        <span className="font-extrabold">{title}</span>
        <span className={`hud !opacity-100 ${isSet ? 'text-emerald' : ''}`}>{isSet ? 'CONFIGURED' : 'NOT SET'}</span>
      </div>
      <p className="text-text-dim text-xs mb-3 max-w-[70ch]">{help}</p>
      <div className="flex items-center gap-3 flex-wrap">
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder={isSet ? 'paste a new one to replace' : placeholder}
          type="password"
          className="field flex-1 min-w-60 px-3 py-2 text-sm font-mono"
        />
        <button onClick={() => { onSave(v.trim()); setV('') }} disabled={busy || v.trim().length < 10} className="btn btn-emerald px-4 py-2 text-sm">
          Save
        </button>
        {isSet && (
          <button onClick={() => { if (confirm(`Remove the ${title}?`)) onRemove() }} disabled={busy} className="text-xs font-bold text-redstone/90 hover:text-redstone">
            remove
          </button>
        )}
      </div>
    </div>
  )
}

export default function Settings() {
  const qc = useQueryClient()
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['settings-summary'],
    queryFn: () => api<Summary>('/api/settings/summary'),
  })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (_r, body) => {
      setMsg('pin' in body ? '✓ PIN changed. Other browsers must sign in again.' : '✓ saved')
      setPin('')
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

      <div className="block px-5 py-4">
        <div className="flex items-center gap-2.5 mb-1">
          <Pi i="shield" className="pi pi-s" />
          <span className="font-extrabold">PIN</span>
        </div>
        <p className="text-text-dim text-xs mb-3 max-w-[70ch]">
          Every browser needs the PIN once every 30 days. Changing it signs out every other browser.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
            placeholder="new PIN (6–12 digits)"
            inputMode="numeric"
            type="password"
            className="field w-56 px-3 py-2 text-sm font-mono"
          />
          <button onClick={() => save.mutate({ pin })} disabled={save.isPending || pin.length < 6} className="btn btn-emerald px-4 py-2 text-sm">
            Change PIN
          </button>
        </div>
      </div>

      <KeyBlock
        icon="crate"
        title="CurseForge API key"
        isSet={data.curseforgeKeySet}
        help="Adds the CurseForge catalog to Content (mods, modpacks, resource packs, shaders). Free from console.curseforge.com."
        placeholder="paste key"
        onSave={(v) => save.mutate({ curseforgeApiKey: v })}
        onRemove={() => save.mutate({ curseforgeApiKey: null })}
        busy={save.isPending}
      />

      <KeyBlock
        icon="bolt"
        title="Genie credential"
        isSet={data.anthropicKeySet}
        help={<>The in-game genie runs Claude Code with this: a Claude token (run <span className="font-mono">claude setup-token</span> anywhere Claude Code is installed) or an Anthropic API key.</>}
        placeholder="Claude token or Anthropic API key"
        onSave={(v) => save.mutate({ anthropicApiKey: v })}
        onRemove={() => save.mutate({ anthropicApiKey: null })}
        busy={save.isPending}
      />

      {/* Crafty connection */}
      <div className="block px-5 py-4">
        <div className="flex items-center gap-2.5 mb-1">
          <Pi i="anvil" className="pi pi-s" />
          <span className="font-extrabold">Crafty Controller</span>
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
