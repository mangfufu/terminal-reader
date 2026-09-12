#!/usr/bin/env python3
"""Native Linux smoke test. Run with xvfb-run and dbus-run-session.

Requires python3-gi, xdotool, openbox, and the GTK 3 introspection package. All reading
state is isolated in a temporary XDG directory; screenshots go to artifacts.
"""
import os
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import zipfile
import hashlib
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

os.environ['GDK_BACKEND'] = 'x11'
import gi
gi.require_version('Gdk', '3.0')
gi.require_version('GdkX11', '3.0')
from gi.repository import Gdk, GdkX11

binary = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else 'artifacts/linux-native').resolve()
output.mkdir(parents=True, exist_ok=True)

def xdotool(*args, check=True):
    result = subprocess.run(['xdotool', *map(str, args)], capture_output=True, text=True, check=check)
    # XSendEvent returning does not mean WebKit has applied a focus change.
    if args[0] in ('key', 'type'): time.sleep(.15)
    return result

with tempfile.TemporaryDirectory(prefix='terminal-reader-linux-smoke-') as directory:
    env = {**os.environ, 'GDK_BACKEND': 'x11', 'XDG_CONFIG_HOME': directory + '/config', 'XDG_DATA_HOME': directory + '/data', 'XDG_CACHE_HOME': directory + '/cache'}
    arguments = [str(binary)]
    epub_mode = '--epub' in sys.argv[3:]
    if epub_mode:
        epub = pathlib.Path(directory) / '本地 EPUB 验收.epub'
        with zipfile.ZipFile(epub, 'w') as archive:
            archive.writestr('mimetype', 'application/epub+zip')
            archive.writestr('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
            archive.writestr('OPS/package.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">linux-smoke</dc:identifier><dc:title>Linux 原生电子书验收</dc:title><dc:creator>Terminal Reader</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>')
            archive.writestr('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="one.xhtml">第一章 原生导入</a></li><li><a href="two.xhtml">第二章 阅读验证</a></li></ol></nav></body></html>')
            for file, title, text in [('one', '第一章 原生导入', '这份 EPUB 通过 Linux 原生程序的启动参数导入，文件路径包含中文和空格。'), ('two', '第二章 阅读验证', '目录、章节顺序和中文正文已经由原生解析器读取。')]:
                archive.writestr(f'OPS/{file}.xhtml', f'<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>{title}</h1><p>{text}</p></body></html>')
        arguments.append(str(epub))
    with (output / 'native.log').open('w') as log:
        # GTK foreground state is supplied by a window manager. Xvfb alone
        # provides keyboard focus but cannot model real desktop activation.
        manager = subprocess.Popen(['openbox'], stdout=log, stderr=subprocess.STDOUT, env=env)
        time.sleep(.5)
        process = subprocess.Popen(arguments, stdout=log, stderr=subprocess.STDOUT, env=env)
        try:
            window = None
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f'Native application exited with {process.returncode}; see {output / "native.log"}')
                result = xdotool('search', '--onlyvisible', '--pid', process.pid, check=False)
                for candidate in result.stdout.splitlines():
                    geometry = xdotool('getwindowgeometry', '--shell', candidate).stdout
                    fields = dict(line.split('=', 1) for line in geometry.splitlines() if '=' in line)
                    if int(fields.get('WIDTH', 0)) >= 280:
                        window = candidate
                        break
                if window: break
                time.sleep(.2)
            if not window: raise RuntimeError('No visible native application window appeared.')
            xdotool('windowfocus', '--sync', window)
            xdotool('windowactivate', '--sync', window)
            time.sleep(2)
            evidence = {'pid': process.pid, 'window': window, 'captures': []}

            def screenshot(name):
                if process.poll() is not None: raise RuntimeError('Application closed during keyboard smoke test.')
                info = subprocess.run(['xwininfo', '-id', window], check=True, text=True, capture_output=True).stdout
                width = int(re.search(r'^\s+Width:\s+(\d+)', info, re.MULTILINE).group(1))
                height = int(re.search(r'^\s+Height:\s+(\d+)', info, re.MULTILINE).group(1))
                display = Gdk.Display.get_default()
                display.sync()
                foreign = GdkX11.X11Window.foreign_new_for_display(display, int(window))
                # A foreign GdkWindow caches its initial size without a GTK
                # main loop. Query X11 each time, especially after a resize.
                pixbuf = Gdk.pixbuf_get_from_window(foreign, 0, 0, width, height)
                if pixbuf is None: raise RuntimeError('Could not capture native window.')
                pixbuf.savev(str(output / name), 'png', [], [])
                assert (pixbuf.get_width(), pixbuf.get_height()) == (width, height)
                evidence['captures'].append({'file': name, 'window_width': width, 'window_height': height, 'png_width': pixbuf.get_width(), 'png_height': pixbuf.get_height()})
                (output / (name.removesuffix('.png') + '-xwininfo.txt')).write_text(info)

            def command(text):
                xdotool('key', 'ctrl+k', 'ctrl+a')
                xdotool('type', '--clearmodifiers', '--delay', '12', text)
                if text == 'backup': screenshot('command-backup.png')
                xdotool('key', 'Return')
                time.sleep(.8)

            screenshot('epub-import.png' if epub_mode else 'welcome.png')
            if epub_mode:
                command('/chapter')
                screenshot('epub-chapters.png')
                xdotool('key', 'Escape')
            command('/demo')
            screenshot('reading.png')
            command('/chapter')
            screenshot('chapters.png')
            xdotool('key', 'Escape')
            command('/find')
            screenshot('search.png')
            xdotool('key', 'Escape')
            xdotool('key', 'ctrl+b')
            time.sleep(.3)
            xdotool('key', 'ctrl+a')
            time.sleep(.3)
            screenshot('keyboard-library.png')
            xdotool('key', 'F1')
            time.sleep(.3)
            screenshot('keyboard-help.png')
            xdotool('key', 'Page_Down')
            xdotool('key', 'Escape')
            xdotool('key', 'Escape')
            xdotool('key', 'Escape')
            command('/style')
            # The first focused setting is the four-profile native select.
            xdotool('key', 'End')
            xdotool('key', 'Return')
            xdotool('key', 'Escape')
            time.sleep(.5)
            screenshot('linux-theme.png')
            # New terminal picker and cover run inside the same native window.
            picker_dir = pathlib.Path(directory) / 'picker'
            picker_dir.mkdir()
            picker_book = picker_dir / 'keyboard.txt'
            picker_book.write_text('Linux terminal file selection works.\n\nSaved reading progress.', encoding='utf-8')
            xdotool('key', 'Escape')
            xdotool('key', 'ctrl+o')
            time.sleep(.5)
            screenshot('picker-opened.png')
            xdotool('key', 'ctrl+l')
            xdotool('type', '--clearmodifiers', str(picker_dir))
            xdotool('key', 'Return')
            time.sleep(.5)
            screenshot('terminal-picker.png')
            xdotool('key', 'alt+q')
            time.sleep(.5)
            screenshot('boss-cover.png')
            xdotool('windowactivate', '--sync', window)
            time.sleep(.5)
            xdotool('key', 'alt+q')
            time.sleep(.5)
            screenshot('boss-restored.png')
            xdotool('key', 'Return')
            time.sleep(.5)
            screenshot('picker-imported.png')
            time.sleep(.8)
            command('backup')
            screenshot('backup-picker.png')
            xdotool('key', 'ctrl+l')
            xdotool('type', '--clearmodifiers', str(picker_dir))
            xdotool('key', 'Return')
            time.sleep(.5)
            xdotool('key', 'ctrl+n')
            xdotool('type', '--clearmodifiers', 'linux-backup.json')
            screenshot('backup-name.png')
            xdotool('key', 'ctrl+Return')
            time.sleep(.8)
            screenshot('backup-result.png')
            archive = json.loads((picker_dir / 'linux-backup.json').read_text())
            assert any(book['id'] == str(picker_book) for book in archive['books'])
            xdotool('key', 'ctrl+c')
            time.sleep(.3)
            screenshot('closed-home.png')
            # Set a password through the native WebKit view and prove that
            # private backup export contains ciphertext rather than plaintext.
            command('vault')
            screenshot('password-setup.png')
            xdotool('type', '--clearmodifiers', 'linux-vault-pass')
            xdotool('key', 'Tab')
            xdotool('type', '--clearmodifiers', 'linux-vault-pass')
            xdotool('key', 'Return')
            time.sleep(1.2)
            screenshot('private-library.png')
            xdotool('key', 'ctrl+o')
            time.sleep(.3)
            xdotool('key', 'ctrl+l')
            xdotool('type', '--clearmodifiers', str(picker_book))
            xdotool('key', 'Return')
            time.sleep(.7)
            xdotool('key', 'ctrl+c')
            time.sleep(.7)
            command('vault')
            screenshot('password-required.png')
            xdotool('type', '--clearmodifiers', 'wrong-password')
            xdotool('key', 'Return')
            time.sleep(.7)
            screenshot('password-rejected.png')
            xdotool('key', 'ctrl+a')
            xdotool('type', '--clearmodifiers', 'linux-vault-pass')
            xdotool('key', 'Return')
            time.sleep(1.2)
            command('backup')
            xdotool('key', 'ctrl+l')
            xdotool('type', '--clearmodifiers', str(picker_dir))
            xdotool('key', 'Return')
            time.sleep(.5)
            xdotool('key', 'ctrl+n')
            xdotool('type', '--clearmodifiers', 'linux-private-backup.json')
            xdotool('key', 'ctrl+Return')
            time.sleep(1)
            screenshot('private-backup.png')
            protected_text = (picker_dir / 'linux-private-backup.json').read_text()
            protected = json.loads(protected_text)
            assert protected['format'] == 'terminal-reader-encrypted'
            assert 'keyboard.txt' not in protected_text and 'Linux terminal file selection' not in protected_text
            secret_key = hashlib.pbkdf2_hmac('sha256', b'linux-vault-pass', base64.b64decode(protected['salt']), protected['iterations'], 32)
            restored = json.loads(AESGCM(secret_key).decrypt(base64.b64decode(protected['iv']), base64.b64decode(protected['ciphertext']), None))
            assert restored['workspace'] == 'vault' and len(restored['books']) == 1
            assert restored['books'][0]['id'] == str(picker_book)
            evidence['encrypted_private_backup'] = {'format': protected['format'], 'iterations': protected['iterations']}
            command('lock')
            time.sleep(.7)
            xdotool('windowsize', window, '280', '160')
            time.sleep(.6)
            screenshot('small.png')
            assert (evidence['captures'][-1]['window_width'], evidence['captures'][-1]['window_height']) == (280, 160)
            # Use the same XDG and D-Bus session so the real single-instance
            # plugin must focus the first app and terminate the second one.
            secondary = subprocess.Popen([str(binary)], stdout=log, stderr=subprocess.STDOUT, env=env)
            try:
                secondary_code = secondary.wait(timeout=8)
            except subprocess.TimeoutExpired:
                secondary.terminate()
                secondary.wait(timeout=5)
                raise AssertionError('Second application process did not exit under single-instance control.')
            main_name = xdotool('getwindowname', window).stdout.strip()
            visible = xdotool('search', '--onlyvisible', '--name', '^' + re.escape(main_name) + '$', check=False).stdout.splitlines()
            assert secondary_code == 0 and visible == [window], f'Unexpected secondary exit/window count: {secondary_code}, {visible}'
            evidence['single_instance'] = {'second_process_exit_code': secondary_code, 'visible_main_windows': len(visible), 'window_ids': visible, 'window_title': main_name}
            xdotool('key', 'alt+F4')
            assert process.wait(timeout=8) == 0
            evidence['graceful_close'] = True
            (output / 'verification.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
            print(f'Native Linux smoke test passed; one main window, xwininfo/PNG 280x160; screenshots: {output}')
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            manager.terminate()
            manager.wait(timeout=5)
