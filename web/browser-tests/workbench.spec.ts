import { openProjectHistory } from './project-actions';
import { seedState } from './seed';
import { emptyState } from '../src/shared/workbench';
import { test, expect } from '@playwright/test';


test('四种表达方式、草稿持久化与模型协议', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByLabel('作品名称')).toHaveValue('清晨旁白');
  await page.getByRole('radio', { name: '跟随音色', exact: true }).click();
  await expect(page.getByRole('radio', { name: '跟随音色', exact: true })).toBeChecked();
  await expect(page.getByText('沿用参考音色中的自然表达。')).toHaveCount(0);
  await page.getByRole('radio', { name: '参考演绎', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加演绎参考' })).toBeVisible();
  await page.getByRole('radio', { name: '情绪调节', exact: true }).click();
  await expect(page.getByRole('group', { name: '情绪预设', exact: true }).getByRole('button')).toHaveCount(3);
  const more = page.getByRole('button', { name: '更多情绪', exact: true });
  const tuning = page.getByRole('button', { name: '微调情绪', exact: true });
  await more.hover();
  await expect(more).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(more).toHaveCSS('background-image', 'none');
  const moreBox = await more.boundingBox();
  const tuningBox = await tuning.boundingBox();
  expect(moreBox!.x).toBe(tuningBox!.x);
  expect(moreBox!.height).toBe(tuningBox!.height);
  expect((await more.locator('svg').boundingBox())!.x).toBe((await tuning.locator('svg').boundingBox())!.x);
  await page.getByRole('button', { name: '更多情绪', exact: true }).click();
  await page.getByText('微调情绪', { exact: true }).click();
  await expect(page.getByRole('slider', { name: '高兴', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '惊喜', exact: true }).click();
  await expect(page.getByRole('button', { name: '惊喜', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('slider', { name: '高兴', exact: true })).toHaveAttribute('aria-valuenow', '0.4');
  await page.getByRole('slider', { name: '高兴', exact: true }).press('ArrowRight');
  await expect(page.getByRole('button', { name: '惊喜', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '悲伤', exact: true }).click();
  await expect(page.getByRole('slider', { name: '悲伤', exact: true })).toHaveAttribute('aria-valuenow', '0.5');
  await page.getByRole('button', { name: '收起情绪', exact: true }).click();
  await expect(page.getByRole('button', { name: '悲伤', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '更多情绪', exact: true }).click();
  await expect(page.getByRole('button', { name: '悲伤', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page.getByRole('slider', { name: '惊讶', exact: true })).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('radio', { name: '文字指导', exact: true }).click();
  await page.getByLabel('作品名称').fill('测试旁白');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByLabel('作品名称')).toHaveValue('测试旁白');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await expect(page.getByRole('button', { name: '下载模型', exact: true })).toHaveCount(33);
  await page.getByRole('button', { name: 'IndexTTS 协议' }).click();
  await expect(page.getByRole('heading', { name: '模型使用协议' })).toBeVisible();
  await page.getByRole('button', { name: '关闭协议' }).click();
  expect(errors).toEqual([]);
});

test('真实 WAV 导入、播放、裁剪和空状态', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '添加参考音频', exact: true }).click();
  const wav = Buffer.alloc(44 + 16000 * 2 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 32000; i++) wav.writeInt16LE(Math.round(Math.sin(i * 440 * Math.PI * 2 / 16000) * 8000), 44 + i * 2);
  await page.locator('input[type=file][accept^="audio/"]').setInputFiles({ name: '测试音色.wav', mimeType: 'audio/wav', buffer: wav });
  await page.getByRole('button', { name: '使用所选参考音频', exact: true }).click();
  await expect(page.getByRole('button', { name: '测试音色', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '试听当前音色' }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const progress = page.getByRole('slider', { name: '播放进度' });
  await expect(progress).toBeVisible();
  const lane = page.locator('.timeline-lane');
  const originalWidth = await page.locator('.waveform').evaluate(el => el.getBoundingClientRect().width);
  await page.getByRole('button', { name: '放大音轨', exact: true }).click();
  await expect(page.getByRole('button', { name: '适应完整音轨' })).toHaveText('200%');
  expect(await page.locator('.waveform').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(originalWidth * 1.9);
  await lane.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  expect(await lane.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await progress.fill('1.5');
  await expect.poll(() => page.locator('footer audio').evaluate((el: HTMLAudioElement) => el.currentTime)).toBeCloseTo(1.5, 1);
  await page.getByRole('button', { name: '适应完整音轨' }).click();
  await expect(page.getByRole('button', { name: '缩小音轨' })).toBeDisabled();
  expect(await lane.evaluate(el => el.scrollLeft)).toBe(0);
  await progress.fill('1');
  await expect.poll(() => page.locator('footer audio').evaluate((el: HTMLAudioElement) => el.currentTime)).toBeCloseTo(1, 1);
  await page.getByRole('button', { name: '回到开头' }).click();
  await expect(progress).toHaveValue('0');
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await expect.poll(() => page.locator('footer audio').evaluate((el: HTMLAudioElement) => el.volume)).toBe(0);
  await page.getByRole('button', { name: '取消静音' }).click();
  await page.getByRole('button', { name: '测试音色', exact: true }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: '试听测试音色', exact: true }).click({ trial: true });
  const list = picker.locator('.voice-list');
  // 弹窗打开时有缩放动画，等动画结束再记录尺寸，否则 macOS CI 上会量到动画中途的大小。
  await picker.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)));
  const listBox = await list.boundingBox();
  const dialogBox = await picker.boundingBox();
  const firstRow = picker.locator('.voice-row').filter({ has: page.getByRole('button', { name: '测试音色', exact: true }) });
  const audition = firstRow.getByRole('button', { name: '试听测试音色', exact: true });
  await audition.click();
  await expect(firstRow.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect(picker.locator('.library-preview')).toHaveCount(0);
  expect(await list.boundingBox()).toEqual(listBox);
  expect(await picker.boundingBox()).toEqual(dialogBox);
  const audio = firstRow.locator('audio');
  await firstRow.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(audition).toBeVisible();
  await audio.evaluate((element: HTMLAudioElement) => { element.currentTime = 0.7; });
  await audition.click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime >= 0.7)).toBeTruthy();
  await audio.evaluate((element: HTMLAudioElement) => { element.currentTime = element.duration; });
  await expect(audition).toBeVisible();
  await page.getByRole('button', { name: '裁剪', exact: true }).click();
  await page.getByRole('button', { name: '另存为新音色' }).click();
  const secondRow = picker.locator('.voice-row').filter({ has: page.getByRole('button', { name: '测试音色 · 裁剪', exact: true }) });
  await audition.click();
  await expect(firstRow.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await secondRow.getByRole('button', { name: '试听测试音色 · 裁剪', exact: true }).click();
  await expect(secondRow.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect(audition).toBeVisible();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBeTruthy();
  const playingAudio = await secondRow.locator('audio').elementHandle();
  await page.getByRole('button', { name: '使用所选参考音频', exact: true }).click();
  await expect(page.getByRole('button', { name: '测试音色 · 裁剪', exact: true })).toBeVisible();
  expect(await playingAudio!.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await page.getByRole('button', { name: '声音库', exact: true }).click();
  await page.getByRole('tab', { name: '参考音频', exact: true }).click();
  await expect(page.locator('footer.player')).toBeHidden();
  await page.getByRole('button', { name: '添加参考音频', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '添加参考音频' })).toBeVisible();
  await expect(page.getByRole('dialog').locator('.voice-list')).toHaveCount(0);
  await page.locator('input[type=file][accept^="audio/"]').setInputFiles({ name: '新增音色.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '新增音色', exact: true })).toBeVisible();
  await page.locator('.recent-projects .project-link').first().click();
  await expect(page.getByRole('button', { name: '测试音色 · 裁剪', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '声音库', exact: true }).click();
  await page.getByRole('tab', { name: '参考音频', exact: true }).click();

  const entry = page.locator('.library-entry').filter({ has: page.getByRole('heading', { name: '测试音色', exact: true }) });
  await entry.click({ position: { x: 150, y: 20 } });
  const controls = page.locator('.library-entry').filter({ has: page.getByRole('heading', { name: '测试音色', exact: true }) }).locator('.avatar-player');
  const preview = controls.locator('audio');
  await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => !audio.paused && audio.currentTime > 0)).toBeTruthy();
  await expect(controls).toHaveAttribute('data-playing', 'true');
  await expect(controls.locator('img')).toHaveCSS('width', '48px');
  await expect(controls.locator('img')).toHaveCSS('animation-name', 'none');
  await entry.click({ position: { x: 150, y: 20 } });
  await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.paused)).toBeTruthy();
  await expect(controls).toHaveAttribute('data-playing', 'false');
  await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(0);
  const cardBox = (await entry.boundingBox())!;
  const avatarBox = (await controls.boundingBox())!;
  expect(Math.abs(avatarBox.y + avatarBox.height / 2 - cardBox.y - cardBox.height / 2)).toBeLessThan(1);
  await preview.evaluate((audio: HTMLAudioElement) => { audio.currentTime = 1; });
  const play = controls.getByRole('button', { name: '试听测试音色', exact: true });
  await play.focus();
  await expect(play).toBeFocused();
  await play.press('Enter');
  await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => !audio.paused && audio.currentTime < 1)).toBeTruthy();
  await preview.evaluate((audio: HTMLAudioElement) => { audio.currentTime = audio.duration; });
  await expect(controls).toHaveAttribute('data-playing', 'false');
  await play.click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluateAll(elements => elements.every(el => (el as HTMLAudioElement).paused))).toBeTruthy();
  await page.getByTestId('nav-story').click();
  await expect(page.locator('footer.player')).toBeHidden();
  await page.locator('.recent-projects .project-link').first().click();
  await expect(page.locator('footer.player')).toBeVisible();
  await expect.poll(() => page.locator('footer audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBeTruthy();
});


test('选中文字显示发音浮层，键盘与鼠标交互应用后只修改选区', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: '正文', exact: true });
  const action = page.getByRole('button', { name: '调整发音', exact: true });
  await expect(action).toHaveCount(0);
  await expect(page.getByRole('button', { name: '段间停顿', exact: true })).toHaveCount(0);
  await editor.fill('银行需要核对资料。');
  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  await editor.press('Shift+ArrowRight'); await editor.press('Shift+ArrowRight');
  await expect(action).toBeVisible();
  // 验证键盘 Tab 聚焦与 Enter 触发
  await editor.press('Tab');
  await expect(action).toBeFocused();
  await action.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('银行');
  await page.getByPlaceholder('例如 HANG2').fill('YIN2 HANG2');
  await page.getByRole('button', { name: '应用发音' }).click();
  await expect(editor).toHaveValue('<银行|YIN2 HANG2>需要核对资料。');
  await expect(action).toHaveCount(0);
  // 关闭对话框后重新聚焦，验证鼠标点击选区与浮层交互
  await editor.focus();
  await expect(async () => {
    await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0)); await editor.press('Shift+ArrowRight');
    await expect(action).toBeVisible({ timeout: 1000 });
  }).toPass();
  await action.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await editor.press('ArrowRight'); await expect(action).toHaveCount(0);
  await editor.press('Shift+ArrowLeft'); await expect(action).toBeVisible();
  await editor.press('Escape'); await expect(action).toHaveCount(0);
  await page.locator('.advanced summary').click();
  await expect(page.getByRole('spinbutton', { name: '段间停顿（毫秒）' })).toBeVisible();
});



test('版本切换仅试听，不改正文参数且不再显示版本操作菜单', async ({ page }) => {
  const state = emptyState();
  const draft = state.drafts[0];
  state.history = [
    { id: 'new', title: draft.title, fileName: 'history.wav', createdAt: '2026-09-15T10:00:00Z', duration: 1, settings: { ...draft, mode: 'text', speed: 1.2, text: '新版正文' } },
    { id: 'old', title: draft.title, fileName: 'history.wav', createdAt: '2026-09-15T09:00:00Z', duration: 1, settings: { ...draft, modelId: 'index-2-q8', mode: 'speaker', speed: 0.8, text: '旧版正文' } },
    { id: 'other', title: '其他作品', fileName: 'history.wav', createdAt: '2026-09-15T08:00:00Z', duration: 1, settings: { ...draft, id: 'other' } },
  ];
  await page.goto('/');
  await page.evaluate(async () => {
    const bytes = new Uint8Array(32044); const view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
    text(0, 'RIFF'); view.setUint32(4, 32036, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, 32000, true);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('voice-workbench-audio', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('audio');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result; const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(new Blob([bytes], { type: 'audio/wav' }), 'history.wav'); tx.oncomplete = () => { db.close(); resolve(); }; };
    });
  });
  await seedState(page, state); await page.reload();
  const selector = page.getByRole('combobox', { name: '当前作品历史' });
  await expect(selector).toContainText('版本 2');
  await expect(page.locator('.player-history').getByRole('combobox', { name: '当前作品历史' })).toBeVisible();
  await expect(page.locator('.transport').getByRole('combobox', { name: '当前作品历史' })).toHaveCount(0);
  await expect(page.locator('.player .waveform')).toBeVisible();
  await expect.poll(() => page.locator('.player').evaluate(panel => {
    const control = panel.querySelector('[role="combobox"]')!.getBoundingClientRect();
    const wave = panel.querySelector('.waveform')!.getBoundingClientRect();
    return Math.abs(control.y + control.height / 2 - wave.y - wave.height / 2);
  })).toBeLessThan(1);
  await selector.click();
  await expect(page.getByRole('option')).toHaveCount(2);
  // 历史选择器优先向下展开，底部空间不足时避让，保持菜单在视口内。
  await expect.poll(async () => {
    const menu = await page.locator('.astryx-selector-popup:visible').boundingBox();
    const trigger = await selector.boundingBox();
    return !!menu && !!trigger && (menu.y >= trigger.y + trigger.height || menu.y + menu.height <= trigger.y)
      && menu.y >= 0 && menu.y + menu.height <= page.viewportSize()!.height;
  }).toBe(true);
  await page.getByRole('option', { name: /版本 1/ }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue(draft.text);
  await expect(page.getByRole('button', { name: '版本操作', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存为角色', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: '文字指导', exact: true })).toBeChecked();
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toContainText('IndexTTS 2.5');
  await expect.poll(() => page.locator('footer audio').evaluate((audio: HTMLAudioElement) => audio.duration)).toBe(1);
  await selector.click(); await page.getByRole('option', { name: /版本 2/ }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue(draft.text);
  await expect(page.getByRole('radio', { name: '文字指导', exact: true })).toBeChecked();
  await page.locator('.recent-projects .project-link').first().click();
  await openProjectHistory(page);
  await page.getByRole('button', { name: `删除音频${draft.title}`, exact: true }).first().click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.history-item')).toHaveCount(2);
  await page.getByRole('button', { name: `试听${draft.title}`, exact: true }).first().click();
  await page.getByRole('button', { name: `删除音频${draft.title}`, exact: true }).first().click();
  await page.getByRole('button', { name: '删除音频', exact: true }).click();
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.locator('.history-item audio')).toHaveCount(0);
  await page.locator('.recent-projects .project-link').first().click();
  await expect(selector).toContainText('版本 1');
  await page.reload();
  await expect(selector).toContainText('版本 1');
  await page.getByTestId('nav-new').click();
  await page.getByRole('menuitem', { name: '语音生成', exact: true }).click();
  await expect(selector).toHaveCount(0);
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
});




test('OmniVoice 和 Qwen3-TTS 使用各自的声音控件', async ({ page }) => {
  await page.goto('/');
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  await model.click();
  await page.getByRole('option', { name: /OmniVoice · Q8/ }).click();
  await expect(page.getByRole('radio', { name: '声音设计', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '添加参考音频', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '性别', exact: true }).click();
  const genderTrigger = await page.getByRole('combobox', { name: '性别', exact: true }).boundingBox();
  const genderMenu = await page.getByRole('listbox').boundingBox();
  expect(genderMenu!.y).toBeGreaterThanOrEqual(genderTrigger!.y + genderTrigger!.height);
  await page.getByRole('option', { name: '女', exact: true }).click();
  await page.locator('summary').filter({ hasText: '非语言声音' }).click();
  const tags = page.getByRole('combobox', { name: '非语言声音', exact: true });
  await tags.click();
  const tagTrigger = await tags.boundingBox();
  const tagMenu = await page.getByRole('listbox').boundingBox();
  expect(tagMenu!.y >= tagTrigger!.y + tagTrigger!.height || tagMenu!.y + tagMenu!.height <= tagTrigger!.y).toBe(true);
  await page.getByRole('option', { name: '[laughter]', exact: true }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue(/\[laughter\]$/);
  await page.getByRole('radio', { name: '音色克隆', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加参考音频', exact: true })).toBeVisible();
  await page.getByLabel('参考音频原文').fill('你好。');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: '音色克隆', exact: true })).toBeChecked();
  await expect(page.getByLabel('参考音频原文')).toHaveValue('你好。');
  await model.click();
  await page.getByRole('option', { name: /Qwen3-TTS 1.7B Base · Q8/ }).click();
  await expect(page.getByRole('button', { name: '添加参考音频', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: '声音设计', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: '情绪调节', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('参考音频原文（可选）')).toHaveValue('你好。');
});

test('Breeze TTS 2 在设计与克隆间切换描述用途，并以短分段为默认', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  await page.getByRole('option', { name: /Breeze TTS 2 · Q8/ }).click();
  await expect(page.getByRole('radio', { name: '声音设计', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '添加参考音频', exact: true })).toHaveCount(0);
  await page.getByLabel('声音描述', { exact: true }).fill('温暖的女声，语速平稳');
  await page.getByRole('radio', { name: '音色克隆', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加参考音频', exact: true })).toBeVisible();
  await expect(page.getByLabel('参考音频原文', { exact: true })).toBeVisible();
  await expect(page.getByLabel('风格指导（可选）', { exact: true })).toHaveValue('温暖的女声，语速平稳');
  await page.locator('summary').filter({ hasText: '高级设置' }).click();
  await expect(page.getByLabel('长文分段字数（0 为模型默认）')).toHaveValue('160');
  await expect(page.getByLabel('细节解码温度')).toHaveValue('0.9');
});



test('作品音频读不到时播放器直接显示不可用，不主动弹出提示', async ({ page }) => {
  const state = emptyState();
  const draft = state.drafts[0];
  state.history = [{ id: 'broken', title: draft.title, fileName: 'broken.wav', createdAt: '2026-09-15T10:00:00Z', duration: 1, settings: { ...draft } }];
  await page.goto('/');
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('voice-workbench-audio', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('audio');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result; const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(new Blob([new Uint8Array(64)], { type: 'audio/wav' }), 'broken.wav'); tx.oncomplete = () => { db.close(); resolve(); }; };
    });
  });
  await seedState(page, state); await page.reload();
  await expect(page.getByRole('combobox', { name: '当前作品历史' })).toContainText('版本 1');
  await expect(page.locator('.player .waveform-unavailable')).toHaveText('音频文件不存在或无法读取');
  await expect(page.locator('.player').getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('窄屏下展开检查器：保持宽屏时的固定宽度，不覆盖全屏且不隐藏正文，无返回正文按钮', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 720 });
  await page.goto('/');
  await expect(page.getByLabel('作品名称')).toHaveValue('清晨旁白');
  const inspector = page.locator('.inspector');
  const document = page.locator('.document');
  const toggleBtn = page.locator('.browser-titlebar').getByRole('button', { name: /右侧面板/ });
  await expect(toggleBtn).toBeVisible();

  // 点击展开检查器
  await toggleBtn.click();
  await expect(page.locator('.studio')).toHaveClass(/show-inspector/);
  await expect(inspector).toBeVisible();
  // 正文仍然可见，没有被全屏覆盖
  await expect(document).toBeVisible();
  // 检查器中没有“返回正文”按钮
  await expect(inspector.getByRole('button', { name: '返回正文' })).toHaveCount(0);

  // 检查 inspector 宽度等于宽屏时的宽度（约 352px），而不是 100% 全屏
  const box = await inspector.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThan(400);
  expect(box!.width).toBeGreaterThan(300);
});
