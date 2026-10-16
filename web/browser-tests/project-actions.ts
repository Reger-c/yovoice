import type { Page } from '@playwright/test';

// 语音作品没有列表页，从工作区播放器旁的“版本记录”进入历史版本。
export async function openProjectHistory(page: Page) {
  await page.getByRole('button', { name: '版本记录', exact: true }).click();
}
