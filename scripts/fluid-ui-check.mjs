// Run against the isolated QA server only. Set LOCAL_GENI_PLAYWRIGHT_MODULE to an
// existing Playwright installation when it is not on the normal module path.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.LOCAL_GENI_PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:4011';
const browser = await chromium.launch({ headless: true });
const errors = [], checks = [];
let page;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  let failResults = false, failPreview = false, failNotes = false, failListSave = true, savedList;
  const notes = [], listRequests = [];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (request.method() === 'POST' && url.pathname === '/api/lists') {
      const body = request.postDataJSON(); listRequests.push(body);
      if (failListSave) return route.fulfill({ status: 503, json: { error: 'Could not save the list.' } });
      savedList = { ...body, id: 'ui-shortlist', version: 1, archivedAt: null };
      return route.fulfill({ json: savedList });
    }
    if (savedList && url.pathname === '/api/lists/ui-shortlist') return route.fulfill({ json: { list: savedList, total: 1, rows: [{ place_id: 'qa-northstar', name: 'Northstar Security / QA simulator', category: 'Security company', emails: [] }] } });
    if (savedList && url.pathname === '/api/lists') return route.fulfill({ json: { rows: [{ ...savedList, count: 1 }] } });
    if (request.method() === 'PATCH' && url.pathname.startsWith('/api/leads/')) {
      const body = request.postDataJSON(); assert.deepEqual(Object.keys(body), ['notes']);
      if (failNotes) return route.fulfill({ status: 503, json: { error: 'Notes unavailable.' } });
      notes.push(body.notes);
      return route.fulfill({ json: { notes: body.notes } });
    }
    if (failResults && url.pathname === '/api/leads' && Number(url.searchParams.get('limit')) > 5) return route.fulfill({ status: 503, json: { error: 'Test unavailable' } });
    if (failPreview && url.pathname === '/api/area/resolve') return route.fulfill({ status: 503, json: { error: 'Location lookup unavailable.' } });
    if (request.method() !== 'GET') return route.abort();
    return route.continue();
  });
  await page.goto(`${base}/#leads`);
  await page.getByRole('button', { name: 'View details for Northstar Security / QA simulator', exact: true }).first().waitFor();
  await check('pointer-down feedback precedes click and cancels after 10px movement', async () => {
    const box = await page.getByRole('button', { name: 'Your account', exact: true }).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    assert.equal(await page.locator('.account-shortcut').getAttribute('data-pressing'), 'true');
    await page.mouse.move(box.x - 15, box.y); assert.equal(await page.locator('.account-shortcut').getAttribute('data-pressing'), null); await page.mouse.up();
  });
  await check('menu can reverse while closing and can reopen after fully unmounting', async () => {
    const box = await page.getByRole('button', { name: 'Your account', exact: true }).boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.click(x, y); await wait(45); await page.mouse.click(x, y); await wait(35); await page.mouse.click(x, y);
    await wait(600); assert.equal(await page.locator('.account-shortcut').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.account-menu').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.keyboard.press('Escape'); await wait(600); assert.equal(await page.locator('.account-menu').count(), 0);
    await page.mouse.click(x, y); await wait(600); assert.equal(await page.locator('.account-menu').evaluate(el => getComputedStyle(el).opacity), '1'); await page.keyboard.press('Escape'); await wait(600);
  });
  await check('workspace search reverses, traps focus, and restores its trigger', async () => {
    await page.getByRole('button', { name: 'Search businesses and pages', exact: true }).click();
    assert.equal(await page.locator('.shell').evaluate(el => el.inert), true);
    await page.keyboard.press('Control+k'); await wait(35); await page.keyboard.press('Control+k'); await wait(600);
    assert.equal(await page.locator('.workspace-search-dialog').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('combobox', { name: 'Search businesses and pages', exact: true }).getAttribute('aria-activedescendant'), 'search-result-1');
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.locator('.workspace-search-dialog').evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape'); await page.locator('.workspace-search-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.shell').evaluate(el => el.inert), false);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Search businesses and pages');
  });
  await check('Ask Geni opens and closes without submitting any content', async () => {
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Ask Geni', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.ask-geni-panel')?.open && getComputedStyle(document.querySelector('.ask-geni-panel')).opacity === '1');
      await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.ask-geni-panel')?.open);
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Ask Geni');
    }
  });
  const openLead = async () => { await page.getByRole('button', { name: 'View details for Northstar Security / QA simulator', exact: true }).first().click(); await page.waitForFunction(() => document.querySelector('.drawer')?.dataset.motionState === 'open'); };
  const position = () => page.locator('.drawer').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41);
  const grip = async () => { const box = await page.locator('.drawer-grab').boundingBox(); return { x: box.x + 70, y: box.y + box.height / 2 }; };
  await openLead();
  await check('handle tracks 1:1, preserves grab offset, and rubber-bands at the open edge', async () => {
    const p = await grip(); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 140, p.y, { steps: 10 });
    assert.ok(Math.abs(await position() - 140) < 1); await page.mouse.move(p.x - 80, p.y, { steps: 10 });
    const x = await position(); assert.ok(x < 0 && x > -64); await wait(100); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.drawer')?.dataset.motionState === 'open'); assert.equal(await position(), 0);
  });
  await check('a closing panel can be grabbed and reversed without jumping', async () => {
    await page.getByRole('button', { name: 'Close lead details', exact: true }).click(); await wait(40);
    const bounds = await page.locator('.drawer-grab').boundingBox();
    const p = { x: Math.min(1425, bounds.x + bounds.width * .65), y: bounds.y + bounds.height / 2 };
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    assert.equal(await page.locator('.drawer').getAttribute('data-motion-state'), 'grabbed'); const grabbed = await position();
    await wait(50); assert.equal(await position(), grabbed);
    await page.mouse.move(p.x - Math.max(grabbed, 30), p.y, { steps: 8 }); await wait(100); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.drawer')?.dataset.motionState === 'open');
  });
  await check('pointer cancellation returns safely; keyboard focus stays in the panel', async () => {
    assert.equal(await page.locator('.workspace').evaluate(el => el.inert), true);
    const p = await grip(); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 100, p.y);
    await page.locator('.drawer-grab').dispatchEvent('pointercancel', { pointerId: 1, isPrimary: true }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.drawer')?.dataset.motionState === 'open');
    await page.locator('.drawer').focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await page.locator('.drawer').evaluate(el => el.contains(document.activeElement)), true);
  });
  await check('release momentum dismisses a panel before the distance midpoint', async () => {
    const p = await grip(); await page.mouse.move(p.x, p.y); await page.mouse.down();
    await page.mouse.move(p.x + 90, p.y); await wait(25); await page.mouse.move(p.x + 220, p.y); await page.mouse.up();
    await page.locator('.drawer').waitFor({ state: 'detached' });
  });
  await check('notes flush when closing before the autosave debounce', async () => {
    await openLead(); const field = page.locator('.drawer-relationship textarea');
    await field.fill('Fictional fluid-interface autosave test.'); await page.keyboard.press('Escape');
    await page.locator('.drawer').waitFor({ state: 'detached' }); assert.deepEqual(notes, ['Fictional fluid-interface autosave test.']);
    assert.equal(await page.locator('.workspace').evaluate(el => el.inert), false);
    assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /View details for Northstar/);
  });
  await check('failed notes stay editable and can be retried without reopening', async () => {
    await openLead(); failNotes = true;
    await page.getByRole('textbox', { name: 'Notes about this business', exact: true }).fill('Fictional retry draft.');
    await page.getByRole('button', { name: 'Retry saving notes', exact: true }).waitFor(); failNotes = false;
    await page.getByRole('button', { name: 'Retry saving notes', exact: true }).click();
    await page.locator('.drawer-relationship [role="status"]').filter({ hasText: /^Saved$/ }).waitFor();
    assert.equal(notes.at(-1), 'Fictional retry draft.');
    await page.keyboard.press('Escape'); await page.locator('.drawer').waitFor({ state: 'detached' });
  });
  await check('shortlisting previews names, allows removal, and retries the exact save safely', async () => {
    await page.getByRole('checkbox', { name: 'Select Northstar Security / QA simulator', exact: true }).check();
    assert.equal(await page.getByRole('checkbox', { name: 'Select all leads on this page' }).evaluate(el => el.indeterminate), true);
    await page.getByRole('checkbox', { name: 'Select Maple Dental / QA simulator', exact: true }).check();
    await page.getByRole('button', { name: 'Save as list', exact: true }).click();
    await page.getByRole('heading', { name: 'Lists & segments', exact: true }).waitFor();
    await page.locator('.shortlist-review').getByText('Northstar Security / QA simulator', { exact: true }).waitFor();
    await page.locator('.shortlist-review').getByText('Maple Dental / QA simulator', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove Maple Dental / QA simulator', exact: true }).click();
    await page.locator('.shortlist-review').getByText('Northstar Security / QA simulator', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Fictional prospect shortlist');
    await page.getByRole('button', { name: 'Save list', exact: true }).click();
    await page.getByText('Could not save the list.', { exact: true }).waitFor(); failListSave = false;
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Fictional prospect shortlist');
    await page.getByRole('button', { name: 'Save list', exact: true }).click();
    await page.getByRole('heading', { name: 'Fictional prospect shortlist', exact: true }).waitFor();
    assert.equal(listRequests.length, 2); assert.deepEqual(listRequests[0], listRequests[1]);
    assert.deepEqual(savedList.memberIds, ['qa-northstar']);
  });
  await check('a failed lead request offers retry, preserves selection, and recovers', async () => {
    failResults = true; await page.getByRole('button', { name: 'Leads', exact: true }).click();
    await page.getByText('We couldn’t load your businesses').waitFor(); failResults = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'View details for Northstar Security / QA simulator', exact: true }).first().waitFor();
    assert.equal(await page.getByRole('checkbox', { name: 'Select Northstar Security / QA simulator', exact: true }).isChecked(), true);
  });
  await check('reduced motion removes automatic travel and closes immediately', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await openLead(); assert.equal(await position(), 0);
    await page.keyboard.press('Escape'); await wait(30); assert.equal(await page.locator('.drawer').count(), 0);
    await page.getByRole('button', { name: 'Your account', exact: true }).click(); assert.equal(await page.locator('.account-menu').evaluate(el => getComputedStyle(el).transform), 'none');
    await page.keyboard.press('Escape'); await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await check('preview failures remain visible beside the recovery action', async () => {
    await page.getByRole('button', { name: 'Find businesses', exact: true }).click();
    await page.getByRole('textbox', { name: 'City or neighbourhood', exact: true }).fill('Lahore'); failPreview = true;
    await page.getByRole('button', { name: 'Preview area', exact: true }).click(); await page.locator('.search-error').waitFor();
    assert.match(await page.locator('.search-error').textContent(), /settings are unchanged/);
  });
  await check('the city input has a visible boundary and readable text', async () => {
    const contrast = await page.getByRole('textbox', { name: 'City or neighbourhood', exact: true }).evaluate(el => {
      const style = getComputedStyle(el);
      const luminance = rgb => rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126,.7152,.0722][i], 0);
      return { border: 1.05 / (luminance(style.borderColor) + .05), text: 1.05 / (luminance(style.color) + .05) };
    });
    assert.ok(contrast.border >= 3); assert.ok(contrast.text >= 4.5);
  });
  await check('mobile navigation reverses and returns focus, with no horizontal page overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await wait(100);
    await page.keyboard.press('Escape'); await wait(700);
    assert.equal(await page.locator('#app-sidebar').evaluate(el => getComputedStyle(el).visibility), 'hidden');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await wait(650);
    assert.equal(await page.locator('#app-sidebar').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41), 0);
    await page.keyboard.press('Escape');
  });
  await check('touch layouts provide larger controls and keep the lead panel in the viewport', async () => {
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await touch.newPage(); mobile.on('pageerror', error => errors.push(error.message));
    await mobile.route('**/*', route => new URL(route.request().url()).origin === base && route.request().method() === 'GET' ? route.continue() : route.abort());
    await mobile.goto(`${base}/#leads`);
    await mobile.getByRole('button', { name: 'View details for Northstar Security / QA simulator', exact: true }).first().click();
    await mobile.waitForFunction(() => document.querySelector('.drawer')?.dataset.motionState === 'open');
    assert.equal(await mobile.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    assert.ok((await mobile.locator('.drawer-grab').boundingBox()).height >= 44);
    assert.ok((await mobile.getByRole('button', { name: 'Close lead details', exact: true }).boundingBox()).height >= 44);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await touch.close();
  });
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: checks.length, pageErrors: errors.length, externalRequestsAllowed: false }));
} finally { await browser.close(); }
