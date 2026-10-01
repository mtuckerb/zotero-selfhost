const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// Exercise the shipped overlay, stopping before it mounts the transport UI.
const source = readFileSync(process.env.ZOTERO_TEST_TTS_SCRIPT || new URL('../assets/reader-tts/reader-tts.js', 'file://' + __filename), 'utf8');
function readerApi(overrides = {}) {
 const context = {
  document: { getElementById: () => null },
  localStorage: { getItem: () => null },
  ...overrides
 };
 vm.runInNewContext(source.replace(
  '// ------------------------------------------------------------ entry point',
  'globalThis.api = { pdfPageLines, pdfSpeechText, fetchPdfDocumentText, fetchDocumentText, normalizeForSpeech, selectionSpeechText, surfaceTokensForDoc }; return;'
 ), context);
 return context.api;
}
const api = readerApi();
test('speech citation cleanup preserves ordinary parenthetical dates', () => {
 assert.equal(api.normalizeForSpeech('A person (born in 1980) worked here (2007–2009).'),
  'A person (born in 1980) worked here (2007–2009).');
 assert.equal(api.normalizeForSpeech('The conference was held in May (2020), then repeated in (May, 2021).'),
  'The conference was held in May (2020), then repeated in (May, 2021).');
 assert.equal(api.normalizeForSpeech('Evidence (Smith, 2020; Jones et al., 2021) supports this.'),
  'Evidence citation supports this.');
 assert.equal(api.normalizeForSpeech('Evidence (Smith & Jones, 2020) supports this.'),
  'Evidence citation supports this.');
});
const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
function item(str, { x = 100, y = 200, size = 12, width = 400, hasEOL = true, transform } = {}) {
 return { str, fontName: 'body', width, height: size, hasEOL, transform: transform || [size, 0, 0, size, x, 800 - y] };
}
function layout(items, tree, view = viewport) {
 return api.pdfPageLines({ items, styles: {} }, view, tree);
}
function body() {
 return [
  item('The main paragraph remains available to the listener.', { y: 250 }),
  item('Another complete body line continues the argument.', { y: 268 }),
  item('The final body paragraph also needs to be preserved.', { y: 650 })
 ];
}
function speak(items, tree) { return api.pdfSpeechText([layout(items, tree)]); }

test('skips the rotated side notice and bottom print metadata in the screenshot', () => {
 const text = speak([
  item('THE COMPETENT INTERVIEWER', { y: 120, size: 18 }), ...body(),
  item('Copyright margin notice', { transform: [0, 5, -5, 0, 10, 20], size: 5 }),
  item('EBSCO Publishing: eBook Collection printed for a library', { x: 15, y: 785, size: 5 }),
  item('Account:ehost.', { x: 15, y: 793, size: 5 })
 ]);
 assert.match(text, /THE COMPETENT INTERVIEWER/);
 assert.match(text, /final body paragraph/);
 assert.doesNotMatch(text, /Copyright|EBSCO|Account/);
});

test('removes small footnotes with continuation lines without cropping bottom body text', () => {
 const text = speak([...body(),
  item('1. An explanatory footnote.', { y: 690, size: 9 }),
  item('Its continuation has no note number.', { y: 704, size: 9 }),
  item('The main text can run close to the bottom.', { y: 748 })
 ]);
 assert.doesNotMatch(text, /footnote|continuation/);
 assert.match(text, /main text can run close/);
});

test('removes horizontal margin notes while preserving both body columns', () => {
 const text = speak([
  item('The complete first column remains in reading order.', { x: 120, width: 170 }),
  item('The complete second column remains in reading order.', { x: 320, width: 170 }),
  item('Margin note', { x: 40, width: 55, size: 8 }),
  item('Right margin note', { x: 510, width: 55, size: 8 })
 ]);
 assert.equal(text, 'The complete first column remains in reading order.\nThe complete second column remains in reading order.');
});

test('detects changing page numbers and alternating running headers across pages', () => {
 const pages = [1, 2, 3, 4].map(n => layout([
  item((n % 2 ? 'Chapter name ' : 'Book title ') + n, { y: 55 }),
  ...body(), item(String(n), { y: 745 })
 ]));
 const text = api.pdfSpeechText(pages);
 assert.doesNotMatch(text, /Chapter name|Book title/);
 assert.equal((text.match(/main paragraph/g) || []).length, 4);
 assert.doesNotMatch(text, /\n[1-4](?:\n|$)/);
});

test('does not discard legitimate repeated body sentences when normalizing speech', () => {
 const text = api.normalizeForSpeech(api.pdfSpeechText([layout(body()), layout(body()), layout(body())]));
 assert.equal((text.match(/main paragraph/g) || []).length, 3);
 assert.equal((text.match(/final body paragraph/g) || []).length, 3);
});

test('Markdown headings are spoken without markup and pause before body text', () => {
 assert.equal(
  api.normalizeForSpeech('# Heading 1\nThe first paragraph starts here.'),
  'Heading 1.\n\nThe first paragraph starts here.'
 );
 assert.equal(
  api.normalizeForSpeech('Introductory prose.\n\n## What changed? ##\nDetails follow.'),
  'Introductory prose.\n\nWhat changed?\n\nDetails follow.'
 );
 assert.equal(
  api.normalizeForSpeech('A #hashtag inside prose\ncontinues normally.'),
  'A #hashtag inside prose continues normally.'
 );
});

test('single-page small running header is excluded and a large chapter title is retained', () => {
 const text = speak([item('Running header', { y: 60, size: 9 }), item('Chapter title', { y: 90, size: 20 }), ...body()]);
 assert.doesNotMatch(text, /Running header/);
 assert.match(text, /Chapter title/);
});

test('tagged footnotes are excluded even at body size and in the middle of a page', () => {
 const tree = { role: 'Root', children: [{ role: 'Note', children: [{ role: 'P', children: [{ type: 'content', id: 'note1' }] }] }] };
 const text = speak([
  ...body(), { type: 'beginMarkedContentProps', id: 'note1', tag: 'P' },
  item('A tagged note at body size.', { y: 400 }), { type: 'endMarkedContent' },
  item('The paragraph after the note survives.', { y: 420 })
 ], tree);
 assert.doesNotMatch(text, /tagged note/);
 assert.match(text, /paragraph after/);
});

test('nested PDF artifacts do not leak text or hide subsequent body text', () => {
 const text = speak([
  { type: 'beginMarkedContent', tag: 'Artifact' },
  { type: 'beginMarkedContentProps', tag: 'Span', id: 'artifact1' },
  item('A nested artifact'), { type: 'endMarkedContent' }, { type: 'endMarkedContent' }, ...body()
 ]);
 assert.doesNotMatch(text, /artifact/);
 assert.match(text, /main paragraph/);
});

test('joins adjacent font runs and preserves line-end hyphenation for normalization', () => {
 const text = api.normalizeForSpeech(speak([
  item('Com', { width: 24, hasEOL: false }),
  item('petent inter-', { x: 124, width: 75 }),
  item('viewers listen.', { y: 220 })
 ]));
 assert.equal(text, 'Competent interviewers listen.');
});

test('uses viewport transforms for intrinsically rotated PDFs', () => {
 const rotatedViewport = { width: 600, height: 800, transform: [0, 1, 1, 0, 0, 0] };
 const text = api.pdfSpeechText([layout([
  item('A correctly oriented paragraph on a rotated PDF page.', { transform: [0, 12, -12, 0, 200, 100] })
 ], null, rotatedViewport)]);
 assert.match(text, /correctly oriented paragraph/);
});

test('single-page print notices are pruned from indexed and selected text', () => {
 assert.equal(api.normalizeForSpeech('A paragraph.\nEBSCO Publishing: eBook Collection printed today\nAll rights reserved. May not be reproduced.\nAnother paragraph.'), 'A paragraph. Another paragraph.');
});

function pdfMock(count = 3) {
 const requested = [];
 return {
  requested, numPages: count,
  getPage: async number => {
   requested.push(number);
   return {
    getViewport: () => viewport,
    getTextContent: async () => ({ items: [item('Body text from page ' + number + ' remains readable.')], styles: {} }),
    getStructTree: async () => null
   };
  }
 };
}

test('extracts every page independently of rendered DOM and caches successful extraction', async () => {
 const pdf = pdfMock();
 const text = await api.fetchPdfDocumentText(pdf);
 assert.match(text, /page 1/);
 assert.match(text, /page 3/);
 assert.equal(await api.fetchPdfDocumentText(pdf), text);
 assert.deepEqual(pdf.requested, [1, 2, 3]);
});

test('retries failed extraction without caching errors', async () => {
 const pdf = pdfMock(1);
 const getPage = pdf.getPage;
 pdf.getPage = async () => { throw new Error('Temporary failure'); };
 await assert.rejects(api.fetchPdfDocumentText(pdf), /Temporary failure/);
 pdf.getPage = getPage;
 assert.match(await api.fetchPdfDocumentText(pdf), /page 1/);
});

test('PDF extraction never falls back to the unfiltered full-text index', async () => {
 let fetched = false;
 const pdf = pdfMock(1);
 pdf.getPage = async () => { throw new Error('PDF failed'); };
 const frameDoc = { defaultView: { PDFViewerApplication: { pdfDocument: pdf } }, querySelectorAll: () => [] };
 const isolated = readerApi({
  document: { getElementById: () => null, querySelector: () => ({ contentDocument: frameDoc }) },
  fetch: () => { fetched = true; }
 });
 await assert.rejects(isolated.fetchDocumentText(), /PDF failed/);
 assert.equal(fetched, false);
});

test('empty or image-only PDFs report no readable text', async () => {
 const pdf = pdfMock(1);
 pdf.getPage = async () => ({ getViewport: () => viewport, getTextContent: async () => ({ items: [] }) });
 await assert.rejects(api.fetchPdfDocumentText(pdf), /No readable body text/);
});

test('reads complete columns despite interleaved PDF drawing order', () => {
 const items = [];
 for (let n = 1; n <= 5; n++) {
  items.push(item('Left row ' + n + ' ends here.', { x: 60, y: 200+n*18, width: 200 }));
  items.push(item('Right row ' + n + ' ends here.', { x: 320, y: 200+n*18, width: 210 }));
 }
 const text = speak(items);
 assert.equal(text, [1,2,3,4,5].map(n=>'Left row '+n+' ends here.').concat([1,2,3,4,5].map(n=>'Right row '+n+' ends here.')).join('\n'));
});

test('keeps a tall chapter-outline sidebar out of the adjacent article flow', () => {
 const items = [
  item('Direct Practice Pitfalls', { x: 75, y: 90, width: 280, size: 20 }),
  item('Chapter outline', { x: 395, y: 150, width: 125, size: 11 }),
  item('Overcoming common barriers', { x: 395, y: 180, width: 145, size: 11 }),
  item('Advice giving', { x: 395, y: 205, width: 80, size: 11 }),
  item('Inappropriate use of humor', { x: 395, y: 230, width: 145, size: 11 }),
  item('Interrupting the client', { x: 395, y: 255, width: 125, size: 11 }),
  item('Premature confrontation', { x: 395, y: 280, width: 135, size: 11 }),
  item('Premature problem solving', { x: 395, y: 305, width: 145, size: 11 }),
  item('Learning from mistakes', { x: 395, y: 330, width: 125, size: 11 }),
  item('Overcoming common barriers in direct practice', { x: 75, y: 345, width: 280, size: 14 }),
  item('Knowing how and when to correctly use social work interviewing', { x: 75, y: 380, width: 280 }),
  item('skills provides the foundation for the helping relationship.', { x: 75, y: 398, width: 280 }),
  item('Social workers may make mistakes even after careful preparation.', { x: 75, y: 416, width: 280 }),
  item('The negative consequences may provide examples of these pitfalls.', { x: 75, y: 434, width: 280 })
 ];
 const text = speak(items);
 const spokenLines = text.split('\n');
 const articleLines = items.filter(entry => entry.transform[4] < 395).map(entry => spokenLines.indexOf(entry.str));
 const outlineLines = items.filter(entry => entry.transform[4] >= 395).map(entry => spokenLines.indexOf(entry.str));
 assert.ok(Math.max(...articleLines) < Math.min(...outlineLines), 'article and chapter outline were interleaved:\n' + text);
});

test('orders full-width headings before columns and spanning sections between bands', () => {
 const items = [item('Article title', {x:100,y:100,width:400,size:20})];
 for (const band of [200,400]) {
  for(let n=0;n<4;n++) {
   items.push(item('Right '+band+' '+n,{x:320,y:band+n*18,width:210}));
   items.push(item('Left '+band+' '+n,{x:60,y:band+n*18,width:200}));
  }
 }
 items.push(item('Full-width section',{x:70,y:350,width:460,size:16}));
 const text=speak(items);
 assert.ok(text.indexOf('Article title')<text.indexOf('Left 200 0'));
 assert.ok(text.indexOf('Left 200 3')<text.indexOf('Right 200 0'));
 assert.ok(text.indexOf('Right 200 3')<text.indexOf('Full-width section'));
 assert.ok(text.indexOf('Full-width section')<text.indexOf('Left 400 0'));
 assert.ok(text.indexOf('Left 400 3')<text.indexOf('Right 400 0'));
});

test('joins OCR fragments sharing a printed line despite baseline/font-size jitter', () => {
 const text=speak([
  item('This is', {x:70,y:500,width:40,size:8}),
  item('one', {x:115,y:502.4,width:18,size:6}),
  item('complete line.', {x:138,y:500,width:100,size:8}),
  item('The next line stays separate.', {x:70,y:512,width:190,size:8})
 ]);
 assert.equal(text,'This is one complete line.\nThe next line stays separate.');
});

test('does not treat smaller article columns beneath a large abstract as footnotes', () => {
 const items=[];
 for(let n=0;n<6;n++) items.push(item('A large abstract has its own type size and spans the page.',{x:80,y:220+n*18,size:16,width:440}));
 for(let n=0;n<8;n++) {
  items.push(item('Complete left body line '+n+' has smaller type.',{x:60,y:490+n*18,size:n%2?8:10,width:210}));
  items.push(item('Complete right body line '+n+' also stays readable.',{x:320,y:490+n*18,size:n%2?8:10,width:210}));
 }
 const text=speak(items);
 for(let n=0;n<8;n++) {
  assert.match(text,new RegExp('Complete left body line '+n));
  assert.match(text,new RegExp('Complete right body line '+n));
 }
});

test('keeps small OCR section headings followed by body text', () => {
 const text=speak([...body(),
  item('A paragraph before the next section ends here.',{y:500,size:10}),
  item('Another section',{y:525,size:6,width:150}),
  item('The next paragraph follows this section heading.',{y:545,size:10})
 ]);
 assert.match(text,/Another section/);
});

test('skips a JSTOR metadata cover and preserves the article that follows', () => {
 const cover=layout([
  item('Author(s): Example Author',{y:150}),item('Source: Example Journal',{y:170}),
  item('Published by: Example Press',{y:190}),item('Stable URL: https://www.jstor.org/stable/123',{y:210}),
  item('Your use of the JSTOR archive indicates acceptance of the terms.',{y:400})
 ]);
 const text=api.pdfSpeechText([cover,layout(body())]);
 assert.doesNotMatch(text,/Author\(s\)|Source:|Published by:|Stable URL:|JSTOR/);
 assert.match(text,/main paragraph/);
});

test('recognizes running footers above the outer page margin', () => {
 const pages=[1,2,3].map(n=>layout([...body(),item('Journal / Volume 39, Number 3 / May 1994',{x:150,y:685,size:7,width:300})]));
 assert.doesNotMatch(api.pdfSpeechText(pages),/Volume 39/);
});

test('places a scanned drop cap at the start of its indented paragraph', () => {
 const text=speak([
  item('focus on the opening paragraph starts here.',{x:82,y:480,width:170,size:8}),
  item('and continues on this indented second line.',{x:82,y:492,width:170,size:8}),
  item('A',{x:60,y:504,width:6,size:8}),
  item('before returning to the full column width.',{x:82,y:504,width:170,size:8}),
  item('The next printed line follows as expected.',{x:60,y:516,width:195,size:8})
 ]);
 assert.match(text,/^A focus on the opening paragraph/);
 assert.doesNotMatch(text,/\nA before/);
});

for (const [input,expected] of [
 ['inter-\nviewer','interviewer'],
 ['inter-  \r\n  viewer','interviewer'],
 ['inter-\n\nviewer','interviewer'],
 ['inter\u00ad\nviewer','interviewer'],
 ['inter\u2010\nviewer','interviewer'],
 ['inter-\u00a0\nviewer','interviewer'],
 ['inter -\nviewer','interviewer'],
 ['inter\u2010\u2009\nviewer','interviewer'],
 ['inter\u00adviewer','interviewer'],
 ['inter-\fviewer','interviewer'],
 ['inter-\u2028viewer','interviewer'],
 ['inter-\u2029viewer','interviewer'],
 ['re-\na-\nlignment','realignment'],
 ['e\u0301-\nconomique','e\u0301conomique'],
 ['éco-\nnomique','économique'],
 ['well-being and client-centered care','well-being and client-centered care'],
 ['well\u2011being and client\u2010centered care','well\u2011being and client\u2010centered care'],
 ['An aside —\nfollowed by more text.','An aside — followed by more text.'],
 ['An inter- viewer.','An inter- viewer.'],
 ['An unfinished inter-','An unfinished inter-'],
 ['10-\n20 participants','10- 20 participants']
]) {
 test('normalizes wrapped word: '+JSON.stringify(input),()=>assert.equal(api.normalizeForSpeech(input),expected));
}

test('joins a hyphenated word across a column boundary before speech', () => {
 const items=[];
 for(let n=0;n<3;n++) {
  items.push(item(n===2?'inter-':'Left line '+n,{x:60,y:200+n*18,width:190}));
  items.push(item(n===0?'viewers listen.':'Right line '+n,{x:320,y:200+n*18,width:210}));
 }
 assert.match(api.normalizeForSpeech(speak(items)),/interviewers listen\./);
});

test('joins a hyphenated word across a page boundary before speech', () => {
 const text=api.pdfSpeechText([layout([item('An inter-')]),layout([item('viewer listens.')])]);
 assert.equal(api.normalizeForSpeech(text),'An interviewer listens.');
});

test('reconstructs every possible wrap position without changing surrounding prose', () => {
 for (const word of ['interviewer', 'realignment', 'économique']) {
  for (let split = 1; split < word.length; split++) {
   for (const hyphen of ['-', '\u00ad', '\u2010']) {
    for (const boundary of ['\n', '\r\n', '\n\n', '\f', '\u2028']) {
     const wrapped = word.slice(0, split) + hyphen + '\u00a0' + boundary + '  ' + word.slice(split);
     const expected = 'We discussed the ' + word + '. Well-being matters.';
     const normalized = api.normalizeForSpeech('We discussed the ' + wrapped + '. Well-being matters.');
     assert.equal(normalized, expected, JSON.stringify(wrapped));
     assert.equal(api.normalizeForSpeech(normalized), expected, 'normalizing twice must not alter the text');
    }
   }
  }
 }
});

// Model PDF text nodes and their ranges so selection and highlight extraction
// see the same physical lines as the PDF.js document extraction above.
function pdfSurface(items) {
 const page = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 }) };
 const nodes = items.map(item => ({
  nodeValue: item.str, item,
  parentElement: { closest: selector => selector === '.page' || selector.startsWith('p, div,') ? page : null }
 }));
 const doc = {
  body: {}, querySelector: () => null,
  createTreeWalker: () => {
   let index = 0;
   return { nextNode: () => nodes[index++] || null };
  },
  createRange: () => {
   let node, start = 0, end;
   const bounds = () => {
    const { item } = node;
    const unit = item.width / node.nodeValue.length;
    const left = item.transform[4] + start * unit;
    const right = item.transform[4] + end * unit;
    const bottom = 800 - item.transform[5];
    return { left, right, top: bottom - item.height, bottom, width: right - left, height: item.height };
   };
   return {
    setStart: (value, offset) => { node = value; start = offset; },
    setEnd: (value, offset) => { node = value; end = offset; },
    selectNodeContents: value => { node = value; start = 0; end = value.nodeValue.length; },
    getClientRects: () => [bounds()], getBoundingClientRect: bounds
   };
  }
 };
 const selection = { rangeCount: 1, getRangeAt: () => ({ intersectsNode: () => true }) };
 return { doc, selection };
}

test('reads a sentence-ending word with a separate PDF hyphen as one word in document, selection and highlighting', () => {
 const items = [
  item('The inter', { width: 54, hasEOL: false }),
  item('-', { x: 159, width: 6 }),
  item('viewer.', { y: 220, width: 42 })
 ];
 const { doc, selection } = pdfSurface(items);
 assert.equal(api.normalizeForSpeech(speak(items)), 'The interviewer.');
 assert.equal(api.normalizeForSpeech(api.selectionSpeechText(doc, selection)), 'The interviewer.');
 const tokens = api.surfaceTokensForDoc(doc);
 assert.equal(tokens.map(token => token.text).join(' '), 'The interviewer.');
 assert.equal(tokens[1].norm, 'interviewer');
 assert.equal(tokens[1].segments.length, 3, 'highlight covers both word fragments and the printed hyphen');
});

test('highlighting follows a word split over three lines including a single-letter fragment', () => {
 const items = [
  item('A re-', { width: 50 }),
  item('a-', { y: 220, width: 20 }),
  item('lignment.', { y: 240, width: 90 })
 ];
 const { doc, selection } = pdfSurface(items);
 assert.equal(api.normalizeForSpeech(api.selectionSpeechText(doc, selection)), 'A realignment.');
 const tokens = api.surfaceTokensForDoc(doc);
 assert.equal(tokens.map(token => token.text).join(' '), 'A realignment.');
 assert.equal(tokens[1].segments.length, 3);
});

test('retains every OCR body fragment on the six reported article pages, in column order', () => {
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/ocr-column-geometry.json','file://'+__filename)));
 for(const [index,page] of fixture.entries()) {
  const text=api.pdfSpeechText([layout(page.items,null,page.viewport)]);
  const words=text.match(/token[a-z]+end/g)||[];
  assert.equal(words.length,page.items.length,'missing or duplicated text on article page '+(index+1));
  for(const item of page.items) assert.equal(words.filter(w=>w===item.str).length,1,item.str);
  // On the first article page, the title and abstract span both columns.
  const columnItems=page.items.filter(i=>index>0 || page.viewport.height-i.transform[5]>475);
  const leftWords=columnItems.filter(i=>i.transform[4]<260).map(i=>text.indexOf(i.str));
  const rightWords=columnItems.filter(i=>i.transform[4]>=260).map(i=>text.indexOf(i.str));
  assert.ok(Math.max(...leftWords)<Math.min(...rightWords),'column jump on article page '+(index+1));
 }
});
