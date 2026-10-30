import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Pi } from './PixelIcons'

// offline-only rescue row: parse the newest crash report, disable the
// client-only mods it names, invite a retry
export default function CrashSweepRow({ serverId }: { serverId: string }) {
  const [msg, setMsg] = useState<string | null>(null)
  const sweep = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/servers/${serverId}/sweep-crash`, { method: 'POST' })
      if (!r.ok) throw new Error(await r.text())
      return r.json() as Promise<{ disabled: string[]; alreadyDisabled: string[]; report: string | null; reportAgeMin: number | null }>
    },
    onSuccess: (r) => {
      if (!r.report) setMsg('No crash reports found — the last stop was clean.')
      else if (r.disabled.length === 0) setMsg(`Newest crash report (${r.reportAgeMin} min ago) names no failed mods${r.alreadyDisabled.length ? ' that are not already disabled' : ''} — check the console log instead.`)
      else setMsg(`✓ Disabled ${r.disabled.length} crashing mod(s): ${r.disabled.join(', ')} — hit Start to try again (re-enable any in Mods → Installed)`)
    },
    onError: (e) => setMsg(`✗ ${String(e)}`),
  })
  return (
    <div className="block px-4 py-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold flex items-center gap-2"><Pi i="shield" className="pi pi-s" /> Crashed on boot?</div>
          <div className="text-text-dim text-xs mt-0.5">
            modpacks often include client-only mods that kill the server — this reads the newest
            crash report and disables exactly the mods it blames
          </div>
        </div>
        <button
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          className="btn btn-block px-4 py-2 text-sm shrink-0"
        >
          {sweep.isPending ? 'sweeping…' : 'Disable crashing mods'}
        </button>
      </div>
      {msg && <div className="text-xs font-semibold mt-2.5 pt-2.5 border-t-2 border-line/40">{msg}</div>}
    </div>
  )
}
