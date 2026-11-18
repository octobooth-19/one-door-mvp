import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAzurePlanner } from '../lib/model.mjs';
import { financeTools } from '../connectors/finance.mjs';
import { createApplication } from '../lib/app.mjs';

const inputs = {
  message: 'What do I owe?', context: {}, tools: financeTools, signal: AbortSignal.timeout(5000),
};
const settings = {
  endpoint: 'https://example.openai.azure.com/', deployment: 'approved-deployment', apiKey: 'test-key-not-a-real-secret',
};
const completion = calls => new Response(JSON.stringify({
  choices: [{ finish_reason: 'tool_calls', message: { tool_calls: calls } }],
}), { headers: { 'Content-Type': 'application/json' } });
const call = (name, args) => ({
  id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) },
});

test('Azure adapter requests only reviewed tools and never enables stored completions', async () => {
  let request;
  const provider = createAzurePlanner({
    ...settings,
    fetchImpl: async (url, options) => {
      request = { url: String(url), ...options, body: JSON.parse(options.body) };
      return completion([call('finance_account_summary', {})]);
    },
  });
  const result = await provider.choose(inputs);
  assert.equal(request.url, 'https://example.openai.azure.com/openai/v1/chat/completions');
  assert.equal(request.body.store, false);
  assert.equal(request.body.model, 'approved-deployment');
  assert.equal(request.body.tools.length, 3);
  assert.ok(request.body.max_completion_tokens <= 1200);
  assert.equal(request.redirect, 'error');
  assert.deepEqual(result.calls, [{ name: 'finance_account_summary', args: {} }]);
});

test('Azure configuration is explicit and cannot target arbitrary external servers', async () => {
  assert.throws(() => createAzurePlanner({ ...settings, endpoint: 'https://untrusted.example' }), { code: 'MODEL_CONFIG' });
  assert.throws(() => createAzurePlanner({ ...settings, apiKey: '' }), { code: 'MODEL_CONFIG' });
  await assert.rejects(createApplication({ environment: { MODEL_PROVIDER: 'azure' } }), { code: 'MODEL_CONFIG' });
});

test('unregistered tools and malformed arguments from a model are rejected', async () => {
  const provider = createAzurePlanner({
    ...settings, fetchImpl: async () => completion([call('finance_issue_refund', { amount: 10 })]),
  });
  await assert.rejects(provider.choose(inputs), { code: 'MODEL_TOOL_DENIED' });
  const malformed = createAzurePlanner({
    ...settings,
    fetchImpl: async () => completion([{
      type: 'function', function: { name: 'finance_account_summary', arguments: '{"invalid"' },
    }]),
  });
  await assert.rejects(malformed.choose(inputs), { code: 'INVALID_MODEL_OUTPUT' });
});

test('a failing configured Azure provider is not replaced by a success-shaped demo answer', async () => {
  const provider = createAzurePlanner({
    ...settings, fetchImpl: async () => new Response('rate limited', { status: 429 }),
  });
  await assert.rejects(provider.choose(inputs), { code: 'MODEL_UNAVAILABLE' });
});

test('model-generated text is not displayed as an unverified account fact', async () => {
  const provider = createAzurePlanner({
    ...settings,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: 'Your balance is $999999.' } }],
    }), { headers: { 'Content-Type': 'application/json' } }),
  });
  const result = await provider.choose(inputs);
  assert.deepEqual(result.calls, []);
  assert.doesNotMatch(result.text, /999999/);
  assert.match(result.text, /more specific/);
});
