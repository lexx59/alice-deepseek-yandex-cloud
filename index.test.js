'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('./index');
const env = { ALICE_SKILL_ID: 'skill', YANDEX_FOLDER_ID: 'folder', ENABLED: 'true' };
const context = { token: { access_token: 'test-only' } };
const event = (command, state = {}) => ({ version: '1.0',
  session: { skill_id: 'skill', user: { user_id: 'owner' } },
  request: { command, original_utterance: command }, state });
test('background request survives a cold invocation and polling never creates another generation', async () => {
  const calls = [];
  let clock = 0;
  const handler = createHandler({ env, monotonic: () => clock, sleep: async ms => { clock += ms; }, fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => options.method === 'POST'
      ? { id: 'job', status: 'queued' }
      : { id: 'job', status: 'in_progress' } };
  } });
  const first = await handler(event('Объясни радугу'), context);
  assert.equal(first.session_state.pending, 'job');
  const poll = createHandler({ env, fetchImpl: async (...args) => {
    calls.push(args); return { ok: true, json: async () => ({ status: 'completed', output_text: 'Ответ.' }) };
  } });
  const result = await poll(event('готово', { session: first.session_state, user: first.user_state_update }), context);
  assert.equal(result.response.text, 'Ответ.');
  assert.equal(result.session_state.pending, undefined);
  assert.equal(result.user_state_update.quota.used, 1);
  assert.equal(calls[1][1].method, 'GET');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.background, true);
  assert.equal(body.max_output_tokens, 384);
  assert.equal(body.reasoning.effort, 'none');
});
test('a fast background result is returned in the original turn without a waiting message', async () => {
  let clock = 0;
  let posts = 0;
  const handler = createHandler({ env, monotonic: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: async (url, options) => {
      clock += 100;
      if (options.method === 'POST') posts++;
      return { ok: true, json: async () => options.method === 'POST'
        ? { id: 'fast', status: 'queued' }
        : { id: 'fast', status: 'completed', output_text: 'Сразу ответ.' } };
    } });
  const result = await handler(event('вопрос'), context);
  assert.equal(result.response.text, 'Сразу ответ.');
  assert.equal(result.session_state.pending, undefined);
  assert.equal(result.user_state_update.quota.used, 1);
  assert.equal(posts, 1);
  assert.ok(clock < 3000);
});
test('slow submission leaves no extra polling budget and preserves task for the next turn', async () => {
  let clock = 0;
  let calls = 0;
  const handler = createHandler({ env, monotonic: () => clock, sleep: () => assert.fail('no pause budget'),
    fetchImpl: async () => { calls++; clock = 2800; return { ok: true, json: async () => ({ id: 'slow', status: 'queued' }) }; } });
  const result = await handler(event('вопрос'), context);
  assert.equal(result.response.text, 'Пу пу пу, тут надо подумать');
  assert.equal(result.session_state.pending, 'slow');
  assert.equal(calls, 1);
});
test('poll timeout after successful submission never loses the task or repeats POST', async () => {
  let clock = 0;
  const methods = [];
  const handler = createHandler({ env, monotonic: () => clock, sleep: async ms => { clock += ms; }, fetchImpl: async (url, options) => {
    methods.push(options.method);
    if (options.method === 'GET') { clock += 700; throw new Error('timeout'); }
    return { ok: true, json: async () => ({ id: 'accepted', status: 'queued' }) };
  } });
  const result = await handler(event('вопрос'), context);
  assert.equal(result.session_state.pending, 'accepted');
  assert.equal(result.response.text, 'Пу пу пу, тут надо подумать');
  assert.deepEqual(methods, ['POST', 'GET']);
});
test('function remaining runtime is respected before starting any API operation', async () => {
  const handler = createHandler({ env, fetchImpl: () => assert.fail('no runtime left') });
  const result = await handler(event('вопрос'), { ...context, getRemainingTimeInMillis: () => 320 });
  assert.match(result.response.text, /недоступна/);
});
test('disabled, wrong skill, owner restriction, help and quota cause no paid calls', async () => {
  const fetchImpl = () => assert.fail('unexpected model call');
  for (const config of [{ ...env, ENABLED: 'false' }, { ...env, ALICE_SKILL_ID: 'other' }, { ...env, ALICE_OWNER_ID: 'other' }])
    await createHandler({ env: config, fetchImpl })(event('вопрос'), context);
  const handler = createHandler({ env, fetchImpl, now: () => new Date('2026-11-17') });
  await handler(event('помощь'), context);
  const capped = await handler(event('вопрос', { user: { quota: { month: '2026-11', used: 300 } } }), context);
  assert.match(capped.response.text, /лимит/);
});
test('reset clears session context but retains monthly usage', async () => {
  const handler = createHandler({ env, now: () => new Date('2026-11-17') });
  const result = await handler(event('новый разговор', { session: { pending: 'old', question: 'private', history: [] },
    user: { quota: { month: '2026-11', used: 7 } } }), context);
  assert.deepEqual(result.session_state, {});
  assert.equal(result.user_state_update.quota.used, 7);
});
test('timeout is safe, counted, and never leaks credentials or exception content', async () => {
  const handler = createHandler({ env, fetchImpl: async () => { throw new Error('secret'); } });
  const result = await handler(event('вопрос'), context);
  assert.equal(result.user_state_update.quota.used, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret|test-only/);
});
test('any phrase retrieves only the pending answer without assuming a new question or creating a generation', async () => {
  const handler = createHandler({ env, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET');
    return { ok: true, json: async () => ({ status: 'completed', output_text: 'Первый ответ.' }) };
  } });
  const result = await handler(event('другой вопрос', { session: { pending: 'job', question: 'первый вопрос' } }), context);
  assert.equal(result.response.text, 'Первый ответ.');
  assert.equal(result.session_state.pending, undefined);
});
test('voice variants retrieve completed legacy pending requests without starting generation', async () => {
  for (const phrase of ['Готово!', 'Ну, уже готово?', 'скажи ответ', 'да', 'ну что?', 'ответ готов']) {
    const handler = createHandler({ env, fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      return { ok: true, json: async () => ({ status: 'completed', output_text: 'Получилось.' }) };
    } });
    const result = await handler(event(phrase, { session: { pending: 'legacy', question: 'вопрос' } }), context);
    assert.equal(result.response.text, 'Получилось.');
    assert.equal(result.session_state.pending, undefined);
  }
});
test('missing tasks and three consecutive transient failures release pending state', async () => {
  for (const status of [404, 410, 503]) {
    const handler = createHandler({ env, fetchImpl: async () => ({ ok: false, status }) });
    let session = { pending: 'gone', question: 'вопрос' };
    for (let attempt = 0; attempt < (status === 503 ? 3 : 1); attempt++) {
      const result = await handler(event('готово', { session }), context);
      session = result.session_state;
    }
    assert.equal(session.pending, undefined);
    assert.equal(session.question, undefined);
  }
});
test('pending expires by age or poll count and cancellation preserves history and quota', async () => {
  const now = () => new Date('2026-11-17T10:00:00Z');
  const handler = createHandler({ env, now, fetchImpl: () => assert.fail('unexpected API call') });
  for (const extra of [{ pendingSince: now().getTime() - 120001 }, { pendingPolls: 10 }]) {
    const result = await handler(event('готово', { session: { pending: 'job', ...extra } }), context);
    assert.equal(result.session_state.pending, undefined);
  }
  const result = await handler(event('Отмена!', { session: { pending: 'job', history: [{ role: 'user', content: 'old' }] },
    user: { quota: { month: '2026-11', used: 5 } } }), context);
  assert.equal(result.session_state.pending, undefined);
  assert.equal(result.session_state.history.length, 1);
  assert.equal(result.user_state_update.quota.used, 5);
});
test('a queued legacy task reaches a finite limit under arbitrary user phrases', async () => {
  let gets = 0;
  const handler = createHandler({ env, fetchImpl: async () => {
    gets++; return { ok: true, json: async () => ({ status: 'in_progress' }) };
  } });
  let session = { pending: 'legacy', question: 'вопрос' };
  for (let i = 0; i < 11; i++) session = (await handler(event('ну что там', { session }), context)).session_state;
  assert.equal(gets, 10);
  assert.equal(session.pending, undefined);
});
