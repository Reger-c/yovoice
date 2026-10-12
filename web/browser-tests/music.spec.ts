import { test, expect } from '@playwright/test';
import { emptyState } from '../src/shared/workbench';
import { createMusicDraft } from '../src/features/music/music-draft';

test('新建音乐作品：示例、风格标签、段落标记、纯音乐与参数持久化', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByTestId('nav-new').click();
  await page.getByRole('menuitem', { name: '音乐生成', exact: true }).click();
  const style = page.getByLabel('风格', { exact: true });
  await expect(style).toHaveValue('');
  await page.getByRole('button', { name: '填入示例', exact: true }).click();
  await expect(style).toHaveValue(/city pop/);
  await expect(page.getByRole('button', { name: '填入示例', exact: true })).toHaveCount(0);

  // 标签与风格描述双向同步。
  const tags = page.getByRole('group', { name: '风格标签' });
  await expect(tags.getByRole('button', { name: 'city pop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(tags.getByRole('button', { name: 'piano', exact: true })).toHaveCount(0);
  await tags.getByRole('button', { name: '全部标签', exact: true }).click();
  await tags.getByRole('button', { name: 'piano', exact: true }).click();
  await expect(style).toHaveValue(/, piano$/);
  await tags.getByRole('button', { name: 'city pop', exact: true }).click();
  await expect(style).not.toHaveValue(/city pop/);

  const lyrics = page.getByLabel('歌词', { exact: true });
  await lyrics.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.getByRole('button', { name: '插入段落' }).click();
  await page.getByRole('menuitem', { name: '[bridge]', exact: true }).click();
  await expect(lyrics).toHaveValue(/一直等\n\n\[bridge\]\n$/);

  // 音乐作品使用独立检查器：只列音乐模型，时长与语言写入作品。
  const model = page.getByRole('combobox', { name: '模型' });
  await expect(model).toContainText('ACE-Step 1.5 Turbo');
  await page.getByRole('radio', { name: '02:00' }).click();
  await page.getByRole('combobox', { name: '演唱语言' }).click();
  await page.getByRole('option', { name: '粤语' }).click();
  await page.getByRole('radio', { name: '纯音乐' }).click();
  await expect(lyrics).toHaveCount(0);
  await expect(page.getByText('纯音乐不演唱歌词')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('music.png') });

  await expect(page.locator('.saved')).toContainText('已保存');
  await page.reload();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('voice-workbench-v1')!).drafts.find((d: { kind?: string }) => d.kind === 'music'));
  expect(saved).toMatchObject({ kind: 'music', modelId: 'ace-step-1.5-turbo-bf16', instrumental: true, synthesisLanguage: 'yue', modelOptions: { ace_step: { duration_seconds: 120 } } });
  expect(saved.lyrics).toContain('[bridge]');
  await expect(page.getByRole('radio', { name: '纯音乐' })).toBeChecked();

  // 未安装模型时生成会打开模型设置；配音作品的模型列表不包含音乐模型。
  await page.getByRole('button', { name: '生成歌曲', exact: true }).click();
  await expect(page.getByRole('tab', { name: '模型', selected: true })).toBeVisible();
  await page.getByTestId('nav-music').click();
  await expect(page.locator('.project-library-row:visible .record-cover')).toHaveCount(1);
  await page.getByTestId('nav-new').click();
  await page.getByRole('menuitem', { name: '语音生成', exact: true }).click();
  await page.getByRole('combobox', { name: '模型' }).click();
  await expect(page.getByRole('option', { name: /ACE-Step/ })).toHaveCount(0);
});


test('选中 YuE2：隐藏时长与纯音乐，长度由歌词决定', async ({ page }, testInfo) => {
  const draft = { ...createMusicDraft('zh-CN'), id: 'd'.repeat(32), modelId: 'ace-step-1.5-turbo-q8', instrumental: true };
  const state = emptyState();
  state.drafts = [draft];
  state.models = [
    { id: 'ace-step-1.5-turbo-q8', path: 'ace-step-1.5-turbo-q8_0.gguf', managed: true },
    { id: 'yue2-3b-q8', path: 'Yue2-3B-GGUF', managed: true },
  ];
  await page.addInitScript(value => { if (!localStorage.getItem('voice-workbench-v1')) localStorage.setItem('voice-workbench-v1', value); }, JSON.stringify(state));
  await page.goto('/');
  await expect(page.getByRole('radio', { name: '纯音乐' })).toBeChecked();
  await page.getByRole('combobox', { name: '模型' }).click();
  await page.getByRole('option', { name: /YuE2 3B · Q8/ }).click();
  // 切到 YuE2 自动回到演唱模式，并去掉 ACE-Step 专属参数。
  await expect(page.getByRole('radio', { name: '纯音乐' })).toHaveCount(0);
  await expect(page.getByLabel('歌词', { exact: true })).toBeVisible();
  await expect(page.getByText('YuE2 只生成带人声的歌曲')).toBeVisible();
  await expect(page.getByText('歌曲长度由歌词决定')).toBeVisible();
  await expect(page.getByRole('radio', { name: '02:00' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '演唱语言' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('music-yue2.png') });
});
