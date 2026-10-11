import { test, expect } from '@playwright/test';

test('AI 服务：未配置时引导到设置，左侧选服务、右侧直接编辑，切换和删除', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByTestId('nav-new').click();
  await page.getByRole('menuitem', { name: '编曲', exact: true }).click();
  const notConfigured = page.locator('.ai-composer');
  await expect(notConfigured).toContainText('接入大模型后，可以用一句话让 AI 写出完整编曲');
  await notConfigured.getByRole('button', { name: '设置 AI', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'AI 服务', selected: true })).toBeVisible();
  const panel = page.getByRole('tabpanel', { name: 'AI 服务' });

  // 固定地址的服务只显示地址和协议；密钥保存后只显示掩码，不回填。
  await panel.getByRole('button', { name: 'DeepSeek', exact: true }).click();
  await expect(panel.getByText('https://api.deepseek.com', { exact: true })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: '服务地址' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '从 DeepSeek 获取 API 密钥' })).toBeVisible();
  await panel.getByLabel('API 密钥').fill('sk-preview-key');
  await panel.getByRole('textbox', { name: '当前模型' }).fill('deepseek-chat');
  await panel.getByRole('button', { name: '添加服务', exact: true }).click();
  await expect(panel.locator('.ai-detail').getByText('使用中', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('API 密钥')).toHaveText('••••••••');
  await expect(panel.getByRole('button', { name: '保存更改', exact: true })).toBeDisabled();

  // 本地服务可改地址；新添加的服务不会抢走当前服务。
  await panel.getByRole('button', { name: 'Ollama', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '服务地址' })).toHaveValue('http://127.0.0.1:11434/v1');
  await panel.getByRole('textbox', { name: '当前模型' }).fill('qwen3');
  await panel.getByRole('button', { name: '添加服务', exact: true }).click();
  await expect(panel.getByRole('switch', { name: '用于 AI 功能' })).not.toBeChecked();
  await panel.getByRole('switch', { name: '用于 AI 功能' }).click();
  await expect(panel.getByRole('switch', { name: '用于 AI 功能' })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('ai-settings.png') });

  // 更换密钥：输入框为空，不回填旧密钥。
  await panel.getByRole('button', { name: 'DeepSeek', exact: true }).click();
  await panel.getByRole('button', { name: '更换密钥', exact: true }).click();
  await expect(panel.getByLabel('API 密钥')).toHaveValue('');
  const saved = await page.evaluate(() => localStorage.getItem('voice-workbench-v1')!);
  expect(saved).not.toContain('sk-preview-key');

  await panel.getByRole('button', { name: 'Ollama', exact: true }).click();
  await panel.getByRole('button', { name: '删除服务', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Ollama', exact: true })).toBeVisible();
  await expect(panel.getByText('已添加')).toBeVisible();
  await panel.getByRole('button', { name: 'DeepSeek', exact: true }).click();
  await expect(panel.locator('.ai-detail').getByText('使用中', { exact: true })).toBeVisible();
});

test('AI 写歌词：在后台运行，结束后在写作栏显示结果或失败原因', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByTestId('nav-settings').click();
  await page.getByRole('tab', { name: 'AI 服务' }).click();
  await page.getByRole('button', { name: 'Ollama', exact: true }).click();
  await page.getByRole('textbox', { name: '当前模型' }).fill('qwen3');
  await page.getByRole('button', { name: '添加服务', exact: true }).click();
  await expect(page.locator('.ai-detail').getByText('使用中', { exact: true })).toBeVisible();

  await page.getByTestId('nav-new').click();
  await page.getByRole('menuitem', { name: '音乐生成', exact: true }).click();
  const composer = page.locator('.ai-composer');
  await expect(composer).toContainText('使用 Ollama · qwen3');
  await expect(composer.getByRole('button', { name: '写歌', exact: true })).toBeDisabled();
  await composer.getByRole('textbox', { name: '描述想要的歌' }).fill('夏夜海边兜风');
  await composer.getByRole('button', { name: '写歌', exact: true }).click();
  // 运行中显示模型、用时与后台提示；预览后端随后以“仅桌面可用”结束。
  await expect(composer.locator('.ai-composer-body')).toContainText('qwen3 正在写');
  await expect(composer).toContainText('夏夜海边兜风');
  await page.screenshot({ path: testInfo.outputPath('ai-running.png') });
  await expect(composer.getByRole('alert')).toContainText('AI 写歌词没有成功');
  await page.screenshot({ path: testInfo.outputPath('ai-failed.png') });
  await expect(composer.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await composer.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(composer.getByRole('textbox', { name: '描述想要的歌' })).toHaveValue('夏夜海边兜风');
});
