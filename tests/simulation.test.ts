import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalSimulation, paragraphRole, type SimulationFrame } from '../src/simulation';

afterEach(() => vi.useRealTimers());

describe('stable terminal colors', () => {
  it('keeps paragraph colors stable and changes them only with an explicit new seed', () => {
    const colors = (seed: number) => Array.from({ length: 60 }, (_, index) => paragraphRole('book-a', index, seed, 'normal', 'paragraph'));
    expect(colors(23)).toEqual(colors(23));
    expect(colors(23)).not.toEqual(colors(24));
    expect(new Set(colors(23)).size).toBeGreaterThan(2);
    expect(colors(23)).toContain('body');
  });
});

describe('simulation scheduling', () => {
  it('defers a full task while the reader is interacting and leaves no timer when disabled', () => {
    vi.useFakeTimers();
    let available = false;
    const frames: (SimulationFrame | null)[] = [];
    const simulation = new TerminalSimulation(() => available, frame => frames.push(frame), () => 0);
    simulation.configure({ enabled: true, theme: 'powershell', frequency: 'normal' });
    simulation.preview();
    vi.advanceTimersByTime(5000);
    expect(frames.filter(Boolean)).toHaveLength(0);
    available = true;
    vi.advanceTimersByTime(400);
    expect(frames.at(-1)?.tokens[0].text).toBe('npm run build');
    available = false;
    simulation.pauseForInteraction();
    expect(frames.at(-1)).toBeNull();
    const count = frames.filter(Boolean).length;
    vi.advanceTimersByTime(2000);
    expect(frames.filter(Boolean)).toHaveLength(count);
    available = true;
    vi.advanceTimersByTime(8000);
    expect(frames.some(frame => frame?.tokens.some(token => token.text.includes('18 modules built successfully')))).toBe(true);
    simulation.configure({ enabled: false, theme: 'powershell', frequency: 'normal' });
    expect(frames.at(-1)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows one preview with periodic tasks off and disposes an active preview', () => {
    vi.useFakeTimers();
    const frames: (SimulationFrame | null)[] = [];
    const simulation = new TerminalSimulation(() => true, frame => frames.push(frame), () => 0.5);
    simulation.configure({ enabled: true, theme: 'cmd', frequency: 'off' });
    expect(vi.getTimerCount()).toBe(0);
    simulation.preview();
    vi.advanceTimersByTime(10000);
    expect(frames.some(frame => frame?.tokens.some(token => token.text.includes('24 passed')))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    simulation.preview();
    expect(vi.getTimerCount()).toBe(1);
    simulation.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.at(-1)).toBeNull();
  });
});
