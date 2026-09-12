/** Quotes preserve spaces and Windows separators; these are reader commands, never a shell process. */
export function parseCommand(line: string): { name: string; argument: string } {
  const text = line.trim().replace(/^\//, '');
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  return { name: match?.[1].toLowerCase() ?? '', argument: (match?.[2] ?? '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2') };
}
export const commandAliases: Record<string, string> = {
  ls: 'books', dir: 'books', 'get-childitem': 'books', gci: 'books',
  cat: 'read', type: 'read', 'get-content': 'read', gc: 'read',
  cd: 'cd', 'set-location': 'cd', pwd: 'pwd', 'get-location': 'pwd',
  cls: 'clear', exit: 'close', history: 'history', man: 'help',
};
export const quickStart: [string, string][] = [
  ['open', '打开 TXT、Markdown、EPUB；folder 添加整个文件夹'],
  ['ls 或 dir', '查看书库；↑ ↓ 选择，Enter 阅读'],
  ['cat 1 或 type "书名.txt"', '按列表编号或书名打开；Tab 补全书名'],
  ['cd "技术" / cd ..', '进入分类 / 返回全部；pwd 查看当前位置'],
  ['recent / resume', '最近阅读 / 接着上次的位置读'],
  ['goto 35% / progress', '跳到全书 35% / 查看本章与全书进度'],
  ['Ctrl+L / Ctrl+U / Ctrl+W', '清屏回到命令行 / 清除光标前输入 / 删除前一个词'],
  ['↑ ↓ / Tab / Ctrl+R', '命令历史与候选 / 补全 / 搜索命令历史'],
  ['Ctrl+C / Alt+Q', '没有选择文字时回主页 / 全局老板键'],
  ['backup --encrypt / restore', '设置密码导出加密备份 / 校验后恢复到当前书库'],
  ['help / F1', '重新查看本说明 / 快捷键速查'],
];
