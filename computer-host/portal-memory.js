const desktopScopes = ['desktop.view', 'desktop.control']
const validEntry = (entry) =>
  typeof entry?.token === 'string' &&
  entry.token.length > 0 &&
  entry.token.length <= 1024 &&
  typeof entry.streamId === 'string' &&
  entry.streamId.length > 0 &&
  entry.streamId.length <= 256

// This state belongs to the trusted local host. Controller RPCs never receive
// a portal token, even if a controller has a remembered desktop scope.
export function createPortalMemory(config, grants, save) {
  const eligible = (peer, scope) =>
    grants(peer).includes(scope) && grants(peer).includes('desktop.view')
  const policy = (peer, scope) => config.portalMemory?.[peer]?.[scope]

  function forget(peer, scope) {
    const records = config.portalMemory?.[peer]
    if (!records) return
    delete records[scope]
    if (!Object.keys(records).length) delete config.portalMemory[peer]
  }

  return {
    scopes(peer) {
      return desktopScopes.filter((scope) => policy(peer, scope)?.enabled === true)
    },
    enable(peer, scope) {
      config.portalMemory ??= {}
      config.portalMemory[peer] ??= {}
      config.portalMemory[peer][scope] ??= { enabled: true }
      save()
    },
    invalidate(peer, scope) {
      if (scope === 'desktop.control') forget(peer, scope)
      else if (scope === 'desktop.view' || scope === undefined) {
        forget(peer, 'desktop.view')
        forget(peer, 'desktop.control')
      }
    },
    disable(peer, scope) {
      forget(peer, scope)
      save()
    },
    session(peer, isCurrent) {
      const enabled = (scope) =>
        isCurrent() && policy(peer, scope)?.enabled === true && eligible(peer, scope)
      return {
        enabled,
        take(scope, context) {
          if (!enabled(scope)) return
          const saved = policy(peer, scope).saved
          const record = { enabled: true }
          config.portalMemory[peer][scope] = record
          const matches =
            validEntry(saved) &&
            saved.seat === context.seat &&
            saved.backend === context.backend &&
            saved.revision === context.revision
          if (saved) {
            // Restore tokens can be used once. Persist their consumption
            // before the native helper receives one across its private pipe.
            save()
          }
          return {
            request: {
              remember: true,
              ...(matches && { restore: { token: saved.token, streamId: saved.streamId } }),
            },
            replace(entry) {
              if (!enabled(scope) || policy(peer, scope) !== record || !validEntry(entry)) return
              record.saved = {
                seat: context.seat,
                backend: context.backend,
                revision: context.revision,
                token: entry.token,
                streamId: entry.streamId,
              }
              save()
            },
          }
        },
        clear(onlyScope) {
          if (!isCurrent()) return
          let changed = false
          for (const scope of desktopScopes) {
            if ((onlyScope && onlyScope !== scope) || !enabled(scope)) continue
            // Replace policy records as well as deleting tokens so that a
            // pending helper response cannot restore a cleared grant.
            config.portalMemory[peer][scope] = { enabled: true }
            changed = true
          }
          if (changed) save()
        },
      }
    },
  }
}
