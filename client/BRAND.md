# Local Geni product brand

Local Geni helps people find local businesses, attach external website designs, and manage personal outreach. The product uses clear actions, readable data surfaces, and honest status labels.

The current palette follows the banner selected by Asif on September 12, 2026: [Clue Marketing, Option 1, node 1691:398](https://www.figma.com/design/RptskuEChO15neibqRTgGx/Clue-Marketing?node-id=1691-398). Its white base carries blue `#2B5FD9` and orange `#FF4E00` radial paints at 80% layer opacity. The app adapts their proportions to the viewport. Cards remain white, with translucent navigation and toolbar surfaces.

## Identity

The mark draws a G as a location marker. Use `BrandMark.jsx` in the app and `public/local-geni.svg` for the favicon. Keep the white path on blue with its existing clear space. Do not add emoji, a mascot, or decorative symbols to product labels.

## Tokens

| Role | Token | Value |
| --- | --- | --- |
| Selection, links, and supporting action blue | `--color-accent` | `#2b5fd9` |
| Blue hover / accessible link ink | `--color-accent-dark`, `--color-accent-ink` | `#234fb7` |
| Selected surface | `--color-accent-soft` | `#edf2fc` |
| Main advancing action orange | `--color-brand-orange` | `#ff4e00` |
| Warm wash | `--color-brand-warm` | `#fef6f3` |
| Background fallback | `--color-bg` | `#f8f8f8` |
| Main surface | `--color-panel` | `#ffffff` |
| Secondary surface | `--color-panel-2` | `#f9fafc` |
| Main text | `--color-ink` | `#151718` |
| Supporting body text | `--color-ink-2` | `#3a4044` |
| Page headings | `--color-heading` | `#00112b` |
| Supporting text | `--color-muted` | `#626a76` |
| Separator | `--color-line-2` | `#e3e3e3` |

Use the existing success, warning, error, and WhatsApp tokens for meaning. Blue handles selection and navigation. Orange is reserved for the main advancing action in a task area. The bright brand orange remains an accent; buttons use the AA-safe darker `--lg-orange-action` derivative with white text. Avoid adding unrelated colors for decoration.

## Runtime system layer

`src/design-system.css` is imported last from `src/main.jsx`. It is the
canonical runtime layer while the older workspace styles are gradually
consolidated. New screens should consume its semantic tokens and existing
primitives instead of adding another component library or a second colour
system. The current dashboard is the reference implementation for surfaces,
status badges, focus states, responsive spacing, and action hierarchy.

## Type and geometry

Use Inter at 400, 500, 600, and 700 as specified by the brand skill. `src/brand-fonts.css` embeds losslessly compressed WOFF2 versions of the font files referenced by the live [Clue stylesheet](https://cdn.prod.website-files.com/6035470ede88024713cf3bf6/css/getclue.webflow.shared.fd28aa335.min.css), so the app does not depend on a font CDN at runtime. Glyph coverage, spacing and weights match the originals. The Inter license is included in `public/Inter-LICENSE.txt`. Do not use synthetic 550/650/750 weights. Workspace page titles use 22px; dashboard hero headings may scale from 30-38px; section headings use 15px; body copy uses 13.5px; supporting labels use 12px. Numeric results use tabular figures. Technical values keep the existing monospace stack.

Controls have a 10px radius, cards 16px, and modal panels 20px. Use the shared card shadow and visible blue keyboard focus. On small screens, form text is 16px to prevent input zoom; primary controls have at least a 42px touch height. Existing compact table actions have separate small-control spacing.

## Product language

Use short sentence-case labels. One primary action per task area. Say what happened: a draft opened, a provider accepted an email, or the user confirmed a WhatsApp send. Do not imply delivery or read status without evidence. Designs are made externally and linked in this CRM.

## Verification

Check the production build, inspect hexadecimal colors for malformed characters, and check edited brand assets for non-ASCII homoglyphs. Contrast ratios should be checked for text, focus, and action colors. Test layout separately from brand source checks before claiming a mobile visual pass.
