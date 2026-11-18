import { AppError, canonical, requireThat } from './shared.mjs';

function matchesKeyword(message, keyword) {
  if (keyword.endsWith('-')) return message.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(message);
}

export function routeMessage(message, eligible, context = {}) {
  const query = message.toLowerCase();
  const suggestions = eligible.flatMap(connector => connector.display.prompts.map(prompt => prompt.message)).slice(0, 3);
  if (!eligible.length) {
    return { text: 'Finance is not enabled for this demo account. Switch to Acme Industrial or Northstar Studio to explore the read-only tools.', suggestions: [] };
  }
  if (/\b(refund|cancel|delete|update|change|transfer|submit|create)\b/.test(query) &&
    !/\b(policy|policies|terms|how|status)\b/.test(query)) {
    return { text: 'This MVP is read-only. I cannot issue refunds, make payments, or change records. I can help you look up the relevant information instead.', suggestions };
  }
  const candidates = eligible.filter(connector =>
    connector.routing.keywords.some(keyword => matchesKeyword(query, keyword)));
  const excluded = eligible.some(connector =>
    connector.routing.excludeKeywords.some(keyword => matchesKeyword(query, keyword)));
  if (excluded) {
    return {
      text: `This MVP has ${eligible.map(connector => connector.display.name).join(' and ')} connected, but not the other service in your request. You can ask me about the available capabilities below.`,
      suggestions,
    };
  }
  if (candidates.length === 1) return { connector: candidates[0] };
  if (!candidates.length && context.domain &&
    /\b(last month|this month|it|that one|that invoice|show more|see more|load more|show me more)\b/.test(query)) {
    const prior = eligible.find(connector => connector.id === context.domain);
    if (prior) return { connector: prior };
  }
  return {
    text: candidates.length > 1
      ? 'Which business unit should I check? Please name the service in your request.'
      : 'I can help with your account information. Would you like to check invoices, your balance, or payment terms?',
    suggestions,
  };
}

export function createChatRunner({ registry, identity, gateway, planner }) {
  return async function run({ message, context, session, signal, emit }) {
    const stage = (id, state, detail) => emit({ type: 'stage', id, state, detail });
    stage('route', 'running', 'Finding the right business unit');
    const route = routeMessage(message, registry.visible(session.principal), context);
    if (!route.connector) {
      stage('route', 'idle', 'No tool was called');
      return { text: route.text, suggestions: route.suggestions, results: [], issues: [], context };
    }
    const connector = route.connector;
    stage('route', 'complete', `Routed to ${connector.display.name}`);
    stage('access', 'running', 'Checking this account and approved tool definitions');
    const { tools } = await gateway.catalog(session, connector.id, signal);
    stage('access', 'complete', `${tools.length} read-only tools passed access and pin checks`);
    stage('source', 'running', planner.id === 'azure' ? 'Selecting a tool with Azure OpenAI' : 'Selecting a tool with the demo rules');
    const plan = await planner.choose({ message, context, tools, signal });
    requireThat(Array.isArray(plan.calls) && plan.calls.length <= 2,
      'TOOL_BUDGET', 'The turn exceeded its two-tool budget.', 502);
    if (!plan.calls.length) {
      stage('source', 'idle', 'A more specific request is needed');
      return { text: plan.text, suggestions: plan.suggestions ?? [], results: [], issues: [], context };
    }
    const seen = new Set();
    const results = [];
    const issues = [];
    let nextContext = context;
    for (const call of plan.calls) {
      signal.throwIfAborted();
      requireThat(tools.some(tool => tool.name === call.name), 'TOOL_DENIED',
        'The selected tool is not in the approved catalog.', 403);
      const key = canonical(call);
      requireThat(!seen.has(key), 'DUPLICATE_TOOL_CALL', 'Duplicate tool calls are not allowed in one turn.', 400);
      seen.add(key);
      stage('source', 'running', `Reading ${tools.find(tool => tool.name === call.name).title}`);
      try {
        const result = await gateway.invoke(session, connector.id, call.name, call.args, signal);
        identity.getSession(session.id);
        results.push(result);
        nextContext = {
          domain: connector.id, lastTool: call.name, lastArgs: call.args,
          nextCursor: result.data.nextCursor, asOf: result.data.asOf,
        };
        emit({ type: 'result', result });
      } catch (error) {
        if (!(error instanceof AppError) || ['CANCELLED', 'SIGN_IN_REQUIRED'].includes(error.code)) throw error;
        issues.push({ code: error.code, message: error.message });
      }
    }
    stage('source', issues.length ? 'error' : 'complete',
      issues.length ? 'Some information could not be retrieved' : 'Read completed; source attached');
    stage('answer', results.length ? 'complete' : 'idle',
      results.length ? 'Answer uses verified connector data' : 'No account data was returned');
    const text = [
      ...results.map(result => result.data.summary),
      ...issues.map(issue => issue.message),
    ].join('\n\n');
    const suggestions = [...new Set(results.flatMap(result => result.data.suggestions))].slice(0, 3);
    if (nextContext.nextCursor) suggestions.unshift('Show more');
    return { text, results, issues, suggestions: suggestions.slice(0, 3), context: nextContext };
  };
}
