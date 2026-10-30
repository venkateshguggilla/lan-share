# LAN Share

Desktop app (Electron + TypeScript) for browsing and copying files between PCs on the same Wi-Fi/LAN,
and to/from phones through their web browser. Windows, Linux and RudramOS.

## Download

Windows installer: [Releases](https://github.com/venkateshguggilla/lan-share/releases).
The installer adds a Windows Firewall rule so devices on your **Private** networks can connect, and
shows this before installing. Uninstall from **Settings → Apps → Installed apps → LAN Share**, which
also removes the firewall rule; settings stay in `%APPDATA%\LAN Share` until you delete that folder.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org) (application in progress; releases made before approval
are unsigned).

Windows releases are built from this repository by GitHub Actions
([release workflow](.github/workflows/release.yml)); only files built from this source are signed,
and every signing request is approved by hand.

- Committers and reviewers: [venkateshguggilla](https://github.com/venkateshguggilla)
- Approvers: [venkateshguggilla](https://github.com/venkateshguggilla)

## Privacy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it. Files and folder listings go only
to devices on your network that you connect to, or that connect with this PC's password. LAN Share
has no telemetry, no accounts and no internet services. Full policy: [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)

## Run

```
npm install
npm start
```

On first launch, set this PC's **name** and **password** and choose the folders to share.
Other PCs running LAN Share appear in the sidebar automatically; click one and enter its password.

To build the Windows installer: `npm run dist` → `release/LAN-Share-Setup-<version>.exe`.
The installer asks for admin rights so it can add a Windows Firewall rule (private/domain networks only);
the uninstaller removes it. `npm run icon` regenerates `build/icon.png`.

Run `npm test` for the end-to-end test (server, auth, browsing, transfers, security checks).

To try two copies on one PC, start the second with a separate profile:

```
set LANSHARE_PROFILE=second && npx electron .
```

## Phones

Click **Connect a phone** on the PC and scan the QR code. The phone's browser opens a page served by the PC
(`static/mobile/`), asks for the PC's password, and can browse shared folders, download files and upload into
Read & write folders. No phone app is needed. The browser shows a one-time certificate warning because the
certificate is self-signed. Downloads use short-lived single-file links (`POST /api/ticket`), so the session
token never appears in a URL.

## Linux and RudramOS

`npm run dist:linux` builds `release/linux-unpacked/lan-share` (x64). RudramOS builds LAN Share into
its image from a pinned commit of this repo (see the RudramOS `Containerfile`).

On RudramOS every network is Public (all incoming traffic dropped) until an admin marks it as Home,
and LAN Share must also be allowed there (`pcos-network share lan-share on`). LAN Share reads
`pcos-network status`; until both are true it doesn't announce itself, and its network warning
offers buttons that run those commands through `pkexec` (admin approval).

## How it works

| Piece | File | Notes |
|---|---|---|
| Discovery | `src/main/discovery.ts` | UDP broadcast on port 47820 every 3 s |
| File server | `src/main/server.ts` | HTTPS on port 47821 (self-signed cert, generated on first run) |
| Auth | `src/main/auth.ts` | scrypt-hashed password, session tokens, 5-attempt lockout |
| Client | `src/main/client.ts` | Certificate pinning (trust on first use) before any password is sent |
| Transfers | `src/main/transfers.ts` | Queue, progress, cancel, folders, no-overwrite naming |
| UI | `src/renderer/app.ts`, `static/` | Device list, two-pane explorer, transfers, dialogs |

Security rules: only the shared folders are reachable (path traversal and links outside them are blocked),
read-only folders reject uploads, and changing the password signs out every connected PC.

## Firewall

Windows asks to allow LAN Share the first time it starts. Allow it on **Private networks**, otherwise other PCs
can't see or connect to this one. Guest/public Wi-Fi often blocks device-to-device traffic; use
**Connect by IP address** if discovery doesn't work.
