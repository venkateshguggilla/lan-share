; LAN Share installer additions (electron-builder NSIS include).
; - Windows Firewall rule for private/domain networks (removed on uninstall).
; - A page asking whether new devices need approval on this PC, saved to install-options.json,
;   which the app applies on first start for each user (and again after a reinstall).

!ifndef BUILD_UNINSTALLER
  ; This file is read before electron-builder loads MUI2; MUI2 guards against a second include.
  !include MUI2.nsh
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var ApprovalAsk
  Var ApprovalDirect
  Var ApprovalChoice

  !macro customPageAfterChangeDir
    Page custom ApprovalPageCreate ApprovalPageLeave
  !macroend

  Function ApprovalPageCreate
    !insertmacro MUI_HEADER_TEXT "Connections from other devices" "What happens when another PC or phone enters this PC's password?"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateRadioButton} 0 8u 100% 12u "Ask me to accept or reject it (recommended)"
    Pop $ApprovalAsk
    ${NSD_CreateLabel} 12u 22u 95% 20u "This PC shows a popup before the device can see your shared folders. Devices you mark $\"Always allow$\" skip it."
    Pop $0

    ${NSD_CreateRadioButton} 0 50u 100% 12u "Let it connect directly"
    Pop $ApprovalDirect
    ${NSD_CreateLabel} 12u 64u 95% 20u "Anyone who knows the password gets in without a popup."
    Pop $0

    ${NSD_CreateLabel} 0 100u 100% 12u "You can change this later in LAN Share > Settings."
    Pop $0

    ${If} $ApprovalChoice == "direct"
      ${NSD_Check} $ApprovalDirect
    ${Else}
      ${NSD_Check} $ApprovalAsk
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function ApprovalPageLeave
    ${NSD_GetState} $ApprovalDirect $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $ApprovalChoice "direct"
    ${Else}
      StrCpy $ApprovalChoice "ask"
    ${EndIf}
  FunctionEnd
!endif

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Share"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="LAN Share" dir=in action=allow program="$INSTDIR\LAN Share.exe" enable=yes profile=private,domain'
  ; Silent installs (/S) skip the page: they keep the safe default, asking for approval.
  FileOpen $0 "$INSTDIR\install-options.json" w
  ${If} $ApprovalChoice == "direct"
    FileWrite $0 '{"askBeforeConnect": false}'
  ${Else}
    FileWrite $0 '{"askBeforeConnect": true}'
  ${EndIf}
  FileClose $0
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Share"'
  ; Start-at-sign-in entry the app adds (app.setLoginItemSettings, name "LAN Share").
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LAN Share"
  Delete "$INSTDIR\install-options.json"
!macroend
