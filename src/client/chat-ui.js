import { createElement as h, useEffect, useRef, useState } from 'react'

const glyphs = {
  search: ['M21 21l-4.3-4.3', 'M19 10.5a8.5 8.5 0 11-17 0 8.5 8.5 0 0117 0Z'],
  add: ['M12 4v16M4 12h16'],
  close: ['m6 6 12 12M18 6 6 18'],
  back: ['M19 12H5m6-6-6 6 6 6'],
  folder: ['M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2Z'],
  panel: ['M4 4h16v16H4z', 'M9 4v16'],
  list: ['M8 6h12M8 12h12M8 18h12M3 6h.1M3 12h.1M3 18h.1'],
  chat: ['M4 4h16v13H9l-5 4Z'],
  more: ['M5 12h.1M12 12h.1M19 12h.1'],
  down: ['m6 9 6 6 6-6'],
  sliders: ['M4 7h8m4 0h4M4 17h3m4 0h9', 'M12 4v6m-5 4v6'],
  send: ['M12 19V5m-6 6 6-6 6 6'],
  stop: ['M7 7h10v10H7z'],
  terminal: ['m4 7 5 5-5 5m8 0h8'],
  monitor: ['M4 5h16v11H4zM12 16v4m-4 0h8'],
  task: ['M8 4h11v16H5V7', 'm7 12 2 2 4-4'],
  clock: ['M12 7v5l3 2', 'M21 12a9 9 0 11-18 0 9 9 0 0118 0Z'],
}
export function Icon({ name, size = 18 }) {
  return h(
    'svg',
    {
      className: 'gb-icon',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: name === 'more' ? 3.5 : 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    glyphs[name]?.map((d, i) => h('path', { key: i, d, fill: name === 'stop' ? 'currentColor' : 'none' })),
  )
}
export function iconButton(label, icon, onClick, props = {}) {
  return h(
    'button',
    { type: 'button', className: 'gb-iconbutton', 'aria-label': label, title: label, onClick, ...props },
    h(Icon, { name: icon }),
  )
}
export function closeMenus(target) {
  target?.closest('details')?.removeAttribute('open')
}
export function Pop({ label, icon, children, className = 'gb-iconbutton', align = 'end' }) {
  const el = useRef(null),
    [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const outside = (e) => {
      if (el.current && !el.current.contains(e.target)) el.current.open = false
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return h(
    'details',
    {
      ref: el,
      className: 'gb-pop',
      'data-align': align,
      onToggle: (e) => setOpen(e.currentTarget.open),
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.open = false
          e.currentTarget.querySelector('summary')?.focus()
        }
      },
    },
    h('summary', { className, title: label, 'aria-label': label }, h(Icon, { name: icon })),
    h(
      'div',
      {
        className: 'gb-popbody',
        onClick: (e) => {
          if (e.target.closest('button')) closeMenus(e.currentTarget)
        },
      },
      children,
    ),
  )
}
