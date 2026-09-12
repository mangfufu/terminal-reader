"""Original EPUB fixtures for native end-to-end checks; no third-party books."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED

out = Path(__file__).resolve().parent.parent / 'artifacts' / 'fixtures'
out.mkdir(parents=True, exist_ok=True)
with ZipFile(out / '夜航 native test.epub', 'w') as book:
    book.writestr('mimetype', 'application/epub+zip', compress_type=ZIP_STORED)
    book.writestr('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', compress_type=ZIP_DEFLATED)
    book.writestr('OEBPS/book.opf', '''<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">native-test</dc:identifier><dc:title>夜航测试集</dc:title><dc:creator>本地测试作者</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="late" href="a.xhtml" media-type="application/xhtml+xml"/><item id="first" href="z.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="first"/><itemref idref="late"/></spine></package>''', compress_type=ZIP_DEFLATED)
    book.writestr('OEBPS/nav.xhtml', '''<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="z.xhtml#start">第一章 起航</a></li><li><a href="a.xhtml#end">第二章 到岸</a></li></ol></nav></body></html>''', compress_type=ZIP_DEFLATED)
    for filename, heading, marker in [('z.xhtml', '第一章 起航', 'start'), ('a.xhtml', '第二章 到岸', 'end')]:
        paragraphs = ''.join(f'<p>第 {i} 段。窗外的灯光照着书页。' + ('原生搜索标记。' if i == 50 else '') + '夜航的船缓缓驶过河岸。</p>' for i in range(100))
        book.writestr('OEBPS/' + filename, f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{heading}</title></head><body><h1 id="{marker}">{heading}</h1>{paragraphs}<script>alert("must not execute")</script></body></html>', compress_type=ZIP_DEFLATED)
(out / '第二份 native.txt').write_text('第一章 新文件\n\n文件关联转交测试。\n' + '下一页仍然可读。\n' * 100, encoding='utf-8')
print(out / '夜航 native test.epub')
