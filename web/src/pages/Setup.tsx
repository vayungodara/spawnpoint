import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PixelDefs, Pi } from '../components/PixelIcons'
import bandSurface from '../assets/band-surface.webp'

// FIRST-RUN WIZARD, shown until the panel has a runtime and a PIN (see
// server/src/routes/wizardRoutes.ts). Welcome → PIN → genie (skippable) →
// done. "Get started" connects the Spawnpoint supervisor the installer set
// up; Crafty is a quiet alternative. Both required writes need the setup
// code; the installer's link (/setup#code=…) fills it in.

type WizardStatus = {
  active: boolean
  runtime?: 'crafty' | 'standalone'
  supervisor?: boolean
  craftyUrl?: string
  craftyReachable?: boolean
  craftyConnected?: boolean
  pinSet?: boolean
  claude?: { installed: boolean }
}

const post = (url: string, body: unknown, method = 'POST') =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const errorOf = async (r: Response, fallback: string) =>
  ((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? fallback
const OFFLINE = 'The panel stopped answering. Is it still running?'
const STEPS = ['Welcome', 'PIN', 'Genie', 'Done']

function Dots({ step }: { step: number }) {
  return (
    <ol className="flex items-center justify-center gap-2" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
      {STEPS.map((s, i) => (
        <li key={s} title={s} aria-current={i === step ? 'step' : undefined}
          className={`h-2 border-2 border-ink transition-all duration-300 ${i === step ? 'w-7 bg-emerald' : i < step ? 'w-2 bg-emerald/60' : 'w-2 bg-block-2'}`} />
      ))}
    </ol>
  )
}

function Err({ msg }: { msg: string }) {
  return msg ? <p role="alert" className="text-sm text-redstone font-semibold mt-3 pop-in">{msg}</p> : null
}

export default function Setup() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data: wiz, isLoading } = useQuery({
    queryKey: ['wizard'],
    queryFn: async () => (await (await fetch('/api/wizard/status')).json()) as WizardStatus,
    staleTime: 30_000,
  })

  const [picked, setStep] = useState<number | null>(null)
  // a reload after connecting resumes at the PIN step
  const step = picked ?? (wiz?.craftyConnected || wiz?.runtime === 'standalone' ? 1 : 0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [code, setCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('code')?.toUpperCase() ?? '')
  const [codeBad, setCodeBad] = useState(false)
  const codeFromLink = useRef(!!code).current
  const [crafty, setCrafty] = useState<'off' | 'key' | 'login'>('off')
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [found, setFound] = useState<number | null>(null)
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [done, setDone] = useState(false) // setup completed in this tab; keep showing the wizard

  // no supervisor (SPAWNPOINT_RUNTIME=crafty installs): lead with Crafty
  useEffect(() => { if (wiz?.supervisor === false) setCrafty('key') }, [wiz?.supervisor])

  if (isLoading) return <div className="min-h-screen" style={{ background: 'var(--color-bedrock)' }} />
  if (!wiz?.active && !done) return <Navigate to="/" replace />

  const go = (n: number) => { setErr(''); setStep(n) }
  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('')
    try { await fn() } catch { setErr(OFFLINE) } finally { setBusy(false) }
  }

  const connect = () => attempt(async () => {
    const r = crafty === 'off'
      ? await post('/api/wizard/standalone', { code })
      : await post('/api/wizard/crafty-login', crafty === 'key'
        ? { token: apiKey.trim(), url: url || undefined, code }
        : { username: user, password: pass, url: url || undefined, code })
    if (!r.ok) {
      const e = await errorOf(r, `Couldn't connect (${r.status}).`)
      if (/setup code/i.test(e)) setCodeBad(true)
      setErr(/setup code/i.test(e) ? "That setup code doesn't match. Copy it again from the installer." : e)
      return
    }
    setFound(crafty === 'off' ? null : ((await r.json()).servers ?? 0))
    setDone(true)
    go(1)
  })

  const savePin = () => attempt(async () => {
    if (pin !== pin2) { setErr("Those PINs don't match. Try the second one again."); setPin2(''); return }
    const r = await post('/api/wizard/finish', { pin, code })
    if (!r.ok) { const e = await errorOf(r, "Couldn't save the PIN."); if (/setup code/i.test(e)) setCodeBad(true); setErr(e); return }
    setDone(true)
    go(2)
  })

  const enter = async (to: string) => {
    await qc.invalidateQueries()
    nav(to, { replace: true })
  }

  const needCode = !codeFromLink || !code || codeBad
  const codeField = needCode && (
    <label className="flex flex-col mt-4 text-left">
      <span className="hud mb-1.5">SETUP CODE</span>
      <input value={code} onChange={(e) => { setErr(''); setCode(e.target.value.replace(/\s/g, '').toUpperCase()) }}
        placeholder="From the installer's last lines" autoComplete="off" spellCheck={false}
        className="field w-full px-3 py-2.5 text-sm font-mono tracking-[0.15em]" />
      <span className="text-xs text-text-dim mt-1.5">
        Lost it? On the panel machine run <code className="font-mono">cat ~/minecraft/Spawnpoint/data/setup-code.txt</code>
      </span>
    </label>
  )

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center p-4 sm:p-6" style={{ background: 'var(--color-bedrock)', backgroundImage: 'var(--noise-dense)' }}>
      <PixelDefs />
      <main className="block w-full max-w-[460px] overflow-hidden">
        {step === 0 && (
          <div className="vista !m-0 !border-0 !border-b-2 !border-ink !shadow-none">
            <img src={bandSurface} alt="" />
            <span className="vista-tag">Y 63 · SURFACE</span>
          </div>
        )}
        <div className="p-6 sm:p-8">
          <div className="flex items-center justify-between mb-6">
            <span className="flex items-center gap-2">
              <Pi i="flag" className="pi" />
              <span className="font-px text-[13px] tracking-[0.04em] font-bold">SPAWNPOINT</span>
            </span>
            <Dots step={step} />
          </div>

          <div key={step} className="route-in">
            {step === 0 && (
              <>
                <h1 className="text-[28px] mb-2">Welcome to your server.</h1>
                <p className="text-text-dim mb-1">
                  Two quick questions and you're in. Then Spawnpoint builds your first server, sets up Java and the
                  mod sync, and gives you an address to send your friends.
                </p>

                {crafty === 'off' ? (
                  <>
                    {codeField}
                    <Err msg={err} />
                    <button onClick={connect} disabled={busy || !code} autoFocus className="btn btn-emerald w-full py-3 mt-6 text-base">
                      {busy ? 'Connecting…' : 'Get started'}
                    </button>
                    <button onClick={() => { setErr(''); setCrafty('key') }} className="text-xs text-text-dim hover:text-text underline underline-offset-2 mt-4 mx-auto flex">
                      I already run servers in Crafty Controller
                    </button>
                  </>
                ) : (
                  <div className="mt-4 rise-in">
                    {wiz?.supervisor === false && (
                      <p className="text-sm mb-3">This install didn't set up Spawnpoint's own service, so connect Crafty Controller.</p>
                    )}
                    <p className="text-sm text-text-dim mb-3">
                      {crafty === 'key'
                        ? <>In Crafty, open your user's <b className="text-text">API Keys</b> page, create a key and paste it here. A non-admin account that only sees these servers is safest.</>
                        : <>Sign in with your Crafty admin account once. Spawnpoint creates its own API access and never stores the password.</>}
                    </p>
                    {wiz?.craftyReachable === false && (
                      <p className="text-sm text-gold mb-3">Nothing answers at {wiz.craftyUrl}. Start Crafty, or enter its address below.</p>
                    )}
                    <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={wiz?.craftyUrl ?? 'https://localhost:8443'}
                      aria-label="Crafty address" className="field w-full px-3 py-2.5 mb-2 text-sm" autoComplete="off" />
                    {crafty === 'key' ? (
                      <input value={apiKey} onChange={(e) => { setErr(''); setApiKey(e.target.value) }} type="password" autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter' && apiKey.trim() && code && !busy) connect() }}
                        placeholder="Crafty API key" aria-label="Crafty API key" className="field w-full px-3 py-2.5 text-sm font-mono" autoComplete="off" />
                    ) : (
                      <>
                        <input value={user} onChange={(e) => { setErr(''); setUser(e.target.value) }} placeholder="Crafty username" aria-label="Crafty username"
                          className="field w-full px-3 py-2.5 mb-2 text-sm" autoComplete="username" autoFocus />
                        <input value={pass} onChange={(e) => { setErr(''); setPass(e.target.value) }} type="password" placeholder="Crafty password" aria-label="Crafty password"
                          onKeyDown={(e) => { if (e.key === 'Enter' && user && pass && code && !busy) connect() }}
                          className="field w-full px-3 py-2.5 text-sm" autoComplete="current-password" />
                      </>
                    )}
                    <button onClick={() => { setErr(''); setCrafty(crafty === 'key' ? 'login' : 'key') }} className="text-xs text-text-dim hover:text-text underline underline-offset-2 mt-2 flex">
                      {crafty === 'key' ? 'No API key? Sign in once instead' : 'Use an API key instead (safer)'}
                    </button>
                    {codeField}
                    <Err msg={err} />
                    <button onClick={connect} disabled={busy || !code || (crafty === 'key' ? !apiKey.trim() : !user || !pass)} className="btn btn-emerald w-full py-3 mt-5 text-base">
                      {busy ? 'Connecting…' : 'Connect Crafty'}
                    </button>
                    {wiz?.supervisor !== false && (
                      <button onClick={() => { setErr(''); setCrafty('off') }} className="text-xs text-text-dim hover:text-text underline underline-offset-2 mt-4 mx-auto flex">
                        Back to a fresh Spawnpoint setup
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {step === 1 && (
              <>
                <h1 className="text-[28px] mb-2">Pick a PIN.</h1>
                <p className="text-text-dim mb-5">
                  {found !== null ? `Crafty connected, with ${found} server${found === 1 ? '' : 's'}. ` : ''}
                  Anyone who opens this panel needs it, so choose 6 to 12 digits your friends won't guess.
                  Each browser asks for it once a month.
                </p>
                <input autoFocus value={pin} type="password" inputMode="numeric" autoComplete="new-password" aria-label="New PIN"
                  onChange={(e) => { setErr(''); setPin(e.target.value.replace(/\D/g, '').slice(0, 12)) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 6) (document.getElementById('pin2') as HTMLInputElement)?.focus() }}
                  placeholder="New PIN" className="field w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.4em] placeholder:tracking-normal placeholder:text-base" />
                <input id="pin2" value={pin2} type="password" inputMode="numeric" autoComplete="new-password" aria-label="Type the PIN again"
                  onChange={(e) => { setErr(''); setPin2(e.target.value.replace(/\D/g, '').slice(0, 12)) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 6 && pin2 && !busy) savePin() }}
                  placeholder="Same PIN again" className="field w-full px-4 py-3 mt-2 text-center text-2xl font-mono tracking-[0.4em] placeholder:tracking-normal placeholder:text-base" />
                {codeField}
                <Err msg={err} />
                <button onClick={savePin} disabled={pin.length < 6 || !pin2 || !code || busy} className="btn btn-emerald w-full py-3 mt-6 text-base">
                  {busy ? 'Saving…' : 'Continue'}
                </button>
              </>
            )}

            {step === 2 && <GenieStep claudeInstalled={!!wiz?.claude?.installed} onNext={() => go(3)} />}

            {step === 3 && (
              <>
                <div className="flex justify-center mb-4" aria-hidden>
                  <span className="pop-in inline-flex items-center justify-center w-16 h-16 bg-emerald border-2 border-ink" style={{ boxShadow: '0 4px 0 var(--color-ink)' }}>
                    <Pi i="flag" className="pi pi-l" />
                  </span>
                </div>
                <h1 className="text-[28px] mb-2 text-center">You're all set.</h1>
                <p className="text-text-dim mb-6 text-center">
                  Next, build your first server. Fabric is picked for you; it takes about half a minute.
                </p>
                <button onClick={() => enter('/new')} autoFocus className="btn btn-emerald w-full py-3 text-base">Create my first server</button>
                <button onClick={() => enter('/')} className="text-xs text-text-dim hover:text-text underline underline-offset-2 mt-4 mx-auto flex">
                  Look around first
                </button>
              </>
            )}
          </div>
        </div>
      </main>
      <p className="text-xs text-text-dim mt-5 opacity-70">Self-hosted · your worlds stay on this machine</p>
    </div>
  )
}

/** Connect an AI subscription for the in-game genie. Uses the one-click
    Claude sign-in when the panel offers it (/api/genie/connect/*), else a
    pasted token or API key. Always skippable; Settings has the same control. */
function GenieStep({ claudeInstalled, onNext }: { claudeInstalled: boolean; onNext: () => void }) {
  const { data: cred } = useQuery({
    queryKey: ['genie-credential'],
    queryFn: async () => {
      const r = await fetch('/api/genie/credential')
      return r.ok ? ((await r.json()) as { connectSupported?: boolean }) : null
    },
    retry: false,
  })
  const [signin, setSignin] = useState<string | null>(null) // sign-in URL while the flow is open
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)
  const oneClick = !!cred?.connectSupported && claudeInstalled

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('')
    try { await fn() } catch { setErr(OFFLINE) } finally { setBusy(false) }
  }
  const start = () => run(async () => {
    const r = await post('/api/genie/connect/start', {})
    if (!r.ok) { setErr(await errorOf(r, "Couldn't start the Claude sign-in. Paste a token instead.")); return }
    const { url } = (await r.json()) as { url: string }
    setSignin(url)
    window.open(url, '_blank', 'noopener')
  })
  const save = () => run(async () => {
    const v = value.trim()
    const r = signin
      ? await post('/api/genie/connect/finish', { code: v })
      : cred ? await post('/api/genie/credential', { value: v }, 'PUT') : await post('/api/settings', { anthropicApiKey: v }, 'PUT')
    if (!r.ok) { setErr(await errorOf(r, "That didn't work. Check it was copied whole.")); return }
    // the genie routes answer 200 with the live test's verdict
    const st = (await r.json().catch(() => ({}))) as { state?: string; detail?: string }
    if (st.state === 'invalid' || st.state === 'expired') { setErr(st.detail ?? 'Claude rejected that credential.'); return }
    setOk(true)
    setTimeout(onNext, 900)
  })
  const looksValid = signin ? value.trim().length > 8 : /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value.trim())

  return (
    <>
      <h1 className="text-[28px] mb-2">Meet the genie.</h1>
      <p className="text-text-dim mb-4">
        Players type <span className="font-mono text-text">genie build me a lighthouse</span> in chat and an AI does it,
        with undo. Connect your Claude subscription to power it, or skip this and do it later in Settings.
      </p>
      {ok ? (
        <p className="text-emerald font-semibold pop-in py-3" role="status">✓ Connected. The genie is ready when you turn it on for a server.</p>
      ) : (
        <>
          {oneClick && !signin && (
            <button onClick={start} disabled={busy} className="btn btn-emerald w-full py-3 text-base">
              {busy ? 'Opening…' : 'Sign in with Claude'}
            </button>
          )}
          {(signin || !oneClick) && (
            <div className="rise-in">
              <p className="text-sm text-text-dim mb-2">
                {signin
                  ? <>A Claude tab opened. Sign in, then paste the code it shows. <a href={signin} target="_blank" rel="noopener" className="underline underline-offset-2 text-text">Reopen it</a></>
                  : <>Run <code className="font-mono text-text">claude setup-token</code> on any computer with Claude Code and paste the token, or paste an Anthropic API key.
                    {!claudeInstalled && <> This machine also needs Claude Code: <code className="font-mono text-text">npm i -g @anthropic-ai/claude-code</code></>}</>}
              </p>
              <input value={value} onChange={(e) => { setErr(''); setValue(e.target.value) }} type="password" autoComplete="off" spellCheck={false}
                onKeyDown={(e) => { if (e.key === 'Enter' && looksValid && !busy) save() }}
                placeholder={signin ? 'Code from the Claude page' : 'sk-ant-…'} aria-label={signin ? 'Code from the Claude page' : 'Claude token or Anthropic API key'}
                className="field w-full px-3 py-2.5 text-sm font-mono" />
              <button onClick={save} disabled={!looksValid || busy} className="btn btn-emerald w-full py-3 mt-3 text-base">
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </div>
          )}
          <Err msg={err} />
          <button onClick={onNext} disabled={busy} className="btn btn-block w-full py-2.5 mt-3 text-sm">Skip for now</button>
        </>
      )}
    </>
  )
}
