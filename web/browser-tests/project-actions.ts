import type { Page } from '@playwright/test';

// 语音作品没有列表页，从播放器版本下拉末尾的“版本记录”进入历史版本。
export async function openProjectHistory(page: Page) {
  await page.getByRole('combobox', { name: '当前作品历史', exact: true }).click();
  await page.getByRole('option', { name: '版本记录', exact: true }).click();
}

// “保存为角色”在右侧面板的角色选择里，保存的是面板当前的声音设置。
export async function saveAsCharacter(page: Page) {
  await page.getByRole('combobox', { name: '选择角色', exact: true }).click();
  await page.getByRole('option', { name: '保存为角色', exact: true }).click();
}
