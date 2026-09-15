# Business API inbox

The WhatsApp workspace offers two separate inboxes:

- Personal inbox / QR: WhatsApp's website in the desktop app. The user links
  their device. Messages are not imported into the CRM database.
- Business API inbox: incoming signed Meta webhooks and outgoing Local Geni
  API messages, available in the browser and desktop. Supports text replies,
  delivery/read events, a 24-hour reply window, and opt-out enforcement.

## Connect a live business inbox

1. Run the updated production Local Geni server, not the 4013 simulated sender.
2. Save and verify the business account, phone number ID, and access token in
   API connection.
3. In Business API inbox / Incoming message setup, save the Meta app secret
   and a secret verify token of at least 16 characters.
4. Provide a public HTTPS route forwarding ONLY `/webhooks/whatsapp` to the
   local server. Never publish all Local Geni routes through an open tunnel.
5. Register that HTTPS callback and the same verify token in Meta. Subscribe
   the WhatsApp business account to the app and enable the `messages` field.
6. Incoming messages appear after Meta delivers a valid signed webhook.

The public route validates the raw-body HMAC and the business account and
phone IDs. The private inbox routes require existing workspace access.
Only connection administrators can change webhook secrets. Only outreach
users can send replies. No public HTTPS route is provisioned automatically.

Unknown send outcomes are retained and are not automatically retried.
Repeated identical replies to the same incoming message are deduplicated
while sending, accepted, or unknown, including across browser tabs.
Manual text replies have a one-second submission interval; template batch
limits remain separate. Provider limits also apply.

This is not historical WhatsApp sync. Inbound media metadata is shown but
attachments are not downloaded or previewed. API support does not establish
that the same phone number can simultaneously use a QR-linked account;
any coexistence eligibility or onboarding must be handled through Meta.

The 4013 QA server is a simulated sender and does not mount the public
webhook route. Never enter live account credentials into that simulator.
The personal QR-linked WhatsApp view, however, is a REAL WhatsApp session.

[WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)
requires approved templates outside the 24-hour customer service window.
