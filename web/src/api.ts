// Typed API client + TanStack Query hooks
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router'

export interface Detection {
  loader: string
  mc: string | null
}
export interface ServerInfo {
  id: string
  name: string
  port: number
  path: string
  active: boolean
  detection: Detection
  /** this machine's LAN address, used when the panel is open on localhost */
  lan?: string | null
}
export interface Stats {
  running: boolean
  crashed: boolean
  waiting_start: boolean
  started: string
  cpu: number
  mem: number | string
  mem_percent: number
  online: number
  max: number
  players: string
  version: string
  desc: string
  world_size: string
  phase?: 'stopped' | 'starting' | 'ready'
  /** an operation that owns the server; `interrupted` when it stopped part-way
      (a panel restart, or `note` says why) and waits for the owner */
  maintenance?: { op: string; since: string; interrupted: boolean; note?: string } | null
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  if (!r.ok) {
    // the server's own sentence ({ error } or Fastify's { message }), not its JSON
    const text = await r.text()
    let why = text
    try { const j = JSON.parse(text) as { error?: string; message?: string }; why = j.error ?? j.message ?? text } catch { /* plain text */ }
    throw new Error(`${r.status}: ${why}`)
  }
  return r.json() as Promise<T>
}

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: ServerInfo[]; active: string | null; warning?: string }>('/api/servers'),
    refetchInterval: 10_000,
  })
}

export function useStats(id: string | undefined) {
  return useQuery({
    queryKey: ['stats', id],
    queryFn: () => api<Stats>(`/api/servers/${id}/stats`),
    enabled: !!id,
    refetchInterval: 4_000,
  })
}

export function useLogs(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['logs', id],
    queryFn: () => api<{ lines: string[] }>(`/api/servers/${id}/logs?tail=200`),
    enabled: !!id && enabled,
    refetchInterval: 2_500,
  })
}

export function useSetActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api('/api/servers/active', { method: 'POST', body: JSON.stringify({ id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })
}

export function useServerAction(id: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (action: 'start' | 'stop' | 'restart') =>
      api(`/api/servers/${id}/action`, { method: 'POST', body: JSON.stringify({ action }) }),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['stats', id] }), 1500),
  })
}

export interface AutostopStatus {
  enabled: boolean
  idleMinutes: number
  idle: { id: string; emptyForSec: number; stopsInSec: number }[]
}

export function useAutostop() {
  return useQuery({
    queryKey: ['autostop'],
    queryFn: () => api<AutostopStatus>('/api/autostop'),
    refetchInterval: 10_000,
  })
}

export function useSetAutostop() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cfg: { enabled: boolean; idleMinutes: number }) =>
      api('/api/autostop', { method: 'PUT', body: JSON.stringify(cfg) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['autostop'] }),
  })
}

export function useSendCommand(id: string | undefined) {
  return useMutation({
    mutationFn: (cmd: string) =>
      api<{ ok: boolean; via: string; output?: string }>(`/api/servers/${id}/command`, {
        method: 'POST',
        body: JSON.stringify({ cmd }),
      }),
  })
}

/** The server the current workspace URL (/s/:id/…) points at. */
export function useCurrentServer(): ServerInfo | undefined {
  const { id } = useParams()
  const { data } = useServers()
  return id ? data?.servers.find((s) => s.id === id) : undefined
}

/** Which servers the independent supervisor owns; the rest belong to Crafty. */
export function useRuntime() {
  return useQuery({
    queryKey: ['runtime'],
    queryFn: () => api<{ mode: 'crafty' | 'standalone'; supervisor: boolean; native: { id: string; name: string; autoStart: boolean; blocked?: string }[] }>('/api/runtime'),
    staleTime: 30_000,
  })
}

// ---- tested mod changes ----------------------------------------------------

export interface Verdict { result: 'passed' | 'failed' | 'unverified'; detail: string; excerpt?: string[]; seconds?: number }
export interface Pin { projectId: string; versionId: string; file: string; requested: boolean }
export interface SolvedPlan { plan: Pin[]; changes: { added: Pin[]; removed: Pin[]; changed: { from: Pin; to: Pin }[] }; warnings: string[] }
export type SolveResult =
  | ({ status: 'ok' } & SolvedPlan)
  | { status: 'conflict'; explanation: string[] }
  | { status: 'inconclusive'; reason: string; tentative?: SolvedPlan }
export interface StagedFile {
  file: string
  path?: string
  to: 'mods' | 'shelf'
  replaces?: string
  remove?: boolean
  entry?: { title: string; versionNumber?: string; via?: 'direct' | 'dependency' }
}
export interface Candidate {
  txn: string
  status: 'collecting' | 'testing' | 'needs-approval' | 'ready' | 'activating' | 'applied' | 'rejected'
  detail: string
  files: StagedFile[]
  server?: Verdict
  client?: Verdict
  approved?: boolean
  consent?: string[]
  revision?: string
  solver?: SolveResult
  repairs?: { kind: string; detail: string }[]
  java?: string
  updatedAt: string
}
/** A change waiting for the server to restart before it goes live. */
export interface Promotion {
  action: 'apply' | 'undo'
  txn: string
  choice: 'now' | 'when-empty' | null
  restarting: boolean
  /** the server is stopped: the change goes in when it is started from the panel */
  stopped: boolean
  /** RCON does not answer, so nobody can say who is online */
  unknown: boolean
  players: number | null
}
export type ChangeAction = 'apply' | 'retest' | 'discard' | 'now' | 'when-empty' | 'cancel-undo'

const LIVE_STATUS = ['collecting', 'testing', 'activating']

/** The open mod change and its restart, polled fast only while something moves. */
export function useChange(id: string | undefined) {
  return useQuery({
    queryKey: ['candidate', id],
    queryFn: () => api<{ candidate: Candidate | null; promotion: Promotion | null }>(`/api/servers/${id}/candidate`),
    enabled: !!id,
    refetchInterval: (q) => {
      const d = q.state.data
      if (LIVE_STATUS.includes(d?.candidate?.status ?? '') || d?.promotion?.restarting) return 3000
      return d?.promotion || d?.candidate?.status === 'ready' ? 5000 : 30_000
    },
  })
}

/** A change the owner has to look at: approve it, or pick when the server restarts. */
export function changeNeedsOwner(c: Candidate | null | undefined, p: Promotion | null | undefined): boolean {
  if (c?.status === 'needs-approval') return true
  return !!p && !p.restarting && !p.stopped && (p.players ?? 0) > 0 && p.choice === null
}

export function useDecide(id: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ action, revision }: { action: ChangeAction; revision?: string }) => {
      const base = `/api/servers/${id}`
      if (action === 'now' || action === 'when-empty') return api(`${base}/promotion`, { method: 'POST', body: JSON.stringify({ choice: action }) })
      if (action === 'cancel-undo') return api(`${base}/promotion`, { method: 'DELETE' })
      if (action === 'discard') return api(`${base}/candidate`, { method: 'DELETE' })
      return api(`${base}/candidate/${action}`, { method: 'POST', body: JSON.stringify(action === 'apply' ? { consent: true, revision } : {}) })
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['candidate', id] })
      qc.invalidateQueries({ queryKey: ['revisions', id] })
      qc.invalidateQueries({ queryKey: ['installed', id] })
    },
  })
}

export interface Revision {
  id: string; minecraft: string; loader: string; loaderVersion: string
  files: number; requested: number; dependencies: number; backup?: string
  tests: Record<string, { result: 'passed' | 'failed' | 'skipped' | 'inconclusive'; detail: string; renderer?: string }>
  approved?: { at: string; reasons: string[] }
}

export function useRevisions(id: string | undefined, live = false) {
  return useQuery({
    queryKey: ['revisions', id],
    queryFn: () => api<{ active?: string; published?: string; revisions: Revision[] }>(`/api/servers/${id}/revisions`),
    enabled: !!id,
    refetchInterval: live ? 5000 : false,
  })
}

/** Transactions and revisions are named after the moment they started. */
export function txnDate(id: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id)
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null
}

export const fmtWhen = (d: Date | null): string =>
  d ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown time'
