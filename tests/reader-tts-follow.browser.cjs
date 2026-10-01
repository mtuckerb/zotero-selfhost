// Real nested reader frames, ranges and scrolling; only the audio clock is simulated.
// ZOTERO_TEST_READER_ROOT=... PLAYWRIGHT_MODULE=... FIREFOX_BINARY=... \
//   node --test tests/reader-tts-follow.browser.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function samplePDF() {
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [' + Array.from({ length: 12 }, (_, i) => `${3 + i * 2} 0 R`).join(' ') + '] /Count 12 >>'];
	for (let i = 0; i < 12; i++) {
		const lines = [
			`Opening words on page ${i + 1} describe a distinct topic.`,
			`Further discussion of subject ${i + 1} fills the middle.`,
			`Closing remarks for chapter ${i + 1} appear near the bottom.`
		];
		const stream = lines.map((text, j) => `BT /F1 12 Tf 72 ${700 - j * 260} Td (${text}) Tj ET`).join('\n');
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 27 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	}
	objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
	let pdf = '%PDF-1.4\n';
	const offsets = [];
	objects.forEach((object, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
		+ offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
		+ `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
	return [...Buffer.from(pdf)];
}

// A tiny stored ZIP keeps the EPUB fixture self-contained, with no accounts,
// downloaded books, compression libraries or additional test dependencies.
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

const chapters = [1, 2].map(chapter => Array.from({ length: 40 }, (_, n) =>
	`Chapter ${chapter} paragraph ${n + 1} follows words. Section ${chapter} passage ${n + 1} remains visible. `
	+ `Topic ${chapter} line ${n + 1} continues through pages.`));
function sampleEPUB() {
	return zip({
		mimetype: 'application/epub+zip',
		'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
		'book.opf': `<?xml version="1.0"?><package version="2.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">read-along-test</dc:identifier><dc:title>Reading test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="toc"><itemref idref="a"/><itemref idref="b"/></spine></package>`,
		'toc.ncx': '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>Reading test</text></docTitle><navMap><navPoint id="a" playOrder="1"><navLabel><text>First chapter</text></navLabel><content src="a.xhtml"/></navPoint><navPoint id="b" playOrder="2"><navLabel><text>Second chapter</text></navLabel><content src="b.xhtml"/></navPoint></navMap></ncx>',
		...Object.fromEntries(chapters.map((paragraphs, i) => [i ? 'b.xhtml' : 'a.xhtml',
			`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Reading</title></head><body>${paragraphs.map(p => `<p>${p}</p>`).join('')}</body></html>`]))
	});
}

const source = readFileSync(process.env.ZOTERO_TEST_TTS_SCRIPT || path.join(__dirname, '../assets/reader-tts/reader-tts.js'), 'utf8');
const script = source.replace('// ------------------------------------------------------------ entry point', `
	globalThis.tts = {
		async start(providedText) {
			const app = readerPdfApplication();
			const text = normalizeForSpeech(providedText || await fetchPdfDocumentText(app.pdfDocument));
			ensureBar().classList.add('ztts-playing');
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const part = createPart(text);
			part.url = 'blob:clock';
			part.timeline = readAlongTokens(text).words.map((_, i) => [i, i * 1000, (i + 1) * 1000]);
			run = { source: 'document', index: 0, parts: [part], surfaceFollowing: true, surfaceScroll: null };
			audio = { src: part.url, paused: false, currentTime: 0, duration: part.timeline.length };
			renderSurfaceFollow();
			renderFollow();
			watchReaderFrames();
			paintHighlight(false);
		},
		step(index) { audio.currentTime = index + 0.1; paintHighlight(false); },
		repaint() { paintHighlight(true, false); },
		pause() { audio.paused = true; },
		get following() { return run.surfaceFollowing; },
		get moving() { return !!run.surfaceScroll; },
		get words() { return partMatchWords(run.parts[0]); }
	}; return;
`);

let browser;
before(async () => {
	assert.ok(process.env.ZOTERO_TEST_READER_ROOT, 'Set ZOTERO_TEST_READER_ROOT');
	browser = await firefox.launch({ headless: true, executablePath: process.env.FIREFOX_BINARY });
});
after(async () => { await browser?.close(); });

async function reader(t, reducedMotion = 'no-preference', type = 'pdf', flowMode = 'scrolled') {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	if (process.env.ZOTERO_TEST_DEBUG) page.on('console', message => console.log(message.type(), message.text()));
	t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
	await page.route('https://reader.test/**', route => {
		const pathname = new URL(route.request().url()).pathname;
		if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!DOCTYPE html>
			<style>html,body{margin:0;height:100%}.reader-wrapper{height:100%;display:flex;flex-direction:column}.reader-wrapper>iframe{flex:1;min-height:0;border:0;width:100%}</style>
			<script type="application/json" id="zotero-reader-tts-config">{"alignmentEndpoint":"/align"}</script>
			<div class="reader-wrapper"><iframe src="/reader.html"></iframe></div>` });
		if (pathname.includes('/voices')) return route.fulfill({ json: { voices: [] } });
		if (pathname === '/fixture.epub') return route.fulfill({ body: Buffer.from(sampleEPUB()) });
		return route.fulfill({ path: path.join(process.env.ZOTERO_TEST_READER_ROOT, pathname) });
	});
	await page.goto('https://reader.test/');
	const outer = page.frames().find(f => f.url().endsWith('/reader.html'));
	await outer.evaluate(async ({ buf, type, flowMode }) => {
		const noop = () => {};
		const bytes = type === 'epub' ? new Uint8Array(await (await fetch('/fixture.epub')).arrayBuffer()) : new Uint8Array(buf);
		// The embedded reader expects buffers from its SPA parent realm.
		window.createReader({ type, data: { buf: new window.top.Uint8Array(bytes) }, annotations: [],
			primaryViewState: { flowMode, zoteroContinuousScrollVersion: 1 },
			readOnly: true, sidebarOpen: false, onChangeViewState: noop, onSaveAnnotations: noop,
			onDeleteAnnotations: noop, onToggleSidebar: noop, onChangeSidebarWidth: noop, onChangeSidebarView: noop });
		await Promise.race([window._reader._primaryView.initializedPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error('Reader initialization timed out')), 15000))]);
		if (type === 'pdf') await PDFViewerApplication.pdfViewer.pagesPromise;
	}, { buf: type === 'pdf' ? samplePDF() : [], type, flowMode });
	const frame = outer.childFrames()[0];
	await frame.waitForSelector(type === 'pdf' ? '.page[data-page-number="1"] .textLayer span' : '.section-container p');
	await page.addStyleTag({ path: path.join(__dirname, '../assets/reader-tts/reader-tts.css') });
	await page.addScriptTag({ content: script });
	await page.evaluate(text => tts.start(text), type === 'pdf' ? null : chapters.flat().join('\n\n'));
	await page.waitForFunction(() => !tts.moving);
	const top = () => frame.evaluate(() => window.PDFViewerApplication
		? PDFViewerApplication.pdfViewer.container.scrollTop : document.scrollingElement.scrollTop);
	return { page, frame, outer, top };
}

test('visible word changes and highlight repaints leave every ancestor viewport still', async t => {
	const { page, frame, top } = await reader(t);
	const initial = await top();
	await page.evaluate(async () => {
		for (let i = 1; i <= 8; i++) {
			tts.step(i);
			tts.repaint();
			await new Promise(requestAnimationFrame);
		}
	});
	await page.waitForTimeout(500);
	assert.equal(await top(), initial);
	assert.equal(await page.evaluate(() => window.scrollY), 0);
	assert.equal(await page.evaluate(() => tts.following), true);
	assert.ok(await frame.locator('.ztts-surface-ball').count());
});

test('wheel browsing stays detached through later words and page boundaries, and Follow reading returns', async t => {
	const { page, frame, top } = await reader(t);
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, 1400);
	await page.waitForFunction(() => !tts.following);
	await page.waitForTimeout(600);
	const manual = await top();
	assert.ok(manual > 500);
	await page.evaluate(() => { tts.step(1); tts.step(33); tts.step(2); tts.repaint(); });
	await page.waitForTimeout(700);
	assert.equal(await top(), manual);
	await page.getByRole('button', { name: 'Follow reading', exact: true }).click();
	await page.waitForFunction(() => !tts.moving);
	assert.equal(await page.evaluate(() => tts.following), true);
	assert.ok(await frame.locator('.ztts-surface-ball').count());
	assert.notEqual(await top(), manual);
});

test('offscreen words advance once and scrolling repaints do not interrupt following', async t => {
	const { page, frame, top } = await reader(t);
	const initial = await top();
	await page.evaluate(() => tts.step(20));
	await page.waitForFunction(() => !tts.moving);
	assert.ok(await top() > initial + 150);
	const moved = await top();
	await page.evaluate(() => { tts.step(21); tts.step(22); tts.repaint(); });
	await page.waitForTimeout(500);
	assert.equal(await top(), moved);
	assert.equal(await page.evaluate(() => tts.following), true);
	assert.ok(await frame.locator('.ztts-surface-ball').count());
});

test('following can render and reach a distant PDF page, including with reduced motion', async t => {
	const { page, frame } = await reader(t, 'reduce');
	assert.equal(await frame.locator('.page[data-page-number="12"] .textLayer span').count(), 0);
	await page.evaluate(() => tts.step(tts.words.lastIndexOf('opening')));
	await frame.waitForSelector('.page[data-page-number="12"] .textLayer span');
	await page.waitForFunction(() => !tts.moving);
	assert.equal(await frame.evaluate(() => PDFViewerApplication.pdfViewer.currentPageNumber), 12);
	assert.equal(await page.evaluate(() => tts.following), true);
	assert.ok(await frame.locator('.ztts-surface-ball').count());
});

test('following catches up when speech advances during an automatic page turn', async t => {
	const { page, frame } = await reader(t);
	await page.evaluate(() => {
		tts.step(20);
		tts.step(tts.words.lastIndexOf('opening'));
	});
	await page.waitForFunction(() => !tts.moving);
	assert.equal(await frame.evaluate(() => PDFViewerApplication.pdfViewer.currentPageNumber), 12);
	assert.ok(await frame.locator('.ztts-surface-ball').count());
	assert.equal(await page.evaluate(() => tts.following), true);
});

test('Follow reading reveals an offscreen word on an unrendered page while paused', async t => {
	const { page, frame } = await reader(t);
	await page.getByRole('button', { name: 'Following reading', exact: true }).click();
	await page.evaluate(() => { tts.pause(); tts.step(tts.words.lastIndexOf('closing')); });
	await page.getByRole('button', { name: 'Follow reading', exact: true }).click();
	await frame.waitForSelector('.page[data-page-number="12"] .textLayer span');
	await page.waitForFunction(() => !tts.moving);
	assert.ok(await frame.locator('.ztts-surface-ball').count(), 'the spoken word is visible without waiting for audio to advance');
	assert.equal(await page.evaluate(() => tts.following), true);
});

test('keyboard navigation and scrollbar scrolling detach without changing audio state', async t => {
	const { page, frame, top } = await reader(t);
	await frame.locator('#viewerContainer').click({ position: { x: 600, y: 400 } });
	await page.keyboard.press('PageDown');
	await page.waitForFunction(() => !tts.following);
	await page.waitForTimeout(500);
	const manual = await top();
	await page.evaluate(() => tts.step(2));
	await page.waitForTimeout(400);
	assert.equal(await top(), manual);
	await page.getByRole('button', { name: 'Follow reading', exact: true }).click();
	await page.waitForFunction(() => !tts.moving);
	// A scrollbar drag emits scroll events without wheel or keyboard events.
	await frame.evaluate(() => { PDFViewerApplication.pdfViewer.container.scrollTop += 200; });
	await page.waitForFunction(() => !tts.following);
});

test('a manual gesture interrupts an automatic page turn immediately', async t => {
	const { page, frame, top } = await reader(t);
	await page.evaluate(() => tts.step(20));
	await frame.evaluate(() => document.dispatchEvent(new Event('touchmove', { bubbles: true })));
	assert.equal(await page.evaluate(() => tts.following), false);
	const stopped = await top();
	await page.evaluate(() => tts.step(21));
	await page.waitForTimeout(500);
	assert.equal(await top(), stopped);
});

test('paused audio and highlight-style changes never move the reader', async t => {
	const { page, top } = await reader(t);
	const initial = await top();
	await page.evaluate(() => { tts.pause(); tts.step(20); });
	await page.getByRole('combobox', { name: 'Highlight style' }).selectOption('sentence');
	await page.waitForTimeout(500);
	assert.equal(await top(), initial);
});

test('scrolled EPUBs keep visible words still and advance to an offscreen paragraph', async t => {
	const { page, frame, top } = await reader(t, 'no-preference', 'epub');
	const initial = await top();
	await page.evaluate(() => { tts.step(1); tts.step(2); });
	await page.waitForTimeout(300);
	assert.equal(await top(), initial);
	await page.evaluate(() => tts.step(350));
	await page.waitForFunction(() => !tts.moving);
	assert.ok(await top() > initial + 300);
	assert.equal(await page.evaluate(() => tts.following), true);
	assert.ok(await frame.locator('.ztts-surface-ball').count());
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, 800);
	await page.waitForFunction(() => !tts.following);
	await page.waitForTimeout(500);
	const manual = await top();
	await page.evaluate(() => tts.step(351));
	await page.waitForTimeout(400);
	assert.equal(await top(), manual);
});

test('paginated EPUBs turn to the spread containing the spoken word', async t => {
	const { page, frame, outer } = await reader(t, 'reduce', 'epub', 'paginated');
	const spread = () => frame.evaluate(() => {
		const sections = document.querySelector('.sections');
		return { left: sections.scrollLeft, top: sections.scrollTop };
	});
	const initial = await spread();
	await page.evaluate(() => { tts.step(1); tts.step(2); });
	await page.waitForTimeout(300);
	assert.deepEqual(await spread(), initial);
	await page.evaluate(() => tts.step(350));
	await page.waitForFunction(() => !tts.moving);
	assert.notDeepEqual(await spread(), initial);
	assert.equal(await outer.evaluate(() => _reader._primaryView.flowMode), 'paginated');
	assert.equal(await page.evaluate(() => tts.following), true);
	assert.ok(await frame.locator('.ztts-surface-ball').count());
	const boundary = chapters[0].join(' ').split(/\s+/).length;
	await page.evaluate(index => tts.step(index), boundary);
	await page.waitForFunction(() => !tts.moving);
	assert.equal(await outer.evaluate(() => _reader._primaryView.flow.currentSectionIndex), 1);
	assert.equal(await page.evaluate(() => tts.following), true);
	assert.ok(await frame.locator('.ztts-surface-ball').count());
});
