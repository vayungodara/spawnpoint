import { useEffect, useState, type CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useServers } from '../api'
import { Pi } from '../components/PixelIcons'

// FILE MANAGER — browse/edit/upload/download anything under the active
// server's directory. Paths are server-confined by the backend; this page is
// deliberately plain: list, breadcrumbs, a text editor for small files.

interface Entry { name: string; dir: boolean; size: number; mtime: number }
interface PackInfo { kind: 'mrpack' | 'curseforge'; name: string; mc: string | null; loader: string | null; fileCount: number }

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const fmtTime = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })

export default function Files() {
  const qc = useQueryClient()
  const { data: serversData } = useServers()
  const active = serversData?.servers.find((s) => s.active)
  const id = active?.id

  const [path, setPath] = useState('') // current directory, '' = server root
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<{ path: string; dir: boolean; size: number }[] | null>(null)
  const runSearch = async (q: string) => {
    setSearch(q)
    if (q.trim().length < 2) { setSearchResults(null); return }
    const r = await fetch(`/api/servers/${id}/files/search?q=${encodeURIComponent(q)}`)
    const j = (await r.json()) as { results?: { path: string; dir: boolean; size: number }[] }
    setSearchResults(j.results ?? [])
  }
  const jumpTo = (p: string, dir: boolean) => {
    setSearch(''); setSearchResults(null)
    // land in the folder (for files: the containing folder, file visible in
    // the listing) — opening directly would race the path state update
    setPath(dir ? p : p.split('/').slice(0, -1).join('/'))
  }
  const [editing, setEditing] = useState<{ path: string; content: string; dirty: boolean } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // dragenter/dragleave fire for every child element crossed, so a plain
  // boolean flickers — count enters/leaves and show the overlay while > 0
  const [dragDepth, setDragDepth] = useState(0)
  // an uploaded file the server recognized as a modpack — offer install /
  // new-server instead of leaving it as a mystery zip
  const [packFile, setPackFile] = useState<({ path: string } & PackInfo) | null>(null)
  const [packJob, setPackJob] = useState<string | null>(null)
  const packJobQuery = useQuery({
    queryKey: ['create-job', packJob],
    queryFn: async () =>
      (await (await fetch(`/api/create-jobs/${packJob}`)).json()) as { status: string; done: boolean; error: string | null },
    enabled: !!packJob,
    refetchInterval: (q) => (q.state.data?.done ? false : 3000),
  })
  useEffect(() => {
    if (packJobQuery.data?.done) qc.invalidateQueries({ queryKey: ['servers'] })
  }, [packJobQuery.data?.done, qc])
  const packInstall = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/servers/${id}/packfile/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: packFile!.path }),
      })
      return (await r.json()) as { name?: string; installed?: number; skippedClientOnly?: number; error?: string }
    },
    onSuccess: (r) => {
      if (r.error) return flash(`✗ ${r.error}`)
      flash(`✓ ${r.name}: ${r.installed} files installed${r.skippedClientOnly ? `, ${r.skippedClientOnly} client-only skipped` : ''} — boot check runs in the background`)
      setPackFile(null)
      refresh()
    },
  })
  const packCreate = useMutation({
    mutationFn: async (name: string) => {
      const r = await fetch(`/api/servers/${id}/packfile/create-server`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: packFile!.path, name }),
      })
      const j = (await r.json()) as { jobId?: string; error?: string }
      if (j.error || !j.jobId) throw new Error(j.error ?? 'could not start the create job')
      return j.jobId
    },
    onSuccess: (jobId) => setPackJob(jobId),
    onError: (e) => flash(`✗ ${String(e).replace(/^Error: /, '')}`),
  })

  const { data, isLoading } = useQuery({
    queryKey: ['files', id, path],
    enabled: !!id && !editing,
    queryFn: async () => {
      const r = await fetch(`/api/servers/${id}/files?path=${encodeURIComponent(path)}`)
      return (await r.json()) as { entries?: Entry[]; error?: string }
    },
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['files', id, path] })

  const flash = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(null), 4000)
  }

  const openFile = async (name: string) => {
    const p = path ? `${path}/${name}` : name
    const r = await fetch(`/api/servers/${id}/files/content?path=${encodeURIComponent(p)}`)
    const j = (await r.json()) as { content?: string; binary?: boolean; tooLarge?: boolean; size?: number; error?: string }
    if (j.error) return flash(`✗ ${j.error}`)
    if (j.binary || j.tooLarge) {
      // not editable — hand the browser the download instead
      window.open(`/api/servers/${id}/files/download?path=${encodeURIComponent(p)}`, '_blank')
      return
    }
    setEditing({ path: p, content: j.content ?? '', dirty: false })
  }

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/servers/${id}/files/content`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: editing!.path, content: editing!.content }),
      })
      return (await r.json()) as { ok?: boolean; error?: string }
    },
    onSuccess: (r) => {
      if (r.ok) {
        setEditing((e) => (e ? { ...e, dirty: false } : e))
        flash('✓ saved')
      } else flash(`✗ ${r.error}`)
    },
  })

  const act = useMutation({
    mutationFn: async (p: { url: string; body: unknown }) => {
      const r = await fetch(`/api/servers/${id}/files/${p.url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p.body),
      })
      return (await r.json()) as { ok?: boolean; error?: string }
    },
    onSuccess: (r) => {
      if (r.ok) refresh()
      else flash(`✗ ${r.error}`)
    },
  })

  const upload = async (file: File) => {
    // streamed raw — no base64, no giant in-memory string, any size
    flash(`uploading ${file.name} (${(file.size / 1048576).toFixed(0)}MB)…`)
    const q = `path=${encodeURIComponent(path)}&filename=${encodeURIComponent(file.name)}`
    const r = await fetch(`/api/servers/${id}/files/upload-stream?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    })
    const j = (await r.json()) as { ok?: boolean; error?: string; pack?: PackInfo }
    if (j.ok) {
      flash(`✓ uploaded ${file.name}${file.name.endsWith('.jar') ? ' — boot-check runs in the background, it appears under Content → Installed' : ''}`)
      if (j.pack) setPackFile({ path: path ? `${path}/${file.name}` : file.name, ...j.pack })
      refresh()
    } else flash(`✗ ${j.error}`)
  }

  const uploadMany = async (files: File[]) => {
    // sequential on purpose: one flash + one refresh at a time, and parallel
    // multi-GB streams would fight the live server for disk bandwidth
    for (const f of files) await upload(f)
    if (files.length > 1) flash(`✓ uploaded ${files.length} files`)
  }

  const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  if (!active)
    return (
      <div className="p-6">
        <p className="text-text-dim">No active server — pick one on the Servers page.</p>
      </div>
    )

  const crumbs = path ? path.split('/') : []

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-3xl">Files — {active.name}</h1>
        {msg && <span key={msg} className="hud !opacity-100 text-gold pop-in">{msg}</span>}
      </div>

      {editing ? (
        <div className="block p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Pi i="crate" className="pi pi-s" />
            <span className="text-sm font-bold font-mono">{editing.path}</span>
            {editing.dirty && <span className="hud text-gold !opacity-100">UNSAVED</span>}
            <div className="ml-auto flex gap-2">
              <button className="btn text-xs" disabled={!editing.dirty || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'saving…' : 'Save'}
              </button>
              <button
                className="btn text-xs"
                onClick={() => {
                  if (editing.dirty && !window.confirm('Discard unsaved changes?')) return
                  setEditing(null)
                }}
              >
                Close
              </button>
            </div>
          </div>
          <textarea
            className="w-full h-[60vh] font-mono text-xs bg-panel border-2 border-ink p-3 resize-y"
            value={editing.content}
            spellCheck={false}
            onChange={(e) => setEditing({ ...editing, content: e.target.value, dirty: true })}
          />
        </div>
      ) : (
        <div
          className="block p-4 space-y-3 relative"
          onDragEnter={(e) => { if (dragHasFiles(e)) { e.preventDefault(); setDragDepth((d) => d + 1) } }}
          onDragOver={(e) => { if (dragHasFiles(e)) e.preventDefault() }}
          onDragLeave={(e) => { if (dragHasFiles(e)) setDragDepth((d) => Math.max(0, d - 1)) }}
          onDrop={(e) => {
            if (!dragHasFiles(e)) return
            e.preventDefault()
            setDragDepth(0)
            // a dropped folder arrives as an unreadable pseudo-file — screen
            // them out via the entry API rather than guessing from size/type
            const items = Array.from(e.dataTransfer.items)
            const files = items.length
              ? items
                  .filter((it) => it.kind === 'file' && !it.webkitGetAsEntry?.()?.isDirectory)
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => f !== null)
              : Array.from(e.dataTransfer.files)
            if (files.length) void uploadMany(files)
            else flash('✗ nothing uploadable — drop files, not folders')
          }}
        >
          {dragDepth > 0 && (
            <div className="absolute inset-0 z-10 bg-panel/90 border-4 border-dashed border-gold flex flex-col items-center justify-center gap-2 pointer-events-none pop-in">
              <Pi i="chest" className="pi" />
              <span className="text-sm font-bold text-gold">Drop to upload</span>
              <span className="text-xs text-text-dim font-mono">→ {active.name}{path ? `/${path}` : ''}/</span>
            </div>
          )}
          {packFile && (
            <div className="border-2 border-diamond/50 bg-diamond/10 p-4 space-y-2 pop-in">
              <div className="flex items-center gap-2 flex-wrap">
                <Pi i="chest" className="pi pi-s" />
                <span className="font-bold">{packFile.name}</span>
                <span className="text-xs text-text-dim">
                  {packFile.kind === 'curseforge' ? 'CurseForge' : 'Modrinth'} modpack · {packFile.loader ?? 'unknown loader'}{' '}
                  {packFile.mc ?? ''} · {packFile.fileCount} mods
                </span>
              </div>
              {packJob ? (
                <div className="text-xs font-semibold flex items-center gap-2">
                  {!packJobQuery.data?.done && <span className="lamp lamp-starting" />}
                  {packJobQuery.data?.done && !packJobQuery.data?.error && <span className="lamp lamp-on" />}
                  {packJobQuery.data?.error && <span className="lamp lamp-crash" />}
                  <span>{packJobQuery.data?.error ? `✗ ${packJobQuery.data.error}` : (packJobQuery.data?.status ?? 'starting…')}</span>
                  {packJobQuery.data?.done && (
                    <button className="btn text-xs !py-0" onClick={() => { setPackJob(null); setPackFile(null) }}>ok</button>
                  )}
                </div>
              ) : (
                <div className="flex gap-2 flex-wrap items-center">
                  <button
                    className="btn btn-emerald text-xs"
                    disabled={packInstall.isPending}
                    onClick={() => packInstall.mutate()}
                    title="Pour this pack's server-side mods + configs into the current server"
                  >
                    {packInstall.isPending ? 'installing… (minutes)' : `Install into ${active.name}`}
                  </button>
                  <button
                    className="btn text-xs"
                    disabled={packCreate.isPending}
                    onClick={() => {
                      const name = window.prompt('Name for the new server?', packFile.name)
                      if (name !== null) packCreate.mutate(name.trim() || packFile.name)
                    }}
                    title="Create a brand-new server running this pack"
                  >
                    New server from pack
                  </button>
                  <button className="btn text-xs" onClick={() => setPackFile(null)}>
                    Just keep the file
                  </button>
                </div>
              )}
            </div>
          )}
          {searchResults !== null && (
            <div className="border-2 border-line/40 p-3 space-y-1">
              <div className="text-xs text-text-dim">{searchResults.length} match(es){searchResults.length >= 100 ? ' (capped — refine the search)' : ''}</div>
              {searchResults.map((r) => (
                <button key={r.path} className="block w-full text-left font-mono text-xs hover:bg-panel px-2 py-1" onClick={() => jumpTo(r.path, r.dir)}>
                  {r.dir ? '📁 ' : ''}{r.path}{!r.dir && r.size ? ` · ${(r.size / 1024).toFixed(0)}KB` : ''}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <button className="btn text-xs" onClick={() => setPath('')}>
              {active.name}
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-2">
                <span className="text-text-dim">/</span>
                <button className="btn text-xs" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>
                  {c}
                </button>
              </span>
            ))}
            <div className="ml-auto flex gap-2">
              <input
                className="input text-xs w-44"
                placeholder="search files…"
                value={search}
                onChange={(e) => void runSearch(e.target.value)}
              />
              <label className="btn text-xs cursor-pointer">
                Upload
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void upload(f)
                    e.target.value = ''
                  }}
                />
              </label>
              <button
                className="btn text-xs"
                onClick={() => {
                  const name = window.prompt('New folder name')?.trim()
                  if (name) act.mutate({ url: 'mkdir', body: { path: path ? `${path}/${name}` : name } })
                }}
              >
                New folder
              </button>
            </div>
          </div>

          {isLoading && <p className="text-xs text-text-dim italic">reading…</p>}
          {data?.error && <p className="text-xs text-redstone">✗ {data.error}</p>}

          <table className="w-full text-xs">
            <tbody>
              {path !== '' && (
                <tr className="cursor-pointer hover:bg-panel" onClick={() => setPath(crumbs.slice(0, -1).join('/'))}>
                  <td className="py-1.5 pl-1 font-bold" colSpan={4}>
                    ← up
                  </td>
                </tr>
              )}
              {(data?.entries ?? []).map((e, i) => {
                const rel = path ? `${path}/${e.name}` : e.name
                return (
                  <tr key={e.name} className="border-t border-line/40 hover:bg-panel rise-in" style={{ '--i': i } as CSSProperties}>
                    <td
                      className="py-1.5 pl-1 cursor-pointer font-mono"
                      onClick={() => (e.dir ? setPath(rel) : void openFile(e.name))}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Pi i={e.dir ? 'chest' : 'crate'} className="pi pi-s" />
                        {e.name}
                        {e.dir ? '/' : ''}
                      </span>
                    </td>
                    <td className="text-right text-text-dim w-20">{e.dir ? '' : fmtSize(e.size)}</td>
                    <td className="text-right text-text-dim w-32 hidden sm:table-cell">{fmtTime(e.mtime)}</td>
                    <td className="text-right w-44">
                      {renaming?.from === rel ? (
                        <span className="inline-flex gap-1">
                          <input
                            className="bg-panel border-2 border-ink px-1 w-28 font-mono"
                            value={renaming.to}
                            autoFocus
                            onChange={(ev) => setRenaming({ ...renaming, to: ev.target.value })}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter' && renaming.to.trim()) {
                                act.mutate({ url: 'rename', body: { from: rel, to: path ? `${path}/${renaming.to.trim()}` : renaming.to.trim() } })
                                setRenaming(null)
                              }
                              if (ev.key === 'Escape') setRenaming(null)
                            }}
                          />
                        </span>
                      ) : confirmDelete === rel ? (
                        <span className="shake-once inline-flex gap-1 items-center">
                          <span className="text-redstone">delete?</span>
                          <button
                            className="btn text-xs !py-0"
                            onClick={() => {
                              act.mutate({ url: 'delete', body: { path: rel } })
                              setConfirmDelete(null)
                            }}
                          >
                            yes
                          </button>
                          <button className="btn text-xs !py-0" onClick={() => setConfirmDelete(null)}>
                            no
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-1 opacity-70">
                          {!e.dir && (
                            <a
                              className="btn text-xs !py-0"
                              href={`/api/servers/${id}/files/download?path=${encodeURIComponent(rel)}`}
                            >
                              dl
                            </a>
                          )}
                          <button className="btn text-xs !py-0" onClick={() => setRenaming({ from: rel, to: e.name })}>
                            mv
                          </button>
                          <button className="btn text-xs !py-0" onClick={() => setConfirmDelete(rel)}>
                            rm
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data?.entries?.length === 0 && <p className="text-xs text-text-dim italic">empty folder</p>}
        </div>
      )}
    </div>
  )
}
