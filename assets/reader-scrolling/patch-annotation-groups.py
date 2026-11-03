"""Add disjoint annotation groups to the pinned reader; fail on bundle drift."""
import hashlib
import pathlib
import re
import sys


def patch(root, helpers):
    bundle = root / 'reader.js'
    source = bundle.read_text()
    replacements = [
        ('if("web"!==n&&2===t.button&&(!r||document.activeElement!==r))',
         'if(2===t.button&&(!r||document.activeElement!==r))'),
        ('!t.button&&c.current.includes(t.ids[0])', 'c.current.includes(t.ids[0])'),
        ('(r=n.previousElementSibling)', '(r=window.zoteroAnnotationGroups.neighbor(n,-1))'),
        ('(i=n.nextElementSibling)', '(i=window.zoteroAnnotationGroups.neighbor(n,1))'),
        ('_updateState(e,t){var n;let r=this._state;',
         '_updateState(e,t){if(e.selectedAnnotationIDs)e={...e,selectedAnnotationIDs:'
         'window.zoteroAnnotationGroups.expand(e.annotations||this._state.annotations,e.selectedAnnotationIDs)};'
         'var n;let r=this._state;'),
        ('...Zu("createAnnotationContextMenu",e,t)',
         '...window.zoteroAnnotationGroups.menu(e,t.ids),...Zu("createAnnotationContextMenu",e,t)'),
        ('C.map((t=>i.createElement(Zn,{',
         'window.zoteroAnnotationGroups.sidebar(C,(t=>i.createElement(Zn,{'),
        ('onSetDataTransferAnnotations:e.onSetDataTransferAnnotations}))):!e.filter',
         'onSetDataTransferAnnotations:e.onSetDataTransferAnnotations})),i.createElement):!e.filter'),
        # EPUB position updates replace the whole selector. Retain membership
        # when resizing a passage; explicit null still separates a group.
        ('i.dateModified=(new Date).toISOString(),i.position=Sn(i.position),t.set(i.id,i)',
         'i.dateModified=(new Date).toISOString(),'
         'i.position=Sn({zoteroAnnotationGroup:e.position.zoteroAnnotationGroup,...i.position}),t.set(i.id,i)'),
    ]
    for old, new in replacements:
        if source.count(old) != 1:
            raise ValueError(f'Expected one annotation group patch target: {old}')
        source = source.replace(old, new, 1)
    source += '\n' + helpers.read_text()
    css_path = root / 'reader.css'
    css = css_path.read_text() + '''
.annotation-group {
  border: 1px dashed currentColor;
  border-radius: 6px;
  margin: 8px 4px;
  padding: 3px;
}
.annotation-group > .annotation { margin-inline: 0; }
'''
    html_path = root / 'reader.html'
    html = html_path.read_text()
    for name, contents in [('reader.js', source), ('reader.css', css)]:
        version = hashlib.sha256(contents.encode()).hexdigest()[:12]
        html, count = re.subn(re.escape(name) + r'(?:\?v=[a-f0-9]+)?"', f'{name}?v={version}"', html)
        if count != 1:
            raise ValueError(f'Expected one reference to {name}')
    bundle.write_text(source)
    css_path.write_text(css)
    html_path.write_text(html)


if __name__ == '__main__':
    patch(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
