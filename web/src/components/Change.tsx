import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, fmtWhen, txnDate, useChange, useDecide, useRevisions, useServerAction,
  type Candidate, type ChangeAction, type Pin, type Promotion, type Revision, type StagedFile, type Verdict,
} from '../api'
import Sheet from './Sheet'
import { changeName, titleOf, useReviewParam } from './status'

// ---------------------------------------------------------------------------
// One mod change, from plan to friends. Every step reads the candidate the
// server keeps, so the card, the sheet and the tab badge never disagree.
// ---------------------------------------------------------------------------

type StepState = 'done' | 'current' | 'you' | 'warn' | 'failed' | 'wait' | 'skipped'
interface Step { label: string; s: StepState; d: string }

const ICON: Record<StepState, string> = { done: '✓', current: '', you: '!', warn: '?', failed: '✗', wait: '', skipped: '–' }

function verdictStep(label: string, v: Verdict | undefined, running: boolean): Step {
  if (!v) return { label, s: running ? 'current' : 'wait', d: running ? 'testing…' : '' }
  if (v.result === 'passed') return { label, s: 'done', d: v.seconds ? `${v.seconds} s` : 'passed' }
  if (v.result === 'failed') return { label, s: 'failed', d: 'failed' }
  return { label, s: 'warn', d: 'not tested' }
}

/** The server parks a change with this reason when the first managed change
    needs the launch guard; approving it starts the tests, it skips none. */
const FIRST_CONSENT = 'owner consent is required to manage revision-checked starts and publication'

/** What the revision report and the published pointer add to the candidate. */
interface RevState { tests?: Revision['tests']; published?: string }

function stepsFor(c: Candidate, p: Promotion | null, rev: RevState): Step[] {
  const st = c.status
  const testing = st === 'testing'
  const solved = c.solver
  const plan: Step = !solved
    ? st === 'collecting' ? { label: 'Plan', s: 'current', d: 'collecting' } : { label: 'Plan', s: 'skipped', d: 'not run' }
    : solved.status === 'ok' ? { label: 'Plan', s: 'done', d: 'minimum change' }
      : solved.status === 'inconclusive' ? { label: 'Plan', s: 'warn', d: solved.tentative ? 'feasible' : 'inconclusive' }
        : { label: 'Plan', s: 'failed', d: 'conflict' }
  // the candidate keeps verdicts only when a run ends; mid-run, the revision
  // report already holds the server result the client phase started after
  const reported = testing && !c.server ? rev.tests?.server : undefined
  const serverVerdict: Verdict | undefined = c.server ?? (reported && reported.result !== 'skipped'
    ? { result: reported.result === 'inconclusive' ? 'unverified' : reported.result, detail: reported.detail }
    : undefined)
  const server = verdictStep('Server boot', serverVerdict, testing)
  const client = verdictStep('Client join', c.client, testing && !!serverVerdict)
  let restart: Step = { label: 'Restart', s: 'wait', d: '' }
  if (st === 'activating' || p?.restarting) restart = { label: 'Restart', s: 'current', d: 'restarting' }
  else if (st === 'ready') {
    restart = !p ? { label: 'Restart', s: 'current', d: 'queued' }
      : p.stopped ? { label: 'Restart', s: 'current', d: 'on next start' }
        : p.unknown ? { label: 'Restart', s: 'you', d: 'restart it yourself' }
          : (p.players ?? 0) > 0 && !p.choice ? { label: 'Restart', s: 'you', d: 'pick when' }
            : { label: 'Restart', s: 'current', d: p.choice === 'when-empty' ? 'when empty' : 'soon' }
  } else if (st === 'applied') restart = { label: 'Restart', s: 'done', d: 'booted' }
  // "applied" means the files moved; friends have it only once this exact
  // revision is the published one
  const friends: Step = st !== 'applied' || p?.restarting ? { label: 'Friends synced', s: 'wait', d: '' }
    : !c.client ? { label: 'Friends synced', s: 'skipped', d: 'no auto-sync' }
      : rev.published === c.revision ? { label: 'Friends synced', s: 'done', d: 'published' }
        : { label: 'Friends synced', s: 'current', d: 'publishing' }
  // approval shows only where it actually happens: before the tests when it is
  // the first managed change, after them otherwise; never as a placeholder
  if (st === 'needs-approval') {
    const you: Step = { label: 'Your approval', s: 'you', d: 'waiting for you' }
    return c.detail === FIRST_CONSENT ? [plan, you, server, client, restart, friends] : [plan, server, client, you, restart, friends]
  }
  if (c.approved) return [plan, server, client, { label: 'Your approval', s: 'done', d: 'approved' }, restart, friends]
  return [plan, server, client, restart, friends]
}

/** Live means the boot verified and, with auto-sync, friends have the exact pack. */
function isLive(c: Candidate, p: Promotion | null, rev: RevState): boolean {
  return c.status === 'applied' && !p?.restarting && (!c.client || rev.published === c.revision)
}

/** Revision state for the open change; polls only while something moves. */
function useRevState(id: string, c: Candidate): RevState {
  const moving = c.status === 'testing' || (c.status === 'applied' && !!c.client)
  const { data } = useRevisions(id, moving)
  return { tests: data?.revisions.find((r) => r.id === c.revision)?.tests, published: data?.published }
}

export function Pipeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="pipe" aria-label="Change progress">
      {steps.map((x, i) => (
        <li key={x.label} className="pstep" data-s={x.s} style={{ '--i': i } as CSSProperties}>
          <span className="pstep-ico" aria-hidden>{ICON[x.s]}</span>
          <span className="pstep-l">{x.label}</span>
          <span className="pstep-d">{x.d || '\u00a0'}<span className="sr-only">{x.s === 'wait' ? 'not reached yet' : ''}</span></span>
        </li>
      ))}
    </ol>
  )
}

const TAG: Record<Candidate['status'], [string, string]> = {
  collecting: ['COLLECTING CHANGES', 'text-sky'],
  testing: ['TESTING ON A COPY', 'text-sky'],
  'needs-approval': ['NEEDS YOUR APPROVAL', 'text-gold'],
  ready: ['READY FOR RESTART', 'text-emerald'],
  activating: ['GOING LIVE', 'text-emerald'],
  applied: ['LIVE', 'text-emerald'],
  rejected: ['TURNED AWAY', 'text-redstone'],
}

// the reasons the server parks a change most often, in the owner's words
const WHY: Record<string, string> = {
  [FIRST_CONSENT]:
    'First managed change on this server. Approve once so Spawnpoint can guard starts and friend sync, then it tests the change on a copy.',
  'approve the listed replacements, removals and config edits before promotion':
    'Tests passed. It replaces, removes or edits files, so check the list before it goes live.',
}

function headline(c: Candidate, live: boolean): string {
  if (c.status === 'applied' && !live) return 'The files are in place. Spawnpoint is checking the live boot, then publishes the exact pack to friends.'
  switch (c.status) {
    case 'collecting': return 'Collecting changes. Tests start a few seconds after the last one.'
    case 'testing': return `${c.detail.replace(/^./, (x) => x.toUpperCase())}. Nothing on the server changes until the tests pass.`
    case 'needs-approval': return WHY[c.detail] ?? `Needs your approval: ${c.detail.replace(/^not tested: /, '')}.`
    case 'ready': return `${c.approved ? 'Approved' : 'Passed its tests'}. It goes live on the next restart, so friends get it together with the server.`
    case 'activating': return 'Restarting the server to load it.'
    default: return `${c.detail.replace(/^./, (x) => x.toUpperCase())}.`
  }
}

/** When a change that waits for a restart will go live, and the owner's choices.
    `extra` joins the same button row, so a card never stacks two rows of buttons. */
export function RestartChoice({ id, p, busy, onDecide, extra }: { id: string; p: Promotion; busy: boolean; onDecide: (action: ChangeAction) => void; extra?: ReactNode }) {
  const start = useServerAction(id)
  if (p.restarting) return <p className="text-sm"><span className="hud !opacity-100 !inline-flex mr-2">RESTARTING</span>The server is restarting to load it.</p>
  const drop = p.action === 'apply'
    ? <button onClick={() => onDecide('discard')} disabled={busy} className="btn btn-block px-4 py-2 text-sm">Discard</button>
    : <button onClick={() => onDecide('cancel-undo')} disabled={busy} className="btn btn-block px-4 py-2 text-sm">Cancel undo</button>
  if (p.stopped) {
    return (
      <div className="space-y-3">
        <p className="text-sm">The server is stopped. Start it from this panel and the change goes in first.</p>
        <div className="flex gap-3 flex-wrap">
          <button onClick={() => start.mutate('start')} disabled={busy || start.isPending || start.isSuccess} className="btn btn-emerald px-4 py-2 text-sm">
            {start.isPending || start.isSuccess ? 'Starting…' : 'Start server'}
          </button>
          {extra}{drop}
        </div>
        {start.error && <p role="alert" className="text-sm text-redstone font-semibold">{start.error.message.replace(/^\d+: /, '')}</p>}
      </div>
    )
  }
  if (p.unknown) {
    return (
      <div className="space-y-3">
        <p className="text-sm">The panel cannot tell who is online (RCON does not answer), so it will not restart on its own. Restart the server to load it.</p>
        <div className="flex gap-3 flex-wrap">{extra}{drop}</div>
      </div>
    )
  }
  const n = p.players ?? 0
  const status = p.players === null ? 'Checking who is online…'
    : n === 0 ? 'Nobody is online, so the server restarts in a moment.'
      : p.choice === 'when-empty' ? `${n} player${n === 1 ? ' is' : 's are'} online. The server restarts once everyone has left.`
        : p.choice === 'now' ? 'Restarting after a 30-second warning in chat.'
          : `${n} player${n === 1 ? ' is' : 's are'} online and ${n === 1 ? 'was' : 'were'} told in chat. Restart now, or wait until everyone has left?`
  return (
    <div className="space-y-3">
      <p className="text-sm">{status}</p>
      {n > 0 && p.choice !== 'now' ? (
        <div className="flex gap-3 flex-wrap">
          <button onClick={() => onDecide('now')} disabled={busy} className="btn btn-emerald px-4 py-2 text-sm">Restart now (30 s warning)</button>
          {p.choice !== 'when-empty' && <button onClick={() => onDecide('when-empty')} disabled={busy} className="btn btn-block px-4 py-2 text-sm">When everyone has left</button>}
          {extra}{drop}
        </div>
      ) : extra && <div className="flex gap-3 flex-wrap">{extra}</div>}
    </div>
  )
}

/** The open change as a card: what it is, how far it got, what you can do. */
export function ChangeCard({ id, c, p }: { id: string; c: Candidate; p: Promotion | null }) {
  const decide = useDecide(id)
  const [, setReview] = useReviewParam()
  const rev = useRevState(id, c)
  const live = isLive(c, p, rev)
  const [tag, tagCls] = c.status === 'applied' && !live ? TAG.activating : TAG[c.status]
  const act = (action: ChangeAction) => decide.mutate({ action, revision: c.revision })
  const details = <button onClick={() => setReview(true)} className="btn btn-block px-4 py-2 text-sm">Plan and test details</button>
  return (
    <section className={`block p-4 sm:p-5 space-y-4 ${c.status === 'needs-approval' ? 'border-gold!' : ''}`} aria-live="polite">
      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`hud !opacity-100 ${tagCls}`}>{tag}</span>
          <span className="hud ml-auto">{fmtWhen(txnDate(c.txn))}</span>
        </div>
        <h2 className="text-xl sm:text-2xl mt-1.5">{changeName(c)}</h2>
        <p className="text-sm text-text-dim mt-1 max-w-[72ch]">{headline(c, live)}</p>
      </div>
      <div className="pipe-box"><Pipeline steps={stepsFor(c, p, rev)} /></div>
      {c.status === 'needs-approval' ? (
        <div className="flex gap-3 flex-wrap">
          <button onClick={() => setReview(true)} className="btn btn-emerald px-4 py-2 text-sm">Review and approve</button>
          <button onClick={() => act('retest')} disabled={decide.isPending} className="btn btn-block px-4 py-2 text-sm">Test again</button>
          <button onClick={() => act('discard')} disabled={decide.isPending} className="btn btn-block px-4 py-2 text-sm">Discard</button>
        </div>
      ) : c.status === 'ready' && p?.action === 'apply' ? (
        <RestartChoice id={id} p={p} busy={decide.isPending} onDecide={act} extra={details} />
      ) : (
        <div className="flex gap-3 flex-wrap">{details}</div>
      )}
      {decide.error && <p role="alert" className="text-sm text-redstone font-semibold">{decide.error.message.replace(/^\d+: /, '')}</p>}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The review sheet: the solver's plan, the tests and exactly what you approve.
// ---------------------------------------------------------------------------

const RESULT: Record<Verdict['result'], [string, string]> = {
  passed: ['✓ passed', 'text-emerald'],
  failed: ['✗ failed', 'text-redstone'],
  unverified: ['? not tested', 'text-gold'],
}

const versionOf = (pin: Pin, files: StagedFile[]): string =>
  files.find((f) => f.file === pin.file)?.entry?.versionNumber?.replace(/\+.*$/, '') ?? pin.file.replace(/\.jar$/, '')
const nameOf = (pin: Pin, files: StagedFile[]): string =>
  files.find((f) => f.file === pin.file)?.entry?.title ?? (pin.file.replace(/[-_]?(fabric|forge|neoforge|mc)?[-_]?\d.*$/i, '') || pin.file)

function PlanTable({ c }: { c: Candidate }) {
  const solved = c.solver?.status === 'ok' ? c.solver : c.solver?.status === 'inconclusive' ? c.solver.tentative : undefined
  type Row = { key: string; sign: string; name: string; version: string; kind: string; cls: string; note?: string }
  const rows: Row[] = solved
    ? [
        ...solved.changes.added.map((p) => ({ key: `a${p.file}`, sign: '+', name: nameOf(p, c.files), version: versionOf(p, c.files), kind: p.requested ? 'added' : 'dependency', cls: p.requested ? 'text-emerald' : 'text-diamond' })),
        ...solved.changes.changed.map(({ from, to }) => ({ key: `c${to.file}`, sign: '~', name: nameOf(to, c.files), version: `${from.file.replace(/\.jar$/, '')} → ${versionOf(to, c.files)}`, kind: 'changed', cls: 'text-gold' })),
        ...solved.changes.removed.map((p) => ({ key: `r${p.file}`, sign: '−', name: nameOf(p, c.files), version: p.file.replace(/\.jar$/, ''), kind: 'removed', cls: 'text-redstone' })),
      ]
    : c.files.map((f) => ({
        key: f.file, sign: f.remove ? '−' : f.replaces ? '~' : '+', name: titleOf(f), version: f.entry?.versionNumber?.replace(/\+.*$/, '') ?? f.file,
        kind: f.remove ? 'removed' : f.replaces ? 'changed' : f.to === 'shelf' ? 'client pack' : f.path ? 'config' : 'added',
        cls: f.remove ? 'text-redstone' : f.replaces || f.path ? 'text-gold' : 'text-emerald',
      }))
  if (!rows.length) return <p className="text-sm text-text-dim">No file changes in this plan.</p>
  return (
    <table className="ptable">
      <thead><tr><th scope="col">Mod</th><th scope="col">Version</th><th scope="col">Change</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="font-bold"><span className={`${r.cls} mr-1.5`} aria-hidden>{r.sign}</span>{r.name}</td>
            <td className="font-mono text-xs text-text-dim">{r.version}</td>
            <td><span className={`chip ${r.cls}`}>{r.kind}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function planSummary(c: Candidate): string {
  const s = c.solver
  if (!s) return 'files staged as uploaded'
  if (s.status === 'ok') return 'feasible, fewest changes'
  if (s.status === 'conflict') return 'no pack satisfies every constraint'
  return s.tentative ? 'feasible, fewest changes not proved' : 'inconclusive'
}

function ReviewBody({ id, c, p, onClose }: { id: string; c: Candidate; p: Promotion | null; onClose: () => void }) {
  const decide = useDecide(id)
  const [consent, setConsent] = useState(false)
  useEffect(() => setConsent(false), [c.revision, c.status])
  const rev = useRevState(id, c)
  const [tag, tagCls] = c.status === 'applied' && !isLive(c, p, rev) ? TAG.activating : TAG[c.status]
  const act = (action: ChangeAction) => decide.mutate({ action, revision: c.revision })
  const asked = c.files.filter((f) => f.entry?.via !== 'dependency' && !f.path)
  const excerpt = c.client?.excerpt?.length ? c.client.excerpt : c.server?.excerpt ?? []
  const solver = c.solver
  return (
    <div className="flex flex-col min-h-full">
      <div className="p-5 sm:p-6 space-y-5 flex-1">
        <div className="flex items-start gap-3">
          <div className="min-w-0">
            <span className={`hud !opacity-100 ${tagCls}`}>{tag}</span>
            <h2 className="text-2xl mt-1.5">Review change</h2>
          </div>
          <button onClick={onClose} className="btn btn-block ml-auto px-3 py-1.5 text-sm" aria-label="Close review">✕</button>
        </div>

        <section>
          <h3 className="hud mb-2">YOU ASKED FOR</h3>
          <ul className="space-y-1.5">
            {(asked.length ? asked : c.files).map((f) => (
              <li key={f.file} className="field px-3 py-2 text-sm font-bold flex gap-2 items-baseline">
                <span className="min-w-0 truncate">{titleOf(f)}</span>
                {f.entry?.versionNumber && <span className="font-mono text-xs text-text-dim ml-auto shrink-0">{f.entry.versionNumber.replace(/\+.*$/, '')}</span>}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="hud mb-2">PLAN · {planSummary(c).toUpperCase()}</h3>
          {solver?.status === 'conflict'
            ? <ul className="text-sm space-y-1 list-disc pl-5">{solver.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
            : <PlanTable c={c} />}
          {solver?.status === 'inconclusive' && <p className="text-xs text-gold mt-2">{solver.reason}</p>}
          {c.repairs?.length ? (
            <div className="mt-3">
              <div className="hud mb-1">AUTOMATIC REPAIRS</div>
              <ul className="text-xs space-y-1">{c.repairs.map((r) => <li key={r.detail}><b className="text-diamond">{r.kind}</b>: {r.detail}</li>)}</ul>
            </div>
          ) : null}
          {c.java && <p className="text-xs text-text-dim mt-2">Tested with a different Java: {c.java}</p>}
        </section>

        <section>
          <h3 className="hud mb-2">TESTS</h3>
          <table className="ptable">
            <tbody>
              {([['Server boot', c.server], ['Client join', c.client]] as const).map(([label, v]) => (
                <tr key={label}>
                  <th scope="row" className="!font-sans !text-[12.5px] !text-text font-bold w-28">{label}</th>
                  <td>
                    {v ? <><b className={RESULT[v.result][1]}>{RESULT[v.result][0]}{v.seconds ? ` in ${v.seconds} s` : ''}</b><span className="text-text-dim"> · {v.detail}</span></>
                      : <span className="text-text-dim">{c.status === 'testing' ? 'running…' : c.detail === FIRST_CONSENT ? 'runs after you approve' : 'not run'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {excerpt.length > 0 && <pre className="console p-2.5 mt-2 text-xs whitespace-pre-wrap max-h-40 overflow-auto">{excerpt.join('\n')}</pre>}
        </section>

        {c.consent?.length ? (
          <section>
            <h3 className="hud mb-2">YOU ARE APPROVING</h3>
            <ul className="text-sm space-y-1.5 list-disc pl-5">{c.consent.map((r) => <li key={r}>{r}</li>)}</ul>
            {c.revision && c.files.filter((f) => f.path).map((f) => (
              <a key={f.path} className="text-sky underline underline-offset-2 block break-all text-sm mt-2" target="_blank" rel="noreferrer"
                href={`/api/servers/${id}/candidate/config?revision=${encodeURIComponent(c.revision!)}&path=${encodeURIComponent(f.path!)}`}>
                Inspect before and after: {f.path}
              </a>
            ))}
          </section>
        ) : null}

        {c.status === 'ready' && p?.action === 'apply' && <RestartChoice id={id} p={p} busy={decide.isPending} onDecide={act} />}
        {decide.error && <p role="alert" className="text-sm text-redstone font-semibold">{decide.error.message.replace(/^\d+: /, '')}</p>}
      </div>

      <div className="sticky bottom-0 p-5 sm:px-6 border-t-2 border-ink space-y-3" style={{ background: 'var(--color-block)' }}>
        {c.status === 'needs-approval' && (
          <>
            <label className="flex items-start gap-2.5 text-sm">
              <input className="mt-1" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{c.detail === FIRST_CONSENT
                ? 'I approve the items above. The mod change itself is tested on a copy next and goes live only if it passes.'
                : c.server?.result === 'passed' && (c.client?.result ?? 'passed') === 'passed'
                  ? 'I approve the changes listed above.'
                  : 'I approve these changes and accept the test gaps shown above. Hash checks and world-restore consent cannot be waived.'}</span>
            </label>
            <button onClick={() => act('apply')} disabled={decide.isPending || !consent} className="btn btn-emerald w-full py-2.5 text-sm">
              {decide.isPending && decide.variables?.action === 'apply' ? 'Approving…' : 'Approve and continue'}
            </button>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => act('retest')} disabled={decide.isPending} className="btn btn-block py-2 text-sm">Test again</button>
              <button onClick={() => act('discard')} disabled={decide.isPending} className="btn btn-redstone py-2 text-sm">Discard</button>
            </div>
          </>
        )}
        <p className="hud !opacity-80 !text-[10px]">LIVE FILES STAY UNCHANGED UNTIL PROMOTION</p>
      </div>
    </div>
  )
}

/** Mounted once per workspace; any tab opens it with ?review. */
export function ReviewSheet({ id }: { id: string }) {
  const [open, setOpen] = useReviewParam()
  const { data } = useChange(id)
  const c = data?.candidate
  return (
    <Sheet open={open} onClose={() => setOpen(false)} label="Review change">
      {c ? <ReviewBody id={id} c={c} p={data?.promotion ?? null} onClose={() => setOpen(false)} />
        : (
          <div className="p-6 space-y-4">
            <div className="flex items-center"><h2 className="text-2xl">Review change</h2><button onClick={() => setOpen(false)} className="btn btn-block ml-auto px-3 py-1.5 text-sm" aria-label="Close review">✕</button></div>
            <p className="text-sm text-text-dim">There is no open change on this server. Install, update or remove a mod and it shows up here while it is tested.</p>
          </div>
        )}
    </Sheet>
  )
}

/** An undo of the last change, waiting for the server to restart. */
export function UndoWaitingBanner({ id, p }: { id: string; p: Promotion }) {
  const decide = useDecide(id)
  return (
    <section className="block border-sky! px-4 py-3 space-y-3" role="status">
      <p className="text-sm"><span className="hud !opacity-100 !inline-flex mr-2 text-sky">UNDO WAITING</span>The undo of the last mod change goes in when the server restarts, so friends never get a pack the server is not running.</p>
      <RestartChoice id={id} p={p} busy={decide.isPending} onDecide={(action) => decide.mutate({ action })} />
    </section>
  )
}

const TEST_LABEL: Record<string, string> = {
  server: 'SERVER BOOT', client: 'CLIENT', clientBoot: 'CLIENT BOOT', join: 'JOIN', handshake: 'SYNC', rendering: 'RENDERING',
  liveBoot: 'LIVE BOOT', publication: 'PUBLISHED', solver: 'SOLVER', optimality: 'FEWEST CHANGES',
}
/** A clean revision reads as one line; anything not passed gets its own chip. */
export function TestChips({ tests }: { tests: Revision['tests'] }) {
  const ran = Object.entries(tests).filter(([, v]) => v.result !== 'skipped')
  const passed = ran.filter(([, v]) => v.result === 'passed')
  const rest = ran.filter(([, v]) => v.result !== 'passed')
  const label = (k: string) => TEST_LABEL[k] ?? k.toUpperCase()
  return (
    <span className="flex gap-1.5 flex-wrap">
      {passed.length > 0 && (
        <span className="chip text-emerald" title={passed.map(([k, v]) => `${label(k)}: ${v.detail}`).join('\n')}>
          ✓ {rest.length ? passed.length : `ALL ${passed.length}`} CHECKS PASSED
        </span>
      )}
      {rest.map(([k, v]) => (
        <span key={k} title={`${label(k)}: ${v.detail}`} className={`chip ${v.result === 'failed' ? 'text-redstone' : 'text-gold'}`}>
          {label(k)} {v.result === 'failed' ? '✗' : '?'}
        </span>
      ))}
    </span>
  )
}

interface Rejection { at: string; jars: string[]; reason: string[] }

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Changes the tests turned away in the last 48 hours; nothing live changed. */
export function Rejections({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['installed', id],
    queryFn: () => api<{ rejections?: Rejection[] }>(`/api/servers/${id}/installed`),
  })
  const list = data?.rejections ?? []
  if (!list.length) return null
  return (
    <section className="block border-gold! px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <span className="hud !opacity-100 text-gold">TURNED AWAY · LAST 48 H</span>
          <p className="mt-1.5"><b>The tests turned away {plural(list.reduce((n, r) => n + r.jars.length, 0), 'mod file')}.</b> Nothing on the server changed.</p>
          {list.map((r) => (
            <p key={r.at} className="mt-1 font-mono text-xs break-words">{fmtWhen(new Date(r.at))} · {r.jars.join(', ')}: {r.reason[0] ?? 'see the panel log'}</p>
          ))}
        </div>
        <button
          className="btn btn-block px-3 py-1 text-xs shrink-0"
          onClick={() => void fetch(`/api/servers/${id}/rejections`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: ['installed', id] }))}
        >
          Dismiss
        </button>
      </div>
    </section>
  )
}
