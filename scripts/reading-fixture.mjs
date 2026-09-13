// Synthetic reading content belongs to test setup, never to the application.
export async function openReadingFixture(page) {
  await page.evaluate(async () => {
    await (await import('/src/storage.ts')).replaceBooks([{
      id: 'test:reading', name: '阅读验证.md',
      content: '# 阅读验证\n\n' + Array.from({ length: 80 }, (_, i) =>
        `第 ${i + 1} 段。这是用于检查终端排版、滚动和颜色的测试文字。`).join('\n\n'),
    }]);
  });
  await page.reload({ waitUntil: 'networkidle' });
  const input = page.getByRole('combobox', { name: '命令' });
  await input.fill('/books');
  await input.press('Enter');
  await page.locator('.book-item').first().click();
  await page.locator('h2').filter({ hasText: /^阅读验证$/ }).waitFor();
}
