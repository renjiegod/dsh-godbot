import { useCallback, useEffect, useRef, useState } from 'react'
import { providerChoices } from './provider-agents-model.js'

export function useProviderChoices(wanted, call, client) {
  const [agents, setAgents] = useState([])
  const [known, setKnown] = useState(false)
  const [scanning, setScanning] = useState(false)
  const revision = useRef(0)
  const load = useCallback(async (fresh = false) => {
    const id = ++revision.current
    setScanning(true)
    const [discovery, accounts] = await Promise.allSettled([
      call(fresh ? 'local-agent-refresh' : 'local-agents'),
      client.dispatch({ action:'provider-accounts' }),
    ])
    if (id !== revision.current) return
    setAgents(providerChoices(discovery.value, accounts.value))
    setScanning(false)
    setKnown(true)
  },[call,client])
  useEffect(() => {
    if (!wanted) return
    const refresh = () => { void load() }
    refresh()
    window.addEventListener('godbot:sandbox-settings-changed',refresh)
    return () => { revision.current++; window.removeEventListener('godbot:sandbox-settings-changed',refresh) }
  },[wanted,load])
  return { agents, known, scanning, refresh:() => load(true) }
}
