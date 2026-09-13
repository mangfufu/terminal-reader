"""Download publisher-hosted free ebooks into ignored artifacts for compatibility checks."""
import hashlib
import json
from pathlib import Path
import time
import urllib.request

root = Path(__file__).resolve().parents[1] / 'artifacts' / 'real-ebooks'
books = root / 'books'
books.mkdir(parents=True, exist_ok=True)
samples = [
    ('alice-pg.mobi', 'https://www.gutenberg.org/ebooks/11.kindle.images', 'https://www.gutenberg.org/ebooks/11'),
    ('alice-pg.azw3', 'https://www.gutenberg.org/ebooks/11.kf8.images', 'https://www.gutenberg.org/ebooks/11'),
    ('alice-pg-epub2.epub', 'https://www.gutenberg.org/ebooks/11.epub.images', 'https://www.gutenberg.org/ebooks/11'),
    ('alice-pg-epub3.epub', 'https://www.gutenberg.org/ebooks/11.epub3.images', 'https://www.gutenberg.org/ebooks/11'),
    ('alice-pg.html', 'https://www.gutenberg.org/cache/epub/11/pg11-images.html', 'https://www.gutenberg.org/ebooks/11'),
    ('red-chamber.mobi', 'https://www.gutenberg.org/ebooks/24264.kindle.images', 'https://www.gutenberg.org/ebooks/24264'),
    ('red-chamber.azw3', 'https://www.gutenberg.org/ebooks/24264.kf8.images', 'https://www.gutenberg.org/ebooks/24264'),
    ('red-chamber.epub', 'https://www.gutenberg.org/ebooks/24264.epub3.images', 'https://www.gutenberg.org/ebooks/24264'),
    ('little-brother.mobi', 'https://craphound.com/littlebrother/Cory_Doctorow_-_Little_Brother.mobi', 'https://craphound.com/littlebrother/download/'),
    ('little-brother.prc', 'https://craphound.com/littlebrother/Cory_Doctorow_-_Little_Brother_Mobipocket.prc', 'https://craphound.com/littlebrother/download/'),
    ('little-brother.fb2', 'https://craphound.com/littlebrother/Cory_Doctorow_-_Little_Brother.fb2', 'https://craphound.com/littlebrother/download/'),
    ('little-brother.epub', 'https://craphound.com/littlebrother/Cory_Doctorow_-_Little_Brother.epub', 'https://craphound.com/littlebrother/download/'),
    ('war-and-peace.fb2', 'https://www.tolstoy.ru/upload/iblock/b52/voina-i-mir.fb2', 'https://www.tolstoy.ru/creativity/fiction/index.php'),
    ('war-and-peace.mobi', 'https://www.tolstoy.ru/upload/iblock/01f/voina-i-mir.mobi', 'https://www.tolstoy.ru/creativity/fiction/index.php'),
    ('war-and-peace.epub', 'https://www.tolstoy.ru/upload/iblock/dac/voina-i-mir.epub', 'https://www.tolstoy.ru/creativity/fiction/index.php'),
    ('alice-standard.azw3', 'https://standardebooks.org/ebooks/lewis-carroll/alices-adventures-in-wonderland/john-tenniel/downloads/lewis-carroll_alices-adventures-in-wonderland_john-tenniel.azw3', 'https://standardebooks.org/ebooks/lewis-carroll/alices-adventures-in-wonderland/john-tenniel'),
]
manifest = []
for name, url, source in samples:
    entry = dict(name=name, url=url, source=source)
    try:
        path = books / name
        if not path.exists():
            request = urllib.request.Request(url, headers={'User-Agent': 'TerminalReader-Compatibility-Test/1.0'})
            with urllib.request.urlopen(request, timeout=40) as response:
                data = response.read()
                entry['resolved'] = response.url
            if name.endswith(('.mobi', '.azw3', '.prc')) and data[60:68] != b'BOOKMOBI':
                raise ValueError('Download is not a MOBI/KF8 database')
            if name.endswith('.epub') and not data.startswith(b'PK'):
                raise ValueError('Download is not an EPUB archive')
            path.write_bytes(data)
            time.sleep(2)
        data = path.read_bytes()
        entry.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        print(f'OK {name}: {len(data)} bytes', flush=True)
    except Exception as error:
        entry['error'] = str(error)
        print(f'FAILED {name}: {error}', flush=True)
    manifest.append(entry)
    (root / 'sources.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
