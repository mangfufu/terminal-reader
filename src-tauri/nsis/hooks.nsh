; Tauri's generated association leaves the executable unquoted. The default
; per-user install directory contains spaces, so quote both executable and file.
; Keep the generated file class and current-user context so uninstall cleanup
; and restoration of the previous associations continue to work normally.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Text and ebook documents\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  !insertmacro UPDATEFILEASSOC
!macroend
