# LAN Share privacy policy

Last updated: 30 October 2026

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it.

## What LAN Share does not do
- No telemetry, analytics, crash reporting or usage statistics.
- No accounts, no sign-up, no cloud or internet services. LAN Share never contacts a server on
  the internet.
- No advertising and no third-party tracking.

## What happens on your local network
- **Discovery:** while other devices are allowed to connect, LAN Share announces this PC's name
  and its LAN Share port to devices on the same local network (UDP broadcast), so other copies of
  LAN Share can list it. On RudramOS it stays silent unless the network is a Home network and
  LAN Share is allowed.
- **Connections:** another PC or a phone can only list folders or transfer files after entering
  the password set on this PC. It can only see the folders you choose to share. Connections are
  encrypted (HTTPS).
- **Transfers:** files go directly between the two devices on your network, and only when someone
  with the password requests them, or when you send them.

## What is stored on your PC
In your user profile (`%APPDATA%\LAN Share` on Windows, `~/.config/LAN Share` on Linux):
- This PC's name, its password as a salted scrypt hash (not the password itself), the folders you
  share and their read-only / read & write setting.
- The encryption certificate this PC uses, and the certificates of PCs you have connected to (to
  detect impostors).
- Saved logins for other PCs when you tick "Remember this PC", encrypted with your operating
  system's protected storage where available.

Nothing is stored about the files you transfer beyond the files themselves. Delete the folder above
to remove all of it.

## Contact
Questions or concerns: open an issue at https://github.com/venkateshguggilla/lan-share/issues
