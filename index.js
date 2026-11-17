'use strict';

const API = 'https://ai.api.cloud.yandex.net/v1/responses';
const INSTRUCTIONS = 'Ты — Дипсик, личный собеседник. Отвечай по-русски, если не попросили иначе. Сразу к сути: обычно два–четыре коротких предложения, без разметки и лишних вступлений. Учитывай историю; при существенной неоднозначности задай один уточняющий вопрос. Признавай неопределённость. Не выдумывай факты, источники и выполненные действия. Не заканчивай каждый ответ вопросом.';
const WAIT = 'Пу пу пу, тут надо подумать';
const normalize = text => String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const truncate = (text, max) => [...String(text)].slice(0, max).join('');
const outputText = data => data.output_text || (data.output || [])
  .filter(item => item.type === 'message')
  .flatMap(item => item.content || [])
  .filter(item => item.type === 'output_text')
  .map(item => item.text || '').join('\n');
function createHandler({ env = process.env, fetchImpl = fetch, now = () => new Date(),
  monotonic = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  return async function handler(event, context = {}) {
    // One budget covers submission, response-body reads, pauses and polling together.
    const remainingRuntime = context.getRemainingTimeInMillis?.();
    const budget = Number.isFinite(remainingRuntime) ? Math.max(0, Math.min(3000, remainingRuntime - 300)) : 3000;
    const deadline = monotonic() + budget;
    const remaining = () => Math.max(0, Math.floor(deadline - monotonic()));
    const state = structuredClone(event.state?.session || {});
    function clearPending() {
      delete state.pending; delete state.question; delete state.pendingSince;
      delete state.pendingPolls; delete state.pendingErrors;
    }
    const month = now().toISOString().slice(0, 7);
    const saved = event.state?.user?.quota;
    const quota = saved?.month === month
      ? { month, used: Math.max(0, Number(saved.used) || 0) }
      : { month, used: 0 };
    function reply(text, end = false) {
      text = truncate(text, 950);
      return { version: '1.0', response: { text, end_session: end,
        ...(!end ? { buttons: [{ title: state.pending ? 'Готово?' : 'Помощь', hide: true },
          { title: 'Новый разговор', hide: true }] } : {}) },
        session_state: state, user_state_update: { quota } };
    }
    const skillId = event.session?.skill_id;
    if (!env.ALICE_SKILL_ID || skillId !== env.ALICE_SKILL_ID)
      return reply('Этот обработчик предназначен для другого навыка.', true);
    const userId = event.session?.user?.user_id || event.session?.user_id;
    if (!userId || (env.ALICE_OWNER_ID && userId !== env.ALICE_OWNER_ID))
      return reply('Доступ к собеседнику ограничен владельцем.', true);
    const command = normalize(event.request?.command || event.request?.original_utterance);
    const intents = event.request?.nlu?.intents || {};
    if (['выход', 'хватит', 'стоп'].includes(command) || intents['YANDEX.STOP'])
      return reply('До встречи!', true);
    if (['новый разговор', 'сброс', 'забудь разговор', 'начни заново', 'начнем заново'].includes(command)) {
      clearPending(); delete state.history;
      return reply('Начнём новый разговор. Что хотите обсудить?');
    }
    if (['отмена', 'отмени', 'отмени вопрос', 'отменить вопрос'].includes(command)) {
      clearPending();
      return reply('Ожидание отменено. Задайте новый вопрос.');
    }
    if (command === 'помощь' || intents['YANDEX.HELP'])
      return reply('Задайте вопрос. Если ответ ещё готовится, скажите «Готово?». Команда «Новый разговор» очищает контекст этой сессии. «Хватит» завершает навык.');
    if (!command || (event.session?.new && !event.request?.command))
      return reply('Привет! Я ваш личный собеседник. Что хотите обсудить?');
    if (env.ENABLED !== 'true')
      return reply('Собеседник подготовлен, но доступ к модели пока не включён.');
    const token = context.token?.access_token;
    if (!token || !env.YANDEX_FOLDER_ID)
      return reply('Не настроен доступ обработчика к модели.');
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      'x-project': env.YANDEX_FOLDER_ID, 'x-data-logging-enabled': 'false' };
    const request = async (url, body, maxWait = 2800) => {
      const timeout = Math.min(maxWait, remaining());
      if (timeout < 50) throw new Error('invocation_budget');
      const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers,
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
      if (!response.ok) {
        const error = new Error('upstream_' + response.status);
        error.status = response.status;
        throw error;
      }
      return response.json();
    };
    async function waitForReady(data) {
      let polls = 0;
      while (['queued', 'in_progress'].includes(data.status) && polls < 12 && remaining() > 250) {
        await sleep(Math.min(200, remaining() - 200));
        if (remaining() < 150) break;
        try {
          data = await request(API + '/' + encodeURIComponent(state.pending), undefined, 700);
          polls++;
        } catch {
          // The POST already succeeded. Keep its ID instead of creating a second generation.
          break;
        }
      }
      return data;
    }
    function consume(data) {
      if (['queued', 'in_progress'].includes(data.status)) return reply(WAIT);
      if (data.status === 'completed' || data.status === 'incomplete') {
        const answer = truncate(outputText(data), 950);
        if (answer) {
          state.history = [...(state.history || []), { role: 'user', content: state.question || '' },
            { role: 'assistant', content: answer }].slice(-4);
          while (Buffer.byteLength(JSON.stringify(state.history)) > 3500) state.history.shift();
          clearPending();
          return reply(answer);
        }
      }
      clearPending();
      return reply('Ответ получить не удалось. Попробуйте задать вопрос короче.');
    }
    if (state.pending) {
      const timestamp = now().getTime();
      if (!Number.isFinite(state.pendingSince)) state.pendingSince = timestamp;
      state.pendingPolls = (Number(state.pendingPolls) || 0) + 1;
      if (timestamp - state.pendingSince >= 120000 || state.pendingPolls > 10) {
        clearPending();
        return reply('Предыдущий ответ слишком долго готовился. Ожидание сброшено. Задайте вопрос ещё раз.');
      }
      // Any utterance can retrieve the result: recognition need not match a magic phrase.
      try {
        const data = await request(API + '/' + encodeURIComponent(state.pending));
        state.pendingErrors = 0;
        return consume(data);
      } catch (error) {
        state.pendingErrors = (Number(state.pendingErrors) || 0) + 1;
        if ([400, 404, 410].includes(error.status) || state.pendingErrors >= 3) {
          clearPending();
          return reply('Предыдущий ответ недоступен. Ожидание сброшено. Задайте новый вопрос.');
        }
        return reply('Пока не удалось получить ответ. Скажите «Готово?» ещё раз или «Отмена», чтобы задать новый вопрос.');
      }
    }
    if (['готово', 'ответ', 'продолжай'].includes(command))
      return reply('Сейчас нет ожидающего ответа. Задайте вопрос.');
    if (quota.used >= 300) return reply('Месячный лимит вопросов исчерпан. Он обновится в следующем месяце.');
    const question = truncate(event.request?.original_utterance || command, 600);
    if (Buffer.byteLength(JSON.stringify([{ role: 'user', content: question }])) > 1800)
      return reply('Пожалуйста, задайте вопрос короче.');
    const input = [...(state.history || []), { role: 'user', content: question }];
    while (input.length > 1 && Buffer.byteLength(JSON.stringify(input)) > 1800) input.shift();
    quota.used += 1;
    try {
      const data = await request(API, {
        model: 'gpt://' + env.YANDEX_FOLDER_ID + '/deepseek-v4.1-flash/latest',
        instructions: INSTRUCTIONS, input, max_output_tokens: 384,
        reasoning: { effort: 'none' },
        background: true, store: true,
      });
      if (!data.id) throw new Error('missing_response_id');
      state.pending = data.id; state.question = question;
      state.pendingSince = now().getTime(); state.pendingPolls = 0; state.pendingErrors = 0;
      return consume(await waitForReady(data));
    } catch {
      return reply('Модель сейчас недоступна. Запрос мог быть принят, поэтому не повторяйте его сразу. Попробуйте позже.');
    }
  };
}
module.exports = { handler: createHandler(), createHandler };
