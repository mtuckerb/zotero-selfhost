// Test a local EPUB without accessing or modifying a Zotero library:
// ZOTERO_TEST_READER_ROOT=... ZOTERO_TEST_EPUB=... PLAYWRIGHT_MODULE=... \
//   FIREFOX_BINARY=... node --test tests/reader-epub-scrolling.browser.cjs
// Set ZOTERO_TEST_READER_URL instead of ROOT to test a deployed reader.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

let browser, page, saved, bookmark;
const errors = [];
const readerURL = process.env.ZOTERO_TEST_READER_URL || 'https://reader.test/reader.html';

async function openReader(state) {
	const tab = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
	tab.on('pageerror', error => errors.push(error.message));
	if (process.env.ZOTERO_TEST_READER_ROOT) await tab.route('https://reader.test/**', route => {
		const pathname = new URL(route.request().url()).pathname;
		return route.fulfill({ path: path.join(process.env.ZOTERO_TEST_READER_ROOT, pathname) });
	});
	await tab.route(new URL('/book.epub', readerURL).href,
		route => route.fulfill({ path: process.env.ZOTERO_TEST_EPUB }));
	await tab.goto(readerURL);
	await tab.evaluate(async primaryViewState => {
		const noop = () => {};
		const buf = new Uint8Array(await (await fetch('/book.epub')).arrayBuffer());
		window.createReader({ type: 'epub', data: { buf }, primaryViewState,
			annotations: [], readOnly: true, sidebarOpen: false,
			onChangeViewState: (state, primary) => { if (primary) window.lastViewState = state; },
			onSaveAnnotations: noop, onDeleteAnnotations: noop, onToggleSidebar: noop,
			onChangeSidebarWidth: noop, onChangeSidebarView: noop });
		await window._reader._primaryView.initializedPromise;
		window._reader._primaryView._handleViewUpdate();
	}, state);
	return tab;
}

before(async () => {
	assert.ok((process.env.ZOTERO_TEST_READER_ROOT || process.env.ZOTERO_TEST_READER_URL)
		&& process.env.ZOTERO_TEST_EPUB, 'Set a reader ROOT or URL, and ZOTERO_TEST_EPUB');
	browser = await firefox.launch({ headless: true, executablePath: process.env.FIREFOX_BINARY });
	page = await openReader({ flowMode: 'paginated', scale: 1.125 });
}, { timeout: 30000 });
after(async () => { await browser?.close(); });

test('existing paginated EPUBs open as a continuous document', async () => {
	const actual = await page.evaluate(() => {
		const view = window._reader._primaryView;
		return { flow: view.flowMode, scale: view.scale,
			scrolled: view._iframeDocument.body.classList.contains('flow-mode-scrolled'),
			mounted: view.renderers.filter(r => r.container.isConnected).length };
	});
	assert.equal(actual.flow, 'scrolled');
	assert.equal(actual.scale, 1.125);
	assert.equal(actual.scrolled, true);
	assert.ok(actual.mounted > 1, 'consecutive sections are mounted together');
});

test('migration preserves a bookmark and text size from the paginated layout', async () => {
	await page.evaluate(() => {
		const view = window._reader._primaryView;
		view.setFlowMode('paginated');
		view.navigate({ pageIndex: 25 }, { behavior: 'instant' });
	});
	await page.waitForFunction(() => window.lastViewState?.flowMode === 'paginated'
		&& window.lastViewState.cfi && window.lastViewState.cfi !== '_start');
	({ saved, bookmark } = await page.evaluate(() => ({ saved: window.lastViewState,
		bookmark: window._reader._primaryView.flow.startCFI.toString(true) })));
	// A pre-upgrade saved state has exactly these fields, without the marker.
	delete saved.zoteroContinuousScrollVersion;
	await page.close();
	page = await openReader(saved);
	const actual = await page.evaluate(bookmark => {
		const view = window._reader._primaryView;
		const rect = view.getRange(bookmark, true).getBoundingClientRect();
		return { flow: view.flowMode, scale: view.scale, top: rect.top, bottom: rect.bottom,
			height: view._iframeWindow.innerHeight };
	}, bookmark);
	assert.equal(actual.flow, 'scrolled');
	assert.equal(actual.scale, saved.scale);
	assert.ok(actual.bottom >= -2 && actual.top < actual.height,
		`bookmarked text should be visible after migration: ${JSON.stringify(actual)}`);
	await page.waitForFunction(() => window.lastViewState?.zoteroContinuousScrollVersion === 1);
});

test('EPUB next-page controls animate within the continuous document', async () => {
	const positions = await page.evaluate(async () => {
		const view = window._reader._primaryView;
		const win = view._iframeWindow;
		const positions = [win.scrollY];
		const started = performance.now();
		const recording = new Promise(resolve => {
			function tick() {
				positions.push(win.scrollY);
				if (performance.now() - started > 1200) resolve(positions);
				else requestAnimationFrame(tick);
			}
			requestAnimationFrame(tick);
		});
		window._reader.navigateToNextPage();
		return recording;
	});
	assert.ok(positions.at(-1) > positions[0]);
	assert.ok(new Set(positions.filter(y => y > positions[0] && y < positions.at(-1))).size >= 3);
});

test('a later explicit paginated choice is remembered after the one-time migration', async () => {
	await page.evaluate(() => window._reader._primaryView.setFlowMode('paginated'));
	await page.waitForFunction(() => window.lastViewState?.flowMode === 'paginated'
		&& window.lastViewState.zoteroContinuousScrollVersion === 1);
	const state = await page.evaluate(() => window.lastViewState);
	await page.close();
	page = await openReader(state);
	assert.equal(await page.evaluate(() => window._reader._primaryView.flowMode), 'paginated');
	assert.deepEqual(errors, []);
});
