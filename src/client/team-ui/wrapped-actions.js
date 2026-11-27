import { useMemo, useRef } from 'react'

// A component that hands its subtree the team actions with a few of them wrapped (to
// start a view switch first, or to close the left drawer) must not hand down a new
// object on every render: a hook below that takes `actions` as a dependency would run
// again each time the parent draws, and a read made on mount would become a read per
// render. The copy keeps its identity for as long as the shared actions do, and each
// wrapper calls the version from the latest render.
export function useWrappedActions(actions, wrappers) {
  const latest = useRef(wrappers)
  latest.current = wrappers
  const names = Object.keys(wrappers).sort().join(',')
  return useMemo(() => {
    const copy = { ...actions }
    for (const name of names.split(',').filter(Boolean)) copy[name] = (...args) => latest.current[name](...args)
    return copy
  }, [actions, names])
}
