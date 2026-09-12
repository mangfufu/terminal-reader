import { shortcutFor, validBossKey } from './keyboard';
import { isTheme, type Theme } from './appearance';
import type { ReadingMode, ColorLevel, EffectFrequency } from './simulation';

export const colorRoles = { bg: '背景', text: '正文', muted: '次要文字', accent: '命令', info: '信息', success: '成功', warning: '提示', highlight: '强调' } as const;
export type Colors = Partial<Record<keyof typeof colorRoles, string>>;
export interface Settings {
  bossKey: string; autoCover: boolean; progressScope: 'book' | 'chapter';
  progressStyle: 'bar' | 'pages' | 'percent';
  theme: Theme; fontSize: number; speed: number; mode: ReadingMode;
  colorLevel: ColorLevel; effectFrequency: EffectFrequency; colorSeed: number;
  fontFamily: string; lineHeight: number; fontWeight: number; colors: Colors;
  colorSchemes: { name: string; colors: Colors }[];
}
const clamp = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
function cleanColors(value: unknown): Colors {
  const result: Colors = {};
  if (value && typeof value === 'object') for (const key of Object.keys(colorRoles) as (keyof Colors)[]) {
    const color = (value as Colors)[key];
    if (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) result[key] = color;
  }
  return result;
}
export function normalizeSettings(value: unknown): Settings {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    autoCover: v.autoCover === true, progressScope: v.progressScope === 'chapter' ? 'chapter' : 'book',
    bossKey: validBossKey(v.bossKey) ? v.bossKey : 'Alt+Q',
    progressStyle: v.progressStyle === 'bar' || v.progressStyle === 'pages' ? v.progressStyle : 'percent',
    theme: isTheme(v.theme) ? v.theme : 'powershell', fontSize: clamp(v.fontSize, 16, 12, 24), speed: clamp(v.speed, 18, 2, 100),
    mode: v.mode === 'plain' ? 'plain' : 'simulate',
    colorLevel: v.colorLevel === 'soft' || v.colorLevel === 'rich' ? v.colorLevel : 'normal',
    effectFrequency: v.effectFrequency === 'off' || v.effectFrequency === 'normal' ? v.effectFrequency : 'low',
    colorSeed: typeof v.colorSeed === 'number' && Number.isInteger(v.colorSeed) && v.colorSeed >= 0 && v.colorSeed <= 0xffffffff ? v.colorSeed : crypto.getRandomValues(new Uint32Array(1))[0],
    fontFamily: typeof v.fontFamily === 'string' ? v.fontFamily.replace(/["'\\;{}\r\n]/g, '').slice(0, 100) : '',
    lineHeight: clamp(v.lineHeight, 1.375, 1.1, 2.2), fontWeight: clamp(v.fontWeight, 400, 300, 700), colors: cleanColors(v.colors),
    colorSchemes: Array.isArray(v.colorSchemes) ? v.colorSchemes.slice(0, 20).flatMap(s => s && typeof s.name === 'string' ? [{ name: s.name.slice(0, 50), colors: cleanColors(s.colors) }] : []) : [],
  };
}
const variables: Record<keyof Colors, string[]> = {
  bg: ['--bg'], text: ['--text'], muted: ['--muted', '--ansi-muted'], accent: ['--accent', '--argument'],
  info: ['--ansi-info'], success: ['--ansi-success'], warning: ['--ansi-warning'], highlight: ['--ansi-accent'],
};
export function applyAppearance(app: HTMLElement, settings: Settings) {
  app.style.setProperty('--font-size', `${settings.fontSize}px`);
  app.style.setProperty('--line-height', String(settings.lineHeight));
  app.style.setProperty('--reader-weight', String(settings.fontWeight));
  if (settings.fontFamily) app.style.setProperty('--terminal-font', `"${settings.fontFamily}", 'Cascadia Mono', Consolas, 'Noto Sans Mono CJK SC', monospace`);
  else app.style.removeProperty('--terminal-font');
  for (const [role, names] of Object.entries(variables)) for (const name of names) {
    const color = settings.colors[role as keyof Colors];
    if (color) app.style.setProperty(name, color); else app.style.removeProperty(name);
  }
  for (const name of ['--surface', '--border', '--selection', '--selection-text']) app.style.removeProperty(name);
  if (settings.colors.bg) {
    app.style.setProperty('--surface', 'color-mix(in srgb, var(--bg) 92%, var(--text))');
    app.style.setProperty('--border', 'color-mix(in srgb, var(--bg) 65%, var(--text))');
    app.style.setProperty('--selection', 'var(--text)'); app.style.setProperty('--selection-text', 'var(--bg)');
  }
}
export function appendAppearanceControls(body: HTMLElement, app: HTMLElement, settings: Settings, changed: () => void) {
  const label = (title: string, control: HTMLElement) => {
    control.setAttribute('aria-label', title);
    const row = document.createElement('label'); row.className = 'setting'; row.append(title, control); body.append(row);
  };
  const bossKey = document.createElement('input'); bossKey.readOnly = true; bossKey.value = settings.bossKey; bossKey.dataset.hotkeyRecorder = 'true';
  bossKey.title = '聚焦后按新的组合键；Tab 离开，Esc 取消';
  const bossHint = document.createElement('p'); bossHint.className = 'muted';
  bossHint.textContent = '老板键默认 Alt+Q。点选上方输入框后直接按新快捷键；再次按下恢复，或双击输出页标题返回。';
  bossKey.onkeydown = event => {
    if (event.isComposing || event.key === 'Tab') return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { bossKey.value = settings.bossKey; bossKey.setAttribute('aria-invalid', 'false'); return; }
    const key = shortcutFor(event); if (!key) return;
    if (!validBossKey(key)) { bossKey.setAttribute('aria-invalid', 'true'); bossHint.textContent = '此按键用于现有操作。请使用其他 Ctrl / Alt 组合键，或 F8、F9 等功能键。'; return; }
    settings.bossKey = key; bossKey.value = key; bossKey.setAttribute('aria-invalid', 'false'); changed(); bossHint.textContent = `已设置为 ${key}。再次按下恢复；Tab 离开设置。`;
  };
  label('老板键', bossKey); body.append(bossHint);
  const autoCover = document.createElement('select'); autoCover.add(new Option('保持界面', 'off')); autoCover.add(new Option('自动显示程序输出', 'on')); autoCover.value = settings.autoCover ? 'on' : 'off'; autoCover.onchange = () => { settings.autoCover = autoCover.value === 'on'; changed(); }; label('窗口失去焦点', autoCover);
  const scope = document.createElement('select'); scope.add(new Option('全书', 'book')); scope.add(new Option('当前章节', 'chapter')); scope.value = settings.progressScope; scope.onchange = () => { settings.progressScope = scope.value as Settings['progressScope']; changed(); }; label('进度范围', scope);
  const progressStyle = document.createElement('select');
  for (const [value, name] of [['bar', '进度条'], ['pages', '页数'], ['percent', '百分比']]) progressStyle.add(new Option(name, value));
  progressStyle.value = settings.progressStyle; progressStyle.onchange = () => { settings.progressStyle = progressStyle.value as Settings['progressStyle']; changed(); }; label('阅读进度样式', progressStyle);
  const font = document.createElement('input'); font.value = settings.fontFamily; font.placeholder = '跟随终端预设'; font.maxLength = 100;
  font.onchange = () => { settings.fontFamily = normalizeSettings({ fontFamily: font.value }).fontFamily; changed(); }; label('字体名称', font);
  for (const [key, title, min, max, step] of [['lineHeight', '行距', 1.1, 2.2, 0.05], ['fontWeight', '字重', 300, 700, 100]] as const) {
    const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(settings[key]);
    input.onchange = () => { if (Number.isFinite(input.valueAsNumber)) { settings[key] = clamp(input.valueAsNumber, settings[key], min, max); input.value = String(settings[key]); changed(); } }; label(title, input);
  }
  const section = document.createElement('details'); section.className = 'appearance-colors';
  const summary = document.createElement('summary'); summary.textContent = '自定义配色'; section.append(summary); body.append(section);
  const fields = document.createElement('div'); section.append(fields);
  const paint = () => {
    fields.replaceChildren();
    const computed = getComputedStyle(app);
    for (const [key, title] of Object.entries(colorRoles)) {
      const row = document.createElement('label'); row.className = 'setting'; row.append(title);
      const field = { value: '' };
      field.value = settings.colors[key as keyof Colors] ?? computed.getPropertyValue(variables[key as keyof Colors][0]).trim();
      const hex = document.createElement('input'); hex.type = 'text'; hex.className = 'color-value'; hex.value = field.value;
      hex.maxLength = 7; hex.pattern = '#[0-9a-fA-F]{6}'; hex.spellcheck = false;
      hex.setAttribute('aria-label', `${title}颜色值`); hex.title = '#RRGGBB · Enter 保存 · Esc 取消输入';
      const commit = () => {
        const valid = /^#[0-9a-f]{6}$/i.test(hex.value);
        hex.setAttribute('aria-invalid', String(!valid));
        if (!valid) { hex.title = '请输入 #RRGGBB，例如 #112233'; return; }
        field.value = hex.value; settings.colors[key as keyof Colors] = hex.value; changed();
      };
      hex.onchange = commit;
      hex.onkeydown = event => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        else if (event.key === 'Escape') { event.preventDefault(); hex.value = field.value; hex.setAttribute('aria-invalid', 'false'); }
      };
      row.append(hex); fields.append(row);
    }
  };
  paint();
  const schemes = document.createElement('select'); schemes.setAttribute('aria-label', '配色方案');
  const options = () => { schemes.replaceChildren(new Option('选择配色方案', ''), new Option('终端默认', 'default'), new Option('浅色纸张', 'light'), ...settings.colorSchemes.map((s, i) => new Option(s.name, String(i)))); };
  options();
  schemes.onchange = () => {
    if (!schemes.value) return;
    settings.colors = schemes.value === 'default' ? {} : schemes.value === 'light'
      ? { bg: '#f3f1e7', text: '#252b30', muted: '#626965', accent: '#705614', info: '#175984', success: '#30612f', warning: '#85580c', highlight: '#754184' }
      : { ...settings.colorSchemes[Number(schemes.value)]?.colors };
    changed(); paint();
  };
  const schemeName = document.createElement('input'); schemeName.placeholder = '方案名称'; schemeName.maxLength = 50; schemeName.setAttribute('aria-label', '方案名称');
  const save = document.createElement('button'); save.textContent = '保存配色';
  save.onclick = () => {
    const name = schemeName.value.trim(); if (!name) { schemeName.focus(); return; }
    settings.colorSchemes = settings.colorSchemes.filter(s => s.name !== name).slice(-19);
    const palette: Colors = {};
    for (const key of Object.keys(colorRoles) as (keyof Colors)[]) palette[key] = settings.colors[key] ?? getComputedStyle(app).getPropertyValue(variables[key][0]).trim();
    settings.colorSchemes.push({ name, colors: palette }); changed(); options(); schemeName.value = '';
  };
  schemeName.onkeydown = event => { if (!event.isComposing && event.key === 'Enter') { event.preventDefault(); save.click(); } };
  const reset = document.createElement('button'); reset.textContent = '恢复默认字体与配色';
  reset.onclick = () => { settings.fontFamily = ''; settings.fontSize = 16; settings.fontWeight = 400; settings.lineHeight = 1.375; settings.colors = {}; changed(); font.value = ''; body.querySelector<HTMLInputElement>('[aria-label="正文字号"]')!.value = '16'; body.querySelector<HTMLInputElement>('[aria-label="行距"]')!.value = '1.375'; body.querySelector<HTMLInputElement>('[aria-label="字重"]')!.value = '400'; paint(); };
  const actions = document.createElement('div'); actions.className = 'panel-actions'; actions.append(schemes, schemeName, save, reset); section.append(actions);
  return paint;
}
