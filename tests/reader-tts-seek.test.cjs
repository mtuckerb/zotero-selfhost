const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.ZOTERO_TEST_TTS_SCRIPT || new URL('../assets/reader-tts/reader-tts.js', 'file://' + __filename), 'utf8');
const paragraphs = [
 'Opening words introduce the first topic with a clear explanation.',
 'Middle words describe the second topic with some useful examples.',
 'Closing words finish the final topic with a memorable conclusion.'
];
const text = paragraphs.join('\n\n');
const settle = () => new Promise(resolve => setImmediate(resolve));

function surface(text) {
 const node = { nodeValue: text, parentElement: { closest: () => null } };
 return {
  body: {},
  querySelector: () => null,
  createTreeWalker: () => {
   let visited = false;
   return { nextNode: () => visited ? null : (visited = true, node) };
  },
  createRange: () => {
   let start, end;
   return {
    setStart: (_, offset) => { start = offset; },
    setEnd: (_, offset) => { end = offset; },
    getClientRects: () => [{ left: start * 8, right: end * 8, top: 0, bottom: 20, width: (end - start) * 8, height: 20 }]
   };
  }
 };
}

function reader({ alignment = false, deferred = false, fulltextDeferred = false, storage = new Map(), config = {} } = {}) {
 const requests = [], revoked = [], clips = new Map();
 const alignmentRequests = [];
 const documentRequests = [];
 let nextUrl = 0;
 class Audio {
  constructor() { this.listeners = {}; this.src = ''; this.paused = true; this.currentTime = 0; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  emit(type) { for (const callback of this.listeners[type] || []) callback(); }
  pause() { this.paused = true; this.emit('pause'); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  load() {
   const src = this.src;
   this.currentTime = 0;
   this.duration = NaN;
   queueMicrotask(() => {
    if (!src || this.src !== src) return;
    this.duration = 90;
    this.emit('loadedmetadata');
   });
  }
  play() { this.paused = false; this.emit('playing'); return Promise.resolve(); }
 }
 const context = {
  document: {
   getElementById: id => id === 'zotero-reader-tts-config'
    ? { textContent: JSON.stringify({ chunkMaxChars: 70, alignmentEndpoint: alignment ? '/align' : null, ...config }) }
    : id === 'zotero-web-library-config' ? { textContent: JSON.stringify({ userId: 1, apiKey: 'test-only' }) } : null,
   querySelector: () => null
  },
  localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  Audio, AbortController,
  location: { pathname: '/library/items/ABCDEFGH' },
  FileReader: class {
   readAsDataURL() { this.result = 'data:audio/mpeg;base64,AAAA'; queueMicrotask(() => this.onload()); }
  },
  URL: {
   createObjectURL: blob => { const url = 'blob:test-' + ++nextUrl; clips.set(url, blob.text); return url; },
   revokeObjectURL: url => revoked.push(url)
  },
  fetch: (url, options) => {
   if (url.endsWith('/fulltext')) return new Promise((resolve, reject) => {
    const request = { reject, resolve: (content = text) => resolve({ ok: true, json: async () => ({ content }) }) };
    documentRequests.push(request);
    if (!fulltextDeferred) request.resolve();
   });
   const body = JSON.parse(options.body);
   if (url.endsWith('/align')) {
    alignmentRequests.push(body.text);
    return Promise.resolve({
    ok: true,
    json: async () => ({ timeline: body.text.match(/\S+/g).map((_, i) => [i, i * 1000, i * 1000 + 800]) })
    });
   }
   return new Promise((resolve, reject) => {
    const request = { text: body.input, signal: options.signal, reject, resolve: () => resolve({
     ok: true, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ text: body.input, type: 'audio/mpeg' })
    }) };
    requests.push(request);
    if (!deferred) request.resolve();
   });
  }
 };
 vm.runInNewContext(source.replace(
  '// ------------------------------------------------------------ entry point',
  `globalThis.api = {
   startRun, stopRun, seekToSurfaceClick, seekToWord, applyVoice, nextPart, togglePlay,
   get run() { return run; }, get audio() { return audio; }
  }; return;`
 ), context);
 const api = context.api;
 function click(phrase, overrides = {}, content = text) {
  const offset = content.indexOf(phrase);
  assert.ok(offset >= 0, 'click target exists');
  const event = {
   metaKey: true, button: 0, clientX: offset * 8 + 4, clientY: 10,
   preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
   ...overrides
  };
  const handled = api.seekToSurfaceClick(surface(content), event);
  return { handled, event };
 }
 return { api, click, requests, alignmentRequests, documentRequests, revoked, clips, storage,
  start: () => api.startRun('document', text, { attachmentKey: 'ABCDEFGH' }) };
}

test('repairs wrapped words before chunking, synthesis and alignment for document and selection playback', async () => {
 for (const source of ['document', 'selection']) {
  const r = reader({ alignment: true, config: { chunkMaxChars: 36 } });
  r.api.startRun(source, 'They spoke to the inter-\u00a0\nviewer.\n\nThey requested a re-\na-\nlignment.');
  await settle();
  assert.deepEqual(Array.from(r.api.run.parts, part => part.text), [
   'They spoke to the interviewer.', 'They requested a realignment.'
  ]);
  assert.equal(r.requests[0].text, 'They spoke to the interviewer.');
  assert.equal(r.alignmentRequests[0], 'They spoke to the interviewer.');
  assert.equal(r.api.run.parts[0].timeline.length, 5);
  r.api.nextPart();
  await settle();
  assert.equal(r.clips.get(r.api.audio.src), 'They requested a realignment.');
 }
});

test('manual browsing survives audio part changes and a new reading restores following', async () => {
 const r = reader();
 r.start();
 await settle();
 assert.equal(r.api.run.surfaceFollowing, true);
 r.api.run.surfaceFollowing = false;
 r.api.nextPart();
 await settle();
 assert.equal(r.api.run.surfaceFollowing, false);
 r.api.togglePlay();
 r.api.togglePlay();
 assert.equal(r.api.run.surfaceFollowing, false);
 r.api.stopRun();
 r.start();
 await settle();
 assert.equal(r.api.run.surfaceFollowing, true);
});

test('corrects meso in speech while preserving source words for alignment and seeking', async () => {
 const r = reader({ alignment: true });
 const sourceText = 'Meso-level examines groups. Meso connects people.';
 r.api.startRun('document', sourceText, { attachmentKey: 'ABCDEFGH' });
 await settle();
 assert.equal(r.requests[0].text, '[Meso](/mˈɛzO/)-level examines groups. [Meso](/mˈɛzO/) connects people.');
 assert.equal(r.api.run.parts[0].speechText, sourceText);
 assert.equal(r.alignmentRequests[0], sourceText);
 const { handled } = r.click('Meso connects', {}, sourceText);
 assert.equal(handled, true);
 await settle();
 assert.equal(r.api.audio.currentTime, 2.92, 'seeks to the original fourth word with the reader’s 80 ms lead-in');
});

test('pronunciation matching respects case, hyphens, and Unicode word boundaries', async () => {
 const r = reader({ config: { chunkMaxChars: 1500 } });
 r.api.startRun('selection', 'meso MESO Meso-level meso–level mesosystem Miso ameso mésomeso meso2 meso_name');
 await settle();
 assert.equal(r.requests[0].text, '[meso](/mˈɛzO/) [MESO](/mˈɛzO/) [Meso](/mˈɛzO/)-level [meso](/mˈɛzO/)–level mesosystem Miso ameso mésomeso meso2 meso_name');
});

test('pronunciation dictionary can be customized or disabled and skips non-English voices', async () => {
 for (const [config, expected] of [
  [{ pronunciations: { MeSo: 'mˈɛsO' }, voice: 'bm_george' }, '[Meso](/mˈɛsO/)'],
  [{ pronunciations: {} }, 'Meso'],
  [{ voice: 'ff_siwis' }, 'Meso'],
  [{ pronunciations: { meso: 'broken/phoneme' } }, 'Meso']
 ]) {
  const r = reader({ config });
  r.api.startRun('selection', 'Meso');
  await settle();
  assert.equal(r.requests[0].text, expected);
 }
});

test('Command-click jumps to an unsynthesized later part without requiring alignment', async () => {
 const r = reader();
 r.start();
 await settle();
 assert.equal(r.api.run.parts.length, 3);
 assert.equal(r.api.run.parts[2].url, null);
 const { handled, event } = r.click('final topic');
 assert.equal(handled, true);
 assert.ok(event.prevented && event.stopped);
 assert.ok(r.api.audio.paused, 'old audio stops while the target loads');
 await settle();
 assert.equal(r.api.run.index, 2);
 assert.equal(r.clips.get(r.api.audio.src), 'final topic with a memorable conclusion.');
 assert.equal(r.api.audio.currentTime, 0);
 assert.equal(r.api.audio.paused, false);
});

test('can jump backwards to text before a prior jump and preserve later parts', async () => {
 const r = reader();
 r.start(); await settle();
 r.click('memorable'); await settle();
 r.click('Closing'); await settle();
 assert.equal(r.clips.get(r.api.audio.src), paragraphs[2]);
 r.click('first topic'); await settle();
 assert.equal(r.api.run.index, 0);
 assert.equal(r.clips.get(r.api.audio.src), 'first topic with a clear explanation.');
 r.api.nextPart(); await settle();
 assert.equal(r.clips.get(r.api.audio.src), paragraphs[1]);
});

test('uses cached word timings in another part and preserves paused playback', async () => {
 const r = reader({ alignment: true });
 r.start(); await settle();
 const requestsBefore = r.requests.length;
 r.api.audio.pause();
 assert.equal(r.click('second topic').handled, true);
 await settle();
 assert.equal(r.api.run.index, 1);
 assert.equal(r.api.audio.currentTime, 4 - 0.08);
 assert.equal(r.api.audio.paused, true);
 assert.equal(r.requests.length, requestsBefore, 'cached target needs no synthesis');
 assert.equal(r.api.run.parts[1].startWord, 0);
});

test('returning to earlier text does not skip a previously clicked prefix during sequential playback', async () => {
 const r = reader();
 r.start(); await settle();
 r.click('final topic'); await settle();
 r.click('second topic'); await settle();
 r.api.audio.emit('ended'); await settle();
 assert.equal(r.api.run.index, 2);
 assert.equal(r.clips.get(r.api.audio.src), paragraphs[2]);
});

test('seeks directly in the current aligned clip', async () => {
 const r = reader({ alignment: true });
 r.start(); await settle();
 const src = r.api.audio.src;
 assert.equal(r.click('first topic').handled, true);
 assert.equal(r.api.audio.src, src);
 assert.equal(r.api.audio.currentTime, 4 - 0.08);
});

test('matches repeated words using context across part boundaries', async () => {
 const r = reader();
 r.start(); await settle();
 assert.equal(r.click('words finish').handled, true);
 await settle();
 assert.equal(r.api.run.index, 2);
 assert.equal(r.clips.get(r.api.audio.src), paragraphs[2].slice('Closing '.length));
});

test('works when only the clicked page is rendered', async () => {
 const r = reader();
 r.start(); await settle();
 assert.equal(r.click('final topic', {}, paragraphs[2]).handled, true);
 await settle();
 assert.equal(r.api.run.index, 2);
 assert.equal(r.api.run.parts[2].startWord, 4);
});

test('ordinary clicks, secondary clicks, empty space and unrelated text are left alone', async () => {
 const r = reader();
 r.start(); await settle();
 for (const result of [
  r.click('final topic', { metaKey: false }),
  r.click('final topic', { button: 2 }),
  r.click('final topic', { clientY: 100 }),
  r.click('Completely', {}, 'Completely unrelated toolbar text')
 ]) {
  assert.equal(result.handled, false);
  assert.equal(result.event.prevented, undefined);
 }
 assert.equal(r.api.run.index, 0);
 assert.equal(r.click('final topic', { metaKey: false, ctrlKey: true }).handled, true);
 await settle();
 assert.equal(r.api.run.index, 2);
});

test('the latest click wins while initial synthesis is still loading', async () => {
 const r = reader({ deferred: true });
 r.start();
 assert.equal(r.api.audio, null);
 r.click('second topic');
 r.click('final topic');
 assert.equal(r.requests.length, 3);
 r.requests[1].reject(new Error('stale synthesis failed'));
 r.requests[0].resolve();
 await settle();
 assert.equal(r.api.run.loading, true);
 assert.equal(r.api.run.failed, null);
 r.requests[2].resolve();
 await settle();
 assert.equal(r.api.run.index, 2);
 assert.equal(r.clips.get(r.api.audio.src), 'final topic with a memorable conclusion.');
 assert.equal(r.api.audio.paused, false);
});

test('late results from an earlier jump into the same part cannot replace the latest target', async () => {
 const r = reader({ deferred: true });
 r.start(); r.requests[0].resolve(); await settle();
 r.click('final topic');
 const oldRequest = r.requests.at(-1);
 r.click('memorable');
 const latest = r.requests.at(-1);
 latest.resolve(); await settle();
 const src = r.api.audio.src;
 oldRequest.resolve(); await settle();
 assert.equal(r.api.audio.src, src);
 assert.equal(r.clips.get(src), 'memorable conclusion.');
 assert.ok(r.revoked.length > 0);
 assert.equal(r.api.run.failed, null);
});

test('a jump stopped during synthesis never restarts playback', async () => {
 const r = reader({ deferred: true });
 r.start(); r.click('final topic');
 r.api.stopRun();
 for (const request of r.requests) request.resolve();
 await settle();
 assert.equal(r.api.run, null);
 assert.equal(r.api.audio, null);
 assert.equal(r.revoked.length, 2);
});

test('alignment after a jump uses the original word indexes for subsequent seeks', async () => {
 const r = reader({ alignment: true });
 r.start(); await settle();
 r.click('final topic'); await settle();
 assert.equal(r.api.run.parts[2].timeline[0][0], 4);
 const src = r.api.audio.src;
 r.click('memorable');
 assert.equal(r.api.audio.src, src);
 assert.equal(r.api.audio.currentTime, 4 - 0.08);
});

test('resuming a document restores both the clicked word and elapsed time', async () => {
 const r = reader();
 r.start(); await settle();
 r.click('final topic'); await settle();
 r.api.audio.currentTime = 7;
 r.api.stopRun();
 const resumed = reader({ storage: r.storage });
 resumed.start(); await settle();
 assert.equal(resumed.api.run.index, 2);
 assert.equal(resumed.clips.get(resumed.api.audio.src), 'final topic with a memorable conclusion.');
 assert.equal(resumed.api.audio.currentTime, 7);
});

test('changing voice after a jump preserves its word offset', async () => {
 const r = reader();
 r.start(); await settle();
 r.click('final topic'); await settle();
 r.api.audio.currentTime = 3;
 r.api.applyVoice('af_bella'); await settle();
 assert.equal(r.clips.get(r.api.audio.src), 'final topic with a memorable conclusion.');
 assert.equal(r.api.audio.currentTime, 3);
});

test('Command-click outside Read selection expands playback to the complete document', async () => {
 const r = reader();
 r.api.startRun('selection', paragraphs[0]); await settle();
 assert.equal(r.click('final topic').handled, true);
 await settle();
 assert.equal(r.api.run.source, 'document');
 assert.equal(r.api.run.index, 2);
 assert.equal(r.clips.get(r.api.audio.src), 'final topic with a memorable conclusion.');
 assert.equal(r.api.audio.paused, false);
 r.click('second topic'); await settle();
 assert.equal(r.api.run.index, 1);
});

test('expanding a paused selection keeps playback paused', async () => {
 const r = reader();
 r.api.startRun('selection', paragraphs[0]); await settle();
 r.api.audio.pause();
 r.click('final topic'); await settle();
 assert.equal(r.api.run.source, 'document');
 assert.equal(r.api.audio.paused, true);
});

test('a newer jump within the selection cancels an outside lookup', async () => {
 const r = reader({ fulltextDeferred: true });
 r.api.startRun('selection', paragraphs[0]); await settle();
 r.click('final topic');
 r.click('first topic'); await settle();
 r.documentRequests[0].resolve(); await settle();
 assert.equal(r.api.run.source, 'selection');
 assert.equal(r.clips.get(r.api.audio.src), 'first topic with a clear explanation.');
 assert.equal(r.api.audio.paused, false);
});

test('the latest outside-selection click wins when document lookups finish out of order', async () => {
 const r = reader({ fulltextDeferred: true });
 r.api.startRun('selection', paragraphs[0]); await settle();
 r.click('second topic');
 r.click('final topic');
 r.documentRequests[1].resolve(); await settle();
 r.documentRequests[0].resolve(); await settle();
 assert.equal(r.api.run.source, 'document');
 assert.equal(r.api.run.index, 2);
 assert.equal(r.api.audio.paused, false);
});

test('stopping during an outside-selection lookup prevents playback from restarting', async () => {
 const r = reader({ fulltextDeferred: true });
 r.api.startRun('selection', paragraphs[0]); await settle();
 r.click('final topic');
 r.api.stopRun();
 r.documentRequests[0].resolve(); await settle();
 assert.equal(r.api.run, null);
 assert.equal(r.api.audio.src, '');
});

test('a full-document lookup failure leaves the selection available to resume', async () => {
 const r = reader({ fulltextDeferred: true });
 r.api.startRun('selection', paragraphs[0]); await settle();
 r.click('final topic');
 r.documentRequests[0].reject(new Error('Full text unavailable')); await settle();
 assert.equal(r.api.run.source, 'selection');
 assert.equal(r.api.run.loading, false);
 r.api.togglePlay();
 assert.equal(r.api.audio.paused, false);
});

test('a click absent from the full text does not discard the selection', async () => {
 const r = reader({ fulltextDeferred: true });
 r.api.startRun('selection', paragraphs[0]); await settle();
 r.click('final topic');
 r.documentRequests[0].resolve(paragraphs[0]); await settle();
 assert.equal(r.api.run.source, 'selection');
 assert.equal(r.api.run.loading, false);
});
