const names = {
  command: ['bash', 'shell', 'pwsh', 'powershell', 'execcommand', 'runcommand', 'writestdin', 'commandexecution', 'terminalexec'],
  code: ['runcode', 'cuaruncode'],
  read: ['read', 'readfile', 'viewfile', 'readimage', 'imageview', 'listdirectory', 'listfiles'],
  search: ['search', 'grep', 'glob', 'find', 'grepsearch', 'filesearch'],
  edit: ['edit', 'write', 'multiedit', 'writefile', 'applypatch', 'filechange', 'replacefilecontent', 'multireplacefilecontent', 'delete', 'move'],
  skill: ['skill', 'loadskill', 'useskill', 'skillload'],
  webSearch: ['websearch', 'searchweb'],
  webFetch: ['webfetch', 'fetch', 'readurlcontent', 'browse', 'browsersubagent'],
  agent: ['agent', 'subagent', 'spawnagent', 'collabagenttoolcall', 'subagentactivity'],
  plan: ['plan', 'todowrite', 'updateplan', 'tasklist', 'creategoal', 'updategoal'],
  image: ['imagegeneration', 'generateimage'],
}
const kinds = new Map(Object.entries(names).flatMap(([kind, aliases]) => aliases.map(name => [name, kind])))

export function skillNameFromPath(path) {
  if (typeof path !== 'string') return
  return /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/iu.exec(path)?.[1]
}

export function toolKind(name, path, reportedKind) {
  const normalized = typeof name === 'string' ? name.toLowerCase().replace(/[_ -]/gu, '') : ''
  const kind = reportedKind ?? kinds.get(normalized)
  return kind === 'read' && skillNameFromPath(path) ? 'skill' : kind
}
