import { useEffect, useRef, useState, type ReactNode } from 'react'

/** A slide-over on the native <dialog>: modal focus, Esc and the top layer
    come from the browser. Content stays mounted while it slides out. */
export default function Sheet({ open, onClose, side = 'right', label, children }: {
  open: boolean
  onClose: () => void
  side?: 'right' | 'left'
  label: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [shown, setShown] = useState(open)

  // the page behind a modal sheet must not scroll under the user's thumb
  useEffect(() => {
    if (!open) return
    const root = document.documentElement
    const before = root.style.overflow
    root.style.overflow = 'hidden'
    return () => { root.style.overflow = before }
  }, [open])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open) {
      setShown(true)
      d.classList.remove('closing')
      if (!d.open) d.showModal()
      return
    }
    if (!d.open) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { d.close(); return }
    d.classList.add('closing')
    const done = () => { d.classList.remove('closing'); d.close() }
    d.addEventListener('animationend', done, { once: true })
    return () => d.removeEventListener('animationend', done)
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label={label}
      className={`sheet ${side === 'left' ? 'left' : ''}`}
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClose={() => setShown(false)}
      // a click on the dialog element itself is a click on the backdrop
      onClick={(e) => { if (e.target === ref.current) onClose() }}
    >
      {shown && <div className="h-full max-h-[inherit] overflow-y-auto overscroll-contain">{children}</div>}
    </dialog>
  )
}
