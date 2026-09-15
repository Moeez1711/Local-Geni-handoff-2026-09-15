# Local Geni interface discipline

Adapted from `/Users/mac/Code/clue-ai/clue-mail/DESIGN-SYSTEM.md` and the
Senit workspace at `http://localhost:4890`. That app is a reference, not a
runtime dependency. Keep Local Geni's name, records and permissions separate.

## Layout

- Group navigation by job. Keep it collapsible and keyboard accessible.
- Use a white utility bar, dark navigation, and quiet gray working surfaces.
- Keep one page title. Put the next action beside it.
- Lead with an answer, then attention items, then supporting details.
- Use rules and whitespace before adding another card or shadow.
- Keep table overflow inside its container, never across the whole page.

## Visual system

- Inter, weights 400, 500 and 600.
- Page title 22px, section 15px, body 13.5px, label 12.5px, hint 12px.
- Metrics may use 24px with tabular numerals.
- Space: 4, 8, 12, 16, 24, 32, 48 and 64px.
- Orange `#ff4e00` is reserved for the main advancing action.
- Selection, tabs, roles and types use neutral ink, not decorative colors.
- Green, amber and red report actual success, attention or failure.
- Buttons in a row share a height. Disabled buttons are neutral.
- Use visible focus rings and respect reduced motion.

## Copy

- One idea per sentence. Aim for twelve words or fewer.
- Delete redundant copy before reducing its font size.
- Labels are nouns. Buttons name the action they perform.
- Add hints only when the field needs explanation.
- Empty states need a clear next action, not an onboarding essay.
- Errors say what failed and what to do next.
- Keep safety-critical instructions even when they need more explanation.
- A saved credential is not a verified connection.
- An accepted message is not necessarily delivered or read.
- Never label a real WhatsApp session as simulated.

## Useful features, not placeholders

The shared shell includes business/page search, keyboard navigation,
saved sidebar and row-density preferences, and a follow-up workspace.
Dashboard actions come from existing workspace data, not generated claims.

Do not add fake AI, invented trends, decorative health scores, or controls
that imply an action happened when they only opened another page.
Personal QR chats and the Business API inbox remain separate.

These are implementation rules, not a claim that every legacy screen has
already passed a full design audit. Apply them as screens are updated.
