// Driver declarations carry only levels advertised for this particular model.
export function effortOptions(values = []) {
  return values.flatMap((value) => {
    const id = typeof value === 'string' ? value : (value?.reasoningEffort ?? value?.value ?? value?.id)
    return typeof id === 'string' && id ? [{ id, name: value.name ?? id }] : []
  })
}

export function requireEffort(options, effort) {
  if (effort != null && !options?.some((option) => option.id === effort)) {
    throw new Error('Reasoning effort is not supported by the selected model: ' + effort)
  }
}
