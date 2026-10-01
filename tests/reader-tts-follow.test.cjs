const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.ZOTERO_TEST_TTS_SCRIPT || new URL('../assets/reader-tts/reader-tts.js', 'file://' + __filename), 'utf8');

function reader({ top = 100, left = 60, following = true, reduced = false } = {}) {
	const calls = [], listeners = {};
	const doc = {
		body: {}, querySelector: () => null,
		addEventListener: (type, callback) => { listeners[type] = callback; },
		createRange: () => ({
			setStart() {}, setEnd() {},
			getClientRects: () => [{ top, bottom: top + 20, left, right: left + 60, width: 60, height: 20 }]
		}),
		defaultView: {
			innerHeight: 800, innerWidth: 1000,
			getComputedStyle: () => ({ overflowY: 'auto', overflowX: 'auto' }),
			matchMedia: () => ({ matches: reduced })
		}
	};
	const container = {
		parentElement: doc.body, closest: () => null,
		clientLeft: 0, clientTop: 0, clientWidth: 900, clientHeight: 600,
		scrollWidth: 900, scrollHeight: 5000, scrollLeft: 0, scrollTop: 0,
		getBoundingClientRect: () => ({ left: 30, top: 50, right: 930, bottom: 650 }),
		scrollTo: options => calls.push(options)
	};
	const context = {
		document: { getElementById: () => null, querySelector: () => null },
		window: { requestAnimationFrame() {} }, localStorage: { getItem: () => null }
	};
	vm.runInNewContext(source.replace('// ------------------------------------------------------------ entry point', `
		globalThis.api = { followSurfaceWord, suspendSurfaceFollow, watchSurfaceNavigation,
			setRun(value) { run = value; }, get run() { return run; } }; return;
	`), context);
	const api = context.api;
	api.setRun({ surfaceFollowing: following, surfaceScroll: null });
	api.watchSurfaceNavigation(doc);
	const target = { doc, tokenIndex: 0, tokens: [{ doc, node: { parentElement: container }, start: 0, end: 4 }] };
	return { api, calls, target, container, listeners };
}

test('words that fit inside the reader viewport never scroll', () => {
	const r = reader();
	for (let i = 0; i < 20; i++) r.api.followSurfaceWord(r.target);
	assert.equal(r.calls.length, 0);
});

test('an offscreen word advances within the reader container without centering its paragraph', () => {
	const r = reader({ top: 700 });
	r.api.followSurfaceWord(r.target);
	assert.equal(r.calls.length, 1);
	assert.equal(r.calls[0].top, 560);
	assert.equal(r.calls[0].left, 0);
	assert.equal(r.calls[0].behavior, 'smooth');
	r.api.followSurfaceWord(r.target);
	assert.equal(r.calls.length, 1, 'word updates cannot restart an in-flight page turn');
});

test('the container edge triggers navigation even if the word fits in the enclosing window', () => {
	const r = reader({ top: 645, reduced: true });
	r.api.followSurfaceWord(r.target);
	assert.equal(r.calls.length, 1);
	assert.equal(r.calls[0].behavior, 'instant');
});

test('manual browsing suppresses page turns until following is explicitly enabled', () => {
	const r = reader({ top: 900, following: false });
	for (let i = 0; i < 30; i++) r.api.followSurfaceWord(r.target);
	assert.equal(r.calls.length, 0);
	r.api.run.surfaceFollowing = true;
	r.api.followSurfaceWord(r.target);
	assert.equal(r.calls.length, 1);
});

test('wheel, touch and page navigation suspend following; inputs and zoom do not', () => {
	for (const [type, event] of [
		['wheel', { deltaY: 100 }], ['touchmove', {}], ['keydown', { key: 'PageDown' }],
		['keydown', { key: 'ArrowLeft' }], ['keydown', { key: 'Home' }]
	]) {
		const r = reader();
		r.listeners[type](event);
		assert.equal(r.api.run.surfaceFollowing, false, type);
	}
	for (const [type, event] of [
		['wheel', { deltaY: 100, ctrlKey: true }],
		['keydown', { key: 'ArrowDown', target: { closest: () => ({}) } }],
		['keydown', { key: 'a' }]
	]) {
		const r = reader();
		r.listeners[type](event);
		assert.equal(r.api.run.surfaceFollowing, true, type);
	}
});

test('manual input cancels an in-flight automatic scroll at its current position', () => {
	const r = reader({ top: 900 });
	r.api.followSurfaceWord(r.target);
	r.container.scrollTop = 125;
	r.listeners.wheel({ deltaY: -50 });
	assert.equal(r.api.run.surfaceFollowing, false);
	assert.equal(r.api.run.surfaceScroll, null);
	assert.equal(r.calls.at(-1).top, 125);
	assert.equal(r.calls.at(-1).behavior, 'instant');
	const count = r.calls.length;
	r.api.followSurfaceWord(r.target);
	assert.equal(r.calls.length, count);
});
