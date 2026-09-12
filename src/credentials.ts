import { cycleFocus } from './keyboard';

export class Credentials {
  readonly element = document.createElement('section');
  private cancelCurrent?: () => void;
  get active() { return !this.element.hidden; }
  constructor(private readonly app: HTMLElement) {
    this.element.id = 'credentials'; this.element.className = 'panel credentials'; this.element.hidden = true;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true'); app.append(this.element);
  }
  cancel() { this.cancelCurrent?.(); }
  ask<T>(title: string, creating: boolean, verify: (password: string) => Promise<T>): Promise<T | null> {
    if (this.active) return Promise.resolve(null);
    const root = this.element; const opener = document.activeElement as HTMLElement | null;
    const inert = [...this.app.children].filter(el => el !== root).map(el => [el as HTMLElement, el.hasAttribute('inert')] as const);
    inert.forEach(([el]) => el.inert = true); root.hidden = false; root.inert = false; root.setAttribute('aria-label', title);
    root.innerHTML = '<header class="panel-header"></header><form class="credential-form"><p class="muted"></p><label>密码: <input type="password" aria-label="密码" autocomplete="off" maxlength="1024"></label><label class="repeat-password">确认: <input type="password" aria-label="确认密码" autocomplete="off" maxlength="1024"></label><p role="status"></p><div class="panel-actions"><button type="submit">确认</button><button type="button">取消</button></div></form>';
    root.querySelector('header')!.textContent = title;
    root.querySelector('.muted')!.textContent = creating ? '设置至少 8 个字符的密码。内容将加密保存，请记住密码。' : '输入密码后继续。';
    root.querySelector<HTMLElement>('.repeat-password')!.hidden = !creating;
    const fields = root.querySelectorAll('input'); const status = root.querySelector('[role="status"]')!;
    let busy = false;
    return new Promise(resolve => {
      const finish = (value: T | null) => {
        fields.forEach(field => field.value = ''); root.hidden = true; root.replaceChildren(); root.onkeydown = null; this.cancelCurrent = undefined;
        inert.forEach(([el, old]) => el.inert = old);
        if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true }); resolve(value);
      };
      this.cancelCurrent = () => { if (!busy) finish(null); };
      root.querySelector<HTMLButtonElement>('[type="button"]')!.onclick = this.cancelCurrent;
      root.onkeydown = event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); this.cancelCurrent?.(); }
        else if (event.key === 'Tab' || event.key === 'F6') { event.preventDefault(); cycleFocus(root, event.shiftKey); }
      };
      root.querySelector('form')!.onsubmit = async event => {
        event.preventDefault(); if (busy) return;
        if (creating && (fields[0].value.length < 8 || fields[0].value !== fields[1].value)) { status.textContent = '密码至少 8 个字符，两次输入须一致。'; fields[0].focus(); return; }
        busy = true; status.textContent = '正在验证…';
        fields.forEach(field => field.readOnly = true);
        try { const result = await verify(fields[0].value); finish(result); }
        catch (error) { status.textContent = String(error).replace(/^Error: /, ''); fields[0].value = ''; fields[0].focus(); }
        finally { busy = false; fields.forEach(field => field.readOnly = false); }
      };
      fields[0].focus();
    });
  }
}
