export function isEditing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');
}

export function shortcutFor(event: KeyboardEvent): string {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return '';
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.key.length === 1 ? event.key.toUpperCase() : event.key].filter(Boolean).join('+');
}
export function validBossKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^F(?:2|4|5|7|8|9|11|12)$/.test(value)) return true;
  if (!/^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?[A-Z0-9]$/.test(value) || !/Ctrl\+|Alt\+|Meta\+/.test(value)) return false;
  return !['Ctrl+A','Ctrl+B','Ctrl+C','Ctrl+L','Ctrl+P','Ctrl+R','Ctrl+U','Ctrl+W','Ctrl+E','Ctrl+D','Ctrl+F','Ctrl+G','Ctrl+J','Ctrl+K','Ctrl+M','Ctrl+N','Ctrl+O','Ctrl+V','Ctrl+X','Ctrl+Z','Ctrl+Shift+A','Ctrl+Shift+B','Ctrl+Shift+F','Ctrl+Shift+G','Ctrl+Shift+O','Ctrl+Shift+P','Ctrl+Shift+R','Alt+G'].includes(value);
}

export function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert]') && element.getClientRects().length > 0);
}

export function cycleFocus(root: HTMLElement, backward = false) {
  const items = focusable(root);
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = current < 0 ? (backward ? items.length - 1 : 0) : (current + (backward ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
}

export function cycleRegions(root: HTMLElement, backward = false) {
  const regions = [...root.querySelectorAll<HTMLElement>('[data-keyboard-region]')]
    .map(region => ({ region, target: region.tabIndex >= 0 ? region : focusable(region)[0] }))
    .filter(({ target }) => target && !target.matches(':disabled') && target.getClientRects().length && !target.closest('[hidden], [inert]'));
  const current = regions.findIndex(({ region }) => region.contains(document.activeElement));
  const next = current < 0 ? (backward ? regions.length - 1 : 0) : (current + (backward ? -1 : 1) + regions.length) % regions.length;
  regions[next]?.target.focus();
}

/** A row is one Tab stop. Up/down changes rows; left/right chooses a row action. */
export function keyboardRows(list: HTMLElement, initial = 0, column = 0) {
  const rows = [...list.children] as HTMLElement[];
  const buttons = rows.map(row => [...row.querySelectorAll<HTMLButtonElement>('button')]);
  let selected = Math.max(0, Math.min(initial, rows.length - 1));
  let action = column;
  const select = (index: number, nextColumn: number, focus: boolean) => {
    selected = Math.max(0, Math.min(index, rows.length - 1));
    action = Math.max(0, Math.min(nextColumn, (buttons[selected]?.length ?? 1) - 1));
    buttons.forEach((items, i) => {
      rows[i].dataset.focused = String(i === selected);
      items.forEach((item, j) => { item.tabIndex = i === selected && j === action ? 0 : -1; });
    });
    if (focus) buttons[selected]?.[action]?.focus();
  };
  buttons.forEach((items, i) => items.forEach((item, j) => item.addEventListener('focus', () => select(i, j, false))));
  select(selected, action, false);
  list.onkeydown = event => {
    if (event.isComposing || event.defaultPrevented || isEditing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    const targets: Record<string, number> = { ArrowDown: selected + 1, ArrowUp: selected - 1, Home: 0, End: rows.length - 1, PageDown: selected + 5, PageUp: selected - 5 };
    if (event.key in targets) { event.preventDefault(); select(targets[event.key], action, true); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); select(selected, action + (event.key === 'ArrowLeft' ? -1 : 1), true);
    }
  };
  return (index = selected, nextColumn = action) => select(index, nextColumn, true);
}

export const keyboardGuide: [string, [string, string][]][] = [
  ['通用', [['F1', '打开 / 关闭键盘速查，返回原焦点'], ['Tab / Shift+Tab', '下一个 / 上一个控件'], ['F6 / Shift+F6', '下一个 / 上一个区域'], ['Enter / 空格', '执行当前文字操作；空格展开折叠项'], ['Esc', '取消当前编辑、退出子界面，再返回阅读'], ['Ctrl+K 或 /', '输入命令；输入框中用 Ctrl+K'], ['F10', '终端外观与菜单'], ['Alt+Q（全局，可自定义）', '老板键：立即切换随机程序输出，再按恢复']]],
  ['入口', [['Ctrl+O / Ctrl+Shift+O', '打开文件 / 文件夹'], ['Ctrl+C', '没有选中文字时关闭当前书籍并回主页；选中文字时复制'], ['Ctrl+B', '书库'], ['Ctrl+J', '章节'], ['Ctrl+D', '书签'], ['Ctrl+,', '外观与阅读设置'], ['Ctrl+Shift+B / Ctrl+Shift+R', '导出 / 恢复备份']]],
  ['阅读与搜索', [['↑ ↓ / PageUp PageDown / Home End', '滚动 / 翻页 / 首尾'], ['← →', '上一份 / 下一份文件，恢复历史位置'], ['空格', '开始 / 暂停自动滚动'], ['Ctrl+F', '书库或章节内筛选；其他界面搜索正文'], ['Ctrl+Shift+F', '直接搜索正文'], ['F3 / Shift+F3', '下一个 / 上一个搜索结果'], ['Alt+←', '返回跳转前的位置']]],
  ['书库', [['↑ ↓ / Home End / PageUp PageDown', '移动当前行'], ['Enter', '打开当前书籍'], ['Ctrl+M', '进入 / 退出多选'], ['空格 / Shift+方向键', '勾选 / 范围选择'], ['Ctrl+A / Ctrl+Shift+A', '全选当前列表 / 清空选择（输入框保留文字选择）'], ['Delete', '移出当前行或已勾选书籍，仅在列表中生效'], ['Ctrl+Z', '撤销上一批移出，输入框中仍为文字撤销'], ['Ctrl+G / Ctrl+Shift+G', '分类筛选 / 管理分类'], ['Alt+G → 方向键 → Ctrl+Enter', '选择目标分类并应用'], ['Ctrl+F → 输入 → ↓', '筛选后回到书籍列表']]],
  ['分类与书签', [['Ctrl+N', '聚焦新建分类或书签名称'], ['↑ ↓ / ← →', '切换条目 / 条目操作'], ['F2 / Delete', '重命名 / 删除当前条目（编辑框除外）'], ['Enter / Esc', '保存名称 / 取消编辑'], ['Esc', '分类管理返回书库，再按一次返回阅读']]],
  ['命令与设置', [['↑ ↓ / Tab / Enter', '选择命令 / 补全 / 执行'], ['空命令 ↑ 或 Alt+↑ ↓', '浏览命令历史'], ['Shift+Tab 或空命令 Tab', '离开命令输入，不触发补全'], ['方向键 / Home End', '调整选择框、滑杆与数值'], ['颜色值输入框', '直接输入 #RRGGBB，Enter 保存，Esc 撤销输入'], ['终端文件选择', 'Ctrl+L 路径，Ctrl+F 筛选，↑ ↓ 选择，Enter 进入/打开，空格勾选，Ctrl+A 全选，Alt+↑ 上级，Ctrl+Enter 确定，Esc 取消']]],
];

export function appendKeyboardGuide(root: HTMLElement) {
  for (const [title, entries] of keyboardGuide) {
    const heading = document.createElement('p'); heading.textContent = title; heading.className = 'keyboard-section'; root.append(heading);
    for (const [keys, action] of entries) {
      const line = document.createElement('p'); line.className = 'keyboard-entry';
      const key = document.createElement('span'); key.textContent = keys; key.className = 'keyboard-key';
      line.append(key, `  ${action}`); root.append(line);
    }
  }
}
