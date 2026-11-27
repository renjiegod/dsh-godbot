// Modified for Godbot. See THIRD_PARTY_NOTICES.
import { SOURCE_KIND } from './constants.js'
import { requestTitle } from './part-titles.js'
import { textOf } from './text.js'
import { conversationHead, ownConversations } from './threads.js'

const CONVERSATIONS_MAX = 12
const PROMPTS_MAX = 4
const TOPIC_CHARS = 3000
const HISTORY_PAGES = 2
const HISTORY_MS = 2000
const MATCH_MARGIN = 0.08
const words = new Intl.Segmenter(undefined, { granularity: 'word' })
const common = new Set((
  'about after again also and are ask been before bot but can could current did does done for from get give had has ' +
  'have help here how into just let make more need new now only our out please reply report send should some take ' +
  'than that the their them then there these they this those through time too use want was were what when where ' +
  'which who will with work would you your 更新 这个 那个 可以 需要 麻烦 帮忙 请问 一下 现在 继续 处理 回复'
).split(' '))

// A task key names one task: an uppercase project key and a number, as in OPS-213 or
// GB-12, also inside Chinese text. Standards and model families written the same way
// (SHA-256, UTF-8, GPT-5) name no task, a version (GPT-6.2) is no key, and a lowercase
// name such as gemini-3 is a name. A key decides a match by itself, so a false one
// would put a message in a conversation it does not belong to.
const TASK_KEY = /(?<![A-Za-z\d_-])([A-Z]{2,10})-\d{1,10}(?![A-Za-z\d_]|[.-]\d)/gu
const NOT_TASKS = new Set(['AES', 'CRC', 'ECMA', 'GLM', 'GPT', 'IEEE', 'ISO', 'MPEG', 'PEP', 'RFC', 'RSA', 'SHA', 'UTF'])

// Read topics locally. Shared task terms and identifiers are positive evidence;
// a sender name, recent activity, or the foreground selection alone never is.
function topic(text) {
  const read = text.slice(0, TOPIC_CHARS).normalize('NFKC')
  const normalized = read.toLowerCase()
  const terms = [...words.segment(normalized)]
    .filter(({ isWordLike, segment }) => isWordLike && /\p{L}/u.test(segment) && !common.has(segment)
      && (/[^\u0000-\u007f]/u.test(segment) || segment.length > 2))
    .map(({ segment }) => segment)
  const issues = new Set([...read.matchAll(TASK_KEY)].filter(([, project]) => !NOT_TASKS.has(project)).map(([key]) => key))
  return { terms: new Set(terms), phrase: terms.join(' '), issues }
}

function similarity(query, prior) {
  const sameIssue = [...query.issues].some(issue => prior.issues.has(issue))
  if (query.issues.size && prior.issues.size && !sameIssue) return 0
  const matches = [...query.terms].filter(term => prior.terms.has(term)).length
  if (matches >= 2 && query.phrase === prior.phrase) return 1
  if (sameIssue) return 0.95
  const coverage = 2 * matches / (query.terms.size + prior.terms.size)
  return matches >= 3 && coverage >= 0.6 ? coverage : 0
}

export const relatedBotMessages = (message, previous) => similarity(topic(message), topic(previous)) > 0

// Session IDs as Godbot writes them. The ID is what the user copies from a session row
// and what a Bot is told when work is handed on outside message_bot.
const SESSION_ID = /(?<![\w-])session-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}(?![\w-])/giu

// The one conversation of `bot` a message names by session ID: any part of it, so a
// conversation that went on to a newer part after a context handoff is still found.
// A Bot's first part has the Bot's id (threads.js currentSession), so that id names its
// first conversation. A message that names two of its conversations leaves the choice
// to the topic.
export function mentionedConversation(bot, text) {
  const heads = new Set()
  for (const [id] of String(text ?? '').normalize('NFKC').matchAll(SESSION_ID)) {
    const head = conversationHead(bot, id.toLowerCase())
    if (head !== undefined) heads.add(head)
  }
  return heads.size === 1 ? [...heads][0] : undefined
}

function promptOf(event) {
  if (event.type !== 'user/message') return undefined
  const source = event.data?.source
  const text = textOf(event.data?.content)
  if (source?.kind === undefined || source.kind === 'user') return text
  if (source.kind === SOURCE_KIND && source.role === 'request' && !source.handoff && !source.resumed) {
    return text.slice(text.indexOf('\n') + 1)
  }
}

export function install(rt) {
  const pending = new Map()

  async function enqueue(botId, work) {
    const operation = (pending.get(botId) ?? Promise.resolve()).catch(() => {}).then(work)
    pending.set(botId, operation)
    try {
      return await operation
    } finally {
      if (pending.get(botId) === operation) pending.delete(botId)
    }
  }

  // A reply or replay already knows which conversation it belongs to.
  rt.botConversationForPart = (bot, partId) => enqueue(bot.id, async () => {
    const existing = await rt.openBotConversation(bot, partId)
    const sessionId = existing ?? await rt.newBotConversation(bot)
    if (sessionId === undefined) throw new Error('The receiving Bot no longer exists.')
    return sessionId
  })

  rt.botMessageOrigin = (sender, target, fromPart) => {
    const request = rt.live.get(fromPart)?.info
    if (request?.kind === SOURCE_KIND && request.role === 'request') {
      // A new request can use a conversation that opened for a different handoff.
      // While answering it, only its own sender is the origin.
      if (request.senderSessionId === target.id && request.senderRoomId === undefined
        && typeof request.senderPart === 'string') return request.senderPart
      return undefined
    }
    return rt.conversationOpeningFrom(sender, target, fromPart)
  }

  // Where a message from `sender` must go in `target`'s chat, strongest evidence first:
  // the conversation the sender named, the handoff the sender's part answers or opened,
  // then the one conversation the text names by session ID. `named` is a part the caller
  // checked belongs to `target`. `by` says why when the sender's words chose it. Undefined
  // leaves the choice to the topic. Each of these gets its own turn there (route).
  rt.botMessageDestination = (sender, target, { fromPart, named, text }) => {
    if (named !== undefined) return { part: named, by: 'named' }
    const origin = rt.botMessageOrigin(sender, target, fromPart)
    if (origin !== undefined) return { part: origin }
    const mentioned = mentionedConversation(target, text)
    return mentioned === undefined ? undefined : { part: mentioned, by: 'mentioned' }
  }

  async function recentPrompts(conversation, signal) {
    const prompts = []
    for (const partId of conversation.parts.slice(-2).reverse()) {
      if (prompts.length >= PROMPTS_MAX) break
      try {
        for await (const event of rt.eventsBackwards(partId, signal, HISTORY_PAGES)) {
          const text = promptOf(event)
          if (text) prompts.push(text)
          if (prompts.length >= PROMPTS_MAX) break
        }
      } catch {
        // Missing history gives no reason to append the request to this conversation.
      }
    }
    return prompts
  }

  async function choose(bot, { text, fromId, fromPart, work, steer, signal }) {
    const conversations = ownConversations(bot)
    if (work !== undefined && steer) {
      const sameWork = conversations.filter(({ sessionId, endedAt }) => {
        const info = rt.live.get(sessionId)?.info
        return endedAt === undefined && info?.role === 'request' && info.senderSessionId === fromId
          && info.senderPart === fromPart && rt.sameWork(info.exchangeId, work)
      })
      if (sameWork.length === 1) return { sessionId: sameWork[0].sessionId, steer: true }
    }
    const query = topic(text)
    if (query.terms.size < 2 && query.issues.size === 0) return undefined
    const timeout = AbortSignal.timeout(HISTORY_MS)
    const historySignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const scoring = Promise.all(conversations.slice(0, CONVERSATIONS_MAX).map(async conversation => {
      const prompts = await recentPrompts(conversation, historySignal)
      const scores = prompts.map(prompt => similarity(query, topic(prompt)))
      const activeScore = scores[0] ?? 0
      const requests = rt.unreadOf(conversation.sessionId).filter(args => args.role === 'request').slice(-PROMPTS_MAX)
      const queuedScores = requests.map(args => similarity(query, topic(args.text)))
      const readScore = rt.live.get(conversation.sessionId)?.turn === undefined ? Math.max(0, ...scores) : activeScore
      return { sessionId: conversation.sessionId, score: Math.max(readScore, ...queuedScores), steer: steer && activeScore > 0 }
    }))
    const cutoff = Promise.withResolvers()
    const stop = () => cutoff.resolve([])
    historySignal.addEventListener('abort', stop, { once: true })
    const ranked = await Promise.race([scoring, cutoff.promise])
      .finally(() => historySignal.removeEventListener('abort', stop))
    ranked.sort((a, b) => b.score - a.score)
    const [best, second] = ranked
    if (best?.score > 0 && best.score - (second?.score ?? 0) >= MATCH_MARGIN) return best
  }

  async function route(bot, message, send) {
    message.signal?.throwIfAborted()
    // A handoff's origin, or a conversation the sender named, is a destination, even
    // when the update has different words or is visible to the user. It must get its
    // own turn in that conversation (botMessageDestination).
    const linked = message.originPart !== undefined
    let match
    if (linked) match = { sessionId: message.originPart, steer: false }
    else if (!message.newConversation) match = await choose(bot, message)
    message.signal?.throwIfAborted()
    if (rt.botOf(bot.id) !== bot) throw new Error('The receiving Bot no longer exists.')
    if (match !== undefined) {
      const sessionId = await rt.openBotConversation(bot, match.sessionId)
      message.signal?.throwIfAborted()
      if (sessionId !== undefined) return send(sessionId, { steer: match.steer, created: false })
    }
    if (!linked && !message.newConversation) {
      const current = rt.chatOf(bot.id)
      // An unused chat already is a fresh conversation. An empty part in a
      // conversation with earlier parts can still have its own work.
      const onlyPart = ownConversations(bot)[0]?.parts.length === 1
      if (onlyPart && !rt.live.get(current)?.turn && rt.unreadOf(current).length === 0 && await rt.partTalked(current).catch(() => true) === false) {
        const agent = await rt.resolveAgent(current).catch(() => undefined)
        if (agent?.status === 'idle' && !rt.openingChat(bot.id) && rt.chatOf(bot.id) === current
          && (agent.inbox?.nextTurn?.length ?? 0) === 0 && (agent.inbox?.nextStep?.length ?? 0) === 0
          && await rt.partTalked(current).catch(() => true) === false) return send(current, { steer: false, created: false })
      }
    }
    message.signal?.throwIfAborted()
    // DSH lists the new conversation under the name the session list gives it.
    const sessionId = await rt.newBotConversation(bot, requestTitle(message.text, message.title))
    if (sessionId === undefined) throw new Error('The receiving Bot no longer exists.')
    message.signal?.throwIfAborted()
    return send(sessionId, { steer: false, created: true })
  }

  // Include delivery in the queue so a simultaneous send can see the input that
  // just opened a conversation, even when its first turn has not started yet.
  rt.routeBotMessage = (bot, message, send) => enqueue(bot.id, () => route(bot, message, send))
}
