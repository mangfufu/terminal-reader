import type { Theme } from './appearance';

export type ReadingMode = 'plain' | 'simulate';
export type ColorLevel = 'soft' | 'normal' | 'rich';
export type EffectFrequency = 'off' | 'low' | 'normal';
export type AnsiRole = 'body' | 'info' | 'success' | 'warning' | 'accent' | 'muted';

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  // Mix the high bits too, so consecutive paragraph groups do not all get one color.
  result = Math.imul(result ^ (result >>> 16), 0x7feb352d);
  result = Math.imul(result ^ (result >>> 15), 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

export function paragraphRole(bookId: string, index: number, seed: number, level: ColorLevel, kind: string): AnsiRole {
  if (kind === 'heading') return 'info';
  if (kind === 'code') return 'muted';
  const density = { soft: 35, normal: 65, rich: 90 }[level];
  // Nearby paragraphs often share a role, as related lines in a build log do.
  const group = Math.floor(index / 2);
  const random = hash(`${bookId}:${seed}:${group}`);
  if (random % 100 >= density) return 'body';
  const roles: AnsiRole[] = ['info', 'success', 'warning', 'accent'];
  return roles[(random >>> 8) % roles.length];
}

export interface SimulationToken { text: string; role: AnsiRole; compact?: string }
export interface SimulationFrame { kind: 'command' | 'output'; tokens: SimulationToken[] }
interface Step { frame: SimulationFrame; duration: number }
export interface SimulationOptions { enabled: boolean; theme: Theme; frequency: EffectFrequency }

function output(text: string, role: AnsiRole, duration = 700, compact?: string): Step {
  return { frame: { kind: 'output', tokens: [{ text, role, compact }] }, duration };
}
function command(text: string, duration = 950, compact?: string): Step {
  return { frame: { kind: 'command', tokens: [{ text, role: 'warning', compact }] }, duration };
}

function scene(index: number, theme: Theme): Step[] {
  const reset = command('', 650);
  if (index === 0) return [
    command('npm run build'),
    output('> reader-core build', 'muted', 650),
    output('[build] checking dependencies...', 'info', 750, 'Checking dependencies...'),
    output('[build] compiling  4 / 18 modules', 'info', 750, '[build]  4/18 modules'),
    output('[build] compiling 12 / 18 modules', 'info', 750, '[build] 12/18 modules'),
    output('[build] compiling 18 / 18 modules', 'info', 600, '[build] 18/18 modules'),
    output('[done] 18 modules built successfully.', 'success', 1300, '[done] 18 modules built'), reset,
  ];
  if (index === 1) return [
    command('python -m pip install rich', 950, 'pip install rich'),
    output('Collecting rich', 'info', 750),
    output('Resolving package dependencies...', 'muted', 700, 'Resolving dependencies...'),
    output('Downloading rich.whl [====        ]  32%', 'info', 700, '[ 32%] rich.whl'),
    output('Downloading rich.whl [=========   ]  76%', 'info', 700, '[ 76%] rich.whl'),
    output('Downloading rich.whl [============] 100%', 'success', 650, '[100%] rich.whl'),
    output('Successfully installed rich and dependencies.', 'success', 1300, '[done] rich installed'), reset,
  ];
  if (index === 2) return [
    command('python -m pytest -q', 950, 'pytest -q'),
    output('collected 24 items', 'muted', 650),
    output('test_reader.py   ........  [ 33%]', 'success', 950, '[ 8/24] reader tests'),
    output('test_library.py  ........  [ 67%]', 'success', 950, '[16/24] library tests'),
    output('test_commands.py ........  [100%]', 'success', 950, '[24/24] command tests'),
    output('================ 24 passed ================', 'success', 1300, '====== 24 passed ======'), reset,
  ];
  const scan = theme === 'linux' ? 'find ./Books -type f' : theme === 'cmd' ? 'dir /s /b .\\Books' : 'Get-ChildItem .\\Books -Recurse';
  return [
    command(scan, 950, theme === 'linux' ? 'find . -type f' : theme === 'cmd' ? 'dir /s /b' : 'gci .\\Books -r'),
    output('[scan] collecting file entries...', 'info', 750, '[scan] collecting files'),
    output('[scan] indexed 12 / 48 files', 'muted', 750, '[scan] 12/48 files'),
    output('[scan] indexed 28 / 48 files', 'info', 750, '[scan] 28/48 files'),
    output('[scan] indexed 48 / 48 files', 'info', 750, '[scan] 48/48 files'),
    output('[done] 48 files indexed. Cache is up to date.', 'success', 1300, '[done] 48 files indexed'), reset,
  ];
}

/** Visual output only. This class never invokes a shell or performs file/network work. */
export class TerminalSimulation {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private options: SimulationOptions = { enabled: false, theme: 'powershell', frequency: 'low' };
  private steps: Step[] | undefined;
  private index = 0;
  private lastScene = -1;
  private quietUntil = 0;

  constructor(
    private readonly canPlay: () => boolean,
    private readonly render: (frame: SimulationFrame | null) => void,
    private readonly random: () => number = Math.random,
  ) {}

  configure(options: SimulationOptions) {
    if (options.enabled === this.options.enabled && options.theme === this.options.theme && options.frequency === this.options.frequency) return;
    this.stop();
    this.options = options;
    if (options.enabled && options.frequency !== 'off') this.schedule(() => this.begin(), 10000);
  }

  preview() {
    if (!this.options.enabled) return;
    this.stop();
    this.begin();
  }

  pauseForInteraction() {
    this.quietUntil = Date.now() + 800;
    this.render(null);
    if (this.steps) this.schedule(() => this.advance(), 350);
  }

  destroy() { this.stop(); this.options.enabled = false; }

  private stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.steps = undefined;
    this.index = 0;
    this.render(null);
  }

  private schedule(action: () => void, delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(action, delay);
  }

  private available() { return this.canPlay() && Date.now() >= this.quietUntil; }

  private begin() {
    if (!this.options.enabled) return;
    if (!this.available()) { this.schedule(() => this.begin(), 400); return; }
    let selected = Math.min(3, Math.floor(this.random() * 4));
    if (selected === this.lastScene) selected = (selected + 1) % 4;
    this.lastScene = selected;
    this.steps = scene(selected, this.options.theme);
    this.index = 0;
    this.advance();
  }

  private advance() {
    if (!this.options.enabled || !this.steps) return;
    if (!this.available()) {
      this.render(null);
      this.schedule(() => this.advance(), 350);
      return;
    }
    const step = this.steps[this.index];
    if (!step) {
      this.steps = undefined;
      this.render(null);
      if (this.options.frequency !== 'off') {
        const delay = this.options.frequency === 'low' ? 45000 + this.random() * 45000 : 20000 + this.random() * 20000;
        this.schedule(() => this.begin(), delay);
      }
      return;
    }
    this.render(step.frame);
    this.schedule(() => { this.index++; this.advance(); }, step.duration);
  }
}
