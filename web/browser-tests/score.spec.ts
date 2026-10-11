import { test, expect } from '@playwright/test';
import { emptyState } from '../src/shared/workbench';
import { createScoreDraft, exampleScore, scoreDuration } from '../src/features/score/score-draft';
import { midiToScore, scoreToMidi } from '../src/features/score/score-midi';

test('新建编曲作品：示例乐谱、音块总览、声部调整与持久化', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByTestId('nav-new').click();
  await page.getByRole('menuitem', { name: '编曲', exact: true }).click();
  await expect(page.getByText('按小节和拍写下每个声部的音符')).toBeVisible();
  await expect(page.getByRole('button', { name: '渲染配乐', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '填入示例', exact: true }).click();

  await expect(page.locator('.score-summary')).toHaveText('D 小调 · 100 BPM · 4/4 · 22 小节 · 00:54');
  await expect(page.getByRole('group', { name: /7 个声部/ })).toBeVisible();
  const sections = page.getByRole('list', { name: '段落' });
  await expect(sections.getByRole('listitem')).toHaveCount(3);
  await expect(sections.getByRole('listitem').last()).toContainText('88 BPM');

  // 轨道视图：鼓组不显示音色，角色决定默认电平，关闭发声后写入 mute。
  const rows = page.locator('.score-track');
  await expect(rows).toHaveCount(7);
  await expect(rows.last()).toContainText('鼓组');
  await expect(page.getByLabel('铺底 的目标电平')).toHaveValue('-29');
  await page.getByLabel('铺底 的目标电平').fill('-26');
  await page.getByRole('switch', { name: '琶音 发声' }).click();
  // 角色收在色点菜单里：切换后行颜色随之变化。
  await page.getByRole('button', { name: '琶音 的角色' }).click();
  await page.getByRole('menuitem', { name: '钢琴' }).click();
  await expect(rows.nth(5)).toHaveAttribute('data-role', 'piano');
  await page.getByRole('button', { name: '琶音 的角色' }).click();
  await page.getByRole('menuitem', { name: '琶音' }).click();
  // 宽屏下右侧面板可收起，收起后主操作移到标题栏，并跨刷新保留。
  await page.getByRole('button', { name: '收起右侧面板' }).click();
  await expect(page.locator('.score-inspector')).toBeHidden();
  await expect(page.getByRole('button', { name: '渲染配乐', exact: true })).toBeVisible();
  await expect(page.locator('.saved')).toContainText('已保存');
  await page.reload();
  await expect(page.locator('.score-inspector')).toBeHidden();
  await page.getByRole('button', { name: '展开右侧面板' }).click();
  await expect(page.locator('.score-inspector')).toBeVisible();
  await expect(page.getByRole('button', { name: '渲染配乐', exact: true })).toHaveCount(1);
  await page.getByRole('spinbutton', { name: '速度（BPM）' }).fill('120');
  await expect(page.locator('.score-summary')).toContainText('120 BPM');
  await page.screenshot({ path: testInfo.outputPath('score.png') });
  // 轨道区在底部全宽面板里，与播放器同宽、贯穿检查器下方；轨头单行固定在左侧，22 小节乐谱默认即可横向滚动。
  const box = (selector: string) => page.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) }; });
  const [arrangement, player, inspector] = [await box('.score-arrangement'), await box('.player'), await box('.inspector')];
  expect(Math.abs(arrangement.right - player.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(arrangement.left - player.left)).toBeLessThanOrEqual(1);
  expect(arrangement.right).toBeGreaterThan(inspector.left + 100);
  expect(arrangement.top).toBeLessThan(player.top);
  const scroll = page.locator('.score-scroll');
  const headWidth = await rows.first().locator('.score-track-head').evaluate(el => el.clientWidth);
  const headHeight = await rows.first().locator('.score-track-head').evaluate(el => el.clientHeight);
  expect(headWidth).toBeLessThanOrEqual(240);
  expect(headHeight).toBeLessThanOrEqual(42);
  await expect.poll(() => scroll.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await scroll.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })); });
  await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await page.getByRole('group', { name: '缩放' }).first().getByRole('button', { name: '放大' }).click();
  await expect.poll(() => scroll.evaluate(el => el.scrollWidth > el.clientWidth * 1.5)).toBe(true);
  await scroll.evaluate(el => { el.scrollLeft = 200; });
  await expect.poll(() => rows.first().locator('.score-track-head').evaluate(el => Math.round(el.getBoundingClientRect().left - el.closest('.score-scroll')!.getBoundingClientRect().left))).toBe(0);

  await expect(page.locator('.saved')).toContainText('已保存');
  await page.reload();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('voice-workbench-v1')!).drafts.find((d: { kind?: string }) => d.kind === 'score'));
  expect(saved).toMatchObject({ kind: 'score', modelId: 'musescore-general-sf2', score: { tempo: 120 } });
  expect(saved.score.tracks.find((t: { id: string }) => t.id === 'pad').level).toBe(-26);
  expect(saved.score.tracks.find((t: { id: string }) => t.id === 'arp').mute).toBe(true);

  // 未安装音色库时渲染会打开独立的音色库页；配音作品的模型列表不包含音色库。
  await page.getByRole('button', { name: '渲染配乐', exact: true }).click();
  await expect(page.getByRole('tab', { name: '音色库', selected: true })).toBeVisible();
  await expect(page.locator('[data-model-id="musescore-general-sf2"]')).toContainText('General MIDI 音色库');
  await page.getByTestId('nav-score').click();
  await expect(page.locator('.project-library-row:visible')).toHaveCount(1);
  await page.getByTestId('nav-new').click();
  await page.getByRole('menuitem', { name: '语音生成', exact: true }).click();
  await page.getByRole('combobox', { name: '模型' }).click();
  await expect(page.getByRole('option', { name: /MuseScore/ })).toHaveCount(0);
});

test('编曲导入 MIDI 后替换乐谱，导出 MIDI 可还原音符', async ({ page }) => {
  const state = emptyState();
  state.drafts = [{ ...createScoreDraft('zh-CN', false), id: 'b'.repeat(32) }];
  await page.addInitScript(value => { if (!localStorage.getItem('voice-workbench-v1')) localStorage.setItem('voice-workbench-v1', value); }, JSON.stringify(state));
  await page.goto('/');
  const source = exampleScore('en');
  await page.locator('input[type=file][accept=".mid,.midi,.json"]').setInputFiles({ name: 'demo.mid', mimeType: 'audio/midi', buffer: Buffer.from(scoreToMidi(source)) });
  await expect(page.locator('.score-track')).toHaveCount(7);
  await expect(page.locator('.score-track').first()).toContainText('Pad');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('menuitem', { name: 'MIDI 文件（.mid）' }).click();
  const file = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of file) chunks.push(chunk as Buffer);
  const back = midiToScore(new Uint8Array(Buffer.concat(chunks)), n => `Track ${n}`);
  expect(back.tracks.map(t => t.notes.length)).toEqual(source.tracks.map(t => t.notes.length));
  expect(back.tracks[6].drums).toBe(true);

  // 损坏的文件给出可读的错误，不替换当前乐谱。
  await page.locator('input[type=file][accept=".mid,.midi,.json"]').setInputFiles({ name: 'broken.mid', mimeType: 'audio/midi', buffer: Buffer.from('MThd broken') });
  await expect(page.getByText('无法读取这个 MIDI 文件')).toBeVisible();
  await expect(page.locator('.score-track')).toHaveCount(7);
});

test('乐谱时长按段落变速累加', () => {
  const score = exampleScore('zh-CN');
  // 1–18 小节 100 BPM（43.2 秒），19–22 小节 88 BPM（约 10.9 秒）。
  expect(scoreDuration(score)).toBeCloseTo(18 * 4 * 0.6 + 4 * 4 * 60 / 88, 6);
});
