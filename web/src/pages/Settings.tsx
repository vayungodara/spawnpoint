import { useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pi } from '../components/PixelIcons'
import { copyText } from '../components/status'
import GenieConnect from '../components/GenieConnect'
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
  craftyConnected?: boolean
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
      <div className="flex flex-wrap items-center gap-2.5 mb-1">
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

type Scope = 'read' | 'control' | 'approve'
interface ApiToken { id: string; name: string; scope: Scope; created: string; lastUsed?: string }
const SCOPE_HELP: Record<Scope, string> = {
  read: 'status, players, mods, logs and test results',
  control: 'also start, stop, console commands, files and staging mod changes',
  approve: 'also approve mod changes, undo and world restore, as you',
}
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never')

/** Scoped, revocable tokens for the spawnpoint CLI and coding agents. */
function ApiTokens() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<Scope>('read')
  const [sure, setSure] = useState(false)
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const { data } = useQuery({ queryKey: ['api-tokens'], queryFn: () => api<{ tokens: ApiToken[] }>('/api/tokens') })
  const create = useMutation({
    mutationFn: () => api<{ token: string; info: ApiToken }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name: name.trim(), scope, confirmApprove: scope === 'approve' && sure }) }),
    onSuccess: (r) => { setFresh({ token: r.token, name: r.info.name }); setCopied(false); setName(''); setSure(false); qc.invalidateQueries({ queryKey: ['api-tokens'] }) },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  })
  const tokens = data?.tokens ?? []
  return (
    <div className="block px-5 py-4">
      <div className="flex items-center gap-2.5 mb-1">
        <Pi i="shield" className="pi pi-s" />
        <h2 className="font-extrabold">API tokens</h2>
        <span className="hud !opacity-100">{tokens.length ? `${tokens.length} ACTIVE` : 'NONE'}</span>
      </div>
      <p className="text-text-dim text-xs mb-3 max-w-[70ch]">
        For the <span className="font-mono">spawnpoint</span> CLI on another machine or a coding agent. Give each one the lowest scope it needs.
        On this machine the CLI uses the admin token by itself.
      </p>
      {fresh && (
        <div className="field px-3 py-3 mb-3 space-y-2" role="status">
          <p className="text-sm font-bold">Token for {fresh.name}. Copy it now: it is not shown again.</p>
          <div className="flex gap-2 flex-wrap items-center">
            <code className="font-mono text-xs break-all flex-1 min-w-60">{fresh.token}</code>
            <button className="btn btn-emerald px-3 py-1.5 text-sm" onClick={() => copyText(fresh.token).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="btn btn-block px-3 py-1.5 text-sm" onClick={() => setFresh(null)}>Done</button>
          </div>
          <p className="text-xs text-text-dim">On the other machine: <span className="font-mono">spawnpoint login --url {location.origin}</span>, then paste it.</p>
        </div>
      )}
      {tokens.length > 0 && (
        <ul className="mb-3 divide-y divide-ink/30">
          {tokens.map((t) => (
            <li key={t.id} className="py-2 flex items-center gap-3 flex-wrap text-sm">
              <span className="font-bold min-w-0 truncate">{t.name}</span>
              <span className={`hud !opacity-100 ${t.scope === 'approve' ? 'text-gold' : t.scope === 'control' ? 'text-sky' : ''}`}>{t.scope.toUpperCase()}</span>
              <span className="text-xs text-text-dim">created {when(t.created)} · last used {when(t.lastUsed)}</span>
              <button className="ml-auto text-xs font-bold text-redstone/90 hover:text-redstone" disabled={revoke.isPending} aria-label={`Revoke ${t.name}`}
                onClick={() => { if (confirm(`Revoke ${t.name}? Anything using it stops working at once.`)) revoke.mutate(t.id) }}>revoke</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="name, e.g. laptop agent" aria-label="Token name" className="field flex-1 min-w-48 px-3 py-2 text-sm" />
        <div className="flex gap-2" role="group" aria-label="Token scope">
          {(['read', 'control', 'approve'] as const).map((s) => (
            <button key={s} aria-pressed={scope === s} onClick={() => { setScope(s); setSure(false) }}
              className={`btn px-3 py-2 text-sm ${scope === s ? 'btn-emerald' : 'btn-block'}`}>{s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
        <button onClick={() => create.mutate()} disabled={create.isPending || !name.trim() || (scope === 'approve' && !sure)} className="btn btn-emerald px-4 py-2 text-sm">Create token</button>
      </div>
      <p className="text-text-dim text-xs mt-2 max-w-[70ch]">{scope[0].toUpperCase() + scope.slice(1)}: {SCOPE_HELP[scope]}.
        {scope !== 'read' && ' Mods are code, so this token can run code on this machine: give it only to agents you would trust with a shell.'}</p>
      {scope === 'approve' && (
        <label className="flex items-start gap-2.5 text-sm mt-2 max-w-[70ch]">
          <input className="mt-1" type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>Approvals made with this token count as mine, including test gaps I would otherwise review. Hash checks still cannot be waived.</span>
        </label>
      )}
      {create.error && <p role="alert" className="text-sm text-redstone font-semibold mt-2">{create.error.message}</p>}
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
        <p className="text-text-dim text-sm">Panel security and integrations. Options for one server live in that server’s Server tab.</p>
      </div>

      {msg && <div className="block border-emerald! px-4 py-2.5 text-sm font-semibold">{msg}</div>}

      <RuntimeCard connected={!!data.craftyConnected} craftyUrl={data.craftyUrl} />

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

      <ApiTokens />

      <KeyBlock
        icon="crate"
        title="CurseForge API key"
        isSet={data.curseforgeKeySet}
        help="Adds the CurseForge catalog to Mods (mods, modpacks, resource packs, shaders). Free from console.curseforge.com."
        placeholder="paste key"
        onSave={(v) => save.mutate({ curseforgeApiKey: v })}
        onRemove={() => save.mutate({ curseforgeApiKey: null })}
        busy={save.isPending}
      />

      <GenieConnect />

      {/* Crafty connection */}
      <div className="block px-5 py-4">
        <div className="flex flex-wrap items-center gap-2.5 mb-1">
          <Pi i="anvil" className="pi pi-s" />
          <span className="font-extrabold">Crafty Controller</span>
          <span className={`hud !opacity-100 ${data.craftyOk ? 'text-emerald' : 'text-redstone'}`}>
            {data.craftyOk ? `CONNECTED · ${data.craftyServers} SERVERS` : 'UNREACHABLE'}
          </span>
        </div>
        <p className="text-text-dim text-xs mb-3">
          {data.craftyUrl} — the legacy adapter manages only servers not yet imported into Spawnpoint.
        </p>
        <button onClick={() => refetch()} disabled={isFetching} className="btn btn-block px-4 py-2 text-sm">
          {isFetching ? 'testing…' : 'Test connection'}
        </button>
      </div>
    </div>
  )
}

/** Which runtime lists and builds servers. Crafty needs a working connection,
    so choosing it without one opens the API-key form instead of failing. */
function RuntimeCard({ connected, craftyUrl }: { connected: boolean; craftyUrl: string }) {
  const qc = useQueryClient()
  const { data: runtime } = useQuery({
    queryKey: ['runtime'],
    queryFn: () => api<{ mode: 'crafty' | 'standalone'; supervisor: boolean }>('/api/runtime'),
    refetchInterval: 10_000,
  })
  const [form, setForm] = useState(false)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const setRuntime = useMutation({
    mutationFn: (mode: 'crafty' | 'standalone') => api('/api/runtime', { method: 'POST', body: JSON.stringify({ mode }) }),
    onSuccess: () => { setForm(false); qc.invalidateQueries() },
  })
  const connect = useMutation({
    mutationFn: () => api<{ servers: number }>('/api/runtime/crafty', { method: 'POST', body: JSON.stringify({ token: key.trim(), url: url.trim() || undefined }) }),
    onSuccess: () => { setForm(false); setKey(''); qc.invalidateQueries() },
  })
  const mode = runtime?.mode
  const busy = setRuntime.isPending || connect.isPending
  const err = (setRuntime.error ?? connect.error)?.message.replace(/^\d+: /, '')
  const tile = (on: boolean) => `btn px-4 py-3 text-left flex flex-col gap-1 ${on ? 'btn-emerald' : 'btn-block'}`
  return (
    <div className="block px-5 py-4">
      <div className="flex items-center gap-2.5 mb-2 flex-wrap">
        <Pi i="anvil" className="pi pi-s" />
        <h2 className="font-extrabold">Server runtime</h2>
        <span className="hud !opacity-100">{runtime?.supervisor ? 'SUPERVISOR CONNECTED' : 'SUPERVISOR OFFLINE'}</span>
      </div>
      <p className="text-text-dim text-sm mb-3 max-w-[70ch]">Choose what lists and builds your servers. Switching never stops or moves a server, and you can switch back at any time.</p>
      <div className="grid sm:grid-cols-2 gap-3" role="group" aria-label="Server runtime">
        <button className={tile(mode === 'standalone')} aria-pressed={mode === 'standalone'} disabled={busy || !runtime?.supervisor}
          onClick={() => setRuntime.mutate('standalone')}>
          <b>Spawnpoint service{mode === 'standalone' ? ' · in use' : ''}</b>
          <span className="text-xs font-semibold opacity-80">Runs your servers itself and keeps them going while the panel restarts. Recommended.{!runtime?.supervisor ? ' The service is offline right now.' : ''}</span>
        </button>
        <button className={tile(mode === 'crafty')} aria-pressed={mode === 'crafty'} disabled={busy}
          onClick={() => (connected ? setRuntime.mutate('crafty') : setForm(true))}>
          <b>Crafty Controller{mode === 'crafty' ? (connected ? ' · in use' : ' · not connected') : ''}</b>
          <span className="text-xs font-semibold opacity-80">Also shows servers that still live in Crafty and builds new ones there. {connected ? 'Connected.' : 'Needs a Crafty API key.'}</span>
        </button>
      </div>
      {connected && !form && (
        <button onClick={() => setForm(true)} className="text-xs underline underline-offset-2 text-text-dim hover:text-text mt-3">Update Crafty connection</button>
      )}
      {form && (
        <div className="mt-4 space-y-2 max-w-md rise-in">
          <p className="text-sm text-text-dim">In Crafty, open your user's <b className="text-text">API Keys</b> page, create a key and paste it here. A non-admin account that only sees these servers is safest.</p>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={craftyUrl} aria-label="Crafty address" className="field w-full px-3 py-2 text-sm" autoComplete="off" />
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="Crafty API key" aria-label="Crafty API key" className="field w-full px-3 py-2 text-sm font-mono" autoComplete="off" autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && key.trim() && !busy) connect.mutate() }} />
          <div className="flex gap-3">
            <button onClick={() => connect.mutate()} disabled={!key.trim() || busy} className="btn btn-emerald px-4 py-2 text-sm">{connect.isPending ? 'Connecting…' : 'Connect and use Crafty'}</button>
            <button onClick={() => { setForm(false); connect.reset() }} className="btn btn-block px-4 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}
      {err && <p role="alert" className="text-sm text-redstone font-semibold mt-3 pop-in">{err}</p>}
      <p className="text-text-dim text-xs mt-3 max-w-[70ch]">Imported servers always stay with Spawnpoint. Move a Crafty server into Spawnpoint from its Server tab → Runtime.</p>
    </div>
  )
}
