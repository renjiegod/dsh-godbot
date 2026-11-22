import { createElement as h, useLayoutEffect, useRef } from 'react'
import { m } from './machine-copy.js'

export function MachineConfirmation({ text, cancel, confirm }) {
  const dialog = useRef(null)
  useLayoutEffect(() => {
    const previous = document.activeElement
    const node = dialog.current
    node.showModal()
    return () => {
      node.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return h(
    'dialog',
    {
      ref: dialog,
      className: 'gb-machine-confirm',
      role: 'alertdialog',
      'aria-modal': true,
      'aria-label': text,
      onCancel: (event) => {
        event.preventDefault()
        event.stopPropagation()
        cancel()
      },
    },
    h('p', null, text),
    h('button', { type: 'button', onClick: cancel }, m('Cancel')),
    h('button', { type: 'button', className: 'gb-machine-primary', onClick: confirm }, m('Continue')),
  )
}
