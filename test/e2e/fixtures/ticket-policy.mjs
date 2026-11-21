// A profile policy for the synthetic work-order server. The real DSH tool pipeline
// prompts the owner before this fixture's write proceeds.
export const name = 'godbot-fixture-ticket-policy'
export const inject = ['tools']
export async function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    const firstReview = exec.name === 'godbot_report_result' && exec.arguments?.evidence?.startsWith('E4-initial-')
    if (decision.kind !== 'allow' || (exec.name !== 'mcp__tickets__write' && !firstReview)) return decision
    return { kind: 'ask', reason: 'Confirm the test ticket update' }
  })
}
