param([int]$VirtualKey = 81, [int]$ReaderProcessId = 0)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ShortcutTestInput {
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    private delegate bool EnumWindowProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    public static IntPtr FindReaderWindow(int process) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((window, data) => {
            uint owner; GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(256); GetWindowText(window, title, title.Capacity);
            if (owner == process && title.ToString() == "Terminal Reader") { found = window; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
if ($ReaderProcessId) {
    $readerWindow = [ShortcutTestInput]::FindReaderWindow($ReaderProcessId)
    if ($readerWindow -eq [IntPtr]::Zero) { throw 'Reader window not found' }
    [ShortcutTestInput]::ShowWindow($readerWindow, 9) | Out-Null
    [ShortcutTestInput]::keybd_event(18, 0, 0, [UIntPtr]::Zero)
    [ShortcutTestInput]::keybd_event(18, 0, 2, [UIntPtr]::Zero)
    [ShortcutTestInput]::SetForegroundWindow($readerWindow) | Out-Null
    Start-Sleep -Milliseconds 250
    if ([ShortcutTestInput]::GetForegroundWindow() -ne $readerWindow) { throw 'Reader did not receive foreground focus' }
}
if (-not $VirtualKey) { exit }
[ShortcutTestInput]::keybd_event(18, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[ShortcutTestInput]::keybd_event([byte]$VirtualKey, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[ShortcutTestInput]::keybd_event([byte]$VirtualKey, 0, 2, [UIntPtr]::Zero)
[ShortcutTestInput]::keybd_event(18, 0, 2, [UIntPtr]::Zero)
