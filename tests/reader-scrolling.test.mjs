import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
	zoteroInstallWheelScrolling,
	zoteroPageNumber,
	zoteroScrollPage,
	zoteroScrollElement,
} from '../assets/reader-scrolling/pdf-navigation.mjs';

function fixture({ reducedMotion = false, scrollMode = 0, presentation = false } = {}) {
	const timers = new Map();
	let timerID = 0;
	const container = new EventTarget();
	container.ownerDocument = { defaultView: {
		matchMedia: () => ({ matches: reducedMotion }),
		setTimeout: callback => { timers.set(++timerID, callback); return timerID; },
		clearTimeout: id => timers.delete(id),
	} };
	const calls = [];
	const viewer = {
		container, scrollMode, isInPresentationMode: presentation,
		_currentPageNumber: 1, pagesCount: 4,
		_getPageAdvance: () => 1,
		set currentPageNumber(pageNumber) {
			calls.push({ pageNumber, behavior: this._zoteroScrollBehavior });
			this._currentPageNumber = pageNumber;
		},
	};
	return { viewer, container, calls, timers };
}

test('page navigation animates, without changing the default behavior of other navigation', () => {
	const { viewer, calls, container, timers } = fixture();
	zoteroScrollPage(viewer, 2);
	assert.deepEqual(calls, [{ pageNumber: 2, behavior: 'smooth' }]);
	assert.equal(viewer._zoteroScrollBehavior, undefined);
	container.dispatchEvent(new Event('scrollend'));
	assert.equal(timers.size, 0);
	viewer._currentPageNumber = 3;
	assert.equal(zoteroPageNumber(viewer), 3);
});

test('rapid navigation uses the destination instead of an intermediate visible page', () => {
	const { viewer, calls, container, timers } = fixture();
	zoteroScrollPage(viewer, 2);
	viewer._currentPageNumber = 1; // PDF.js update during the animation.
	zoteroScrollPage(viewer, zoteroPageNumber(viewer) + 1);
	assert.equal(calls.at(-1).pageNumber, 3);
	assert.equal(timers.size, 1);
	zoteroScrollPage(viewer, zoteroPageNumber(viewer) - 1);
	assert.equal(calls.at(-1).pageNumber, 2);
	container.dispatchEvent(new Event('scrollend'));
	assert.equal(timers.size, 0);
});

test('manual scrolling and fallback expiry discard pending destinations', () => {
	for (const event of ['wheel', 'touchstart', 'pointerdown', null]) {
		const { viewer, container, timers } = fixture();
		zoteroScrollPage(viewer, 3);
		viewer._currentPageNumber = 2;
		if (event) container.dispatchEvent(new Event(event));
		else [...timers.values()][0]();
		assert.equal(zoteroPageNumber(viewer), 2);
		assert.equal(timers.size, 0);
	}
});

test('reduced motion, presentation, and explicit single-page mode use instant navigation', () => {
	for (const options of [{ reducedMotion: true }, { presentation: true }, { scrollMode: 3 }]) {
		const { viewer, calls, timers } = fixture(options);
		zoteroScrollPage(viewer, 2);
		assert.equal(calls[0].behavior, 'instant');
		assert.equal(timers.size, 0);
	}
});

test('failed navigation restores behavior and clears pending state', () => {
	const { viewer, timers } = fixture();
	Object.defineProperty(viewer, 'currentPageNumber', { set() { throw new Error('unloaded'); } });
	assert.throws(() => zoteroScrollPage(viewer, 2), /unloaded/);
	assert.equal(viewer._zoteroScrollBehavior, undefined);
	assert.equal(zoteroPageNumber(viewer), 1);
	assert.equal(timers.size, 0);
});

test('the PDF surface owns pinch gestures without disabling zoom outside the reader', () => {
	const topDocument = { documentElement: { style: {} } };
	const topWindow = { frameElement: null };
	topDocument.defaultView = topWindow;
	const readerFrame = { style: {}, ownerDocument: topDocument };
	const readerWindow = { frameElement: readerFrame };
	const readerDocument = { defaultView: readerWindow };
	const pdfFrame = { style: {}, ownerDocument: readerDocument };
	const pdfWindow = new EventTarget();
	pdfWindow.frameElement = pdfFrame;
	pdfWindow.matchMedia = () => ({ matches: false });
	const container = new EventTarget();
	container.style = {};
	container.ownerDocument = { defaultView: pdfWindow };
	const viewer = { container };

	zoteroInstallWheelScrolling(viewer);

	assert.equal(container.style.touchAction, 'pan-x pan-y');
	assert.equal(pdfFrame.style.touchAction, 'pan-x pan-y');
	assert.equal(readerFrame.style.touchAction, 'pan-x pan-y');
	assert.equal(topDocument.documentElement.style.touchAction, undefined);
});

test('the reader shell reserves pinch gestures without asserting nested document ownership', () => {
	let css = '';
	try {
		css = readFileSync(new URL('../assets/reader-scrolling/document-gestures.css', import.meta.url), 'utf8');
	}
	catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	assert.match(css, /#split-view[\s\S]*\.split-view[\s\S]*iframe\s*\{[\s\S]*touch-action:\s*pan-x pan-y/);
});

// Point this at the actual Nix output to exercise the patched upstream
// functions, including offsets and page boundaries, without a browser.
const readerRoot = process.env.ZOTERO_TEST_READER_ROOT;
test('the packaged reader applies and cache-versions document gesture ownership', { skip: !readerRoot }, () => {
	const css = readFileSync(`${readerRoot}/reader.css`, 'utf8');
	const html = readFileSync(`${readerRoot}/reader.html`, 'utf8');
	const pdf = readFileSync(`${readerRoot}/pdf/web/viewer.mjs`, 'utf8');
	const source = readFileSync(`${readerRoot}/reader.js`, 'utf8');
	const assignment = source.match(/document\.getElementById\("viewerContainer"\)\.style\.touchAction="pointer"!==e\.type\?"none":"pan-x pan-y"/);
	assert.ok(assignment, 'setTool must preserve document pinch ownership');
	const container = { style: {} };
	for (const type of ['pointer', 'highlight', 'pointer', 'ink', 'pointer']) {
		vm.runInNewContext(assignment[0], { document: { getElementById: () => container }, e: { type } });
		assert.equal(container.style.touchAction, type === 'pointer' ? 'pan-x pan-y' : 'none');
	}
	assert.match(css, /#split-view[\s\S]*\.split-view iframe[\s\S]*touch-action:\s*pan-x pan-y/);
	assert.match(html, /href="reader\.css\?v=[a-f0-9]{12}"/);
	assert.match(pdf, /container\.style\.touchAction = 'pan-x pan-y'/);
});

test('saved single-page layouts become continuous without losing position or zoom', { skip: !readerRoot }, async () => {
	const source = readFileSync(`${readerRoot}/reader.js`, 'utf8');
	const start = source.indexOf('async _setState(');
	const method = source.slice(start, source.indexOf('async _initThumbnails(', start));
	const View = vm.runInNewContext(`(class {${method}})`, { setTimeout: () => {} });
	for (const mode of [0, 1, 2, 3]) {
		const view = new View();
		const destinations = [];
		const pdfViewer = { pagesPromise: Promise.resolve(), scrollPageIntoView: args => destinations.push(args) };
		view._iframeWindow = { PDFViewerApplication: { pdfViewer } };
		const state = { scrollMode: mode, spreadMode: 0, pageIndex: 8, left: 42, top: 150, scale: 125 };
		await view._setState(state, false);
		assert.equal(pdfViewer.scrollMode, mode === 3 ? 0 : mode);
		assert.equal(state.scrollMode, mode);
		for (const destination of destinations) {
			assert.equal(destination.pageNumber, 9);
			assert.deepEqual(Array.from(destination.destArray).slice(2), [42, 150, 1.25]);
		}
		assert.equal(destinations.length, 2);
	}
});

test('packaged PDF.js scrolling and page controls use the smooth-navigation helper', { skip: !readerRoot }, () => {
	const source = readFileSync(`${readerRoot}/pdf/web/viewer.mjs`, 'utf8');
	const scrollFunction = source.slice(source.indexOf('function scrollIntoView('), source.indexOf('function watchScroll('));
	const scrollIntoView = vm.runInNewContext(`(${scrollFunction})`, { zoteroScrollElement });
	const calls = [];
	const container = { clientHeight: 600, scrollHeight: 4000, clientWidth: 800, scrollWidth: 1000,
		scrollLeft: 23, scrollTo: options => calls.push({ ...options }) };
	const page = { offsetParent: container, offsetTop: 900, clientTop: 1, offsetLeft: 40, clientLeft: 2 };
	scrollIntoView(page, null, false, 'smooth');
	assert.deepEqual(calls.pop(), { top: 901, left: 23, behavior: 'smooth' });
	scrollIntoView(page, { top: 12, left: 5 });
	assert.deepEqual(calls.pop(), { top: 913, left: 47, behavior: 'instant' });

	const methods = source.slice(source.indexOf('nextPage(){const currentPageNumber='), source.indexOf('updateScale({drawingDelay:', source.indexOf('nextPage(){const currentPageNumber=')));
	const Navigation = vm.runInNewContext(`(class {${methods}})`, { zoteroPageNumber, zoteroScrollPage });
	const f = fixture();
	Object.setPrototypeOf(f.viewer, Navigation.prototype);
	assert.equal(f.viewer.previousPage(), false);
	assert.equal(f.viewer.nextPage(), true);
	f.viewer._currentPageNumber = 1;
	f.viewer.nextPage();
	f.viewer.nextPage();
	assert.equal(f.calls.at(-1).pageNumber, 4);
	assert.equal(f.viewer.nextPage(), false);
	f.viewer.previousPage();
	assert.equal(f.calls.at(-1).pageNumber, 3);
	f.container.dispatchEvent(new Event('scrollend'));
});
