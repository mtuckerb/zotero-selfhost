"""Patch the pinned prebuilt reader outside its fixed-output Nix build."""

import hashlib
import pathlib
import sys


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError(f"expected one reader scrolling patch target: {old}")
    return source.replace(old, new, 1)


def patch(root):
    bundle = root / "reader.js"
    # Existing EPUBs keep a per-book layout in IndexedDB. Changing just the
    # fallback does not affect a book already saved in paginated mode. Migrate
    # that layout once; later choices in Appearance still persist normally.
    source = replace_once(bundle.read_text(),
                          'e.flowMode?this.setFlowMode(e.flowMode):this.setFlowMode("paginated")',
                          'this.setFlowMode(e.zoteroContinuousScrollVersion===1&&e.flowMode?e.flowMode:"scrolled")')
    source = replace_once(source,
                          'savedPageMapping:this.pageMapping.toJSON(),flowMode:this.flowMode,',
                          'savedPageMapping:this.pageMapping.toJSON(),flowMode:this.flowMode,zoteroContinuousScrollVersion:1,')
    # The scrolled EPUB layout's page controls move by one viewport. Animate
    # those moves as well, while retaining instant bookmark restoration.
    for offset in ('left:this._iframe.clientWidth+this.scrollPadding',
                   'top:-this._iframe.clientHeight+this.scrollPadding',
                   'left:-this._iframe.clientWidth-this.scrollPadding',
                   'top:this._iframe.clientHeight-this.scrollPadding'):
        source = replace_once(source,
                              'this._iframeWindow.scrollBy({' + offset + '})',
                              'this._iframeWindow.scrollBy({' + offset
                              + ',behavior:this._iframeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"})')
    # Migrate saved single-page PDF layouts while retaining the reading
    # position, zoom, and other continuous layouts.
    source = replace_once(source,
                          'pdfViewer.scrollMode=e.scrollMode',
                          'pdfViewer.scrollMode=3===e.scrollMode?0:e.scrollMode')
    # setTool runs after PDF viewer setup and on every tool change. Preserve
    # document pinch ownership when returning to pointer mode; drawing tools
    # still disable native panning so annotations can capture the gesture.
    source = replace_once(source,
                          'document.getElementById("viewerContainer").style.touchAction="pointer"!==e.type?"none":"auto"',
                          'document.getElementById("viewerContainer").style.touchAction="pointer"!==e.type?"none":"pan-x pan-y"')

    # EPUB images, fonts, and Firefox hyphenation can reflow a chapter after
    # the initial annotation render. Scroll events reuse cached rectangles,
    # so highlights (and their hit targets) otherwise stay at the old position.
    # Observe every chapter: a change above the viewport also moves its text.
    # The overlay is outside these containers, so repainting cannot resize an
    # observed element. Dispose the observer when leaving continuous mode.
    source = replace_once(source,
                          'for(let e of this._view.renderers)e.mount();kt&&setTimeout',
                          'for(let e of this._view.renderers)e.mount();'
                          'this._zoteroLayoutObserver=new this._iframeWindow.ResizeObserver('
                          '()=>this._view._handleViewUpdate());'
                          'for(let e of this._view.renderers)this._zoteroLayoutObserver.observe(e.container);'
                          'kt&&setTimeout')
    source = replace_once(source,
                          'destroy(){super.destroy(),this._iframe.classList.remove("flow-mode-scrolled")',
                          'destroy(){this._zoteroLayoutObserver.disconnect(),super.destroy(),'
                          'this._iframe.classList.remove("flow-mode-scrolled")')

    viewer = root / "pdf/web/viewer.mjs"
    pdf = viewer.read_text()
    pdf = replace_once(pdf,
                       'function scrollIntoView(element,spot,scrollMatches=false){',
                       'function scrollIntoView(element,spot,scrollMatches=false,behavior="instant"){')
    pdf = replace_once(pdf,
                       'offsetX+=spot.left;parent.scrollLeft=offsetX}}parent.scrollTop=offsetY}',
                       'offsetX+=spot.left}}zoteroScrollElement(parent,{top:offsetY,left:spot?.left!==undefined?offsetX:parent.scrollLeft,behavior})}')
    pdf = replace_once(pdf,
                       'this.container=options.container;this.viewer=options.viewer',
                       'this.container=options.container;zoteroInstallWheelScrolling(this);this.viewer=options.viewer')
    pdf = replace_once(pdf, 'scrollIntoView(div,pageSpot);',
                       'scrollIntoView(div,pageSpot,false,this._zoteroScrollBehavior);')
    pdf = replace_once(pdf,
                       'nextPage(){const currentPageNumber=this._currentPageNumber,',
                       'nextPage(){const currentPageNumber=zoteroPageNumber(this),')
    pdf = replace_once(pdf,
                       'previousPage(){const currentPageNumber=this._currentPageNumber;',
                       'previousPage(){const currentPageNumber=zoteroPageNumber(this);')
    pdf = replace_once(pdf,
                       'this.currentPageNumber=Math.min(currentPageNumber+advance,pagesCount);return true}',
                       'zoteroScrollPage(this,Math.min(currentPageNumber+advance,pagesCount));return true}')
    pdf = replace_once(pdf,
                       'this.currentPageNumber=Math.max(currentPageNumber-advance,1);return true}',
                       'zoteroScrollPage(this,Math.max(currentPageNumber-advance,1));return true}')
    pdf += '\n' + pathlib.Path(sys.argv[2]).read_text()

    # Version every layer of the nested iframe chain so an existing browser
    # cannot combine a new reader with an older cached PDF viewer module.
    version = hashlib.sha256(pdf.encode()).hexdigest()[:12]
    html_path = root / "pdf/web/viewer.html"
    html = replace_once(html_path.read_text(), 'src="viewer.mjs"',
                        f'src="viewer.mjs?v={version}"')
    source = replace_once(source, 'this._iframe.src="pdf/web/viewer.html"',
                          f'this._iframe.src="pdf/web/viewer.html?v={version}"')
    reader_html_path = root / "reader.html"
    version = hashlib.sha256(source.encode()).hexdigest()[:12]
    reader_html = replace_once(reader_html_path.read_text(), 'src="reader.js"',
                               f'src="reader.js?v={version}"')

    # touch-action must be declared before a gesture starts; prevent the
    # browser viewport from claiming a pinch while leaving one-finger panning
    # native. Nested documents still need their own surface ownership.
    css_path = root / "reader.css"
    css = css_path.read_text() + "\n" + pathlib.Path(sys.argv[3]).read_text()
    version = hashlib.sha256(css.encode()).hexdigest()[:12]
    reader_html = replace_once(reader_html, 'href="reader.css"',
                               f'href="reader.css?v={version}"')

    # Validate all patch targets before writing any output.
    viewer.write_text(pdf)
    html_path.write_text(html)
    bundle.write_text(source)
    css_path.write_text(css)
    reader_html_path.write_text(reader_html)


if __name__ == "__main__":
    patch(pathlib.Path(sys.argv[1]))
