// Exercise the packaged PDF.js reader and real DOM ranges in Firefox.
// ZOTERO_TEST_READER_ROOT=... ZOTERO_TEST_TTS_SCRIPT=... \
// PLAYWRIGHT_MODULE=... FIREFOX_BINARY=... node --test tests/reader-tts.browser.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function wrappedPDF() {
 const pages = [
  [[72, 700, 'The inter'], [142, 700, '-'], [72, 680, 'viewer values well-being.'],
   [72, 660, 'They requested a re-'], [72, 640, 'a-'], [72, 620, 'lignment.'],
   [72, 600, 'The final word is inter-']],
  [[72, 700, 'viewer.'], [72, 680, 'The rest remains readable.']]
 ];
 const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
 for (const lines of pages) {
  const stream = lines.map(([x, y, text]) => `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
  const content = objects.length + 2;
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${content} 0 R >>`,
   `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
 }
 objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
 let pdf = '%PDF-1.4\n';
 const offsets = [];
 objects.forEach((object, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
 });
 const xref = pdf.length;
 pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  + offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  + `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
 return [...Buffer.from(pdf)];
}

let browser, page, frame;
const errors = [];
before(async () => {
 assert.ok(process.env.ZOTERO_TEST_READER_ROOT, 'Set ZOTERO_TEST_READER_ROOT to a built reader directory');
 const source = readFileSync(process.env.ZOTERO_TEST_TTS_SCRIPT || path.join(__dirname, '../assets/reader-tts/reader-tts.js'), 'utf8');
 const script = source.replace('// ------------------------------------------------------------ entry point',
  'globalThis.tts = { fetchPdfDocumentText, normalizeForSpeech, selectionSpeechText, surfaceTokensForDoc, usableSurfaceRectsForToken }; return;');
 browser = await firefox.launch({ headless: true, executablePath: process.env.FIREFOX_BINARY });
 page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
 page.on('pageerror', error => errors.push(error.message));
 await page.route('http://reader.test/**', route => route.fulfill({
  path: path.join(process.env.ZOTERO_TEST_READER_ROOT, new URL(route.request().url()).pathname)
 }));
 await page.goto('http://reader.test/reader.html');
 await page.evaluate(async buf => {
  const noop = () => {};
  window.createReader({ type: 'pdf', data: { buf: new Uint8Array(buf) }, annotations: [],
   readOnly: true, sidebarOpen: false, onChangeViewState: noop, onSaveAnnotations: noop,
   onDeleteAnnotations: noop, onToggleSidebar: noop, onChangeSidebarWidth: noop, onChangeSidebarView: noop });
  await window._reader._primaryView.initializedPromise;
  await PDFViewerApplication.pdfViewer.pagesPromise;
 }, wrappedPDF());
 frame = page.frames().find(frame => frame.url().includes('/pdf/web/viewer.html'));
 await frame.waitForSelector('.page[data-page-number="1"] .textLayer span');
 await page.addScriptTag({ content: script });
 await frame.addScriptTag({ content: script });
}, { timeout: 30000 });
after(async () => { await browser?.close(); });

test('real PDF extraction joins words across lines and pages before speech', async () => {
 const text = await page.evaluate(async () => tts.normalizeForSpeech(await tts.fetchPdfDocumentText(PDFViewerApplication.pdfDocument)));
 assert.equal(text, 'The interviewer values well-being. They requested a realignment. The final word is interviewer. The rest remains readable.');
});

test('real PDF selection and highlight ranges follow the repaired words', async () => {
 const result = await frame.evaluate(() => {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector('.page[data-page-number="1"] .textLayer'));
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const text = tts.normalizeForSpeech(tts.selectionSpeechText(document, selection));
  const tokens = tts.surfaceTokensForDoc(document);
  const joined = ['interviewer', 'realignment'].map(word => {
   const token = tokens.find(token => token.norm === word);
   return token && { word: token.norm, rects: tts.usableSurfaceRectsForToken(token).length };
  });
  return { text, joined };
 });
 assert.equal(result.text, 'The interviewer values well-being. They requested a realignment. The final word is inter-');
 assert.equal(result.joined[0]?.word, 'interviewer');
 assert.equal(result.joined[1]?.word, 'realignment');
 assert.ok(result.joined.every(token => token.rects >= 3), 'each repaired word highlights all three printed fragments');
 assert.deepEqual(errors, []);
});
