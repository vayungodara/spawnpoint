import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fmtWhen, txnDate, useChange, useCurrentServer, useRevisions } from '../../api'
import { ChangeCard, Rejections, TestChips, UndoWaitingBanner } from '../../components/Change'
import { changeVisible } from '../../components/status'
import { ConfirmButton } from './Workspace'

function History({ id, live }: { id: string; live: boolean }) {
  const qc = useQueryClient()
  const q = useRevisions(id, live)
  const [msg, setMsg] = useState<string | null>(null)
  const last = useQuery({
    queryKey: ['last-change', id],
    queryFn: () => api<{ change: { txn: string; added: { file: string }[] } | null }>(`/api/servers/${id}/last-change`),
  })
  const undo = useMutation({
    mutationFn: () => api<{ waiting: boolean }>(`/api/servers/${id}/last-change/undo`, { method: 'POST', body: '{}' }),
    onSuccess: (r) => {
      setMsg(r.waiting ? 'The undo waits for the server to restart; see above.' : 'Undone: the files from before that change are back. They load when the server starts.')
      for (const key of ['candidate', 'installed', 'last-change', 'revisions']) qc.invalidateQueries({ queryKey: [key, id] })
    },
    onError: (e) => setMsg(`✗ ${String(e).replace(/^Error: \d+: /, '')}`),
  })
  const revisions = q.data?.revisions ?? []
  return (
    <section className="space-y-3">
      <div className="flex items-end gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl">History</h2>
          <p className="text-sm text-text-dim mt-0.5 max-w-[68ch]">Friends get the published revision. Undo puts back the files the last change replaced; it does not restore the world.</p>
        </div>
        {last.data?.change && (
          <ConfirmButton
            onConfirm={() => undo.mutate()}
            disabled={undo.isPending}
            confirmLabel="Click again to undo"
            className="btn btn-block px-4 py-2 text-sm min-w-[11rem]"
          >
            {undo.isPending ? 'Undoing…' : 'Undo last change'}
          </ConfirmButton>
        )}
      </div>
      {msg && <p role="status" className="text-sm font-semibold pop-in">{msg}</p>}
      {q.isError && <p role="alert" className="text-sm text-gold">History could not be loaded: {q.error.message}</p>}
      {!q.isLoading && !revisions.length && (
        <p className="block px-4 py-3 text-sm text-text-dim">No revisions yet. The first tested change seals one, together with the pack that was running before it.</p>
      )}
      <ol className="space-y-2.5">
        {revisions.map((r, i) => {
          const published = r.id === q.data?.published
          const active = r.id === q.data?.active
          // a failed report alone is not a rejection: a flaky or pre-existing
          // failure can still be approved, so say what is known
          const failed = !r.approved && Object.values(r.tests).some((v) => v.result === 'failed')
          const state = published ? ['PUBLISHED TO FRIENDS', 'text-emerald'] : active ? ['ACTIVE · PUBLISHING', 'text-sky']
            : failed ? ['CHECKS FAILED', 'text-redstone'] : ['RETAINED', 'text-text-dim']
          return (
            <li key={r.id} className="rise-in" style={{ '--i': i } as React.CSSProperties}>
              <details className={`block group ${published ? 'border-emerald!' : ''}`}>
                <summary className="px-4 py-3 flex items-center gap-x-4 gap-y-2 flex-wrap list-none">
                  <span className={`hud !opacity-100 ${state[1]} w-48 shrink-0`}>{state[0]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-bold">{fmtWhen(txnDate(r.id))}</span>
                    <span className="text-sm text-text-dim"> · {r.requested} picked · {r.dependencies} dependencies · {r.files} locked files{r.id.endsWith('-baseline') ? ' · pack before the first change' : ''}</span>
                  </span>
                  <TestChips tests={r.tests} />
                  <span className="hud group-open:rotate-180 transition-transform" aria-hidden>▾</span>
                </summary>
                <div className="px-4 pb-4 pt-1 text-sm space-y-2 border-t-2 border-line/40">
                  <p className="text-text-dim pt-2">Minecraft {r.minecraft} · {r.loader} {r.loaderVersion}</p>
                  <ul className="space-y-1">
                    {Object.entries(r.tests).map(([test, v]) => (
                      <li key={test}><b className={v.result === 'failed' ? 'text-redstone' : v.result === 'passed' ? 'text-emerald' : 'text-text-dim'}>{test}: {v.result}</b>{v.renderer ? ` · renderer ${v.renderer}` : ''} · {v.detail}</li>
                    ))}
                  </ul>
                  {r.approved && <p className="text-gold">You approved: {r.approved.reasons.join('; ')}</p>}
                  {r.backup && <p className="text-text-dim break-all">World backup before the swap: {r.backup}</p>}
                  <a className="text-sky underline underline-offset-2 inline-block" href={`/api/servers/${id}/revisions/${r.id}`} target="_blank" rel="noreferrer">Inspect lock and test report</a>
                </div>
              </details>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export default function Changes() {
  const s = useCurrentServer()
  const { data } = useChange(s?.id)
  if (!s) return null
  const c = data?.candidate
  const p = data?.promotion ?? null
  const moving = !!p || ['collecting', 'testing', 'activating'].includes(c?.status ?? '')
  return (
    <div className="space-y-6">
      {p?.action === 'undo' && <UndoWaitingBanner id={s.id} p={p} />}
      {changeVisible(c) ? <ChangeCard id={s.id} c={c} p={p?.action === 'apply' ? p : null} /> : (
        <section className="block p-5">
          <h2 className="hud">NO OPEN CHANGE</h2>
          <p className="text-sm mt-2 max-w-[68ch]">
            Install, update or remove a mod and it lands here first. Spawnpoint plans the whole pack, boots it on a copy,
            joins it with a real client where AutoModpack is set up, and only then asks the server to restart with it.
          </p>
          <Link to={`/s/${s.id}/mods`} className="btn btn-emerald px-4 py-2 text-sm inline-block mt-3">Browse mods</Link>
        </section>
      )}
      <Rejections id={s.id} />
      <History id={s.id} live={moving} />
    </div>
  )
}
