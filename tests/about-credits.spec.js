const { test, expect } = require('@playwright/test');

async function openAbout(page, app = 'index.html') {
  await page.goto(`/${app}`);
  await page.waitForFunction(() => window.MemoShell && window.MemoAbout, null, { timeout: 15000 });
  await page.click('#hamburgerBtn');
  await page.click('#aboutBtn');
  const about = page.locator('#aboutDlg');
  await expect(about).toHaveAttribute('open', '');
  return about;
}

test.describe('About', () => {
  for (const app of ['index.html', 'finance.html', 'planner.html']) {
    test(`${app}: opens from the menu, closes the drawer and shows the version`, async ({ page }) => {
      const about = await openAbout(page, app);
      await expect(page.locator('#mobileMenu')).toHaveAttribute('aria-hidden', 'true');
      await expect(about.locator('.about-version')).toHaveText(/^Memora · v\d+\.\d+\.\d+$/);
      // Google Play asks for the privacy policy in the app as well as on the listing.
      await expect(about.locator('#aboutPolicyLink')).toHaveAttribute('href', 'https://rustcoleone.github.io/privacy/memora/');
      await expect(about.locator('#aboutPolicyLink')).toHaveText('Read the full privacy policy');
      await page.click('#aboutCloseBtn');
      await expect(about).not.toHaveAttribute('open', '');
    });
  }

  test('credits the developers and loads the AI-Chan portraits on first open', async ({ page }) => {
    await page.goto('/index.html');
    await page.waitForFunction(() => window.MemoAbout);
    // Not fetched at startup.
    expect(await page.locator('#aboutDlg .credits-gallery img[src]').count()).toBe(0);
    const about = await openAbout(page);
    const credits = about.locator('.about-credits');
    await expect(credits.locator('li')).toHaveText([
      'Haoxian Yan — UCLA alum', 'Mingrui Liu — UCLA alum', 'Qishen Liang — USC alum', 'Hanlin Ouyang — MSU alum', 'Guanyu Qian — UCLA Ph.D. student',
      'Taihao Zhong (钟太豪) — speedcuber',
    ]);
    await expect(credits.locator('li a[href="https://rustcoleone.github.io/"]')).toHaveText('Haoxian Yan');
    await expect(credits.locator('li a[href="https://qgy511.github.io/"]')).toHaveText('Guanyu Qian');
    await expect(credits).toContainText('Honorable Mention');
    await expect(credits.locator('.about-honor')).toHaveText('Prof. Xiaofan Cui · UCLA Power Electronics and Energy Control (PEEC) Lab');
    await expect(credits.locator('.about-honor a')).toHaveAttribute('href', 'https://samueli.ucla.edu/people/xiaofan-cui/');
    await expect(credits).toContainText('Deepseek-Chan, GPT-Chan, and Claude-Chan');
    const portraits = credits.locator('.credits-gallery img');
    await expect(portraits).toHaveCount(3);
    for (const img of await portraits.all()) {
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate(el => el.complete && el.naturalWidth)).toBe(512);
    }
    await expect(credits.locator('.artwork-credit')).toContainText('ZipZipPipe');
    await expect(credits.locator('.artwork-credit a[href*="by-nc-sa/4.0"]')).toHaveCount(1);
  });

  test('the Android app keeps the thanks as text, without the non-commercial pictures', async ({ page }) => {
    const asked = [];
    page.on('request', (r) => { if (r.url().includes('credits-images')) asked.push(r.url()); });
    await page.addInitScript(() => { window.Capacitor = Object.assign(window.Capacitor || {}, { getPlatform: () => 'android' }); });
    const about = await openAbout(page);
    const credits = about.locator('.about-credits');
    await expect(credits).toContainText('Deepseek-Chan, GPT-Chan, and Claude-Chan');
    await expect(credits.locator('.credits-gallery')).toHaveCount(0);
    await expect(credits.locator('.artwork-credit')).toHaveCount(0);
    expect(asked).toEqual([]);
    await expect(about.locator('#aboutSourceLink')).toHaveAttribute('href', 'https://github.com/RustColeone/memora');
  });

  test.describe('in Chinese', () => {
    test.use({ locale: 'zh-CN' });
    test('the About sheet is localized', async ({ page }) => {
      const about = await openAbout(page);
      await expect(about.locator('header strong')).toHaveText('关于 Memora');
      await expect(about.locator('#aboutPolicyLink')).toHaveText('阅读完整隐私政策');
      await expect(about).toContainText('Qishen Liang — USC 校友');
      await expect(about).toContainText('Hanlin Ouyang — MSU 校友');
      await expect(about).toContainText('特别鸣谢');
      await expect(about).toContainText('Guanyu Qian — UCLA 博士生');
      await expect(about).toContainText('Taihao Zhong (钟太豪) — 魔方速拧选手');
      await expect(about).toContainText('荣誉致谢');
      await expect(about.locator('.about-honor')).toHaveText('Prof. Xiaofan Cui · UCLA 电力电子与能源控制（PEEC）实验室');
      await expect(about).toContainText('AI 联系人获准读取的记录');   // the AI disclosure is current
    });
  });
});
