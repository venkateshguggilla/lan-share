; Allow LAN Share through Windows Firewall on private/domain networks (removed on uninstall).
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Share"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="LAN Share" dir=in action=allow program="$INSTDIR\LAN Share.exe" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Share"'
!macroend
