# Local Geni

Local Geni is a local workspace for finding businesses and selling website redesigns. Save leads, attach links from your separate design system, prepare personal WhatsApp drafts, and manage email conversations and reviewed follow-ups.

Design creation and hosting belong to the separate design system. Local Geni currently accepts its public links manually. Automatic integration with that system is a future step.

## What is included

| Workspace | Purpose |
|---|---|
| Discover | Find businesses by service and location using Google Places. Review scan limits before starting. |
| Leads | Filter and rank businesses, inspect website checks, save notes, set follow-ups, and move leads to recoverable Trash. |
| Design links | Attach a public external homepage URL, add a short pitch note and contact name, and track the sales stage. |
| WhatsApp batch | Review up to 25 personal drafts for manual chats, or queue approved templates through your connected WhatsApp Business API account. |
| Email | Connect sender accounts, review exact messages, send through the chosen provider, and sync replies. |
| Sequences | Schedule reviewed follow-ups with a time zone, sending window, and explicit start, pause, resume, and cancel controls. |
| Email setup | Check DNS records, configure optional SMTP DKIM signing, verify recipients, set limits, and manage email exclusions. |
| System checks | Inspect isolated regression results and the email unsubscribe connection. |
| Exports | Download selected or filtered lead data as CSV or Excel. |

## Run locally

Use Node.js 22.13 or newer and npm. The application uses Node's built-in SQLite driver.

```bash
npm run setup
cp .env.example .env
npm run dev
```

Edit `.env` with your Google keys before running a scan. Development uses the API at `http://127.0.0.1:4000` and the browser UI at `http://localhost:5173`.

For the built application:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:4000`. The server binds to loopback and serves the built client. API access checks the local host and origin. Optional workspace sign-in adds a password and an HttpOnly session cookie.

## Configuration

| Variable | Purpose |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Server-side Places API key. Required for discovery. |
| `VITE_GOOGLE_MAPS_JS_KEY` | Browser Maps key. Restrict it to the app's actual local origins. |
| `VITE_GOOGLE_MAP_ID` | Map style identifier. |
| `PORT` | API port, default `4000`. The dedicated development UI uses port `5173`. |
| `PLACES_RPS` | Places request rate. |
| `PLACES_COST_PER_1000` | Configured cost estimate for the usage panel, not a verified current Google price. |
| `PLACES_CACHE_TTL_HOURS` | Reuse period for identical Places responses. |
| `WEBSITE_CONCURRENCY` | Concurrent website analysis jobs. |
| `DB_PATH` | Optional SQLite path; defaults to `data/leads.db`. |
| `EMAIL_KEY_PATH` | Optional local credential encryption key path; normally next to the database. |

Google discovery needs an enabled Places API and the owner's Google billing setup. The browser map needs Maps JavaScript API access. Limit each key to its intended API and origins. Use the app's request budgets and the Google account's billing controls together.

Mailbox credentials, Microsoft consent, recipient-verification credentials, and unsubscribe connection settings are entered inside Local Geni. The application does not arrive with an authenticated sender account.

## Find and manage leads

Choose a business category, location, and scan budget. Discovery searches smaller map areas when a result set fills. Coverage remains limited by Google results, scan budgets, and minimum tile sizes.

Website analysis reads markup and contact links. It can identify missing websites, social-only links, broken responses, missing HTTPS, missing mobile viewport metadata, and other sales signals. These are heuristics; the app does not measure rendered design quality or Core Web Vitals.

Each lead receives a score and reasons. Filters include tier, location, searched category, web presence, rating, contact route, lead status, and follow-up date. Notes and sales status stay with the saved business.

**Delete lead** or **Delete selected** moves records to Trash. Pending sequence recipients are stopped. Restoration preserves notes, external design links, and message history, but does not restart stopped follow-ups. Deletion waits while an email submission is in progress. Repeated scans do not restore deleted businesses.

## Attach an external design link

Open **Design links**, choose a saved business, and paste the public HTTPS address supplied by your design system. Add a contact name and a short pitch note if useful. Save before composing outreach.

Use a link the recipient can open. Local addresses, IP addresses, sample domains, embedded credentials, and non-HTTPS links are rejected. Link validation checks the address format; it does not test permissions or guarantee that the external page is reachable.

The saved public URL fills `{previewUrl}` in supported outreach templates. A legacy designer/work URL is not automatically used as the prospect's link. The sales stages are Shortlisted, Designing, Ready to share, Sent, Replied, Call booked, Won, and Lost. Marking a stage manually does not create a sent-message event.

The workspace retains prior project notes and history. Older image and publication records remain in the local database for preservation; active routes expose only project/link tracking and activity.

## Prepare a WhatsApp batch

1. Select between 1 and 25 businesses in **Leads**, then choose **WhatsApp batch**.
2. Write a shared template or use the saved business-specific pitches. Names, contact names, pitch notes, and saved public design links are filled in separately.
3. Review each recipient and its exact message. Edit individual drafts as needed. Missing and duplicate phone numbers are excluded by default. Businesses marked not interested or lost are excluded.
4. Choose **Open WhatsApp draft** for that business. Send the message yourself inside WhatsApp.
5. Return and choose **I sent this** to record your confirmation.

In manual mode, Local Geni checks the current lead again before opening one chat at a time. A removed business or changed recipient must be reviewed again. It does not automate WhatsApp Web or inspect delivery and read status. Opening or copying a draft does not mark a business contacted. A sent confirmation records exactly the reviewed text and is safe to retry without adding the same confirmation twice.

Phone numbers are shown as unverified unless the business website published a WhatsApp link. A published link is evidence of the listing, not a guarantee that the number is currently active or that someone will reply. Email exclusions are address-based. WhatsApp API opt-outs are recorded separately against the phone number; incoming WhatsApp replies and opt-outs are not synced automatically.

### Send through the WhatsApp Business API

In **WhatsApp**, save your Meta business account ID, phone number ID, and access token. Verify the connection and refresh approved templates. Tokens are encrypted and excluded from settings responses. This connection supports one business sender at a time. Verification checks account access without sending a message.

Select 1 to 25 businesses in Leads and choose **WhatsApp batch**, then the API mode. Record each recipient's explicit WhatsApp permission and its source. A public phone number or website WhatsApp link does not count as permission. Select an approved template, fill its fields, and check every recipient's exact final message before confirming the queue. Template text headers, bodies, footers, public HTTPS URL buttons, and phone buttons are supported. Media, named parameters, quick replies, flows, and authentication templates are not supported.

The worker submits one recipient at a time while Local Geni is running. Default pacing is 25 attempts per rolling 24 hours, 5 per rolling hour, and 120 seconds between attempts. The settings allow lower or higher local caps, within 1 to 1000 daily attempts, 1 to 100 hourly attempts, and 1 to 3600 seconds between attempts. Meta's own account limits also apply. Accepted, failed, and unknown attempts count toward pacing.

**Accepted** means Meta accepted the API request. It does not mean delivered or read. An unknown outcome is never retried automatically. Review it in WhatsApp Manager before deciding what to do next. **Cancel unsent messages** stops the remaining queue; it cannot recall an already submitted message. Paused queues require an explicit resume. App restarts pause unfinished queues. Changed settings, permissions, recipients, or templates may require a fresh review.

Record opt-outs when you receive them. They block API submissions for that phone number and cancel queued submissions. There is no WhatsApp inbox/webhook sync or automatic delivery/read tracking in this release. Manual chat activity and API submission history remain distinct.

## Connect email accounts

Each saved sender has separate encrypted credentials and incoming-mail settings. Select the account for a message or sequence. Adding an account does not bypass the workspace's shared sending limits.

| Provider | Required setup |
|---|---|
| Gmail / Google Workspace | Sender email and a Google app password. SMTP uses TLS on port 465. App-password availability depends on the account's security and organization settings. |
| Microsoft 365 / Outlook | Microsoft Entra public-client application registration, client ID, and user sign-in. Delegated `User.Read`, `Mail.Send`, and offline access are requested; inbox sync additionally requires `Mail.Read` consent. Organization policy may require an administrator. |
| Custom SMTP | Public SMTP hostname, authorized sender address, username, and password/app password. Port 465 uses TLS; port 587 requires STARTTLS. |

Save and **Verify connection** before preparing a send. Verification connects to the provider but sends no test email. It does not prove inbox placement.

Credentials and OAuth tokens are encrypted with AES-256-GCM in dedicated database records. The persistent key has owner-only filesystem permissions. The UI receives masked connection information. Changing the credential identity requires a new connection; old passwords are not reused for another host or account.

Official provider setup references: [Google app passwords](https://support.google.com/accounts/answer/185833) and [Microsoft device authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).

## Review and send email

Choose **Compose email** from a lead or Design links. Check the selected sender and single recipient, edit the subject and plain-text message, then choose **Review email**. Review includes the exact footer and unsubscribe link when configured. Sending requires explicit confirmation of that content.

A review expires after 15 minutes and is bound to the message, account, and sending rules. A consumed review or repeated request cannot submit the same attempt again. History distinguishes `sending`, `sent`, `failed`, and `unknown`. Here, `sent` means the provider accepted the submission, not delivered or read.

Only accepted email submissions update the contacted marker. An uncertain provider response or interrupted submission is never retried automatically. Review the provider's Sent folder before considering a different attempt. The app preserves the message and its outcome even when account settings later change.

### Incoming mail and sequences

Enable and verify incoming mail for each sender. Gmail can reuse its app password for IMAP. Custom SMTP accounts need their own IMAP hostname and credentials on TLS port 993. Microsoft accounts need `Mail.Read`; reconnect with inbox access selected if the original consent covered sending only.

Sync begins with recent inbox mail from the last 30 days, then tracks subsequent changes. Mail is fetched without marking unrelated messages read. Matching replies appear with the lead; delivery-status bounces and opt-out replies can stop future outreach. Classification can be reviewed in Inbox. The UI shows the newest 200 imported messages per query.

A sequence supports up to 25 recipients and five message steps. Delays are measured after the previous accepted email. Choose a time zone, weekdays, and sending window. Review every expanded recipient/step message before starting. The approved content is stored; later design-link edits do not rewrite it.

Automatic follow-ups require a verified sender, a verified inbox, and working public email unsubscribe handling. Each cycle checks replies and opt-outs before sending. A failed inbox or unsubscribe sync holds sending. Replies, bounces, opt-outs, and Trash stop pending recipients. Pausing and cancelling remain explicit actions. Changes to the sender or sending rules require another review.

Sequences run only while the local application is open. Unknown outcomes are terminal for that attempt and are not automatically retried.

### Sending rules, DNS and verification

Default limits are 25 attempts per rolling day, five per rolling hour, and 120 seconds between attempts. These are local controls, not provider allowances. Reserved failed attempts count toward the limits. Replaying the same request does not reserve another slot. The email do-not-contact list applies across all sender accounts.

DNS checks report MX, SPF, a selected DKIM record, and DMARC. Record presence is distinct from authentication of a real message. SPF and DMARC drafts can be copied into the owner's DNS provider; the app does not edit DNS. It does not implement complete recursive SPF evaluation or organizational-domain DMARC resolution.

Gmail and Microsoft domain signing is configured in their administrator systems. Custom SMTP can use a locally generated 2048-bit RSA DKIM key after its public key is found in DNS. The private key stays encrypted locally. Signed messages cover both one-click unsubscribe headers.

Recipient verification supports DNS mail-route checks and optional ZeroBounce mailbox checks. DNS alone does not prove a mailbox exists. Mailbox verification requires the owner's provider credentials and may consume paid credits. Recent invalid results block email attempts; mandatory successful mailbox verification is optional.

The small `public-relay/` service handles signed email unsubscribe preferences only. Opaque tokens identify requests; email addresses are mapped locally. Its account, URL, connection key, and signing key must be configured under **System checks**. Individual email can use the reply-based opt-out footer without this service; automatic sequences require the unsubscribe connection.

## Data, access and backups

The default database is `data/leads.db`. It contains leads, scans, app settings, project links, outreach activity, email accounts/history, imported mail, sequences, and QA results. Existing legacy project tables are retained.

Back up the database together with its credential encryption key and any separately configured secrets. A database-only backup cannot recover encrypted mailbox credentials. Use SQLite's backup facility for a consistent live backup, or stop the app before copying its database files. Protect backup access as carefully as the original key.

Workspace sign-in is optional. With no credentials configured, the local dashboard is open. Configured sign-in uses salted password hashing, random server-side sessions, an HttpOnly SameSite cookie, and failed-login throttling. To recover access, stop the application and run `npm run reset-login`.

Lead export supports CSV and Excel, up to 5,000 selected or filtered records. Private credentials and mailbox tokens are not included. Trash records are excluded from active lead views by default.

## API overview

All application endpoints are under `/api` and use local-origin and optional sign-in checks. The legacy `/previews` resource name is retained for external design-link and pipeline compatibility.

| Resource | Operations |
|---|---|
| `/meta`, `/settings`, `/limits`, `/followups`, `/events` | Workspace metadata, settings, budgets, reminders, and live events. |
| `/scans` | Discovery lifecycle, progress, pause/resume/stop. |
| `/leads` | Search and filter saved businesses. Use `trash=true` for Trash. |
| `/leads/:placeId` | Read a lead or update notes, status, and follow-up date. |
| `/leads/delete`, `/leads/restore` | Move selected IDs to Trash or restore them. Delete requires `confirmed:true`. |
| `/export` | CSV or Excel lead-data export. |
| `/previews`, `/previews/:placeId` | List projects, read details, or save an external URL and project fields. |
| `/previews/:placeId/activity` | Record draft opening, manual sent confirmation, reply, or booked call. |
| `/email/accounts`, `/email/settings` | Sender selection and masked configuration. |
| `/email/prepare`, `/email/send`, `/email/messages` | Canonical email review, confirmed submission, and history. |
| `/email/inbox`, `/email/inbox/sync` | Imported incoming mail and synchronization. |
| `/email/campaigns` | Drafts, exact reviews, explicit start, and sequence control. |
| `/email/policy`, `/email/suppressions` | Shared email limits and exclusions. |
| `/email/infrastructure`, `/email/domain/check`, `/email/verification` | DNS and recipient checks. |
| `/publishing/status`, `/publishing/settings`, `/publishing/verify`, `/publishing/sync` | Email unsubscribe connection. Naming is retained for compatibility. |
| `/qa/status`, `/qa/settings`, `/qa/run` | Recurring isolated regression checks. |
| `/auth/*` | Workspace login, credentials, sessions, and recovery controls. |

Email operations accept an explicit `accountId`; otherwise the selected sender is used. Existing primary-account data is preserved when additional accounts are added.

## Development and checks

| Command | Purpose |
|---|---|
| `npm run setup` | Install server and client dependencies. |
| `npm run dev` | Start the API and Vite development client. |
| `npm run dev:server`, `npm run dev:client` | Start either side individually. |
| `npm run build` | Build `client/dist`. |
| `npm start` | Run the built local application. |
| `npm test` | Run server, client-helper, and unsubscribe-relay regressions with isolated data. |
| `npm run qa` | Run regressions and build the client. |
| `npm run test:email-ui` | Start the dedicated fictional email/DNS/inbox/WhatsApp simulator on port 4011. |

**System checks** runs tests after source changes and periodically while the app is open. Its child process excludes production credentials, uses memory databases and keys, and blocks network access except ephemeral local HTTP servers created by its tests. It does not send real messages or rewrite application code. Provider acceptance and account setup still need testing with the owner's actual accounts when explicitly authorized.

The main code areas are `server/repo.js` for leads, `server/previewRepo.js` for external links and activity, `server/email*.js` for email, `client/src/lib/whatsappBatch.js` for draft preparation, and `client/src/components/` for the workspaces. Tests sit beside the relevant modules. The unsubscribe relay is separate under `public-relay/`.

## Current boundaries

- External design links are entered manually. The separate bulk designer's automatic integration is not connected yet.
- Mailbox credentials, Microsoft registration/consent, verification-provider credits, DNS changes, and unsubscribe-service configuration require the owner's accounts.
- Website checks are markup heuristics. Email acceptance and verification do not guarantee delivery, inbox placement, or replies.
- WhatsApp API sending requires the owner's Meta account, supported approved templates, and recorded recipient permission. Incoming replies, opt-outs, delivery, and read receipts are not synced.
- Background inbox sync, follow-ups, and recurring checks run while Local Geni is open.

### Finished pages from your design system

In **Design links**, choose a business and save its finished `.html` or `.htm` file. Uploads accept UTF-8 HTML up to 3 MB. Local Geni stores the exact bytes and their SHA-256 checksum. It does not render the HTML, run its scripts, fetch its assets, add CRM notes, or create a public webpage. Use self-contained HTML for offline use; external and relative assets remain as provided.

**Export finished HTML** downloads the current file. Earlier versions stay available under **File details and earlier versions**. Repeating the same upload does not add another identical current version. A first file creates a shortlisted CRM entry without changing contact status. A public design link remains separate and is still required for link-based outreach.

To download several saved pages, select up to 25 businesses in Leads and choose **Export finished pages**. The ZIP contains each business's latest HTML with safe business-name prefixes. Total source size is limited to 25 MB. Missing files or deleted businesses stop the whole export with an explanation. Moving a business to Trash hides its files; restoring it makes them available again.

The private `/api/preview-files` endpoints provide metadata, upload, version downloads, and selected-business ZIP export behind the same workspace access and local-origin checks as the CRM. They are a manual file workflow today; no separate design system is connected automatically.

### Isolated WhatsApp UI checks

The messaging simulator creates a separate temporary database with two fictional phone numbers and external design-link strings. It blocks real network requests and shows **NO MESSAGES DELIVERED**. Use `LOCAL_GENI_QA_PORT=4013 npm run test:email-ui` for the alternate isolated port. The simulator's `/api/whatsapp/qa/status` returns its fake connection values and template ID. No sender or recipient permission is preconfigured, so setup and permission checks can be tested through the UI.

The simulated WhatsApp worker does not run automatically. `POST /api/whatsapp/qa/tick` with `{ "advanceMs": 120000 }` advances its clock and runs at most one queued submission. `GET /api/whatsapp/qa/outbox` returns the exact simulated provider payloads. `POST /api/whatsapp/qa/outcome` accepts a fictional `number` and an `outcome` of `accepted`, `failed`, or `unknown`. These controls exist only in the isolated simulator, behind its local-origin and workspace-access checks.
