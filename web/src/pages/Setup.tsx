import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PixelDefs, Pi } from '../components/PixelIcons'

// FIRST-RUN WIZARD, shown until the panel has a runtime and a PIN (see
// server/src/routes/wizardRoutes.ts). Three steps: connect an owner, set a
// PIN, optional keys. Both required steps need the setup code the installer
// printed; its link (/setup#code=…) fills it in.

type WizardStatus = {
  active: boolean
  runtime?: 'crafty' | 'standalone'
  craftyUrl?: string
  craftyReachable?: boolean
  hasJdk?: boolean
  craftyConnected?: boolean
  pinSet?: boolean
  claude?: { installed: boolean }
}

const put = (body: Record<string, unknown>) =>
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export default function Setup() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data: wiz, isLoading } = useQuery({
    queryKey: ['wizard'],
    queryFn: async () => (await (await fetch('/api/wizard/status')).json()) as WizardStatus,
    staleTime: 30_000,
  })

  const [stepPicked, setStep] = useState<number | null>(null)
  // a reload after connecting an owner resumes at the PIN step
  const step = stepPicked ?? (wiz?.craftyConnected || wiz?.runtime === 'standalone' ? 1 : 0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // step 0 — crafty. API key is the recommended path (the panel then never
  // holds anything that can unlock the superuser); one-time login is fallback.
  const [mode, setMode] = useState<'standalone' | 'key' | 'login'>('standalone')
  const [apiKey, setApiKey] = useState('')
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [code, setCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('code')?.toUpperCase() ?? '')
  const [serverCount, setServerCount] = useState<number | null>(null)

  // step 1 — pin
  const [pin, setPin] = useState('')

  // step 2 — optional keys
  const [cfKey, setCfKey] = useState('')
  const [aiKey, setAiKey] = useState('')

  if (isLoading) return null
  if (!wiz?.active && serverCount === null) return <Navigate to="/" replace />

  const connect = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await fetch(mode === 'standalone' ? '/api/wizard/standalone' : '/api/wizard/crafty-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          mode === 'standalone' ? { code } : mode === 'key'
            ? { token: apiKey.trim(), url: url || undefined, code }
            : { username: user, password: pass, url: url || undefined, code },
        ),
      })
      const j = await r.json()
      if (!r.ok) { setErr(j.error ?? `Crafty connect failed (${r.status})`); return }
      setServerCount(j.servers ?? 0)
      setStep(1)
    } catch {
      setErr('the panel could not be reached — is it still running?')
    } finally {
      setBusy(false)
    }
  }

  const savePin = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await fetch('/api/wizard/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, code }),
      })
      if (!r.ok) {
        setErr(await r.json().then((j) => j.error).catch(() => null) ?? 'could not save the PIN')
        return
      }
      setStep(2)
    } catch {
      setErr('the panel stopped responding — is it still running?')
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    setBusy(true)
    setErr('')
    try {
      if (cfKey || aiKey) {
        // setting the PIN signed this browser in, so the normal settings route works
        const r = await put({
          ...(cfKey ? { curseforgeApiKey: cfKey } : {}),
          ...(aiKey ? { anthropicApiKey: aiKey } : {}),
        })
        if (!r.ok) { setErr('could not save the keys — you can add them later in Settings'); return }
      }
      await qc.invalidateQueries()
      nav('/', { replace: true })
    } catch {
      setErr('the panel stopped responding — is it still running?')
    } finally {
      setBusy(false)
    }
  }

  const stepTag = ['STEP 1 / 3 · CHOOSE RUNTIME', 'STEP 2 / 3 · LOCK THE PANEL', 'STEP 3 / 3 · OPTIONAL EXTRAS'][step]

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--color-bedrock)', backgroundImage: 'var(--noise-dense)' }}>
      <PixelDefs />
      <div className="block bg-block p-8 w-full max-w-md">
        <div className="flex items-center justify-center gap-2.5 mb-1.5">
          <Pi i="flag" className="pi pi-l" />
          <span className="font-px text-[15px] tracking-[0.04em] font-bold">SPAWNPOINT</span>
        </div>
        <div className="hud mb-6 justify-center">{stepTag}</div>

        {step === 0 && (
          <>
            <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Server runtime">
              <button className={`btn px-3 py-2 text-sm ${mode === 'standalone' ? 'btn-emerald' : 'btn-block'}`} aria-pressed={mode === 'standalone'}
                disabled={busy} onClick={() => { setMode('standalone'); setErr('') }}>Spawnpoint</button>
              <button className={`btn px-3 py-2 text-sm ${mode !== 'standalone' ? 'btn-emerald' : 'btn-block'}`} aria-pressed={mode !== 'standalone'}
                disabled={busy} onClick={() => { setMode('key'); setErr('') }}>Crafty Controller</button>
            </div>
            {mode === 'standalone' ? <p className="text-sm opacity-85 mb-4">
              Use the independent Spawnpoint supervisor. It keeps Java and the console running when
              the panel restarts. Install its OS service first; no Crafty account is required.
            </p> : <>
            {mode === 'key' ? (
              <p className="text-sm opacity-85 mb-4">
                In Crafty, open your user's <strong>API Keys</strong> page, create a key, and paste it
                here. Best from a <strong>dedicated non-superuser account</strong> that can only see the
                servers this panel should manage — the panel then never holds anything that could
                unlock your admin account.
              </p>
            ) : (
              <p className="text-sm opacity-85 mb-4">
                Log in with your <strong>Crafty admin account</strong> once. The panel mints its own
                API access from it and never stores the password.
              </p>
            )}
            {wiz?.craftyReachable === false && (
              <p className="font-px text-[10px] text-gold mb-3">
                NOTHING IS ANSWERING AT {(wiz.craftyUrl ?? '').toUpperCase()} — START CRAFTY FIRST, OR CHANGE THE ADDRESS BELOW
              </p>
            )}
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={wiz?.craftyUrl ?? 'https://localhost:8443'}
              className="field w-full px-3 py-2.5 mb-2 text-sm"
              autoComplete="off"
            />
            {mode === 'key' ? (
              <input
                value={apiKey}
                onChange={(e) => { setErr(''); setApiKey(e.target.value) }}
                onKeyDown={(e) => { if (e.key === 'Enter' && apiKey.trim() && !busy) connect() }}
                type="password"
                placeholder="Crafty API key"
                className="field w-full px-3 py-2.5 text-sm font-mono"
                autoComplete="off"
                autoFocus
              />
            ) : (
              <>
                <input
                  value={user}
                  onChange={(e) => { setErr(''); setUser(e.target.value) }}
                  placeholder="Crafty admin username"
                  className="field w-full px-3 py-2.5 mb-2 text-sm"
                  autoComplete="username"
                  autoFocus
                />
                <input
                  value={pass}
                  onChange={(e) => { setErr(''); setPass(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && user && pass && !busy) connect() }}
                  type="password"
                  placeholder="Crafty admin password"
                  className="field w-full px-3 py-2.5 text-sm"
                  autoComplete="current-password"
                />
              </>
            )}
            <button
              type="button"
              onClick={() => { setErr(''); setMode(mode === 'key' ? 'login' : 'key') }}
              className="text-xs opacity-70 hover:opacity-100 underline mt-2 block"
            >
              {mode === 'key' ? 'No API key handy? Log in once instead' : 'Have an API key? Paste it instead (recommended)'}
            </button>
            </>}
            <p className="text-xs opacity-70 mt-3 mb-2">
              The <strong>setup code</strong> proves you own this install. The installer and the panel log
              print it (on the panel machine:{' '}
              <code className="font-mono">cat &lt;layout&gt;/Spawnpoint/data/setup-code.txt</code>).
            </p>
            <input
              value={code}
              onChange={(e) => { setErr(''); setCode(e.target.value.toUpperCase()) }}
              placeholder="Setup code"
              className="field w-full px-3 py-2.5 text-sm font-mono tracking-[0.2em]"
              autoComplete="off"
            />
            {err && <div className="font-px text-[10px] text-redstone mt-3">{err.toUpperCase()}</div>}
            <button
              onClick={connect}
              disabled={(mode === 'standalone' ? false : mode === 'key' ? !apiKey.trim() : !user || !pass) || !code || busy}
              className="btn btn-emerald w-full py-2.5 text-sm mt-4"
            >
              {busy ? 'Connecting…' : mode === 'standalone' ? 'Use standalone runtime' : 'Connect Crafty'}
            </button>
          </>
        )}

        {step === 1 && (
          <>
            <p className="text-sm opacity-85 mb-1">
              {wiz?.runtime === 'standalone' || (serverCount !== null && mode === 'standalone') ? 'Independent supervisor connected.' : `Crafty connected${serverCount !== null ? ` — found ${serverCount} server${serverCount === 1 ? '' : 's'}` : ''}.`}
            </p>
            <p className="text-sm opacity-85 mb-4">
              Now set a PIN. Every browser needs it once every 30 days, this one included.
            </p>
            <input
              autoFocus
              value={pin}
              onChange={(e) => { setErr(''); setPin(e.target.value.replace(/\D/g, '').slice(0, 12)) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 6 && !busy) savePin() }}
              type="password"
              inputMode="numeric"
              placeholder="6-12 digits"
              className="field w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em]"
            />
            {!code && (
              <input
                value={code}
                onChange={(e) => { setErr(''); setCode(e.target.value.toUpperCase()) }}
                placeholder="Setup code"
                className="field w-full px-3 py-2.5 mt-2 text-sm font-mono tracking-[0.2em]"
                autoComplete="off"
              />
            )}
            {err && <div className="font-px text-[10px] text-redstone mt-3">{err.toUpperCase()}</div>}
            <button onClick={savePin} disabled={pin.length < 6 || !code || busy} className="btn btn-emerald w-full py-2.5 text-sm mt-4">
              Set PIN
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <p className="text-sm opacity-85 mb-4">
              Both optional — everything core already works. Add these any time later in Settings.
            </p>
            <div className="hud mb-1">CURSEFORGE BROWSING</div>
            <p className="text-xs opacity-70 mb-2">
              Modrinth works with no key. A free key from console.curseforge.com adds the CurseForge catalog.
            </p>
            <input
              value={cfKey}
              onChange={(e) => setCfKey(e.target.value)}
              placeholder="CurseForge API key (optional)"
              className="field w-full px-3 py-2.5 mb-4 text-sm"
              autoComplete="off"
            />
            <div className="hud mb-1">IN-GAME AI GENIE</div>
            <p className="text-xs opacity-70 mb-2">
              Off until you turn it on in Settings. Players type a wish in chat and the panel carries
              it out. It runs Claude Code with a <strong>Claude token</strong> (run{' '}
              <code className="font-mono">claude setup-token</code> anywhere Claude Code is installed)
              or an <strong>Anthropic API key</strong>. Paste either one.
              {wiz?.claude?.installed ? '' : ' The panel machine also needs Claude Code: npm i -g @anthropic-ai/claude-code.'}
            </p>
            <input
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              type="password"
              placeholder="Claude token or Anthropic API key (optional)"
              className="field w-full px-3 py-2.5 text-sm"
              autoComplete="off"
            />
            {err && <div className="font-px text-[10px] text-redstone mt-3">{err.toUpperCase()}</div>}
            <button onClick={finish} disabled={busy} className="btn btn-emerald w-full py-2.5 text-sm mt-4">
              {cfKey || aiKey ? 'Save and enter the panel' : 'Enter the panel'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
