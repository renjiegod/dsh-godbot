import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { accountConsumption, accountText, botAgentRows, botModelRows, localTime, quotaKind, quotaPercent, quotaWindowLabel, usageCount, usagePeriods, usageProviders } from './provider-usage-model.js'
import style from './provider-agents.css'

const activeSources = { 'claude-usage':'Claude Code /usage', 'codex-app-server':'Codex app-server',
  'antigravity-statusline':'Antigravity 状态栏', 'gemini-cli-model':'Gemini CLI /model' }
const kindSources = { antigravity:'Antigravity',claude:'Claude Code',codex:'Codex',gemini:'Gemini CLI' }
const quotaStates = { unchecked:'尚未同步', stale:'上次读数', 'signed-out':'账号未登录', unavailable:'暂无额度数据' }
const reasonLabels = { 'not-authenticated':'请先登录当前账号，再刷新额度。', 'not-reported':'当前账号未报告可用的额度窗口。',
  'source-unavailable':'暂时无法从该账号读取额度。', unsupported:'此提供商未开放可读取的官方额度接口。',
  'identity-changed':'登录身份已变化，请刷新当前账号的额度。',expired:'上次额度读数已过期，请刷新。' }

// `botId` reads that Bot's own calls only; without it, every local agent's.
export function useLocalConsumption(call, enabled, botId) {
  const [usage,setUsage] = useState(null)
  const [error,setError] = useState('')
  const [loading,setLoading] = useState(false)
  const ticket = useRef(0)
  const refresh = useCallback(async (refreshHistory = false) => {
    const id = ++ticket.current
    setLoading(true)
    try {
      const deadline = Date.now() + 60000
      while (id === ticket.current) {
        const result = await call('local-agent-usage', botId === undefined ? { refreshHistory } : { refreshHistory, botId })
        if (id !== ticket.current) break
        setUsage(result); setError('')
        if (!refreshHistory || !result.historyScanning || Date.now() >= deadline) break
        await new Promise(resolve => setTimeout(resolve, 700))
      }
    } catch (cause) {
      if (id === ticket.current) setError(cause?.message ?? String(cause))
    } finally { if (id === ticket.current) setLoading(false) }
  },[call,botId])
  useEffect(() => {
    if (!enabled) return
    void refresh()
    return () => { ticket.current++ }
  },[enabled,refresh])
  return {usage,loading,error,refresh}
}

function PeriodSwitch({period, setPeriod}) {
  return h('div',{role:'group','aria-label':'用量统计周期',className:'gb-pr-periods'},
    Object.entries(usagePeriods).map(([key,label])=>h('button',{key,type:'button','data-usage-period':key,
      'aria-pressed':key===period,onClick:()=>setPeriod(key)},label)))
}

function Count({totals}) {
  if (!totals?.reports) return h('span',{className:'gb-pr-muted'}, totals?.unreported ? '未报告 token 数' : '暂无记录')
  return h('span',null,usageCount(totals.tokens),' token')
}

function Coverage({totals}) {
  if (!totals?.reports && !totals?.unreported) return null
  const text = []
  if (totals.reports) text.push(usageCount(totals.reports)+' 条用量记录')
  if (totals.unreported) text.push(usageCount(totals.unreported)+' 条未报告 token 数')
  return h('small',{className:'gb-pr-muted'},text.join(' · '))
}

function Breakdown({totals}) {
  if (!totals?.reports) return null
  return h('div',{className:'gb-pr-usage-numbers'},[['输入','input'],['输出','output'],['缓存读取','cacheRead'],['缓存写入','cacheWrite']].map(([label,key])=>
    h('span',{key},label+' '+usageCount(totals[key]))))
}

function DailyHistory({history}) {
  if (!Array.isArray(history) || !history.some(day=>day.reports || day.unreported)) return null
  const peak = Math.max(1,...history.map(day=>day.tokens || 0))
  return h('details',null,h('summary',null,'近 7 个 UTC 日'),
    h('ol',{className:'gb-pr-days'},history.map(day=>h('li',{key:day.date},
      h('span',null,day.date.slice(5)),day.reports>0 ? h('progress',{max:peak,value:day.tokens,'aria-label':day.date+' token'}) : h('span'),
      h(Count,{totals:day})))))
}

function LocalDetail({row,period}) {
  const totals = row?.periods?.[period]
  return h('div',{className:'gb-pr-usage-local','data-godbot-account-usage':true},
    h('div',{className:'gb-pr-heading'},h('strong',null,'Godbot 会话用量'),h(Count,{totals})),
    (totals?.reports || totals?.unreported) > 0 && row.attribution !== 'unknown' &&
      h('small',{className:'gb-pr-muted'},'按运行环境累计。同一环境更换登录账号后，历史记录仍计入这里。'),
    h(Coverage,{totals}),h(DailyHistory,{history:row?.history}),
    h(Breakdown,{totals}),
    row?.models?.some(model => model.periods?.[period]?.reports || model.periods?.[period]?.unreported) &&
      h('details',null,h('summary',null,'按模型查看'),h('ul',{className:'gb-pr-model-totals'},
        row.models.filter(m=>m.periods?.[period]?.reports || m.periods?.[period]?.unreported).map(model=>
          h('li',{key:model.model},h('span',null,model.model || '未标记模型'),h(Count,{totals:model.periods[period]}))))))
}

function QuotaWindows({snapshot}) {
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
  return h('div',{className:'gb-pr-windows'},windows.map(window=>{
    const percent = window.disabled ? undefined : quotaPercent(window)
    const hasAmount = typeof window.remainingAmount === 'number' && Number.isFinite(window.remainingAmount)
    const resets = localTime(window.resetsAt)
    const label = quotaWindowLabel(snapshot.source, window)
    return h('div',{key:window.id,className:'gb-pr-window','data-quota-window':window.id},
      h('div',{className:'gb-pr-heading'},h('span',null,label),
        h('strong',null,window.disabled ? '未启用' : percent ? percent.label+' '+usageCount(percent.value)+'%' : hasAmount ? '剩余 '+usageCount(window.remainingAmount) : '未报告比例')),
      percent && h('progress',{max:100,value:percent.value,'aria-label':label+' '+percent.label,
        'data-remaining':percent.label==='剩余' ? 'true' : undefined,
        'data-limited': (percent.label==='已用' ? percent.value>=90 : percent.value<=10) ? 'true' : undefined}),
      (resets || (hasAmount && percent)) && h('small',{className:'gb-pr-muted'},[resets && (resets+' 重置'),
        hasAmount && percent && ('剩余额度 '+usageCount(window.remainingAmount))].filter(Boolean).join(' · ')))
  }))
}

function OfficialQuota({client,kind,id,disabled,readOnly}) {
  const [snapshot,setSnapshot] = useState(null)
  const [error,setError] = useState('')
  const [pending,setPending] = useState(false)
  const [reading,setReading] = useState(false)
  const revision = useRef(0)
  const load = useCallback(async (fresh=false) => {
    const req = ++revision.current
    setPending(fresh); setReading(!fresh); setError('')
    try {
      const result = await client.dispatch({action:fresh?'provider-usage-refresh':'provider-usage',kind,accountId:id})
      if (req !== revision.current) return
      if (result?.kind !== kind || result?.accountId !== id) throw Error('额度来源与所选账号不一致。')
      setSnapshot(result)
    } catch (cause) {
      if (req === revision.current) setError(cause?.message ?? String(cause))
    } finally { if (req===revision.current) { setPending(false); setReading(false) } }
  },[client,kind,id])
  useEffect(()=>{setSnapshot(null); if (kind) void load(); return ()=>{revision.current++}},[load,kind])
  if (!kind) return h('div',{className:'gb-pr-usage-official gb-pr-muted'},'官方额度 · 暂无可读取的接口')
  const state = snapshot?.status ?? 'unchecked'
  const data = state === 'available' || state === 'stale'
  const credits = data && snapshot?.credits
  const source = activeSources[snapshot?.source] || kindSources[kind]
  const updated = localTime(snapshot?.updatedAt)
  const checked = localTime(snapshot?.checkedAt)
  return h('section',{className:'gb-pr-usage-official','data-account-quota':true,'data-quota-status':state,'aria-label':'官方额度'},
    h('div',{className:'gb-pr-heading'},h('strong',null,'官方额度',source && h('small',{className:'gb-pr-muted'},' · '+source)),
      h('button',{type:'button',className:'bt-soft bt-soft-sm','data-account-action':'refresh-usage',
        disabled:disabled || readOnly || pending || reading,onClick:()=>load(true)},pending?'正在同步…':'刷新额度')),
    snapshot?.plan && data && h('small',{className:'gb-pr-muted'},snapshot.plan),
    state!=='available' && h('small',{className:'gb-pr-muted',role:'status'},reading ? '正在读取已保存的额度…' :
      [quotaStates[state],reasonLabels[snapshot?.reason]].filter(Boolean).join(' · ')),
    data && snapshot?.windows?.length>0 && h(QuotaWindows,{snapshot}),
    credits && h('span',{className:'gb-pr-muted'},credits.unlimited ? '积分余额 · 不限量' :
      typeof credits.balance==='number' ? '积分余额 · '+usageCount(credits.balance) :
      credits.hasCredits===true ? '账号有可用积分' : credits.hasCredits===false ? '账号无可用积分' : null),
    (updated || checked) && h('small',{className:'gb-pr-muted'},
      [updated && ('上次同步 '+updated),checked && snapshot?.checkedAt !== snapshot?.updatedAt && ('最近检查 '+checked)].filter(Boolean).join(' · ')),
    error && h('small',{className:'bt-error',role:'alert'},error))
}

export function AccountUsage({client,route,accountId,consumption,period,disabled,readOnly,identityKey=''}) {
  return h('div',{className:'gb-pr-account-usage'},
    h(OfficialQuota,{key:route+':'+(accountId ?? '')+':'+identityKey,client,kind:quotaKind(route),id:accountId,disabled,readOnly}),
    h(LocalDetail,{row:accountConsumption(consumption,accountId),period}))
}

function QuotaComparison({rows,client,readOnly}) {
  const providers = rows.filter(row => quotaKind(row.route))
  const [picked,setPicked] = useState('')
  const current = providers.find(row=>row.route===picked) ?? providers.find(row=>row.accountCount || row.installed) ?? providers[0]
  if (!current) return null
  const accounts = current.accounts?.accounts.filter(a=>!a.removed && (a.local || a.managed || a.inUse || a.identity?.status==='signed-in'))
    ?? [{id:null,local:true,name:'本机',available:current.installed}]
  return h('section',{className:'gb-pr-section','data-official-quota-comparison':true},
    h('div',{className:'gb-pr-heading'},h('h3',null,'账号额度'),
      h('label',null,h('select',{name:'usageProvider',className:'bt-input','aria-label':'额度提供商',value:current.route,onChange:e=>setPicked(e.target.value)},
        providers.map(row=>h('option',{key:row.route,value:row.route},row.name))))),
    h('div',{className:'bt-set-card'},accounts.map(account=>h('div',{key:current.route+':'+account.id,
      className:'gb-pr-quota-compare','data-quota-account':account.id??'local'},h('strong',null,account.name),
      h(OfficialQuota,{key:[account.identity?.email,account.identity?.checkedAt].join('|'),client,kind:quotaKind(current.route),
        id:account.id,disabled:!account.available,readOnly})))))
}

export function UsageOverview({rows,usage,period,setPeriod,select,client,readOnly,AgentLogo,focusRoute}) {
  const data = usage.usage
  const sorted = usageProviders(data?.providers,period)
  const peak = Math.max(1,...sorted.map(provider => provider.periods?.[period]?.tokens ?? 0))
  return h('section',{className:'gb-pr-section','data-provider-usage-overview':true},
    h('div',{className:'gb-pr-heading'},h('h3',null,'Godbot 会话用量'),
      h('button',{type:'button',className:'bt-soft bt-soft-sm',onClick:()=>usage.refresh(!readOnly),disabled:usage.loading},'刷新统计')),
    h(PeriodSwitch,{period,setPeriod}),
    usage.error && h('small',{className:'bt-error',role:'alert'},usage.error),
    data?.historyScanning && h('small',{className:'gb-pr-muted',role:'status'},'正在读取历史会话，当前显示已收录的记录。'),
    data?.ledgerStatus==='unavailable' && h('small',{className:'gb-pr-muted',role:'status'},'团队用量账本暂不可读，以下为当前可取得的记录。'),
    data && h('div',{className:'bt-set-card gb-pr-box'},
      h('div',{className:'gb-pr-heading'},h('strong',null,'全部本地 Agent'),h(Count,{totals:data.totals?.[period]})),
      h(Breakdown,{totals:data.totals?.[period]}),h(Coverage,{totals:data.totals?.[period]})),
    sorted.length ? h('ul',{className:'bt-set-card gb-pr-list'},sorted.map(provider=>{
      const totals=provider.periods?.[period]
      const status = provider.archived ? '历史 Agent' : !provider.available ? '本机未检测到 CLI' : ''
      return h('li',{key:provider.route},h('button',{className:'gb-pr-row gb-pr-usage-summary',type:'button','data-usage-provider':provider.route,
        ref:el => { if (el && focusRoute.current === provider.route) { el.focus(); focusRoute.current = null } },
        onClick:()=>select(provider.route)},h(AgentLogo,{route:provider.route,name:provider.name,size:28}),
        h('span',{className:'gb-pr-copy'},h('strong',null,provider.name),status && h('small',{className:'gb-pr-muted'},status),
          totals?.reports > 0 && h(Coverage,{totals})),
        h('span',{className:'gb-pr-usage-amount'},h(Count,{totals}),totals?.tokens > 0 &&
          h('progress',{max:peak,value:totals.tokens,'aria-hidden':true})),h('span',{'aria-hidden':true},'›')))
    })) : !usage.error && h('p',{className:'gb-pr-muted',role:'status'},data?'暂无本地 Agent。':'正在读取统计…'),
    data?.asOf && h('small',{className:'gb-pr-muted'},'更新于 '+localTime(data.asOf)),
    h(QuotaComparison,{rows,client,readOnly}))
}

// One Bot's own local agent usage, for its conversation header: the agent and account
// it runs on now, the tokens its own calls spent (its chat, its group chats, their
// earlier parts), and that account's official quota. Other Bots stay out of it.
export function BotAgentUsage({client,call,AgentLogo,botId,readOnly,openAll}) {
  const [period,setPeriod] = useState('week')
  const usage = useLocalConsumption(call,true,botId)
  const data = usage.usage
  const agent = data?.agent
  const totals = data?.totals?.[period]
  const agents = botAgentRows(data,period)
  const models = botModelRows(data,period)
  const account = agent && accountText(agent.accountId,agent.accountName)
  return h('div',{className:'gb-providers gb-bot-usage','data-godbot-bot-usage':botId},
    h('style',null,style),
    agent ? h('div',{className:'gb-pr-title','data-bot-agent':agent.route},
      h(AgentLogo,{route:agent.route,name:agent.name,size:32}),
      h('span',{className:'gb-pr-copy'},h('strong',null,agent.name),
        h('small',{'data-bot-agent-account':agent.accountId ?? 'local'},['当前运行账号',account,!agent.available && '当前不可用'].filter(Boolean).join(' · '))))
      : data && h('p',{className:'gb-pr-muted',role:'status'},'这个 Bot 当前没有使用本地 Agent，下面是它之前用本地 Agent 的记录。'),
    h('section',{className:'gb-pr-section','data-bot-usage-totals':true},
      h('div',{className:'gb-pr-heading'},h('h3',null,'这个 Bot 的会话用量'),
        h('button',{type:'button',className:'bt-soft bt-soft-sm','data-usage-action':'refresh',onClick:()=>usage.refresh(!readOnly),disabled:usage.loading},'刷新统计')),
      h(PeriodSwitch,{period,setPeriod}),
      usage.error && h('small',{className:'bt-error',role:'alert'},usage.error),
      data?.historyScanning && h('small',{className:'gb-pr-muted',role:'status'},'正在读取历史会话，当前显示已收录的记录。'),
      data?.ledgerStatus==='unavailable' && h('small',{className:'gb-pr-muted',role:'status'},'团队用量账本暂不可读，以下为当前可取得的记录。'),
      data ? h('div',{className:'bt-set-card gb-pr-box'},
        h('div',{className:'gb-bot-usage-total','data-bot-usage-total':period},h(Count,{totals})),
        h(Breakdown,{totals}),h(Coverage,{totals}),
        agents.length > 1 && h('details',null,h('summary',null,'按 Agent 和账号查看'),
          h('ul',{className:'gb-pr-model-totals'},agents.map(row=>h('li',{key:row.key,'data-bot-usage-agent':row.route},
            h('span',null,row.name+' · '+row.account),h(Count,{totals:row.totals}))))),
        models.length > 0 && h('details',null,h('summary',null,'按模型查看'),
          h('ul',{className:'gb-pr-model-totals'},models.map(row=>h('li',{key:row.key},h('span',null,row.label),h(Count,{totals:row.totals}))))),
        h(DailyHistory,{history:data.history}))
        : !usage.error && h('p',{className:'gb-pr-muted',role:'status'},'正在读取统计…'),
      data?.asOf && h('small',{className:'gb-pr-muted'},'包括它的私聊、群聊和更早的会话段，不含其他 Bot。更新于 '+localTime(data.asOf))),
    agent?.quotaSupported && h('section',{className:'gb-pr-section','data-bot-quota':true},
      h(OfficialQuota,{key:agent.route+':'+(agent.accountId ?? ''),client,kind:quotaKind(agent.route),id:agent.accountId,disabled:!agent.available,readOnly}),
      h('small',{className:'gb-pr-muted'},'额度属于'+account+'，用同一账号的其他 Bot 也会消耗。')),
    openAll && h('button',{type:'button',className:'gb-pr-back gb-bot-usage-all','data-usage-action':'all',onClick:openAll},'查看全部本地 Agent 用量',h('span',{'aria-hidden':true},' ›')))
}

export function ProviderUsageSummary({provider,period,setPeriod,usageError,history=false,accountList=[]}) {
  const totals = provider?.periods?.[period]
  if (history) {
    const previous = (provider?.accounts ?? []).filter(row =>
      (row.attribution==='unknown' || (row.attribution==='sandbox' && !accountList.some(a => a.id===row.accountId && !a.removed))) &&
      (row.periods?.[period]?.reports || row.periods?.[period]?.unreported))
    return previous.length ? h('details',{className:'gb-pr-extra'},h('summary',null,'历史账号与未归属的记录'),
      previous.map(row=>h('div',{key:row.attribution+':'+row.accountId},h('strong',null,row.attribution==='unknown'?'未归属账号':row.accountId),h(LocalDetail,{row,period})))) : null
  }
  return h('div',{className:'gb-pr-section'},h('div',{className:'gb-pr-heading'},
    h('h4',null,'提供商会话用量'),h(Count,{totals})),h(PeriodSwitch,{period,setPeriod}),
    h(Breakdown,{totals}),h(Coverage,{totals}),h(DailyHistory,{history:provider?.history}),
    usageError && h('small',{className:'bt-error',role:'alert'},usageError))
}
