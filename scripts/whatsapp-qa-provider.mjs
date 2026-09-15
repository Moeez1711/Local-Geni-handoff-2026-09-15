/** In-memory provider double. No network requests or messages leave this module. */
export const WHATSAPP_QA_ACCOUNT = Object.freeze({
  businessAccountId: '987654321098765', phoneNumberId: '123456789012345',
  accessToken: 'qa-meta-token-no-real-account-00000000', apiVersion: 'v26.0',
});
export const WHATSAPP_QA_NUMBERS = Object.freeze(['14165550123', '14165550124']);
export const WHATSAPP_QA_TEMPLATE = Object.freeze({
  id: '111222333444555', name: 'website_design', language: 'en_US', status: 'APPROVED',
  category: 'MARKETING', parameter_format: 'POSITIONAL', components: [
    { type: 'BODY', text: 'Hi {{1}}, here is your finished homepage design: {{2}}' },
    { type: 'FOOTER', text: 'Reply STOP to opt out.' },
  ],
});

export function createWhatsAppQaProvider({ startTime = Date.now() } = {}) {
  let clock = startTime;
  const submissions = [], outcomes = new Map();
  const rejection = (code = 190) => Response.json({ error: { code, message: 'Simulated provider rejection.' } }, { status: 400 });
  const fetchFn = async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== 'https://graph.facebook.com' || options.headers?.Authorization !== `Bearer ${WHATSAPP_QA_ACCOUNT.accessToken}`) throw new Error('Unrecognized simulated Meta request. No external request was made.');
    const root = `/${WHATSAPP_QA_ACCOUNT.apiVersion}`;
    if (options.method === 'GET' && url.pathname === `${root}/${WHATSAPP_QA_ACCOUNT.businessAccountId}/phone_numbers`) return Response.json({ data: [{
      id: WHATSAPP_QA_ACCOUNT.phoneNumberId, display_phone_number: '+1 416 555 0199', verified_name: 'Local Geni QA simulator', code_verification_status: 'VERIFIED', quality_rating: 'GREEN',
    }] });
    if (options.method === 'GET' && url.pathname === `${root}/${WHATSAPP_QA_ACCOUNT.businessAccountId}/message_templates`) return Response.json({ data: [WHATSAPP_QA_TEMPLATE] });
    if (options.method === 'POST' && url.pathname === `${root}/${WHATSAPP_QA_ACCOUNT.phoneNumberId}/messages`) {
      const payload = JSON.parse(options.body);
      if (!WHATSAPP_QA_NUMBERS.includes(payload.to) || payload.type !== 'template' || payload.template?.name !== WHATSAPP_QA_TEMPLATE.name) return rejection(131030);
      const outcome = outcomes.get(payload.to) || 'accepted';
      submissions.push({ id: `wamid.qa_${submissions.length + 1}`, payload: structuredClone(payload), outcome, attemptedAt: clock, simulated: true, delivered: false });
      if (outcome === 'unknown') throw new Error('Simulated connection loss after submission. No message was delivered.');
      if (outcome === 'failed') return rejection(131026);
      return Response.json({ messages: [{ id: submissions.at(-1).id }] });
    }
    return rejection();
  };
  return {
    fetchFn, now: () => clock,
    advance(milliseconds = 0) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 7 * 86400000) throw Object.assign(new Error('Advance the simulated clock by 0 to 604800000 milliseconds.'), { status: 400 });
      clock += milliseconds;
      return clock;
    },
    setOutcome(number, outcome) {
      if (!WHATSAPP_QA_NUMBERS.includes(number) || !['accepted', 'failed', 'unknown'].includes(outcome)) throw Object.assign(new Error('Choose a fictional QA phone number and accepted, failed, or unknown outcome.'), { status: 400 });
      outcomes.set(number, outcome);
    },
    outbox: () => structuredClone(submissions),
  };
}
