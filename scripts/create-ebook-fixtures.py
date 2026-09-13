"""Generate synthetic MOBI/KF8 fixtures using Calibre's ebook-convert (test tooling only)."""
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
output = root / 'tests' / 'fixtures' / 'ebooks'
output.mkdir(parents=True, exist_ok=True)
source = output / 'sample.html'
source.write_text('''<!doctype html><html><head><meta charset="utf-8"><title>电子书兼容性示例</title>
<meta name="author" content="Terminal Reader"></head><body>
<h1 id="one">第一章 纸船</h1><p>这是专门生成的测试正文，包含中文、English 和标点。纸船沿着小溪漂走。</p>
<p>第二段保留完整内容：甲乙丙丁，春夏秋冬。</p>
<h1 id="two">第二章 星灯</h1><p>远处的灯亮了！下一页会发生什么？</p><p>全书结束。</p>
</body></html>''', encoding='utf-8')
converter = shutil.which('ebook-convert')
if not converter:
    raise SystemExit('Install Calibre to regenerate the binary test fixtures.')
for filename, flags in [('sample.mobi', ['--mobi-file-type', 'old']), ('sample.azw3', []), ('hybrid.mobi', ['--mobi-file-type', 'both'])]:
    result = subprocess.run([converter, str(source), str(output / filename), '--authors', 'Terminal Reader', '--title', '电子书兼容性示例', '--chapter', '//h:h1', '--level1-toc', '//h:h1', *flags], capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr.decode(errors='replace'))
    print(f'{filename}: {(output / filename).stat().st_size} bytes')
