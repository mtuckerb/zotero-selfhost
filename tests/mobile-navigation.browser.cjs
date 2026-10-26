// WEB_LIBRARY_SOURCE=/path/to/prepared/web-library node tests/mobile-navigation.browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const source = process.env.WEB_LIBRARY_SOURCE;
assert(source, 'Set WEB_LIBRARY_SOURCE to the prepared upstream source with its testing bundle');
const engine = process.env.ZOTERO_TEST_ENGINE || 'chromium';
const browserType = require(path.join(source, 'node_modules/playwright'))[engine];
const rust = fs.readFileSync(path.join(__dirname, '../../zotero-rs/src/handlers/pages.rs'), 'utf8');
const rail = rust.slice(rust.indexOf('fn inject_navrail('), rust.indexOf('/// Inject site branding'));
const literal = name => JSON.parse(rail.match(new RegExp(`const ${name}: &str = ("(?:[^"\\\\]|\\\\[\\s\\S])*");`))[1].replace(/\\\r?\n[ \t]*/g, ''));

(async () => {
  const { getServer, closeServer } = await import(pathToFileURL(path.join(source, 'test/utils/fixed-state-server.js')));
  const browser = await browserType.launch({ executablePath: process.env.ZOTERO_TEST_BROWSER, headless: true, args: engine === 'chromium' ? ['--no-sandbox'] : [] });
  const state = JSON.parse(fs.readFileSync(path.join(source, 'test/fixtures/state/mobile-test-user-library-view.json')));
  const library = state.libraries.u1;
  for (const key of Object.keys(library.itemsByCollection)) {
    const keys = Object.values(library.items).filter(item => item.collections?.includes(key)).map(item => item.key);
    library.itemsByCollection[key] = { ...library.itemsTop, keys, totalResults: keys.length, pointer: keys.length };
  }
  library.itemsByCollection.HNLXYCXS = { ...library.itemsByCollection.HNLXYCXS, keys: [], totalResults: 0, pointer: 0 };
  const server = await getServer(Buffer.from(JSON.stringify(state)), 0);
  const origin = `http://localhost:${server.address().port}`;
  try {
    for (const width of [320, 390, 820, 1200]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 1000, isMobile: width < 1000, locale: 'en-US' });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack));
      await page.addInitScript(() => localStorage.setItem('zr-rail-collapsed', '1'));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [], headers: { 'Total-Results': '0', 'Last-Modified-Version': '1000000' } });
        if (request.resourceType() === 'document') {
          const response = await route.fetch();
          const html = (await response.text()).replace('</head>', literal('STYLE') + '</head>').replace('</body>', literal('SCRIPT') + '</body>');
          return route.fulfill({ response, body: html });
        }
        return route.continue();
      });
      await page.goto(origin + '/testuser/item-list');
      await page.locator('.view-item-list-active').waitFor();
      await page.locator('#zr-rail-toggle').click();
      if (width >= 768) {
        assert.equal(await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width > 100), true);
        await page.locator('#zr-rail-toggle').click();
        assert.equal(await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width), 0);
      } else {
        await page.getByRole('treeitem', { name: 'My Library', exact: true }).waitFor({ state: 'visible', timeout: 2500 });
        assert.equal(await page.evaluate(() => location.pathname), '/', 'Handle opens the native mobile navigator');
        await page.getByRole('treeitem', { name: 'My Library', exact: true }).tap();
        await page.getByRole('treeitem', { name: 'AI', exact: true }).tap();
        await page.locator('.view-item-list-active').waitFor({ timeout: 2500 });
        assert.match(new URL(page.url()).pathname, /collections\/I6WUED2Y\/item-list$/);
        await page.getByRole('navigation', { name: 'Main' }).getByText('AI', { exact: true }).waitFor({ state: 'visible' });
        await page.goBack();
        const dogs = page.getByRole('treeitem', { name: 'Dogs', exact: true });
        await dogs.tap();
        await page.locator('.view-item-list-active').waitFor({ timeout: 2500 });
        await page.goBack();
        const subfolders = page.getByRole('button', { name: 'Browse subcollections of Dogs', exact: true });
        if (width === 390) { await subfolders.focus(); await page.keyboard.press('Enter'); }
        else await subfolders.tap();
        await page.getByRole('treeitem', { name: 'Border Collie', exact: true }).waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
          const el = document.querySelector('[data-collection-key="HNLXYCXS"]');
          const box = el.getBoundingClientRect();
          return Math.abs(box.x) < 0.01 && box.right <= innerWidth + 0.01;
        });
        assert.equal(await page.locator('.site-wrapper').evaluate(el => el.scrollLeft), 0, 'Navigation must stay inside the phone viewport after focus changes');
        assert.equal(await page.locator('.collection-tree .items-node').filter({ hasText: /^Items$/ }).count(), 0);
        if (process.env.ZOTERO_TEST_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ZOTERO_TEST_SCREENSHOTS, `navigation-${width}.png`) });
        await page.getByRole('treeitem', { name: 'Border Collie', exact: true }).tap();
        await page.locator('.view-item-list-active').waitFor({ timeout: 2500 });
        assert.match(new URL(page.url()).pathname, /collections\/HNLXYCXS\/item-list$/);
        await page.locator('.item-list-empty').waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS navigation at ${width}px`);
    }
  } finally {
    await browser.close();
    await closeServer(server);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
