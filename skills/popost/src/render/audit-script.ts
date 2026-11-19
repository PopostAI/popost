/**
 * The machine audit that runs inside the page for one canvas root (port of `render_html.AUDIT_JS`): overflow and clipping
 * checks, broken images, unloaded fonts. It returns facts and issues; it never decides what to promote.
 * Shipped as text because it runs in the browser, not in Node. Page scripts are off in the render context, which also stops
 * DOM collections from calling back into script (`NodeList.forEach`, `FontFaceSet.forEach`): iterate real arrays instead.
 */
export const AUDIT_SCRIPT = String.raw`
(arg) => {
  const selector = arg.selector, index = arg.index, fallbackSel = arg.fallback;
  let list = document.querySelectorAll(selector);
  let used = selector;
  if (list.length === 0 && fallbackSel && selector !== fallbackSel) {
    list = document.querySelectorAll(fallbackSel);
    used = fallbackSel;
  }
  const issues = [];
  const facts = {usedFonts: [], images: []};
  if (!list[index]) return {rootFound: false, issues, facts, rootCount: list.length};
  const root = list[index];
  const rootRect = root.getBoundingClientRect();
  facts.rootSize = {width: Math.round(rootRect.width), height: Math.round(rootRect.height)};
  facts.rootCount = list.length;

  const rt = getComputedStyle(root).transform;
  if (rt && rt !== 'none') issues.push({code:'global-scale', severity:'error',
    message:'根元素带整体 transform:'+rt, evidence:rt});

  const tol = 1;
  Array.from(root.querySelectorAll('*')).forEach(el => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if (r.left < rootRect.left - tol || r.top < rootRect.top - tol ||
        r.right > rootRect.right + tol || r.bottom > rootRect.bottom + tol) {
      issues.push({code:'out-of-bounds', severity:'error',
        message:'元素越出根画布',
        evidence:{tag:el.tagName, cls:(el.className&&el.className.toString)?el.className.toString():'',
                  rect:{x:Math.round(r.left-rootRect.left),y:Math.round(r.top-rootRect.top),
                        w:Math.round(r.width),h:Math.round(r.height)}}});
    }
    if (st.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + tol) {
      issues.push({code:'ellipsis-clipped', severity:'error', message:'单行省略号截断文本',
        evidence:{text:(el.textContent||'').slice(0,40), sw:el.scrollWidth, cw:el.clientWidth}});
    }
    const lc = st.webkitLineClamp;
    if (lc && parseInt(lc,10) > 0 && el.scrollHeight > el.clientHeight + tol) {
      issues.push({code:'line-clamped', severity:'error', message:'line-clamp 隐藏后续多行',
        evidence:{clamp:lc, sh:el.scrollHeight, ch:el.clientHeight}});
    }
    if (st.overflow === 'hidden' && (el.scrollWidth > el.clientWidth + tol ||
                                     el.scrollHeight > el.clientHeight + tol) &&
        st.textOverflow !== 'ellipsis' && !(lc && parseInt(lc,10)>0)) {
      issues.push({code:'clipped-hidden', severity:'error', message:'overflow:hidden 裁掉内容',
        evidence:{sw:el.scrollWidth,cw:el.clientWidth,sh:el.scrollHeight,ch:el.clientHeight}});
    }
    if ((st.overflow === 'auto' || st.overflow === 'scroll') &&
        (el.scrollWidth > el.clientWidth + tol || el.scrollHeight > el.clientHeight + tol)) {
      issues.push({code:'scroll-overflow', severity:'error', message:'需滚动才能看到内容',
        evidence:{sw:el.scrollWidth, sh:el.scrollHeight}});
    }
  });

  Array.from(root.querySelectorAll('img')).forEach(img => {
    facts.images.push({src:(img.currentSrc||img.src||'').slice(0,120),
                       complete:img.complete, naturalWidth:img.naturalWidth});
    if (img.complete && img.naturalWidth === 0) {
      issues.push({code:'broken-image', severity:'error', message:'裂图（naturalWidth=0）',
        evidence:{src:(img.src||'').slice(0,120), alt:img.alt}});
    }
  });

  try {
    Array.from(document.fonts).forEach(f => facts.usedFonts.push(f.family + ' / ' + f.status));
    if (document.fonts.status === 'error')
      issues.push({code:'font-unloaded', severity:'error', message:'存在加载失败的 @font-face',
        evidence:document.fonts.status});
  } catch (e) { facts.fontError = String(e); }

  return {rootFound: true, rootRect: {x: rootRect.x, y: rootRect.y, width: rootRect.width, height: rootRect.height},
          rootSelector: used, issues, facts};
}
`;
