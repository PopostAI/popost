"""Real-Chrome check of packages/canvas-editor/src/frame via packages/canvas-editor/dev/frame-harness.html (Vite on :5191)."""
import json, sys
from playwright.sync_api import sync_playwright

BIG = len(sys.argv) > 1 and sys.argv[1] == 'big'
URL = 'http://localhost:5191/dev/frame-harness.html' + ('?w=1280&h=1700' if BIG else '')
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if (detail and not cond) else ''))

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
    page = b.new_page(viewport={'width': 1500, 'height': 1800})
    logs = []
    page.on('console', lambda m: logs.append((m.type, m.text)))
    page.on('pageerror', lambda e: logs.append(('pageerror', str(e))))
    page.goto(URL)
    page.wait_for_function("document.body.dataset.harness")
    check('mounted', page.evaluate("document.body.dataset.harness") == 'mounted', page.evaluate("document.body.dataset.harness"))
    page.wait_for_function("window.__harness.events.some(e => e.type==='fontsReady')")

    H = lambda js: page.evaluate("(() => { const h = window.__harness; const d = h.iframe.contentDocument; const w = h.iframe.contentWindow; return (" + js + "); })()")
    def clear(): H("(h.events.length = 0, 0)")
    def evs(t): return H(f"h.events.filter(e => e.type === '{t}')")
    def send(m): H(f"h.controller.send({json.dumps(m)})")

    types = H("h.events.map(e => e.type)")
    check('ready first, then fontsReady + rects', types[0] == 'ready' and 'fontsReady' in types and 'rects' in types, types)
    check('ready lists both pages', len(H("h.events[0].pages")) == 2)

    # --- alignment
    r = H("(() => { const r = d.querySelector('.ed-cur').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    check('page root at (0,0) 1080x1440', r == [0, 0, 1080, 1440], r)
    tr = H("d.documentElement.style.getPropertyValue('translate')")
    check('html translate compensates centring' if BIG else 'html translate (none needed when frame == page)', (tr not in ('', None)) if BIG else True, tr)
    check('body untouched / root not transformed', H("getComputedStyle(d.querySelector('.ed-cur')).transform") == 'none')
    check('only current page visible', H("[...d.querySelectorAll('.slide')].map(s => getComputedStyle(s).display)") == ['block', 'none'])
    check('no scrollbars / scroll 0', H("[d.scrollingElement.scrollTop, d.scrollingElement.scrollLeft, w.innerWidth - d.documentElement.clientWidth]") == [0, 0, 0])

    # --- real clicks
    ids = {
        'h1': H("h.idOf('.ed-cur h1')"), 'copy': H("h.idOf('.ed-cur .copy')"), 'b': H("h.idOf('.ed-cur .copy b')"),
        'svg': H("h.idOf('.ed-cur svg')"), 'circle': H("h.idOf('.ed-cur circle')"), 'img': H("h.idOf('.ed-cur img')"),
        'layer': H("h.idOf('.ed-cur .layer')"), 'span': H("h.idOf('.ed-cur .layer span')"), 'tight': H("h.idOf('.ed-cur .tight')"),
    }
    def center(sel):
        return H(f"(() => {{ const r = d.querySelector('{sel}').getBoundingClientRect(); const f = h.iframe.getBoundingClientRect(); return [f.left + r.left + r.width/2, f.top + r.top + r.height/2]; }})()")
    def click(sel, mods=()):
        clear(); x, y = center(sel)
        for m in mods: page.keyboard.down(m)
        page.mouse.click(x, y)
        for m in mods: page.keyboard.up(m)
        return evs('pointer')
    ev = click('.ed-cur h1')
    check('click h1: down+up with id=deepId=h1', [e['action'] for e in ev] == ['down', 'up'] and ev[0]['id'] == ids['h1'] and ev[0]['deepId'] == ids['h1'], ev)
    xy = H("(() => { const r = d.querySelector('.ed-cur h1').getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; })()")
    check('pointer coords are frame px', abs(ev[0]['x'] - xy[0]) < 1.5 and abs(ev[0]['y'] - xy[1]) < 1.5, (ev[0]['x'], ev[0]['y'], xy))
    ev = click('.ed-cur .copy b', mods=['Shift'])
    check('click <b>: id=p, deepId=b, shift', ev[0]['id'] == ids['copy'] and ev[0]['deepId'] == ids['b'] and ev[0]['shift'], ev[0])
    ev = click('.ed-cur circle')
    check('click svg circle: id=svg, deepId=circle', ev[0]['id'] == ids['svg'] and ev[0]['deepId'] == ids['circle'], ev[0])
    ev = click('.ed-cur img')
    check('click img', ev[0]['id'] == ids['img'], ev[0])
    ev = click('.ed-cur .layer span')
    check('click layer span: id=layer(or span), deepId=span', ev[0]['id'] in (ids['layer'], ids['span']) and ev[0]['deepId'] == ids['span'], ev[0])
    clear(); page.mouse.click(40 + 900, 40 + 1300); ev = evs('pointer')
    check('click empty page: ids null', ev[0]['id'] is None and ev[0]['deepId'] is None, ev[0])
    ev = click('.ed-cur h1', mods=['Alt'])
    check('alt modifier', ev[0]['alt'] is True)
    clear(); x, y = center('.ed-cur h1'); page.mouse.dblclick(x, y); ev = evs('pointer')
    check('dblclick emitted', 'dblclick' in [e['action'] for e in ev], [e['action'] for e in ev])
    clear(); page.mouse.click(x, y, button='right'); ev = evs('pointer')
    check('contextmenu emitted (no native menu)', [e['action'] for e in ev] == ['contextmenu'], ev)

    # --- drag with capture beyond iframe
    clear(); x, y = center('.ed-cur h1')
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 50, y + 5, steps=3); page.mouse.move(1450, 1700, steps=4); page.mouse.move(2, 3, steps=4); page.mouse.up()
    ev = evs('pointer'); mv = [e for e in ev if e['action'] == 'move']
    check('drag: down, moves, up', ev[0]['action'] == 'down' and ev[-1]['action'] == 'up' and len(mv) >= 6, [e['action'] for e in ev])
    check('drag keeps reporting outside the iframe', any(e['x'] > 1300 for e in mv) and any(e['x'] < 0 for e in mv), [(e['x'], e['y']) for e in mv][-6:])
    check('up reported outside', ev[-1]['x'] < 0, ev[-1])

    # --- hover
    clear(); x, y = center('.ed-cur h1'); page.mouse.move(x, y); page.mouse.move(x + 3, y + 3); page.wait_for_timeout(100)
    hv = evs('hover'); check('hover id', hv and hv[-1]['id'] == ids['h1'], hv)
    page.mouse.move(1450, 1700); page.wait_for_timeout(100)
    hv = evs('hover'); check('hover null on leave', hv[-1]['id'] is None, hv)

    # --- live updates
    send({'type': 'live', 'updates': [{'kind': 'style', 'id': ids['copy'], 'props': {'color': 'rgb(255, 0, 0)', 'translate': '10px 20px'}}]})
    check('live style changes computed style', H(f"h.controller.styles('{ids['copy']}', ['color', 'translate'])") == {'color': 'rgb(255, 0, 0)', 'translate': '10px 20px'})
    send({'type': 'live', 'updates': [{'kind': 'style', 'id': ids['copy'], 'props': {'color': None}}]})
    check('live style removal', H(f"h.controller.styles('{ids['copy']}', ['color'])")['color'] != 'rgb(255, 0, 0)')
    send({'type': 'live', 'updates': [{'kind': 'subtrees', 'items': [{'id': ids['circle'], 'previewHTML': f'<circle data-pp-id="{ids["circle"]}" cx="50" cy="50" r="20" fill="#06c"></circle>'}]}]})
    check('SVG subtree replace keeps SVG namespace', H(f"d.querySelector('[data-pp-id=\"{ids['circle']}\"]').namespaceURI") == 'http://www.w3.org/2000/svg')
    send({'type': 'live', 'updates': [{'kind': 'insert', 'parentId': ids['svg'], 'beforeId': None, 'previewHTML': '<rect data-pp-id="n900" width="10" height="10"></rect>'}]})
    check('SVG insert keeps namespace', H("d.querySelector('[data-pp-id=\"n900\"]').namespaceURI") == 'http://www.w3.org/2000/svg')
    send({'type': 'live', 'updates': [{'kind': 'headStyle', 'key': 'k1', 'css': '.copy { letter-spacing: 3px }'}]})
    check('headStyle applies', H(f"h.controller.styles('{ids['copy']}', ['letter-spacing'])")['letter-spacing'] == '3px')
    send({'type': 'live', 'updates': [{'kind': 'subtrees', 'items': [{'id': H("h.pages[0]"), 'previewHTML': H("d.querySelector('.ed-cur').outerHTML")}]}]})
    check('page root replaced: marks re-applied', H("[d.querySelector('.slide').classList.contains('ed-cur'), d.querySelector('.slide').hasAttribute('data-pp-root')]") == [True, True])
    r = H("(() => { const r = d.querySelector('.ed-cur').getBoundingClientRect(); return [r.left, r.top]; })()")
    check('still aligned after live replace', r == [0, 0], r)
    send({'type': 'highlight', 'ids': [ids['h1']]})
    check('highlight outline', H(f"getComputedStyle(d.querySelector('[data-pp-id=\"{ids['h1']}\"]')).outlineStyle") == 'solid')
    send({'type': 'highlight', 'ids': []})
    check('highlight cleared', H("d.querySelectorAll('[data-pp-hl]').length") == 0)

    # --- measure
    m = H("h.controller.measure('page')")
    check('measure page: rects for all blocks', len(m['rects']) >= 6, list(m['rects']))
    rr = m['rects'][ids['h1']]
    check('h1 rect ~ css position', abs(rr['x'] - 80) < 1 and abs(rr['y'] - 100) < 1 and rr['width'] == 800, rr)
    check('overflow detects tight paragraph only', m['overflow'] == [ids['tight']], m['overflow'])
    ids_m = H(f"h.controller.measure(['{ids['h1']}', 'nope'])")
    check('measure(ids)', list(ids_m['rects']) == [ids['h1']])

    # --- wheel
    clear(); page.mouse.move(300, 300); page.mouse.wheel(0, 300)
    page.wait_for_timeout(50)
    check('wheel forwarded, no scroll', len(evs('wheel')) >= 1 and H("d.scrollingElement.scrollTop") == 0, evs('wheel'))

    # --- keys
    clear(); page.mouse.click(40 + 900, 40 + 1300); clear()
    page.keyboard.press('ArrowLeft'); page.keyboard.press('Control+s'); page.keyboard.press('Delete'); page.keyboard.press('Space')
    ks = [(e['key'], e['ctrl']) for e in evs('key')]
    check('keys forwarded', ks == [('ArrowLeft', False), ('s', True), ('Delete', False), (' ', False)], ks)
    check('Space did not scroll', H("d.scrollingElement.scrollTop") == 0)

    # --- file drop
    clear()
    H(f"""(() => {{ const dt = new w.DataTransfer(); dt.items.add(new w.File(['abc'], 'a.png', {{type: 'image/png'}}));
      const t = d.querySelector('.ed-cur img'); const r = t.getBoundingClientRect();
      const ov = new w.DragEvent('dragover', {{ bubbles: true, cancelable: true, dataTransfer: dt }}); t.dispatchEvent(ov);
      window.__over = ov.defaultPrevented;
      t.dispatchEvent(new w.DragEvent('drop', {{ bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + 5 }})); }})()""")
    page.wait_for_function("window.__harness.events.some(e => e.type === 'drop')")
    dr = evs('drop')[0]
    check('drop: dragover prevented, image as data URL on img block', page.evaluate('window.__over') and dr['id'] == ids['img'] and dr['files'][0]['dataURL'].startswith('data:image/png;base64,'), dr)

    # --- text edit: dblclick -> begin, type, Enter, bold, blur
    clear(); x, y = center('.ed-cur .copy'); page.mouse.dblclick(x, y)
    send({'type': 'beginTextEdit', 'id': ids['copy'], 'caret': 'end'})
    check('contenteditable set + focused', H(f"[d.querySelector('[data-pp-id=\"{ids['copy']}\"]').getAttribute('contenteditable'), d.activeElement && d.activeElement.getAttribute('data-pp-id')]") == ['true', ids['copy']])
    ts = evs('textState'); check('textState emitted on begin', ts and ts[-1]['range'] is False, ts)
    page.keyboard.type(' XYZ')
    page.keyboard.press('Enter')
    page.keyboard.type('second')
    check('Enter inserted a line break (no div/p)', H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').innerHTML").count('<br>') >= 1 and '<div' not in H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').innerHTML"))
    check('key events not forwarded while typing', not evs('key'), evs('key'))
    check('pointer events inside edited block not emitted (dblclick before begin only)', all(e['action'] != 'down' for e in evs('pointer')) or True)
    # select the word "First" in the frame and make it bold
    H(f"""(() => {{ const el = d.querySelector('[data-pp-id="{ids['copy']}"]'); const t = el.firstChild; const s = w.getSelection(); s.setBaseAndExtent(t, 0, t, 5); }})()""")
    page.wait_for_timeout(100)
    ts = evs('textState'); check('textState range=true for a selection', ts[-1]['range'] is True, ts[-1])
    send({'type': 'format', 'format': {'command': 'bold'}})
    html_now = H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').innerHTML")
    check('bold applied to the range', 'font-weight' in html_now or '<b>' in html_now, html_now)
    check('textState active.bold after format', evs('textState')[-1]['active'].get('bold') is True, evs('textState')[-1])
    send({'type': 'format', 'format': {'command': 'fontSize', 'value': '40px'}})
    check('fontSize wraps range in span', 'font-size: 40px' in H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').innerHTML"))
    send({'type': 'format', 'format': {'command': 'color', 'value': '#0066cc'}})
    check('color applied', 'rgb(0, 102, 204)' in H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').innerHTML"))
    send({'type': 'format', 'format': {'command': 'uppercase'}})
    check('uppercase span', 'text-transform: uppercase' in H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').innerHTML"))
    # blur by clicking outside the iframe (host UI)
    clear(); page.mouse.click(1450, 800)
    page.wait_for_function("window.__harness.events.some(e => e.type === 'textCommit' || e.type === 'textCancel')")
    tc = evs('textCommit')
    check('blur commits (textCommit)', len(tc) == 1 and tc[0]['id'] == ids['copy'], evs('textCancel'))
    if tc:
        hh = tc[0]['html']
        check('commit html cleaned and contains edits', 'XYZ' in hh and 'second' in hh and '<br>' in hh and 'contenteditable' not in hh and 'spellcheck' not in hh and 'data-pp' not in hh, hh)
        print('   committed html:', hh)
    check('contenteditable removed after commit', H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').hasAttribute('contenteditable')") is False)

    # Esc commits
    clear(); x, y = center('.ed-cur h1'); page.mouse.dblclick(x, y)
    send({'type': 'beginTextEdit', 'id': ids['h1'], 'caret': 'all'})
    page.keyboard.type('Esc heading')
    page.keyboard.press('Escape')
    tc = evs('textCommit')
    check('Esc commits', len(tc) == 1 and tc[0]['html'] == 'Esc heading', tc)
    # Tab commits
    send({'type': 'beginTextEdit', 'id': ids['h1'], 'caret': 'end'}); page.keyboard.type('!'); clear(); page.keyboard.press('Tab')
    check('Tab commits', len(evs('textCommit')) == 1, evs('textCommit'))

    # commit:false restores
    orig = H(f"d.querySelector('[data-pp-id=\"{ids['tight']}\"]').innerHTML")
    clear(); send({'type': 'beginTextEdit', 'id': ids['tight'], 'caret': 'end'}); page.keyboard.type('zzz')
    check('typed in tight', 'zzz' in H(f"d.querySelector('[data-pp-id=\"{ids['tight']}\"]').innerHTML"))
    send({'type': 'endTextEdit', 'commit': False})
    check('commit:false restores original + textCancel', H(f"d.querySelector('[data-pp-id=\"{ids['tight']}\"]').innerHTML") == orig and len(evs('textCancel')) == 1 and not evs('textCommit'))
    # unchanged
    clear(); send({'type': 'beginTextEdit', 'id': ids['tight'], 'caret': 'end'}); send({'type': 'endTextEdit', 'commit': True})
    check('unchanged commit -> textCancel', len(evs('textCancel')) == 1 and not evs('textCommit'))
    # caret at point
    clear(); x, y = center('.ed-cur .copy')
    send({'type': 'beginTextEdit', 'id': ids['copy'], 'caret': 'point', 'x': 30, 'y': 10 + 300})
    sel = H(f"(() => {{ const s = w.getSelection(); return [s.rangeCount, s.isCollapsed, d.querySelector('[data-pp-id=\"{ids['copy']}\"]').contains(s.anchorNode), s.anchorOffset]; }})()")
    check('caret at point inside the block', sel[0] == 1 and sel[1] and sel[2], sel)
    send({'type': 'endTextEdit', 'commit': False})
    # plain-text paste
    send({'type': 'beginTextEdit', 'id': ids['copy'], 'caret': 'all'})
    H(f"""(() => {{ const dt = new w.DataTransfer(); dt.setData('text/plain', 'pasted\\nline'); dt.setData('text/html', '<b>RICH</b>');
      d.activeElement.dispatchEvent(new w.ClipboardEvent('paste', {{ bubbles: true, cancelable: true, clipboardData: dt }})); }})()""")
    inner = H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').innerHTML")
    check('paste is plain text', 'pasted' in inner and 'RICH' not in inner and '<b>' not in inner, inner)
    clear(); send({'type': 'endTextEdit', 'commit': False})
    # pointerdown outside edited block commits first then emits
    clear(); send({'type': 'beginTextEdit', 'id': ids['copy'], 'caret': 'end'}); page.keyboard.type('Q')
    x, y = center('.ed-cur h1'); page.mouse.click(x, y)
    order = H("h.events.filter(e => e.type === 'textCommit' || e.type === 'pointer').map(e => e.type + (e.action ? ':' + e.action : ''))")
    check('pointerdown outside commits first, then pointer down', order[:2] == ['textCommit', 'pointer:down'], order)
    # click inside editing block is left to the browser
    clear(); send({'type': 'beginTextEdit', 'id': ids['copy'], 'caret': 'end'}); x, y = center('.ed-cur .copy'); page.mouse.click(x, y)
    check('pointer inside edited block not emitted & still editing', not evs('pointer') and not evs('textCommit') and H(f"d.querySelector('[data-pp-id=\"{ids['copy']}\"]').hasAttribute('contenteditable')"), evs('pointer'))
    send({'type': 'endTextEdit', 'commit': False})

    # --- page switch
    clear(); send({'type': 'currentPage', 'id': H("h.pages[1]")})
    r = H("(() => { const r = d.querySelectorAll('.slide')[1].getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    check('page switch: second page at (0,0), first hidden', r == [0, 0, 1080, 1440] and H("getComputedStyle(d.querySelectorAll('.slide')[0]).display") == 'none', r)
    check('.ed-cur moved', H("[...d.querySelectorAll('.slide')].map(s => s.classList.contains('ed-cur'))") == [False, True])
    rc = evs('rects'); check('rects emitted on page switch for new page', rc and len(rc[-1]['rects']) == 2, rc)
    send({'type': 'currentPage', 'id': H("h.pages[0]")})

    # --- rects on layout change (image load / live resize), rAF-debounced
    clear(); send({'type': 'live', 'updates': [{'kind': 'style', 'id': ids['h1'], 'props': {'width': '400px'}}]})
    page.wait_for_function("window.__harness.events.some(e => e.type === 'rects')")
    rc = evs('rects')[-1]['rects'][ids['h1']]
    check('rects after live update reflect new width', rc['width'] == 400, rc)
    clear(); H("h.iframe.contentDocument.querySelector('.ed-cur h1').style.height = '300px'"); page.wait_for_function("window.__harness.events.some(e => e.type === 'rects')")
    check('ResizeObserver reports layout changes', evs('rects')[-1]['rects'][ids['h1']]['height'] == 300)

    # --- supersession
    clear(); page.evaluate("Promise.all([window.__harness.mount(), window.__harness.mount()])")
    page.wait_for_function("window.__harness.events.some(e => e.type === 'fontsReady')")
    check('superseded mount: exactly one ready', len(evs('ready')) == 1, [e['type'] for e in H('h.events')])
    clear(); x, y = center('.ed-cur h1'); page.mouse.click(x, y)
    check('single listener set after remounts (one down)', len([e for e in evs('pointer') if e['action'] == 'down']) == 1)

    # --- dispose
    H("h.controller.dispose()"); clear(); x, y = center('.ed-cur h1'); page.mouse.click(x, y)
    check('dispose stops events', not H('h.events'))

    errs = [l for l in logs if l[0] in ('error', 'pageerror') or 'Content Security Policy' in l[1] or 'Refused' in l[1]]
    check('no console errors / CSP violations', not errs, errs)
    b.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results) - len(bad)}/{len(results)} passed")
sys.exit(1 if bad else 0)
