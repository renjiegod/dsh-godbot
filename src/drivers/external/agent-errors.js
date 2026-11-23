// What an agent CLI says when its sign-in is missing, expired or revoked, and when
// its account is out of quota. The wording comes from the CLIs themselves: Claude
// Code ("Failed to authenticate: OAuth session expired and could not be refreshed",
// "OAuth token revoked"), Codex ("token_expired", "refresh_token_reused") and the
// ACP agents' "not signed in" / "login required".
export const SIGN_IN_TEXT = /not (?:signed|logged) in|login required|sign.?in required|failed to authenticate|authentication[_ ]?(?:failed|required|error)|unauthenticated|unauthorized|\b401\b|oauth (?:session|token|access token)[^.\n]{0,40}(?:expired|revoked|invalid)|token[_ ](?:expired|revoked|invalidated)|refresh[_ ]token[_ ](?:reused|expired|invalidated)|invalid_grant|please (?:run \S+ )?(?:log ?in|sign ?in|re-?authenticate)/i
export const QUOTA_TEXT = /quota|rate.?limit|usage limit|credit balance|billing/i

// Claude Code's typed API failures (the `error` of a synthetic assistant message).
const CLAUDE_ERRORS = {
  authentication_failed: 'LOCAL_AGENT_SIGNIN',
  billing_error: 'LOCAL_AGENT_QUOTA',
  rate_limit: 'LOCAL_AGENT_QUOTA',
}

// A Claude Code `result` that ended its turn in an error. The CLI marks an API
// failure as `subtype: "success"` with `is_error: true`, after a synthetic
// assistant message whose text is the error, so is_error alone decides.
export const claudeResultFailed = event => event?.is_error === true

export function claudeTurnError(event, apiError) {
  const error = new Error(event?.result || 'the agent failed')
  const code = CLAUDE_ERRORS[apiError] ?? (SIGN_IN_TEXT.test(error.message) ? 'LOCAL_AGENT_SIGNIN' : undefined)
  if (code !== undefined) error.code = code
  return error
}
