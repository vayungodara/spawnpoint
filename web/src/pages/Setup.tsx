import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PixelDefs, Pi } from '../components/PixelIcons'

// FIRST-RUN WIZARD — served instead of the panel while the install has no
// Crafty token (see server/src/routes/wizardRoutes.ts). Three steps, one
// screen each: connect Crafty (the only required one), set a PIN, optional
// keys. A configured install never routes here: Shell only redirects while
// the server says the wizard is active, and this page bounces back the
// moment it isn't.

type WizardStatus = {
  active: boolean
  craftyUrl?: string
  craftyReachable?: boolean
  hasJdk?: boolean
  pinSet?: boolean
  needsCode?: boolean
  claude?: { installed: boolean; loggedIn: boolean }
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

  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // step 0 — crafty
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [code, setCode] = useState('')
  const [serverCount, setServerCount] = useState<number | null>(null)

  // step 1 — pin
  const [pin, setPin] = useState('')
  const [pinDone, setPinDone] = useState(false)

  // step 2 — optional keys
  const [cfKey, setCfKey] = useState('')
  const [aiKey, setAiKey] = useState('')

  if (isLoading) return null
  if (!wiz?.active && serverCount === null) return <Navigate to="/" replace />

  const connect = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await fetch('/api/wizard/crafty-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass, url: url || undefined, code: code || undefined }),
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
        body: JSON.stringify({ pin, code: code || undefined }),
      })
      if (!r.ok) {
        setErr(await r.json().then((j) => j.error).catch(() => null) ?? 'could not save the PIN')
        return
      }
      setPinDone(true)
      setStep(2)
    } catch {
      setErr('the panel stopped responding — is it still running?')
    } finally {
      setBusy(false)
    }
  }

  const finish = async (skipKeys: boolean) => {
    setBusy(true)
    setErr('')
    try {
      if (!skipKeys && (cfKey || aiKey)) {
        const body = {
          ...(cfKey ? { curseforgeApiKey: cfKey } : {}),
          ...(aiKey ? { anthropicApiKey: aiKey } : {}),
        }
        // with a PIN set we hold a session cookie; without one the API is
        // loopback-only, so the claim-code route carries the keys instead
        const r = pinDone
          ? await put(body)
          : await fetch('/api/wizard/finish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, code: code || undefined }),
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

  const stepTag = ['STEP 1 / 3 · CONNECT CRAFTY', 'STEP 2 / 3 · LOCK THE PANEL', 'STEP 3 / 3 · OPTIONAL EXTRAS'][step]

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
            <p className="text-sm opacity-85 mb-4">
              Log in with your <strong>Crafty admin account</strong> once. The panel mints its own
              API access from it and never stores the password.
            </p>
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
            {wiz?.needsCode && (
              <>
                <p className="text-xs opacity-70 mt-3 mb-2">
                  You're setting up from another device, so paste the <strong>setup code</strong> the
                  installer printed. (On the panel machine:{' '}
                  <code className="font-mono">cat &lt;layout&gt;/Spawnpoint/data/setup-code.txt</code>)
                </p>
                <input
                  value={code}
                  onChange={(e) => { setErr(''); setCode(e.target.value.toUpperCase()) }}
                  placeholder="Setup code"
                  className="field w-full px-3 py-2.5 text-sm font-mono tracking-[0.2em]"
                  autoComplete="off"
                />
              </>
            )}
            {err && <div className="font-px text-[10px] text-redstone mt-3">{err.toUpperCase()}</div>}
            <button onClick={connect} disabled={!user || !pass || busy} className="btn btn-emerald w-full py-2.5 text-sm mt-4">
              {busy ? 'Connecting…' : 'Connect Crafty'}
            </button>
          </>
        )}

        {step === 1 && (
          <>
            <p className="text-sm opacity-85 mb-1">
              Crafty connected{serverCount !== null ? ` — found ${serverCount} server${serverCount === 1 ? '' : 's'}` : ''}.
            </p>
            <p className="text-sm opacity-85 mb-4">
              Now set a PIN. Anyone opening the panel from another device needs it; this browser
              stays logged in.
            </p>
            <input
              autoFocus
              value={pin}
              onChange={(e) => { setErr(''); setPin(e.target.value.replace(/\D/g, '').slice(0, 8)) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 4 && !busy) savePin() }}
              type="password"
              inputMode="numeric"
              placeholder="4-8 digits"
              className="field w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em]"
            />
            {err && <div className="font-px text-[10px] text-redstone mt-3">{err.toUpperCase()}</div>}
            <button onClick={savePin} disabled={pin.length < 4 || busy} className="btn btn-emerald w-full py-2.5 text-sm mt-4">
              Set PIN
            </button>
            <button onClick={() => setStep(2)} disabled={busy} className="btn w-full py-2 text-xs mt-2 opacity-80">
              Skip — the panel then answers only on this machine
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
              Off by default — players type a wish in chat and the panel builds it. It runs on the
              AI subscription you already pay for, or on an API key.
            </p>
            {wiz?.claude?.loggedIn ? (
              <p className="font-px text-[10px] text-emerald mb-2">
                ✓ CLAUDE SUBSCRIPTION DETECTED ON THIS MACHINE — NO KEY NEEDED
              </p>
            ) : (
              <p className="text-xs opacity-70 mb-2">
                <strong>Using a Claude subscription?</strong> On the panel machine run{' '}
                <code className="font-mono">claude setup-token</code>
                {wiz?.claude?.installed ? '' : ' (install the Claude Code CLI first)'} — the genie
                picks it up automatically, nothing to paste here. Otherwise drop an API key below.
              </p>
            )}
            <input
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              type="password"
              placeholder="Anthropic API key (optional)"
              className="field w-full px-3 py-2.5 text-sm"
              autoComplete="off"
            />
            <p className="text-xs opacity-55 mt-2">
              ChatGPT/Codex support is in progress — the genie speaks to any CLI engine.
            </p>
            {err && <div className="font-px text-[10px] text-redstone mt-3">{err.toUpperCase()}</div>}
            <button onClick={() => finish(false)} disabled={busy} className="btn btn-emerald w-full py-2.5 text-sm mt-4">
              {cfKey || aiKey ? 'Save and enter the panel' : 'Enter the panel'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
