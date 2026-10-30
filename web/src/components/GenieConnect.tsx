import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pi } from './PixelIcons'

// The genie's AI account: live status, one-click Claude subscription connect
// (the panel runs `claude setup-token` and keeps the token), or a pasted
// token / API key. Secrets go in, only status comes back out.

export interface GenieCredential {
  kind: 'subscription' | 'api-key' | 'local-login' | 'none'
  state: 'connected' | 'expired' | 'invalid' | 'rate-limited' | 'unavailable' | 'untested'
  detail: string
  checkedAt: string | null
  connectedAt: string | null
  usage: { window: string; percent: number; resetsAt: string }[] | null
  connectSupported: boolean
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `request failed (${r.status})`)
  return j as T
}

const KIND: Record<GenieCredential['kind'], string> = {
  subscription: 'Claude subscription',
  'api-key': 'Anthropic API key',
  'local-login': "this computer's Claude Code login",
  none: 'nothing connected',
}
const STATE: Record<GenieCredential['state'], { label: string; tone: string }> = {
  connected: { label: 'CONNECTED', tone: 'text-emerald' },
  expired: { label: 'EXPIRED', tone: 'text-redstone' },
  invalid: { label: 'REJECTED', tone: 'text-redstone' },
  'rate-limited': { label: 'LIMIT REACHED', tone: 'text-gold' },
  unavailable: { label: 'UNREACHABLE', tone: 'text-gold' },
  untested: { label: 'NOT CHECKED', tone: '' },
}

const when = (iso: string) => {
  const d = new Date(iso)
  const mins = Math.round((d.getTime() - Date.now()) / 60_000)
  if (mins > 0 && mins < 90) return `in ${mins} min`
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export default function GenieConnect() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['genie-credential'],
    queryFn: () => call<GenieCredential>('/api/genie/credential'),
    // a fresh save is tested in the background; poll until the verdict lands
    refetchInterval: (q) => (q.state.data?.state === 'untested' && q.state.data.kind !== 'none' ? 2000 : 60_000),
  })
  const [url, setUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [paste, setPaste] = useState(false)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    setErr('')
    try {
      const r = await fn()
      if (r && typeof r === 'object' && 'kind' in r) qc.setQueryData(['genie-credential'], r)
      else await qc.invalidateQueries({ queryKey: ['genie-credential'] })
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const start = () => run('start', async () => {
    const r = await call<{ url: string }>('/api/genie/connect/start', 'POST', {})
    setUrl(r.url)
    window.open(r.url, '_blank', 'noopener')
  })
  const finish = () => run('finish', async () => {
    const r = await call<GenieCredential>('/api/genie/connect/finish', 'POST', { code: code.trim() })
    setUrl(null)
    setCode('')
    return r
  })
  const save = () => run('save', async () => {
    const r = await call<GenieCredential>('/api/genie/credential', 'PUT', { value: secret.trim() })
    setSecret('')
    setPaste(false)
    return r
  })

  if (!data) return null
  const st = STATE[data.state]
  const linked = data.kind !== 'none'
  const checking = busy === 'test' || (data.state === 'untested' && linked)

  return (
    <div className="block px-5 py-4">
      <div className="flex items-center gap-2.5 mb-1 flex-wrap">
        <Pi i="bolt" className="pi pi-s" />
        <h2 className="font-extrabold">Genie AI account</h2>
        <span role="status" className={`hud !opacity-100 ${linked ? st.tone : ''}`}>
          {!linked ? 'NOT CONNECTED' : checking ? 'CHECKING…' : st.label}
        </span>
      </div>
      <p className="text-text-dim text-sm mb-3 max-w-[70ch]">
        {linked
          ? <>Using {KIND[data.kind]}. {checking ? 'Sending a test message…' : data.detail}</>
          : <>The in-game genie needs an AI account. Connect the Claude Pro or Max subscription you already pay for; there is nothing extra to buy.</>}
        {data.kind === 'subscription' && data.connectedAt && (
          <> Connected {new Date(data.connectedAt).toLocaleDateString()}, renew by {new Date(new Date(data.connectedAt).getTime() + 365 * 86_400_000).toLocaleDateString()}.</>
        )}
      </p>

      {data.usage && data.usage.length > 0 && (
        <div className="flex gap-5 flex-wrap mb-3" aria-label="Subscription usage">
          {data.usage.map((u) => (
            <div key={u.window} className="text-xs min-w-40">
              <div className="flex justify-between mb-1"><span className="font-bold">{u.window} limit</span><span>{u.percent}%</span></div>
              <div className="h-1.5 bg-bedrock" role="meter" aria-valuenow={u.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${u.window} limit used`}>
                <div className={`h-full ${u.percent >= 90 ? 'bg-redstone' : u.percent >= 75 ? 'bg-gold' : 'bg-emerald'}`} style={{ width: `${Math.min(100, u.percent)}%` }} />
              </div>
              <div className="text-text-dim mt-1">resets {when(u.resetsAt)}</div>
            </div>
          ))}
        </div>
      )}

      {url ? (
        <div className="space-y-2">
          <p className="text-sm max-w-[70ch]">
            A Claude sign-in page opened in a new tab (<a href={url} target="_blank" rel="noopener noreferrer" className="underline">open it again</a>).
            Approve access, then paste the code it shows here.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste the code from the Claude page"
              aria-label="Code from the Claude page" autoFocus spellCheck={false} autoComplete="off"
              className="field flex-1 min-w-60 px-3 py-2 text-sm font-mono" onKeyDown={(e) => { if (e.key === 'Enter' && code.trim().length >= 10) finish() }} />
            <button onClick={finish} disabled={!!busy || code.trim().length < 10} className="btn btn-emerald px-4 py-2 text-sm">
              {busy === 'finish' ? 'connecting…' : 'Finish'}
            </button>
            <button onClick={() => { setUrl(null); setCode(''); call('/api/genie/connect/cancel', 'POST', {}).catch(() => {}) }} className="text-xs font-bold text-text-dim hover:text-text">cancel</button>
          </div>
        </div>
      ) : paste ? (
        <div className="flex items-center gap-3 flex-wrap">
          <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" autoFocus autoComplete="off"
            placeholder="sk-ant-… token or API key" aria-label="Claude token or Anthropic API key"
            className="field flex-1 min-w-60 px-3 py-2 text-sm font-mono" onKeyDown={(e) => { if (e.key === 'Enter' && secret.trim().length >= 20) save() }} />
          <button onClick={save} disabled={!!busy || secret.trim().length < 20} className="btn btn-emerald px-4 py-2 text-sm">
            {busy === 'save' ? 'checking…' : 'Save and test'}
          </button>
          <button onClick={() => { setPaste(false); setSecret('') }} className="text-xs font-bold text-text-dim hover:text-text">cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
          {data.connectSupported && (
            <button onClick={start} disabled={!!busy} className={`btn px-4 py-2 text-sm ${linked && data.state === 'connected' ? 'btn-block' : 'btn-emerald'}`}>
              {busy === 'start' ? 'opening Claude…' : linked && data.kind === 'subscription' ? 'Reconnect Claude' : 'Connect Claude subscription'}
            </button>
          )}
          <button onClick={() => setPaste(true)} className="btn btn-block px-4 py-2 text-sm">
            {data.connectSupported ? 'Paste a token or API key' : 'Paste a Claude token or API key'}
          </button>
          {linked && (
            <button onClick={() => run('test', () => call('/api/genie/credential/test', 'POST', {}))} disabled={!!busy} className="btn btn-block px-4 py-2 text-sm">
              {busy === 'test' ? 'testing…' : 'Test'}
            </button>
          )}
          {(data.kind === 'subscription' || data.kind === 'api-key') && (
            <button onClick={() => { if (confirm('Disconnect the genie from this AI account?')) run('remove', () => call('/api/genie/credential', 'PUT', { value: null })) }}
              disabled={!!busy} className="text-xs font-bold text-redstone/90 hover:text-redstone">disconnect</button>
          )}
        </div>
      )}
      {!data.connectSupported && !url && (
        <p className="text-text-dim text-xs mt-2 max-w-[70ch]">Run <span className="font-mono">claude setup-token</span> on any computer with Claude Code, then paste the token it prints.</p>
      )}
      {err && <p role="alert" className="text-sm mt-2 text-redstone">{err}</p>}
    </div>
  )
}
