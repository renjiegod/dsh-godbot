import { createElement as h } from 'react'
import { webIconUrl } from '../../host/web-icon.js'

export function WorkspaceMark({ size = 24 }) {
  return h('img', { className: 'gb-product-mark', src: webIconUrl, width: size, height: size, alt: '', draggable: false })
}
