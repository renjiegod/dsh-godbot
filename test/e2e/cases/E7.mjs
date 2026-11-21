import { fullBudget } from '../full-budget.mjs'

export default async function E7({ makeHost, candidate, note }) {
  const host = await makeHost()
  host.model.models = ['deepseek-flash', 'deepseek-v4-pro']
  host.env.NODE_OPTIONS = '--import=' + new URL('../fixture-clock.mjs', import.meta.url).href
  await host.install(candidate)
  await host.start()
  await fullBudget(host, note, Date.now())
}
