// Native annotation geometry after EPUB content reflows, without library writes.
// ZOTERO_TEST_READER_ROOT=... PLAYWRIGHT_MODULE=... FIREFOX_BINARY=... \
//   node --test tests/reader-epub-highlights.browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function zip(entries) {
	const local = [], directory = [];
	let offset = 0;
	for (const [name, text] of Object.entries(entries)) {
		const filename = Buffer.from(name), data = Buffer.from(text);
		let crc = 0xffffffff;
		for (const byte of data) {
			crc ^= byte;
			for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
		local.push(header, filename, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
		central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
		central.writeUInt32LE(offset, 42);
		directory.push(central, filename);
		offset += header.length + filename.length + data.length;
	}
	const central = Buffer.concat(directory), end = Buffer.alloc(22), count = Object.keys(entries).length;
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
	end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
	return [...Buffer.concat([...local, central, end])];
}

function book() {
 return zip({
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'book.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">annotation-layout</dc:identifier><dc:title>Annotation layout</dc:title><dc:language>en</dc:language></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
  'nav.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="a.xhtml">First</a></li><li><a href="b.xhtml">Second</a></li></ol></nav></body></html>',
  ...Object.fromEntries(['a','b'].map(id => [id+'.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><div class="late-content" style="height:100px"></div><p class="target">The saved highlight belongs to these exact words.</p><div style="height:1000px"></div></body></html>']))
 });
}
let browser;
const errors = [];
before(async () => {
 assert.ok(process.env.ZOTERO_TEST_READER_ROOT, 'Set ZOTERO_TEST_READER_ROOT');
 const engine = process.env.ZOTERO_TEST_BROWSER || 'firefox';
 browser = await playwright[engine].launch({ headless:true,
  executablePath: engine === 'firefox' ? process.env.FIREFOX_BINARY : process.env.CHROMIUM_BINARY });
});
after(async () => { await browser?.close(); });
async function open() {
 const page = await browser.newPage({ viewport:{width:1100,height:800} });
 page.on('pageerror', e => errors.push(e.message));
 await page.route('http://reader.test/**', route => route.fulfill({
  path:path.join(process.env.ZOTERO_TEST_READER_ROOT,new URL(route.request().url()).pathname)
 }));
 await page.goto('http://reader.test/reader.html');
 await page.evaluate(async buf => {
  const noop = () => {};
  createReader({type:'epub',data:{buf:new Uint8Array(buf)},annotations:[],sidebarOpen:false,readOnly:false,
   onChangeViewState:noop,onSaveAnnotations:noop,onDeleteAnnotations:noop,onToggleSidebar:noop,
   onChangeSidebarWidth:noop,onChangeSidebarView:noop});
  await _reader._primaryView.initializedPromise;
  const v = _reader._primaryView;
  // Create then reload a real CFI annotation through the reader's native APIs.
  const target = v.renderers[1].container.querySelector('.target');
  const range = v._iframeDocument.createRange();range.selectNodeContents(target);
  const annotation = {...v._getAnnotationFromRange(range,'highlight'), id:'HIGHL001', color:'#ffd400',comment:''};
  window.originalAnnotation = JSON.stringify(annotation);
  _reader.setAnnotations([annotation]);
  v.navigate({annotationID:annotation.id},{behavior:'instant'});
  window.measure = () => {
   const a = _reader._state.annotations.find(a=>a.id==='HIGHL001');
   const range = v.toDisplayedRange(a.position);
   // Check the painted rectangles and the clickable/selection hit targets.
   const rects = [...v._annotationShadowRoot.querySelectorAll('g[data-annotation-id="HIGHL001"] > g > rect, g[data-annotation-id="HIGHL001"] > foreignObject')].map(r=>r.getBoundingClientRect());
   const textRects = [...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
   const distance = (a,b) => Math.max(...['left','top','width','height'].map(k=>Math.abs(a[k]-b[k])));
   return { count:rects.length, text:range.toString(), error:Math.max(0,...rects.map(r=>Math.min(...textRects.map(t=>distance(r,t))))) };
  };
 },book());
 await page.waitForFunction(() => measure().count>0);
 await page.waitForTimeout(300);
 return page;
}
async function aligned(page) {
 const result = await page.evaluate(() => measure());
 assert.ok(result.count>0,'saved highlight remains visible');
 assert.equal(result.text,'The saved highlight belongs to these exact words.');
 assert.ok(result.error<1,`highlight and text differ by ${result.error}px`);
 assert.equal(await page.evaluate(() => JSON.stringify(_reader._state.annotations[0])===originalAnnotation),true,'CFI and annotation data stay unchanged');
}

test('saved highlights follow a late layout change in the current chapter', async () => {
 const page = await open();
 try {
  await aligned(page);
  await page.evaluate(() => _reader._primaryView.renderers[1].container.querySelector('.late-content').style.height='245px');
  await page.waitForTimeout(500);
  await aligned(page);
 } finally { await page.close(); }
});

test('reflow above the visible chapter preserves geometry while Firefox anchors the scroll', async () => {
 const page = await open();
 try {
  await aligned(page);
  await page.evaluate(() => _reader._primaryView.renderers[0].container.querySelector('.late-content').style.height='355px');
  await page.waitForTimeout(500);
  await aligned(page);
  // Switching modes disposes the old observer and installs a new one.
  await page.evaluate(() => _reader._primaryView.setFlowMode('paginated'));
  await page.waitForTimeout(300);
  await page.evaluate(() => _reader._primaryView.setFlowMode('scrolled'));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
   const v=_reader._primaryView;
   v.navigate({annotationID:'HIGHL001'},{behavior:'instant'});
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => _reader._primaryView.renderers[1].container.querySelector('.late-content').style.height='180px');
  await page.waitForTimeout(500);
  await aligned(page);
  assert.deepEqual(errors,[]);
 } finally { await page.close(); }
});
