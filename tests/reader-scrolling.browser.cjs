// Run against a built reader with Playwright and a compatible Firefox binary:
// ZOTERO_TEST_READER_ROOT=... PLAYWRIGHT_MODULE=... FIREFOX_BINARY=... \
//   node --test tests/reader-scrolling.browser.cjs
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function samplePDF() {
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>'];
	for (let i = 0; i < 4; i++) {
		const stream = `BT /F1 24 Tf 72 720 Td (Scroll test page ${i + 1}) Tj ET`;
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 11 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	}
	objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
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

let browser, page, frame;
const errors = [];
before(async () => {
	assert.ok(process.env.ZOTERO_TEST_READER_ROOT, 'Set ZOTERO_TEST_READER_ROOT to the built reader directory');
	browser = await firefox.launch({ headless: true, executablePath: process.env.FIREFOX_BINARY });
	page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
	page.on('pageerror', error => errors.push(error.message));
	// Use only local build artifacts and a synthetic document, with no account
	// or library access and no dependency on the live server.
	await page.route('http://reader.test/**', route => route.fulfill({
		path: path.join(process.env.ZOTERO_TEST_READER_ROOT, new URL(route.request().url()).pathname),
	}));
	await page.goto('http://reader.test/reader.html');
	await page.evaluate(async buf => {
		const noop = () => {};
		window.createReader({ type: 'pdf', data: { buf: new Uint8Array(buf) }, annotations: [],
			readOnly: true, sidebarOpen: false, onChangeViewState: noop, onSaveAnnotations: noop,
			onDeleteAnnotations: noop, onToggleSidebar: noop, onChangeSidebarWidth: noop, onChangeSidebarView: noop });
		await window._reader._primaryView.initializedPromise;
		await PDFViewerApplication.pdfViewer.pagesPromise;
	}, samplePDF());
	frame = page.frames().find(f => f.url().includes('/pdf/web/viewer.html'));
	await page.mouse.move(700, 500);
}, { timeout: 30000 });

after(async () => { await browser?.close(); });

async function recordAt(top) {
	return frame.evaluate(async top => {
		const c = PDFViewerApplication.pdfViewer.container;
		c.scrollTo({ top, behavior: 'instant' });
		await new Promise(requestAnimationFrame);
		await new Promise(requestAnimationFrame);
		const start = c.scrollTop;
		const samples = [start];
		const started = performance.now();
		window.recordedScroll = new Promise(resolve => {
			function tick() {
				samples.push(c.scrollTop);
				if (performance.now() - started > 500) resolve(samples);
				else requestAnimationFrame(tick);
			}
			requestAnimationFrame(tick);
		});
		return start;
	}, top);
}

test('Firefox wheel scrolling animates continuously across a PDF page boundary', async () => {
	const boundary = await frame.evaluate(() => {
		const page = PDFViewerApplication.pdfViewer.getPageView(1).div;
		return page.offsetTop + page.clientTop;
	});
	const start = await recordAt(boundary - 80);
	await page.mouse.wheel(0, 320);
	const samples = await frame.evaluate(() => window.recordedScroll);
	assert.ok(Math.abs(samples.at(-1) - start - 320) <= 1, 'wheel distance is preserved');
	const intermediate = new Set(samples.filter(y => y > start && y < samples.at(-1)));
	assert.ok(intermediate.size >= 4, `expected animated positions, got ${[...intermediate]}`);
	assert.ok(samples.some(y => y < boundary) && samples.some(y => y > boundary));
});

test('repeated wheel input accumulates instead of dropping steps', async () => {
	const start = await recordAt(100);
	for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100);
	const samples = await frame.evaluate(() => window.recordedScroll);
	assert.ok(Math.abs(samples.at(-1) - start - 300) <= 1);
});

test('page navigation cancels an unfinished wheel animation', async () => {
	await recordAt(100);
	await page.mouse.wheel(0, 500);
	const destination = await page.evaluate(() => {
		PDFViewerApplication.pdfViewer.scrollPageIntoView({ pageNumber: 3 });
		return PDFViewerApplication.pdfViewer.container.scrollTop;
	});
	const samples = await frame.evaluate(() => window.recordedScroll);
	assert.equal(samples.at(-1), destination);
});

test('reduced motion and document boundaries preserve native wheel handling', async () => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await recordAt(100);
	const reducedPrevented = await frame.evaluate(() => {
		const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
		PDFViewerApplication.pdfViewer.container.dispatchEvent(event);
		return event.defaultPrevented;
	});
	assert.equal(reducedPrevented, false);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await recordAt(0);
	const boundaryPrevented = await frame.evaluate(() => {
		const event = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true });
		PDFViewerApplication.pdfViewer.container.dispatchEvent(event);
		return event.defaultPrevented;
	});
	assert.equal(boundaryPrevented, false);
	assert.deepEqual(errors, []);
});
