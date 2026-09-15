# Local Geni Desktop

Open the existing Local Geni workspace and WhatsApp's website in one native window.
The CRM sidebar stays available while the WhatsApp inbox is open.

## Start

Keep the Local Geni server running at `http://127.0.0.1:4013`.
Run `npm run desktop` from the project root, or open `desktop/launch.command`.
The desktop opens the WhatsApp Inbox tab. On your phone, open WhatsApp,
choose Linked devices, then Link a device and scan the QR code in Local Geni.

For another existing local server:

```sh
LOCAL_GENI_DESKTOP_URL=http://127.0.0.1:4000 npm run desktop
```

Only loopback HTTP origins are accepted. The desktop does not start servers,
change the CRM database, or start message workers. Port 4013 currently serves
the CRM simulator, but the WhatsApp website is REAL. After linking, anything
you send in the WhatsApp view is a real message, not a simulated campaign.

The server must serve the updated client. For the existing 4013 preview, build
the client with `npm --prefix client run build -- --outDir qa-dist`.

## Privacy and controls

- WhatsApp runs in a sandboxed Electron WebContentsView with no Node access,
  preload bridge, DOM scraping, or automatic sending. Its TLS and security
  headers remain intact. Browser identity uses the actual bundled Chromium
  version without application suffixes, for website compatibility.
- The CRM and WhatsApp use separate persistent browser sessions. WhatsApp's
  linked-device data stays under the current OS user's application data in
  `Local Geni Desktop`, not in the CRM database or on the Desktop.
- This is a personal linked inbox for the computer account, not a team inbox.
  A different person using the same unlocked OS account can access it.
- Chat history and delivery status are not copied into CRM records. Existing
  Business API templates, campaigns, and send history remain separate.
- Reload keeps the sign-in. Forget sign-in removes only WhatsApp's local
  browser data after confirmation. Revoke the device under Linked devices
  on your phone as well if you no longer want it linked.
- External web links require confirmation before opening the system browser.
  Other URL schemes are blocked. Attachment downloads show a Save dialog
  with Downloads as the initial location.
- Notifications and camera/microphone requests require an explicit desktop
  permission prompt. Other site permissions are denied. Platform-level
  permissions and WhatsApp's own browser feature support still apply.

## Scope

This is a local development desktop launcher, not a signed installer or an
official WhatsApp client. It uses WhatsApp's own website and QR sign-in;
availability, linked history, and calling features depend on WhatsApp's
support for the embedded Chromium browser. It does not bypass restrictions
or implement the WhatsApp protocol with an unofficial library.

Electron is pinned in the package lock. Keep it updated before distributing
the desktop beyond this local development setup. Signed distribution,
automatic updates, and bundled server lifecycle are not implemented here.

References: [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view),
[Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
