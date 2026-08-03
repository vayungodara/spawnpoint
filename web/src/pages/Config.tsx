import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useServers } from '../api'
import bandRedstone from '../assets/band-redstone.png'
import PregenSection from './PregenSection'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json() as Promise<T>
}

interface Player { name: string; uuid: string; whitelisted: boolean; op: boolean }
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
    <div className="flex items-center justify-between gap-6 py-3.5 border-b-2 border-line/40 last:border-0">
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

export default function Config() {
  const { data: serversData } = useServers()
  const active = serversData?.servers.find((s) => s.active)
  const id = active?.id
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
  const { data: playersData } = useQuery({
    queryKey: ['players', id],
    queryFn: () => api<{ players: Player[] }>(`/api/servers/${id}/players`),
    enabled: !!id,
  })
  const { data: audit } = useQuery({
    queryKey: ['ports-audit'],
    queryFn: () => api<PortAudit>('/api/ports/audit'),
    refetchOnWindowFocus: true,
  })

  const [draft, setDraft] = useState<Record<string, string>>({})
  const [ram, setRam] = useState<number | null>(null)
  const [newPlayer, setNewPlayer] = useState('')
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
  const [resetMsg, setResetMsg] = useState<string | null>(null)
  // the restart-to-apply bar is dismissible: not every saved change deserves an
  // immediate restart (owner request). Editing anything brings it back.
  const [restartDismissed, setRestartDismissed] = useState(false)
  useEffect(() => {
    if (dirty) setRestartDismissed(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty])
  const resetPlayers = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; wiped: string[]; restarted: boolean; error?: string }>(
        `/api/servers/${id}/reset-players`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: (r) => {
      setResetMsg(r.ok ? `✓ Player progress wiped (${r.wiped.join(', ')})${r.restarted ? ' — server restarting' : ''}` : `✗ ${r.error}`)
      setTimeout(() => setResetMsg(null), 10000)
    },
    onError: (e) => { setResetMsg(`✗ ${String(e)}`); setTimeout(() => setResetMsg(null), 10000) },
  })
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
  const addPlayer = useMutation({
    mutationFn: (vars: { name: string; whitelist: boolean; op: boolean }) =>
      api(`/api/servers/${id}/players`, { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['players', id] }),
  })
  const delPlayer = useMutation({
    mutationFn: (name: string) => api(`/api/servers/${id}/players/${name}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['players', id] }),
  })
  const [portInput, setPortInput] = useState('')
  const [portMsg, setPortMsg] = useState<string | null>(null)
  const [packMsg, setPackMsg] = useState('')
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

  if (!active)
    return (
      <div>
        <div className="hud mb-3">Y 5 · REDSTONE</div>
        <p className="text-text-dim">No active server — pick one on the Servers page.</p>
      </div>
    )

  // server-side flag only — refetched after every mutation, cleared by apply-restart
  const restartRequired = data?.restartRequired ?? false

  return (
    <div className="max-w-3xl space-y-6 pb-28">
      <div>
        <div className="vista mb-6">
          <img src={bandRedstone} alt="" />
          <span className="vista-tag">Y 5 · REDSTONE</span>
        </div>
        <h1 className="text-3xl">Config — {active.name}</h1>
        <p className="text-text-dim text-sm mt-1 max-w-[68ch]">
          Changes save to server.properties; most need a restart.
        </p>
      </div>

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
              ? "Servers that share a port can't run at the same time, and a shared RCON port lets a command reach the wrong world. Give each its own port — open the colliding server on the Servers page, then Network → Move."
              : 'A server is bound to 25570, the panel’s own port. Open it on the Servers page and use Network → Move to give it a free one.'}
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

      <div className="flex gap-3">
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

      <Section tag="CREW" title="Players">
        <form
          className="flex gap-3 py-3.5 border-b-2 border-line/40"
          onSubmit={(e) => {
            e.preventDefault()
            if (newPlayer.trim()) addPlayer.mutate({ name: newPlayer.trim(), whitelist: true, op: false })
            setNewPlayer('')
          }}
        >
          <input value={newPlayer} onChange={(e) => setNewPlayer(e.target.value)} placeholder="Minecraft username" className="field flex-1 px-3 py-1.5 text-sm" />
          <button className="btn btn-emerald px-4 py-1.5 text-sm">Whitelist</button>
        </form>
        {playersData?.players.map((pl) => (
          <div key={pl.name} className="flex items-center gap-3 py-3 border-b-2 border-line/40 last:border-0">
            <span className="text-sm font-bold flex-1">{pl.name}</span>
            {pl.op && <span className="font-px text-[10px] text-gold border-2 border-gold/50 px-1.5 py-0.5">OP</span>}
            <button
              onClick={() => addPlayer.mutate({ name: pl.name, whitelist: pl.whitelisted, op: !pl.op })}
              className="text-xs font-bold text-text-dim hover:text-text"
            >
              {pl.op ? 'de-op' : 'make op'}
            </button>
            <button onClick={() => { if (confirm(`Remove ${pl.name}?`)) delPlayer.mutate(pl.name) }} className="text-xs font-bold text-redstone/90 hover:text-redstone">
              remove
            </button>
          </div>
        ))}
        {playersData?.players.length === 0 && <div className="py-3 text-sm text-text-dim">nobody whitelisted yet</div>}
      </Section>

      <Section tag="ENGINE" title="World & performance">
        <Row label="View distance" hint={`${p['view-distance'] ?? 10} chunks`}>
          <input type="range" min={4} max={16} value={p['view-distance'] ?? 10} onChange={(e) => set('view-distance', e.target.value)} className="xp w-48" />
        </Row>
        <Row label="Simulation distance" hint={`${p['simulation-distance'] ?? 10} chunks`}>
          <input type="range" min={4} max={16} value={p['simulation-distance'] ?? 10} onChange={(e) => set('simulation-distance', e.target.value)} className="xp w-48" />
        </Row>
        <Row label="RAM" hint={`${ram ?? jvm?.maxGb ?? '?'} GB heap · machine has 16 GB, max 12`}>
          <input type="range" min={2} max={12} value={ram ?? jvm?.maxGb ?? 6} onChange={(e) => setRam(+e.target.value)} className="xp w-48" />
        </Row>
        <Row label="Spawn protection" hint="radius nobody can build in (0 = off)">
          <input type="number" className="field w-20 px-3 py-1.5 text-sm font-mono" value={p['spawn-protection'] ?? '16'} onChange={(e) => set('spawn-protection', e.target.value)} />
        </Row>
      </Section>

      {id && <PregenSection serverId={id} />}

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

      <Section tag="SHARE" title="Friends">
        <Row
          label="Starter pack (.mrpack)"
          hint="the ONLY file a friend ever needs: tiny (~1KB), imports into Modrinth App/Prism, and on first join AutoModpack downloads this server's entire modpack automatically — updates forever after, no re-downloads"
        >
          <button
            onClick={async () => {
              const fresh = ((await (await fetch('/api/servers')).json()) as { servers: { id: string; name: string; active: boolean }[] })
                .servers.find((s) => s.active) ?? active
              setPackMsg(`building the ${fresh.name} starter…`)
              try {
                const res = await fetch(`/api/servers/${fresh.id}/starterpack`)
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
                const blob = await res.blob()
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'starter.mrpack'
                a.click()
                URL.revokeObjectURL(a.href)
                setPackMsg(`done — send it to your friends: File → Import in Modrinth App or Prism, press Play, join. Everything else installs itself on first join.`)
              } catch (e) {
                setPackMsg(`starter failed: ${e instanceof Error ? e.message : String(e)}`)
              }
            }}
            disabled={packMsg.startsWith('building')}
            className="btn btn-block px-4 py-1.5 text-sm"
          >
            {packMsg.startsWith('building') ? 'Building…' : 'Download starter'}
          </button>
          <button
            onClick={async () => {
              const fresh = ((await (await fetch('/api/servers')).json()) as { servers: { id: string; name: string; active: boolean }[] })
                .servers.find((s) => s.active) ?? active
              setPackMsg(`building the ${fresh.name} CurseForge starter…`)
              try {
                const res = await fetch(`/api/servers/${fresh.id}/starterpack?format=curseforge`)
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
                const blob = await res.blob()
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'starter-curseforge.zip'
                a.click()
                URL.revokeObjectURL(a.href)
                setPackMsg('done — for friends on the CurseForge app: Create Custom Profile → Import → pick the .zip. Same auto-sync after that.')
              } catch (e) {
                setPackMsg(`starter failed: ${e instanceof Error ? e.message : String(e)}`)
              }
            }}
            disabled={packMsg.startsWith('building')}
            className="btn btn-block px-4 py-1.5 text-sm"
          >
            CurseForge version
          </button>
        </Row>
        {packMsg && <div role="status" className="py-2 text-sm font-semibold max-w-[68ch]">{packMsg}</div>}
        <p className="text-xs text-text-dim max-w-[68ch]">
          The server is the source of truth: add or remove mods in Content and every player syncs
          automatically on their next join — nobody ever downloads a pack again.
        </p>
      </Section>

      <Section tag="DANGER" title="Fresh start">
        <Row
          label="Reset all player progress"
          hint="wipes EVERYONE's inventory, XP, position, advancements & stats — terrain, seed and mods stay"
        >
          <button
            onClick={() => {
              if (confirm('Reset ALL player progress on this server?\n\nInventories, ender chests, XP, positions, advancements, stats — gone for everyone. Terrain and mods stay. The server will stop and restart (takes ~1 minute).'))
                resetPlayers.mutate()
            }}
            disabled={resetPlayers.isPending}
            className="btn btn-redstone px-4 py-2 text-sm shrink-0"
          >
            {resetPlayers.isPending ? 'Resetting… (waiting for full stop)' : 'Reset players'}
          </button>
        </Row>
        {resetMsg && <div className="py-2 text-sm font-semibold">{resetMsg}</div>}
      </Section>

      {(dirty || applyRestart.isPending || ((restartRequired || applied) && !restartDismissed)) && (
        <div className="fixed bottom-6 left-4 right-4 md:left-72 md:right-8 max-w-3xl block px-5 py-3.5 flex items-center gap-4 z-10">
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
