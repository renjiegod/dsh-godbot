// Use the same provider/model catalog as DSH's own model picker. A slow
// provider discovery must never delay an operator trying to stop a turn.
export function dshModelCatalog(controller) {
  let models = [], profileDefault, issue, refreshAt = 0, pending
  function refresh() {
    if (!pending) {
      pending = Promise.resolve().then(() => controller.modelCatalog()).then(catalog => {
        models = catalog.groups.flatMap(group => group.models.map(model => ({
          provider: group.id, model: model.id, name: model.name || model.id,
          ...(model.reasoning ? { reasoning: model.reasoning } : {}),
        })))
        profileDefault = catalog.default
        issue = undefined
        refreshAt = Date.now() + 60_000
        return models
      }).catch(error => {
        issue = 'DSH model discovery is unavailable'
        refreshAt = Date.now() + 5_000
        throw error
      }).finally(() => { pending = undefined })
    }
    return pending
  }
  return {
    view() {
      if (Date.now() >= refreshAt) void refresh().catch(() => {})
      return { dshModels: models, ...(profileDefault ? { dshDefault: profileDefault } : {}), ...(issue ? { dshModelsError: issue } : {}) }
    },
    list: refresh,
    async require(provider, model, reasoningEffort) {
      const current = await refresh()
      const selected = current.find(item => item.provider === provider && item.model === model)
      if (!selected) throw new Error('This provider/model is not available in this DSH profile')
      if (reasoningEffort != null && !selected.reasoning?.efforts?.some(item => item.id === reasoningEffort)) {
        throw new Error('This reasoning effort is not available for the selected DSH provider and model')
      }
    },
  }
}
