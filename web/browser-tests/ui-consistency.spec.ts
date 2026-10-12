import { test, expect } from '@playwright/test';
import { createDraft, emptyState, synthesisSettings } from '../src/shared/workbench';

test('三类删除统一危险样式，等待期间不能关闭，失败后可就地重试', async ({ page }, testInfo) => {
  const state = emptyState();
  state.drafts.push({ ...createDraft(), title: '待删除作品' });
  state.voices = [{ id: 'voice', name: '测试音色', fileName: 'voice.wav', duration: 3 }];
  state.characters = [{ id: 'character', name: '测试角色', settings: synthesisSettings(state.drafts[0]), demoText: '' }];
  await page.addInitScript(state => {
    let receive: (event: { data: unknown }) => void;
    let pending: string | undefined;
    Object.assign(window, {
      finishDelete: (success: boolean) => {
        receive({ data: { id: pending, ...(success ? { result: true } : { error: { code: '@yovoice.error.unknown' } }) } });
        pending = undefined;
      },
      chrome: { webview: {
        addEventListener: (_name: string, listener: typeof receive) => { receive = listener; },
        postMessage: (message: { id: string; method: string }) => {
          if (['draft.delete', 'media.delete', 'character.delete'].includes(message.method)) { pending = message.id; return; }
          queueMicrotask(() => receive({ data: { id: message.id, result: message.method === 'state.get' ? { state, catalog: [], desktop: true } : true } }));
        },
      } },
    });
  }, state);
  await page.goto('/');
  for (const [section, trigger, action] of [
    ['projects', '删除作品：待删除作品', '删除作品'],
    ['voices', '删除声音测试音色', '删除声音'],
    ['characters', '删除角色', '删除角色'],
  ]) {
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.getByTestId(`nav-${section === 'voices' ? 'characters' : section === 'projects' ? 'text' : section}`).click();
    if (section === 'voices') await page.getByRole('tab', { name: '参考音频', exact: true }).click();
    if (section === 'projects') {
      await page.locator('.project-library-row').filter({ hasText: '待删除作品' }).getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    } else await page.getByRole('button', { name: trigger, exact: true }).last().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toBeFocused();
    await expect(dialog).toHaveAccessibleName(await dialog.getByRole('heading').innerText());
    const confirm = dialog.getByRole('button', { name: action, exact: true });
    const cancel = dialog.getByRole('button', { name: '取消', exact: true });
    await expect(confirm).toHaveAttribute('data-variant', 'destructive');
    await page.setViewportSize({ width: 360, height: 640 });
    await expect(confirm).toBeInViewport();
    await expect(cancel).toBeInViewport();
    await confirm.click();
    await expect(confirm).toBeDisabled();
    await expect(cancel).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.evaluate(() => (window as unknown as { finishDelete: (success: boolean) => void }).finishDelete(false));
    await expect(dialog.getByRole('alert')).toHaveText('出了点问题，请重试。');
    await expect(confirm).toBeEnabled();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${section}-delete.png`) });
    await confirm.click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { finishDelete: (success: boolean) => void }).finishDelete(true));
    await expect(dialog).toHaveCount(0);
  }
});

test('高级设置跨模型保持展开，随机种子保留零值和自动状态', async ({ page }) => {
  await page.goto('/');
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  await page.getByText('高级设置', { exact: true }).click();
  const seed = page.getByRole('spinbutton', { name: '随机种子', exact: true });
  await seed.fill('0');
  for (const name of [/VoxCPM2 · Q8/, /OmniVoice · Q8/, /Kokoro-82M 1.0 Official · Q8/]) {
    await model.click();
    await page.getByRole('option', { name }).click();
    await expect(seed).toBeVisible();
    await expect(seed).toHaveValue('0');
  }
  await seed.fill('');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('voice-workbench-v1')!).drafts[0].seed)).toBeNull();
  await page.reload();
  await page.getByText('高级设置', { exact: true }).click();
  await expect(seed).toHaveValue('');
});

test('参考音频展开裁剪后确认按钮不被长内容裁切', async ({ page }) => {
  const state = emptyState();
  state.voices = Array.from({ length: 12 }, (_, i) => ({ id: `voice-${i}`, name: `参考 ${i}`, fileName: `${i}.wav`, duration: 3 }));
  await page.addInitScript(state => localStorage.setItem('voice-workbench-v1', JSON.stringify(state)), state);
  await page.goto('/');
  await page.getByRole('button', { name: '添加参考音频', exact: true }).click();
  await page.getByRole('button', { name: '裁剪', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: '使用所选参考音频', exact: true });
  for (const height of [920, 640]) {
    await page.setViewportSize({ width: 1280, height });
    await expect(confirm).toBeInViewport({ ratio: 1 });
    const bounds = await dialog.boundingBox();
    const button = await confirm.boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  }
});

test('页面标题和第二行控件与侧栏中心对齐', async ({ page }) => {
  await page.goto('/');
  const center = async (locator: import('@playwright/test').Locator) => {
    const box = (await locator.boundingBox())!;
    return box.y + box.height / 2;
  };
  for (const [nav, title, control] of [
    ['nav-story', '故事配音', '进行中'],
    ['nav-text', '语音生成', '进行中'],
    ['nav-characters', '声音库', '角色'],
    ['nav-settings', '设置', '常规'],
  ]) {
    await page.getByTestId(nav).click();
    expect(Math.abs(await center(page.getByRole('heading', { name: title, exact: true })) - await center(page.getByTestId('nav-new')))).toBeLessThan(1);
    if (['nav-story', 'nav-text'].includes(nav)) {
      await expect(page.getByRole('combobox', { name: control, exact: true })).toHaveCount(0);
      if (nav === 'nav-text') expect(Math.abs(await center(page.getByRole('textbox', { name: '搜索作品', exact: true })) - await center(page.getByTestId('nav-story')))).toBeLessThan(1);
      continue;
    }
    const second = page.getByRole('tab', { name: control, exact: true });
    expect(Math.abs(await center(second) - await center(page.getByTestId('nav-story')))).toBeLessThan(1);
  }
});

test('弹窗关闭按钮与标题中线对齐', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '添加参考音频', exact: true }).click();
  const header = page.getByRole('dialog').locator('.app-dialog-header');
  for (const width of [1280, 600]) {
    await page.setViewportSize({ width, height: 820 });
    await expect.poll(() => header.evaluate(element => {
      const title = element.querySelector('h2')!.getBoundingClientRect();
      const close = element.querySelector('button')!.getBoundingClientRect();
      return Math.abs(title.y + title.height / 2 - close.y - close.height / 2);
    })).toBeLessThan(1);
  }
});

test('桌面端内容卡片横向中线对齐且不超出视口底部', async ({ page }) => {
  const state = emptyState();
  state.drafts.push(createDraft());
  await page.addInitScript(state => {
    let receive: (event: { data: unknown }) => void;
    Object.assign(window, {
      chrome: { webview: {
        addEventListener: (_name: string, listener: typeof receive) => { receive = listener; },
        postMessage: (message: { id: string; method: string }) => {
          queueMicrotask(() => receive({ data: { id: message.id, result: message.method === 'state.get' ? { state, catalog: [], desktop: true } : true } }));
        },
      } },
    });
  }, state);
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto('/');
  await expect(page.locator('.workbench.desktop')).toBeVisible();
  const sheet = page.locator('.app-sheet');
  await expect(sheet).toBeVisible();
  const center = async (locator: import('@playwright/test').Locator) => {
    const box = (await locator.boundingBox())!;
    return box.y + box.height / 2;
  };
  const title = page.locator('.document-title');
  await expect(title).toBeVisible();
  const navNew = page.getByTestId('nav-new');
  expect(Math.abs(await center(title) - await center(navNew))).toBeLessThan(1);
  const generateBtn = page.locator('.generation-action button').first();
  await expect(generateBtn).toBeVisible();
  expect(Math.abs(await center(generateBtn) - await center(navNew))).toBeLessThan(1);
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(840);
});

