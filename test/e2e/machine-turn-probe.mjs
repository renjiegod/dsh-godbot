export const testTURN = async ({ host, viewer }) => {
  const left = new RTCPeerConnection({ iceServers: host, iceTransportPolicy: 'relay' })
  const right = new RTCPeerConnection({ iceServers: viewer, iceTransportPolicy: 'relay' })
  const pending = [[], []],
    pcs = [left, right],
    errors = []
  for (const [i, p] of pcs.entries())
    p.onicecandidate = (e) => {
      if (!e.candidate) return
      const dest = 1 - i
      if (pcs[dest].remoteDescription)
        void pcs[dest].addIceCandidate(e.candidate).catch((e) => errors.push(e.name))
      else pending[dest].push(e.candidate)
    }
  const channel = left.createDataChannel('proof')
  const delivery = new Promise((resolve) => {
    right.ondatachannel = (e) => {
      e.channel.onmessage = (m) => resolve(m.data)
    }
  })
  try {
    channel.onopen = () => channel.send('godbot-turn-proof')
    await left.setLocalDescription(await left.createOffer())
    await right.setRemoteDescription(left.localDescription)
    for (const c of pending[1]) await right.addIceCandidate(c)
    await right.setLocalDescription(await right.createAnswer())
    await left.setRemoteDescription(right.localDescription)
    for (const c of pending[0]) await left.addIceCandidate(c)
    const data = await Promise.race([
      delivery,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'TURN-only path failed: ' +
                  left.iceConnectionState +
                  ' / ' +
                  right.iceConnectionState +
                  ' ' +
                  errors.join(','),
              ),
            ),
          20000,
        ),
      ),
    ])
    const stats = await left.getStats(),
      pair = [...stats.values()].find((s) => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated)
    const local = stats.get(pair?.localCandidateId),
      remote = stats.get(pair?.remoteCandidateId)
    return { data, local: local?.candidateType, remote: remote?.candidateType, protocol: local?.relayProtocol }
  } finally {
    left.close()
    right.close()
  }
}
