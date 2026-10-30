import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useCurrentServer, useLogs, useSendCommand, useStats } from '../../api'
import { PlayersLiveCard } from './Players'

export default function Console() {
  const s = useCurrentServer()
  const { data: stats } = useStats(s?.id)
  const { data: logs } = useLogs(s?.id, true)
  const send = useSendCommand(s?.id)
  const qc = useQueryClient()
  const [cmd, setCmd] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [at, setAt] = useState(-1)
  const [err, setErr] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // follow the tail unless the owner scrolled up to read something
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight })
  }, [logs])

  if (!s) return null
  const running = !!stats?.running
  const ready = stats?.phase === 'ready' || (running && !stats?.phase)
  const lines = logs?.lines ?? []

  const submit = () => {
    const c = cmd.trim()
    if (!c) return
    setErr(null)
    send.mutate(c, {
      onSuccess: () => qc.invalidateQueries({ queryKey: ['logs', s.id] }),
      onError: (e) => setErr(`${c}: ${String(e).replace(/^Error: \d+: /, '')}`),
    })
    setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 30))
    setAt(-1)
    setCmd('')
  }

  return (
    <div className="space-y-6">
      <section className="apanel">
        <div className="apanel-head">
          <i className={`ph-dot ${ready ? '' : running ? 'animate-pulse' : 'ph-dot-off'}`} style={running && !ready ? { background: 'var(--color-gold)', boxShadow: '0 0 8px var(--color-gold)' } : undefined} />
          <b className="truncate">{s.name}</b>
          <span className="ml-auto shrink-0 opacity-70">{lines.length ? `last ${lines.length} lines` : ''}</span>
        </div>
        <div
          ref={box}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
          className="console h-[min(62dvh,640px)] overflow-y-auto px-4 py-3 text-[#cfd6db]"
          role="log"
          aria-label="Server console"
        >
          {lines.length ? lines.map((l, i) => (
            <p key={i} className={`cline whitespace-pre-wrap break-all ${/\b(WARN|ERROR)\b/.test(l) ? (/ERROR/.test(l) ? 'text-[#ff8a80]' : 'text-[#f3d77a]') : ''} ${i === lines.length - 1 ? 'console-caret' : ''}`}>{l}</p>
          )) : <p className="opacity-50 console-caret">No output yet.</p>}
        </div>
        <form className="flex border-t-2 border-black" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <label htmlFor="cmd" className="pl-4 pr-2 py-2.5 font-px text-sm" style={{ color: 'var(--color-emerald)' }}>&gt;</label>
          <input
            id="cmd"
            aria-label="Console command"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              // shell-style recall: up and down walk this session's commands
              if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); const n = Math.min(at + 1, history.length - 1); setAt(n); setCmd(history[n]) }
              if (e.key === 'ArrowDown' && at >= 0) { e.preventDefault(); const n = at - 1; setAt(n); setCmd(n >= 0 ? history[n] : '') }
            }}
            placeholder={running ? 'type a command, like list or time set day' : 'start the server to send commands'}
            disabled={!running}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent py-2.5 pr-4 font-mono text-sm outline-none placeholder:text-[#cfd6db]/50"
          />
          <button type="submit" disabled={!running || !cmd.trim() || send.isPending} className="pb pb-go shrink-0 m-1">Send</button>
        </form>
      </section>
      {err && <p role="alert" className="text-sm font-semibold text-redstone">✗ {err}</p>}
      {ready && <PlayersLiveCard serverId={s.id} running />}
    </div>
  )
}
