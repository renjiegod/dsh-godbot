const taskPrompt = /Task ([\da-f-]+): ([^\n]+)\nAssignment: ([\da-f-]+)/

/** The Bot returns its result through its ordinary DSH reply in the assigned private chat. */
export function reportBotAssignments(host, answer) {
  const seen = new Set()
  host.model.reply = async (body, call) => {
    const user = body.messages.filter(message => message.role === 'user').reverse()
    const requests = user.map(message => typeof message.content === 'string' ? message.content :
      message.content.map(part => part.type === 'text' ? part.text : '').join('\n'))
    const assignment = requests.find(text => taskPrompt.test(text))
    if (!assignment) return 'Acknowledged.'
    const [, taskId, title, assignmentId] = taskPrompt.exec(assignment)
    if (seen.has(assignmentId)) return 'Acknowledged.'
    seen.add(assignmentId)
    const evidence = await answer({ taskId, title, assignmentId, assignment, sessionId: call.sessionId })
    if (evidence === undefined) return 'Acknowledged.'
    return evidence
  }
}
