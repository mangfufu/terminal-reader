export const profiles = [
  { id: 'powershell', name: 'Windows Terminal · PowerShell', title: 'Windows PowerShell', banner: 'Windows PowerShell', chrome: 'terminal', description: '标签栏 · Campbell 黑底 · Cascadia Mono' },
  { id: 'powershell-classic', name: 'Windows PowerShell · 经典', title: 'Windows PowerShell', banner: 'Windows PowerShell', chrome: 'classic', description: '经典标题栏 · 深蓝底 · Consolas' },
  { id: 'cmd', name: 'CMD · 命令提示符', title: '命令提示符', banner: 'Microsoft Windows', chrome: 'classic', description: '经典标题栏 · 黑底白字 · Consolas' },
  { id: 'linux', name: 'Linux · Ubuntu Terminal', title: 'reader@desktop: ~/Books', banner: 'reader@desktop: ~/Books', chrome: 'linux', description: 'Ubuntu 风格 · 紫黑底 · 用户与路径提示符' },
] as const;

export type Theme = typeof profiles[number]['id'];
export function isTheme(value: unknown): value is Theme {
  return profiles.some(profile => profile.id === value);
}

export function profileFor(theme: Theme) {
  return profiles.find(profile => profile.id === theme)!;
}

export function renderPrompt(element: HTMLElement, theme: Theme) {
  if (theme === 'linux') {
    element.replaceChildren();
    for (const [text, role] of [['reader@desktop', 'shell-user'], [':', ''], ['~/Books', 'shell-path'], ['$', '']]) {
      const span = document.createElement('span');
      span.textContent = text;
      span.className = role;
      element.append(span);
    }
  } else element.textContent = theme === 'cmd' ? 'C:\\Books>' : 'PS C:\\Books>';
}

export function fileArgument(theme: Theme, name: string) {
  // This is reader command history, never an executable shell command.
  return JSON.stringify((theme === 'linux' ? './' : '.\\') + name).replaceAll('\\\\', '\\');
}

export const shellIcons: Record<Theme, string> = {
  powershell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#267ec8" d="M5 4h17l-4 16H1z"/><path d="m8 8 5 4-7 4m7 0h4" fill="none" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  'powershell-classic': '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#235fa4" stroke="#75a7da" d="M5 4h17l-4 16H1z"/><path d="m8 8 5 4-7 4m7 0h4" fill="none" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  cmd: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="1" fill="#111" stroke="#999"/><path d="M3 6h18" stroke="#ddd"/><path d="m5 10 3 3-3 3m5 0h5" fill="none" stroke="#ddd" stroke-width="1.3"/></svg>',
  linux: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="2" fill="#222" stroke="#aaa"/><path d="M3 6h18" stroke="#e95420" stroke-width="2"/><path d="m5 10 4 3-4 3m6 0h6" fill="none" stroke="white" stroke-width="1.5"/></svg>',
};
