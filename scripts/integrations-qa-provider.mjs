/** Fixed, fictional responses. No network access or real deliveries. */
export function createIntegrationsQaProvider() {
  let sequence = 0;
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const answer = 'Sample response: I can help review outreach totals and prepare a draft. No records were changed and no message was sent. Connect an AI provider in your live workspace for generated answers.';
  return async function fetchFn(input, options = {}) {
    const url = new URL(input), route = url.pathname;
    if (url.hostname === 'api.neverbounce.com') return reply({ status: 'success' });
    if (url.hostname === 'api.firecrawl.dev') return reply({ success: true, data: { remaining_credits: 500 } });
    if (url.hostname === 'api.apollo.io') return reply({ is_logged_in: true });
    if (url.hostname === 'slack.com') return reply({ ok: true, team_id: 'QA_TEAM' });
    if (url.hostname === 'api.hubapi.com') return reply({ portalId: 12345 });
    if (url.hostname === 'oauth2.googleapis.com') return reply({ access_token: 'QA_ONLY_ACCESS_TOKEN' });
    if (url.hostname === 'docs.googleapis.com') return reply({ documentId: route.split('/').at(-1) });
    if (url.hostname === 'sheets.googleapis.com') return reply({ spreadsheetId: route.split('/').at(-1) });
    if (url.hostname === 'www.googleapis.com') return reply({ user: { permissionId: 'QA_USER' } });
    if (url.hostname === 'api.anthropic.com') return reply(route === '/v1/models' ? { data: [{ id: 'claude-qa', display_name: 'Claude · sample' }] } : { content: [{ type: 'text', text: answer }] });
    if (url.hostname === 'api.openai.com') return reply(route === '/v1/models' ? { data: [{ id: 'gpt-5-qa' }] } : { choices: [{ message: { content: answer } }] });
    if (url.hostname === 'generativelanguage.googleapis.com') return reply(route.endsWith('/models') ? { models: [{ name: 'models/gemini-qa', displayName: 'Gemini · sample', supportedGenerationMethods: ['generateContent'] }] } : { candidates: [{ content: { parts: [{ text: answer }] } }] });
    if (url.hostname === 'api.twilio.com') {
      if (route.endsWith('IncomingPhoneNumbers.json')) return reply({ incoming_phone_numbers: [{ phone_number: url.searchParams.get('PhoneNumber'), capabilities: { sms: true } }] });
      if (route.endsWith('/Messages.json')) return reply({ sid: `SM${String(++sequence).padStart(32, '0')}`, status: 'queued' });
      if (route.includes('/Messages/')) return reply({ sid: route.split('/').at(-1).replace('.json', ''), status: 'delivered' });
      return reply({ sid: route.split('/').at(-1).replace('.json', ''), status: 'active', type: 'Trial' });
    }
    if (url.hostname === 'api.telnyx.com') {
      if (route === '/v2/phone_numbers') return reply({ data: [{ id: 'qa-phone-id', phone_number: url.searchParams.get('filter[phone_number]') }] });
      if (route === '/v2/messages') return reply({ data: { id: `qa-telnyx-${++sequence}` } });
      if (route.includes('/messages/')) return reply({ data: { id: route.split('/').at(-1), to: [{ status: 'delivered' }] } });
    }
    if (url.hostname === 'rest.nexmo.com') return reply(route.includes('get-balance') ? { value: 10 } : { messages: [{ 'message-id': `qa-vonage-${++sequence}`, status: '0' }] });
    throw new Error('Unexpected provider request in the isolated simulator');
  };
}
