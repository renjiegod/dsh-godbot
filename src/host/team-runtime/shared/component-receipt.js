export const COMPONENT_RECEIPT = 'godbot-component-v1'

export function readComponentReceipt(text) {
  if (typeof text !== 'string' || text.length > 16_384 || !text.startsWith('{')) return undefined
  try {
    const result = JSON.parse(text)
    if (result?.kind === COMPONENT_RECEIPT && typeof result.title === 'string' && result.view && typeof result.view.type === 'string') return result
  } catch {}
  return undefined
}
