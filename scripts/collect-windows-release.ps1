$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $config.version
$destination = Join-Path $projectRoot 'artifacts\release\windows'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$binary = Join-Path $projectRoot 'src-tauri\target\release\terminal-reader.exe'
$installer = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis\Terminal Reader_${version}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $binary) -or -not (Test-Path -LiteralPath $installer)) { throw 'Build Windows executable and installer first.' }
Copy-Item -LiteralPath $binary -Destination (Join-Path $destination "TerminalReader-${version}-win-x64.exe") -Force
Copy-Item -LiteralPath $installer -Destination (Join-Path $destination "TerminalReader-${version}-win-x64-setup.exe") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'PRIVATE-LIBRARY.md') -Destination (Join-Path $destination 'PRIVATE-LIBRARY.md') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'KEYBOARD.md') -Destination (Join-Path $destination 'KEYBOARD.md') -Force
$notes = @"
Terminal Reader $version

Run TerminalReader-${version}-win-x64.exe directly, or use the setup executable to install for the current Windows user.
The release contains its frontend; Node, Rust and the development server are not needed.
Microsoft WebView2 Runtime is required; setup handles its installation when missing.

Formats: TXT, Markdown, EPUB 2/3 (text and table of contents).
Commands: open folder ls boss close find chapter mark back refresh backup restore style mode speed help
Search: Ctrl+F; F3/Shift+F3 next/previous; Esc returns to the original reading position.
Bookmarks: Ctrl+D. Left/right switches books, preserving existing history and starting unread books at the first line.
Library: custom categories, category filtering, multiple selection, batch removal and undo. Original files are preserved.
Interface: text actions, [ ]/[x] selection and #category labels; mouse and keyboard controls remain available.
Independent library: see PRIVATE-LIBRARY.md; separate password-protected encrypted library. Backups stay within their own workspace.
Global boss key: Alt+Q, customizable in /style. Ctrl+C without a selection closes the current book.
Commands: ls/dir, cd, cat/type, recent/resume, goto, history, clear/cls, help.
Progress: whole book or chapter; bar, viewport page count, percentage and estimated remaining pages. File/backup selection stays inside the terminal UI.
Keyboard: F1 reference; F6 regions; Ctrl+K commands; Ctrl+B library; Ctrl+M selection; Delete/Ctrl+Z remove/undo.

EPUB images, complex layouts and DRM-protected books are not rendered. Backups include cached text, categories, progress, bookmarks and settings.
"@
Set-Content -LiteralPath (Join-Path $destination 'README.txt') -Value $notes -Encoding UTF8
$hashes = Get-ChildItem -LiteralPath $destination -File -Filter '*.exe' | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLowerInvariant())  $(Split-Path -Leaf $_.Path)" }
Set-Content -LiteralPath (Join-Path $destination 'SHA256SUMS.txt') -Value $hashes -Encoding ASCII
Get-ChildItem -LiteralPath $destination -File | Select-Object Name,Length
