const layouts = new WeakMap()
const containers = '[data-chat-flow], [data-step-process-body], [data-chat-flow-kind], [data-slot="conversation.chat.node"], .bt-astack'
const concealed = { concealed: true }

// A tool can be rendered inside a reply or in its own DSH node. Walk only
// transcript containers, so a reply, reasoning row, or interactive card ends
// the run, and the contents of a tool receipt never enter the walk.
function toolRuns(flow, members) {
  const runs = []
  let run = []
  const finish = () => {
    if (run.length) runs.push(run)
    run = []
  }
  function visit(container) {
    for (const child of container.childNodes) {
      if (child.nodeType !== 1) {
        if (child.nodeType === 3 && child.textContent.trim()) finish()
        continue
      }
      const member = members.get(child)
      if (member) {
        if (run.length && run[0].turn !== member.turn) finish()
        run.push(member)
      } else if (child.hasAttribute('data-step-process')) {
        const body = child.querySelector(':scope > [data-step-process-body]')
        if (body) visit(body)
      } else if (child.matches(containers)) {
        visit(child)
      } else if (!child.hasAttribute('hidden')) {
        finish()
      }
    }
  }
  visit(flow)
  finish()
  return runs
}

function createLayout(flow) {
  const members = new Map()
  const expanded = new Set()
  let queued = false

  function publish(member, view) {
    const last = member.view
    if (last === view || (last && view && last.open === view.open && last.count === view.count &&
      last.running === view.running && last.failed === view.failed && last.concealed === view.concealed)) return
    member.view = view
    member.publish(view)
  }

  function sync() {
    const previouslyExpanded = new Set(expanded)
    expanded.clear()
    for (const run of toolRuns(flow, members)) {
      let count = 0, running = 0, failed = 0
      for (const { element } of run) {
        count += Number(element.dataset.gbToolCount)
        running += Number(element.dataset.gbToolRunning)
        failed += Number(element.dataset.gbToolFailed)
      }
      if (count < 2) {
        run[0].grouped = false
        publish(run[0], null)
        continue
      }
      const [first, ...rest] = run
      const focus = flow.ownerDocument.activeElement
      // Appending to a run keeps its disclosure open. If a lone call gains a
      // sibling while someone is interacting with it, keep that call visible.
      const open = run.some(member => previouslyExpanded.has(member) || (!member.grouped && member.element.contains(focus)))
      if (open) expanded.add(first)
      for (const member of run) member.grouped = true
      publish(first, { count, running, failed, open })
      for (const member of rest) publish(member, open ? null : concealed)
    }
  }

  function schedule() {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (members.size) sync()
    })
  }

  const observer = new MutationObserver(changes => {
    if (changes.some(({ target, type }) => type === 'attributes' || target === flow ||
      target.matches?.(containers) || target.hasAttribute?.('data-step-process'))) schedule()
  })
  observer.observe(flow, {
    childList: true, subtree: true,
    attributeFilter: ['data-gb-tool-count', 'data-gb-tool-running', 'data-gb-tool-failed'],
  })

  return {
    add(element, turn, update) {
      const member = { element, turn, publish: update, grouped: false }
      members.set(element, member)
      schedule()
      return {
        toggle() {
          if (!expanded.delete(member)) expanded.add(member)
          sync()
        },
        dispose() {
          members.delete(element)
          expanded.delete(member)
          if (members.size) schedule()
          else {
            observer.disconnect()
            layouts.delete(flow)
          }
        },
      }
    },
  }
}

export function observeToolGroups(element, turn, publish) {
  const flow = element.closest('[data-slot="conversation.chat.flow"]')
  if (!flow) return
  let layout = layouts.get(flow)
  if (!layout) {
    layout = createLayout(flow)
    layouts.set(flow, layout)
  }
  return layout.add(element, turn, publish)
}
