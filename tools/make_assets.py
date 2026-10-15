"""Builds icons/*.png and sample.epub (an original short story) for Lantern.
Run: python -I tools/make_assets.py   (from the novel-reader folder)"""
import io, os, zipfile
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NIGHT, NIGHT2, AMBER, GLOW = (20, 22, 42), (42, 47, 90), (240, 170, 69), (255, 214, 140)


def lantern(size, pad=0.0, bg=True, radius=0.22):
    s = size * 4  # supersample
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if bg:
        d.rounded_rectangle([0, 0, s - 1, s - 1], int(s * radius), fill=NIGHT)
    inset = s * pad
    u = (s - 2 * inset) / 24  # 24-unit grid like the SVG icon
    X = lambda v: inset + v * u
    glow = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([X(4), X(6), X(20), X(22)], fill=AMBER + (90,))
    im.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s * 0.06)))
    w = max(2, int(u * 1.6))
    d.line([X(9.5), X(3.5), X(14.5), X(3.5)], fill=AMBER, width=w)
    d.line([X(12), X(3.5), X(12), X(5.5)], fill=AMBER, width=w)
    d.rounded_rectangle([X(8), X(5), X(16), X(19.5)], int(u * 4), outline=AMBER, width=w)
    d.polygon([(X(12), X(9.6)), (X(13.9), X(12.6)), (X(12), X(15.6)), (X(10.1), X(12.6))], fill=GLOW)
    d.line([X(9.5), X(21.5), X(14.5), X(21.5)], fill=AMBER, width=w)
    return im.resize((size, size), Image.LANCZOS)


def save_icons():
    out = os.path.join(ROOT, 'icons')
    os.makedirs(out, exist_ok=True)
    for n in (180, 192, 512):
        lantern(n, pad=0.12).save(os.path.join(out, f'icon-{n}.png'))
    m = Image.new('RGBA', (512, 512), NIGHT + (255,))  # maskable: full bleed, art in safe zone
    m.alpha_composite(lantern(512, pad=0.24, bg=False))
    m.save(os.path.join(out, 'icon-maskable-512.png'))


def picture(w, h, title=None):
    im = Image.new('RGB', (w, h), NIGHT)
    d = ImageDraw.Draw(im)
    for y in range(h):  # dusk sky
        t = y / h
        d.line([0, y, w, y], fill=tuple(int(NIGHT2[i] * (1 - t) + NIGHT[i] * t) for i in range(3)))
    for i in range(60):  # stars
        x, y = (i * 97) % w, (i * 53) % int(h * 0.55)
        d.point((x, y), fill=(230, 226, 210))
    d.polygon([(0, h), (0, int(h * .72)), (w * .3, int(h * .62)), (w * .62, int(h * .74)), (w, int(h * .6)), (w, h)], fill=(12, 13, 26))
    lam = lantern(int(w * .42), pad=0.05, bg=False)
    im.paste(lam, (int(w * .29), int(h * .3)), lam)
    return im


def jpeg(im):
    b = io.BytesIO(); im.save(b, 'JPEG', quality=88); return b.getvalue()


CH = [
    ('Chapter 1: The Lamplighter of Kurogane Street', [
        'The last tram had already gone when Aoi reached the bottom of Kurogane Street, and every lantern on the hill was dark.',
        '“That isn’t right,” she said to nobody in particular. “Grandfather never misses a night.”',
        'She climbed the stone steps two at a time. The shop at the top was shuttered, but a thin line of gold leaked from beneath the door, as if something inside were breathing light.',
        '<img src="../images/lantern.jpg" alt="A paper lantern glowing on a dark hillside"/>',
        'Inside, a single lantern sat on the counter. Its paper was older than the house, patched with notes in her grandfather’s careful hand. When Aoi leaned closer, the flame leaned back.',
        '「おかえり」 the lantern whispered. Welcome home. (T/N: Okaeri is what family says when someone returns home.)',
        'Aoi did not drop it, which she would later count among the bravest things she had ever done.',
    ]),
    ('Chapter 2: Rules for Borrowed Light', [
        'The lantern had rules, and it insisted on explaining every one of them before breakfast.',
        '“First,” it said, in a voice like a page being turned, “I may only be carried by someone who is not afraid of the dark. Second, I must be returned before the morning bell. Third, you must never ask me what I burn.”',
        '“What do you burn?” Aoi asked immediately.',
        'The flame sighed. “That is exactly the sort of thing I meant.”',
        'They argued until the kettle whistled. In the end she wrote the rules on the back of her hand in ink: <ruby>灯<rt>あかり</rt></ruby> — light, borrowed, returned.',
        'That night, with the lantern swinging at her side, Aoi lit Kurogane Street one lamp at a time. Each wick caught as if it had only been waiting for permission.',
    ]),
    ('Chapter 3: The Morning Bell', [
        'The bell at the shrine began to ring just as the final lamp flared to life.',
        '“You did well,” the lantern said, quieter now. Its paper had grown thin, and through it Aoi could see a faint outline, like handwriting held up to a window.',
        '『Keep the street bright for me,』 the writing said. It was her grandfather’s.',
        'Aoi carried the lantern home and set it on the counter where she had found it. She did not ask what it burned. She thought, perhaps, she already knew.',
        'Down the hill, the first tram of the morning rattled past a street full of light.',
    ]),
]


def xhtml(title, body):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>{title}</title><link rel="stylesheet" href="../style.css"/></head>
<body>{body}</body></html>'''


def sample_epub():
    files = {}
    files['OEBPS/style.css'] = 'p { text-indent: 1em; }'
    files['OEBPS/images/cover.jpg'] = jpeg(picture(600, 900))
    files['OEBPS/images/lantern.jpg'] = jpeg(picture(900, 600))
    files['OEBPS/text/title.xhtml'] = xhtml('Title', '<h1>The Lantern of Kurogane Street</h1><p style="text-align:center">A short story · Sample book for Lantern</p>')
    spine = ['title']
    for i, (t, paras) in enumerate(CH, 1):
        body = f'<h2>{t}</h2>' + ''.join(p if p.startswith('<img') else f'<p>{p}</p>' for p in paras)
        files[f'OEBPS/text/ch{i}.xhtml'] = xhtml(t, body)
        spine.append(f'ch{i}')
    nav_items = ''.join(f'<li><a href="text/ch{i}.xhtml">{t}</a></li>' for i, (t, _) in enumerate(CH, 1))
    files['OEBPS/nav.xhtml'] = f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol><li><a href="text/title.xhtml">Title page</a></li>{nav_items}</ol></nav></body></html>'''
    manifest = ''.join(f'<item id="{s}" href="text/{s}.xhtml" media-type="application/xhtml+xml"/>' for s in spine)
    files['OEBPS/content.opf'] = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">lantern-sample-1</dc:identifier><dc:title>The Lantern of Kurogane Street</dc:title>
<dc:creator>Lantern Sample</dc:creator><dc:language>en</dc:language><meta name="cover" content="cover"/></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
<item id="pic" href="images/lantern.jpg" media-type="image/jpeg"/><item id="css" href="style.css" media-type="text/css"/>
{manifest}</manifest>
<spine>{''.join(f'<itemref idref="{s}"/>' for s in spine)}</spine></package>'''
    files['META-INF/container.xml'] = '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'''
    with zipfile.ZipFile(os.path.join(ROOT, 'sample.epub'), 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        for name, data in files.items():
            z.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)


if __name__ == '__main__':
    save_icons()
    sample_epub()
    print('icons and sample.epub written')
