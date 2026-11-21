// The lines between the earlier parts of a Bot's own chat (cells.js EarlierParts). An
// earlier part nobody talked in shows nothing but its line. Lines in a row keep the last
// one, and the line where the current part begins (drawn after these) needs none right
// above it. With every earlier part loaded (`complete`), a line with nothing above it
// marks no boundary either: the parts before it were all empty, and its time is when
// the part after it became current, not when the messages under it were written.
export function withoutEmptyParts(items, { complete = false } = {}) {
  const kept = items.filter((item, index) => item?.kind !== 'divider'
    || (index + 1 < items.length && items[index + 1]?.kind !== 'divider'))
  return complete && kept[0]?.kind === 'divider' ? kept.slice(1) : kept
}
