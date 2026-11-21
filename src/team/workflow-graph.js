function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required')
  return value.trim()
}

export function compileWorkflow(input, allowedOwnerIds) {
  if (!Array.isArray(input.nodes) || !input.nodes.length) throw new Error('A workflow needs at least one node')
  if (!Array.isArray(input.edges)) throw new Error('Workflow edges must be an array')
  const incoming = new Map()
  const outgoing = new Map()
  const nodes = input.nodes.map(node => {
    const id = required(node?.id, 'Node ID')
    if (incoming.has(id)) throw new Error('Duplicate workflow node ID')
    incoming.set(id, [])
    outgoing.set(id, [])
    if (!allowedOwnerIds.has(node.ownerId)) throw new Error('Workflow node owner does not belong to this team')
    const join = node.join ?? 'all'
    if (!['all', 'any'].includes(join)) throw new Error('Workflow join must be all or any')
    return { id, ownerId: node.ownerId, title: required(node.title, 'Node title'), criteria: required(node.criteria, 'Acceptance criteria'), join }
  })
  const edges = input.edges.map(edge => {
    if (!edge || !incoming.has(edge.to) || !outgoing.has(edge.from)) throw new Error('Workflow edge references an unknown node')
    if (edge.from === edge.to) throw new Error('A workflow node cannot depend on itself')
    const predecessors = incoming.get(edge.to)
    if (predecessors.some(other => other.from === edge.from)) throw new Error('Duplicate workflow edge')
    const { from, to, when } = edge
    if (!['accepted', 'contains', 'not-contains'].includes(when)) throw new Error('Unknown workflow edge condition')
    if (when !== 'accepted' && (typeof edge.value !== 'string' || !edge.value.trim())) throw new Error('A text condition needs a value')
    const condition = when === 'accepted' ? { from, to, when } : { from, to, when, value: edge.value }
    predecessors.push(condition)
    outgoing.get(from).push(to)
    return condition
  })
  const remaining = new Map(nodes.map(node => [node.id, incoming.get(node.id).length]))
  const order = nodes.filter(node => !remaining.get(node.id)).map(node => node.id)
  for (const id of order) {
    for (const next of outgoing.get(id)) {
      remaining.set(next, remaining.get(next) - 1)
      if (!remaining.get(next)) order.push(next)
    }
  }
  if (order.length !== nodes.length) throw new Error('Workflow dependencies contain a cycle')
  return { name: required(input.name, 'Workflow name'), nodes, edges, incoming, order }
}

export function normalizeWorkflow(input, allowedOwnerIds) {
  const { name, nodes, edges } = compileWorkflow(input, allowedOwnerIds)
  return { name, nodes, edges }
}
