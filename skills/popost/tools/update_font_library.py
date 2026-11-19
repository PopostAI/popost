#!/usr/bin/env python3
"""Fetch pinned OFL Fontsource WOFF2 assets and audit their real glyph coverage.
Maintainer-only: not part of the popost CLI, which is TypeScript and needs no Python. Run it with any Python 3 that has
fonttools[woff].
"""
import hashlib,json,re,subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from fontTools.ttLib import TTFont
ROOT=Path(__file__).resolve().parent.parent
BANK=ROOT/'assets/fonts'
CACHE=ROOT.parent.parent/'logs/font-library-cache'
CACHE.mkdir(parents=True,exist_ok=True)

def fetch(url):
    path=CACHE/hashlib.sha256(url.encode()).hexdigest()
    if path.exists():return path.read_bytes()
    data=subprocess.check_output(['curl','-fsSL','--retry','2','--connect-timeout','15','--max-time','150',url])
    path.write_bytes(data);return data

def audit(role):
    directory=BANK/role['id'];license=(directory/'LICENSE').read_text()
    if 'SIL OPEN FONT LICENSE' not in license.upper() or '1.1' not in license:raise ValueError('missing OFL license: '+role['id'])
    glyphs=set();weights=set();files=sorted(directory.glob('*.woff2'))
    if not files:raise ValueError('missing WOFF2: '+role['id'])
    for path in files:
        font=TTFont(path);glyphs.update(font.getBestCmap() or {})
        if 'fvar' in font:
            for axis in font['fvar'].axes:
                if axis.axisTag=='wght':weights.update([int(axis.minValue),int(axis.maxValue)])
        else:weights.add(font['OS/2'].usWeightClass)
        font.close()
    han=set()
    for row in range(0xb0,0xf8):
        for col in range(0xa1,0xff):
            try:han.update(map(ord,bytes([row,col]).decode('gb2312')))
            except UnicodeDecodeError:pass
    return {'fileCount':len(files),'totalBytes':sum(f.stat().st_size for f in files),
        'assetSha256':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in files},
        'weights':' '.join(map(str,sorted(weights))),
        'license':{'spdx':'OFL-1.1','path':role['licensePath'],'sha256':hashlib.sha256((directory/'LICENSE').read_bytes()).hexdigest(),
                   'url':'https://openfontlicense.org/open-font-license-official-text/'},
        'coverage':{'glyph_count':len(glyphs),'basic_latin_hits':len(set(range(32,127))&glyphs),'basic_latin_total':95,
                    'has_basic_latin':set(range(32,127))<=glyphs,'gb2312_han_hits':len(han&glyphs),'gb2312_han_total':len(han),
                    'cjk_common_hits':len(set(map(ord,'天地人山水产品海报字体繁體臺灣香港'))&glyphs),
                    'cjk_common_total':len(set('天地人山水产品海报字体繁體臺灣香港'))}}

def update(role):
    rid=role['id'];directory=BANK/rid;css_path=BANK/role['cssPath']
    if not directory.exists() or not css_path.exists():
        pkg=role['package'];version=role.get('packageVersion')
        metadata=json.loads(fetch('https://registry.npmjs.org/'+pkg+'/'+(version or 'latest')))
        if metadata.get('license')!='OFL-1.1':raise ValueError('unapproved license: '+pkg)
        version=metadata['version'];base='https://cdn.jsdelivr.net/npm/'+pkg+'@'+version+'/'
        meta=json.loads(fetch(base+'metadata.json'))
        listing=json.loads(fetch('https://data.jsdelivr.com/v1/package/npm/'+pkg+'@'+version+'/flat'))
        names={r['name'].lstrip('/') for r in listing['files']}
        variable='@fontsource-variable/' in pkg
        if variable:
            sheets=['wght.css']
            if 'wght-italic.css' in names:sheets.append('wght-italic.css')
        else:
            available=meta['weights'];regular=400 if 400 in available else min(available,key=lambda w:abs(w-400))
            chosen=sorted({regular,700 if 700 in available else regular})
            sheets=[str(w)+'.css' for w in chosen]
            sheets += [str(w)+'-italic.css' for w in chosen if str(w)+'-italic.css' in names]
        css='\n'.join(fetch(base+s).decode() for s in sheets)
        css=re.sub(r'src\s*:[^;]*;',lambda m:'src: '+re.search(r'url\([^)]*\.woff2\)[^,;]*',m.group()).group()+';',css)
        urls=set(re.findall(r'url\((?:[\'\"])?([^\)\'\"]+\.woff2)',css))
        directory.mkdir(parents=True,exist_ok=True)
        def asset(relative):
            name=Path(relative).name;data=fetch(base+relative.removeprefix('./'))
            if data[:4]!=b'wOF2':raise ValueError('invalid WOFF2: '+relative)
            (directory/name).write_bytes(data)
        with ThreadPoolExecutor(8) as pool:list(pool.map(asset,sorted(urls)))
        license_file='LICENSE' if 'LICENSE' in names else 'LICENSE.txt'
        (directory/'LICENSE').write_bytes(fetch(base+license_file))
        css=re.sub(r'url\((?:[\'\"])?([^\)\'\"]+\.woff2)(?:[\'\"])?\)',lambda m:'url("../'+rid+'/'+Path(m.group(1)).name+'")',css)
        css_path.parent.mkdir(exist_ok=True);css_path.write_text(css)
        family=re.search(r"font-family:\s*['\"]([^'\"]+)",css).group(1)
        role.update(family=family,packageVersion=version,variable=variable,
                    sourceUrl=meta.get('source') or 'https://fontsource.org',sourceCss=sheets)
    role.update(audit(role));role.setdefault('scripts',['Hani','Latn'] if rid.startswith('cjk-') else ['Latn'])
    role.setdefault('fallback','serif' if 'serif' in rid else 'sans-serif')
    print(rid,role['fileCount'],role['totalBytes'],flush=True)
    return role

def main():
    palette=json.loads((BANK/'palette.json').read_text())
    with ThreadPoolExecutor(3) as pool:roles=list(pool.map(update,palette['roles']))
    palette.update(version='2.0.0',source='Pinned Fontsource packages; original WOFF2 and OFL-1.1 notices',roles=roles)
    (BANK/'palette.json').write_text(json.dumps(palette,ensure_ascii=False,indent=2)+'\n')
    lines=['Popost shared font library — original OFL-1.1 fonts',
           'Retain the original copyright and license in each family directory.',
           'Font files may not be sold by themselves. Reserved Font Names apply to modifications.',
           'Artwork does not inherit the font license. See https://openfontlicense.org/ofl-faq/', '']
    for role in roles:
        lines.extend([role['id']+' — '+role['family'],role['package']+'@'+role['packageVersion'],
                      'License: '+role['licensePath']+' (OFL-1.1)', ''])
    (BANK/'NOTICE.txt').write_text('\n'.join(lines))
    print(json.dumps({'families':len(roles),'woff2_bytes':sum(r['totalBytes'] for r in roles)},indent=2),flush=True)
if __name__=='__main__':main()
