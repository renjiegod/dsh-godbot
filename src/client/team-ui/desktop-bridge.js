// Older desktop hosts expose the same preload capabilities under their original global.
export function desktopBridge() {
  return globalThis.godbotApp ?? globalThis.dsBotApp
}
