// ZOTERO_TEST_READER_ROOT=... PLAYWRIGHT_MODULE=... CHROMIUM_BINARY=... \
//   node --test tests/annotation-groups.browser.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function pdf() {
  const stream = 'BT /F1 24 Tf 72 720 Td (First gap Last) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let value = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = value.length;
    value += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = value.length;
  value += `xref\n0 6\n0000000000 65535 f \n`
    + offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...Buffer.from(value)];
}

function epub() {
  return [...execFileSync('python3', ['-c', `
import io, sys, zipfile
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as book:
    book.writestr('mimetype', 'application/epub+zip')
    book.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    book.writestr('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">groups</dc:identifier><dc:title>Groups</dc:title><dc:language>en</dc:language></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>')
    book.writestr('a.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Groups</title></head><body><p id="target">First gap Last</p><p id="other">Unrelated</p></body></html>')
sys.stdout.buffer.write(buf.getvalue())
`])];
}

for (const type of ['pdf', 'epub']) test(`${type}: combine, select, persist, undo, and separate disjoint passages`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BINARY, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://localhost/**', route => route.fulfill({
      path: path.join(process.env.ZOTERO_TEST_READER_ROOT, new URL(route.request().url()).pathname)
    }));
    await page.goto('http://localhost/reader.html');
    await page.evaluate(async ({ buf, type }) => {
      const noop = () => {};
      window.saved = [];
      createReader({ type, data: { buf: new Uint8Array(buf) }, annotations: [],
        readOnly: false, sidebarOpen: true, onChangeViewState: noop,
        onSaveAnnotations: async annotations => { saved.push(...JSON.parse(JSON.stringify(annotations))); },
        onDeleteAnnotations: noop, onToggleSidebar: noop, onChangeSidebarWidth: noop, onChangeSidebarView: noop });
      await _reader._primaryView.initializedPromise;
      if (type === 'pdf') await PDFViewerApplication.pdfViewer.pagesPromise;
      const annotations = [
        { id: 'FIRST001', text: 'First', rect: [72, 715, 120, 740], type: 'highlight' },
        { id: 'GAP00001', text: 'Unrelated', rect: [72, 650, 120, 675], type: 'highlight' },
        { id: 'LAST0001', text: 'Last', rect: [175, 715, 225, 740], type: 'underline' }
      ].map((a, i) => ({ id: a.id, type: a.type, text: a.text, comment: `Comment ${i}`, tags: [],
        color: '#ffd400', pageLabel: '1', sortIndex: `00000|00000${i}|00000`,
        position: { pageIndex: 0, rects: [a.rect] } }));
      if (type === 'epub') {
        const view = _reader._primaryView;
        annotations.forEach((a, i) => {
          const node = view.renderers[0].container.querySelector(i === 1 ? '#other' : '#target').firstChild;
          const range = view._iframeDocument.createRange();
          range.setStart(node, i === 2 ? 10 : 0);
          range.setEnd(node, i === 0 ? 5 : node.length);
          Object.assign(a, view._getAnnotationFromRange(range, a.type));
        });
      }
      window.original = JSON.parse(JSON.stringify(annotations));
      _reader.setAnnotations(annotations);
    }, { type, buf: type === 'pdf' ? pdf() : epub() });
    const first = page.locator('[data-sidebar-annotation-id="FIRST001"]');
    await first.locator('.text').click();
    await page.locator('[data-sidebar-annotation-id="LAST0001"] .text').click({ modifiers: ['Control'] });
    await first.click({ button: 'right' });
    await page.getByText('Combine annotations', { exact: true }).click();
    await page.waitForSelector('.annotation-group');
    assert.equal(await page.locator('.annotation-group .annotation').count(), 2);
    assert.equal(await page.locator('.annotation-group [data-sidebar-annotation-id="GAP00001"]').count(), 0);
    const combined = await page.evaluate(() => _reader._state.annotations);
    assert.equal(combined[0].position.zoteroAnnotationGroup,
      combined.find(a => a.id === 'LAST0001').position.zoteroAnnotationGroup);
    assert.ok(combined[0].position.zoteroAnnotationGroup);
    const original = await page.evaluate(() => original);
    for (let i = 0; i < original.length; i++) {
      const annotation = combined.find(a => a.id === original[i].id);
      const { zoteroAnnotationGroup, ...position } = annotation.position;
      assert.deepEqual(position, original[i].position);
      assert.equal(annotation.comment, original[i].comment);
      assert.equal(annotation.text, original[i].text);
    }

    // Click the actual document highlight after clearing selection.
    await page.evaluate(() => _reader._updateState({ selectedAnnotationIDs: [] }));
    const point = await page.evaluate(type => {
      if (type === 'epub') {
        const view = _reader._primaryView;
        const annotation = _reader._state.annotations.find(a => a.id === 'FIRST001');
        const box = view.toDisplayedRange(annotation.position).getBoundingClientRect();
        const frame = view._iframe.getBoundingClientRect();
        return { x: frame.x + box.x + box.width / 2, y: frame.y + box.y + box.height / 2 };
      }
      const view = PDFViewerApplication.pdfViewer.getPageView(0);
      const [x, y] = view.viewport.convertToViewportPoint(90, 725);
      const box = view.div.getBoundingClientRect();
      const frame = _reader._primaryView._iframe.getBoundingClientRect();
      return { x: frame.x + box.x + x, y: frame.y + box.y + y };
    }, type);
    await page.mouse.click(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => [..._reader._state.selectedAnnotationIDs].sort()), ['FIRST001', 'LAST0001']);
    assert.deepEqual(await page.evaluate(() => [..._reader._primaryView._selectedAnnotationIDs].sort()), ['FIRST001', 'LAST0001']);

    await page.evaluate(() => _reader._annotationManager.undo());
    await page.waitForFunction(() => !document.querySelector('.annotation-group'));
    await page.evaluate(() => _reader._annotationManager.redo());
    await page.waitForSelector('.annotation-group');
    // Force the native save queue and round-trip exactly the saved JSON.
    await page.evaluate(async () => {
      _reader._annotationManager._skipAnnotationSavingDebounce = true;
      await _reader._annotationManager._triggerSaving();
    });
    const saved = await page.evaluate(() => saved);
    assert.ok(saved.some(a => a.position.zoteroAnnotationGroup));
    await page.evaluate(annotations => _reader.setAnnotations(annotations), saved);
    await page.evaluate(() => _reader._updateState({ selectedAnnotationIDs: ['LAST0001'] }));
    assert.deepEqual(await page.evaluate(() => [..._reader._state.selectedAnnotationIDs].sort()), ['FIRST001', 'LAST0001']);
    await first.click({ button: 'right' });
    await page.getByText('Separate annotations', { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.annotation-group'));
    await page.evaluate(() => _reader._updateState({ selectedAnnotationIDs: ['FIRST001'] }));
    assert.deepEqual(await page.evaluate(() => _reader._state.selectedAnnotationIDs), ['FIRST001']);
    // Three passages, including an existing group, remain one group.
    await page.evaluate(() => {
      const groups = window.zoteroAnnotationGroups;
      groups.menu(_reader, ['FIRST001', 'LAST0001'])[0][0].onCommand();
      groups.menu(_reader, ['LAST0001', 'GAP00001'])[0][0].onCommand();
    });
    assert.equal(await page.locator('.annotation-group .annotation').count(), 3);
    assert.equal(await page.evaluate(() => {
      const first = document.querySelector('.annotation-group .annotation');
      return window.zoteroAnnotationGroups.neighbor(first, 1).dataset.sidebarAnnotationId;
    }), type === 'pdf' ? 'GAP00001' : 'LAST0001');
    assert.deepEqual(await page.evaluate(() => {
      _reader._updateState({ readOnly: true });
      return window.zoteroAnnotationGroups.menu(_reader, ['FIRST001']);
    }), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
