import { describe, expect, it } from 'vitest';
import { Button, TextField } from '@daftar/design-system';
import { Ltr, defineView, formatQty, normaliseDigits, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { elements, parseHtml, renderAtPhoneWidth, renderFixture, styleOf, textOf } from './helpers/render';

/** The render helper the screen agents and the SSR suites share (§5(3)). */
describe('render helper', () => {
  it('parses static markup into a walkable tree, entities decoded, void and self-closed tags handled', () => {
    const root = parseHtml(
      '<div class="a" style="width:100%;min-height:calc(2.75rem + 0.5rem)"><input type="text"/><br/><span>a &amp; b &lt;c&gt; &quot;d&quot; &#x27;e&#x27;</span></div>',
    );
    const [div, input, br, span] = [...elements(root)].slice(1);
    expect(div?.tag).toBe('div');
    expect(styleOf(div ?? root)).toEqual({ width: '100%', 'min-height': 'calc(2.75rem + 0.5rem)' });
    expect(input?.attrs['type']).toBe('text');
    expect(br?.tag).toBe('br');
    expect(textOf(span ?? root)).toBe(`a & b <c> "d" 'e'`);
  });

  it('refuses markup it cannot balance', () => {
    expect(() => parseHtml('<div><span></div>')).toThrow(/unbalanced/);
    expect(() => parseHtml('<div>')).toThrow(/unclosed/);
  });

  it('renders at 360px with the locale direction, and records a missing key', () => {
    const view = ({ t }: ViewBaseProps) => (
      <div>
        <TextField label={t('common.search')} />
        <Button>{t('common.save')}</Button>
        <span>{t('stock.no_such_key_for_the_helper_test')}</span>
      </div>
    );
    const ar = renderAtPhoneWidth(view, 'ar');
    expect(ar.frame.attrs['dir']).toBe('rtl');
    expect(ar.frame.attrs['lang']).toBe('ar');
    expect(styleOf(ar.frame)['width']).toBe('360px');
    expect(ar.missingKeys).toEqual(['stock.no_such_key_for_the_helper_test']);
    expect(renderAtPhoneWidth(view, 'en').frame.attrs['dir']).toBe('ltr');
  });

  it('defineView renders a fixture with the base props, and keeps the data props for T-08', () => {
    const entry = defineView('Probe', (p: { qty: string; decimals: number } & ViewBaseProps) => <Ltr>{formatQty(p.qty, p.decimals, p.locale)}</Ltr>, {
      tr: { qty: '1234.5', decimals: 2 },
    });
    const fixture = entry.fixtures[0];
    if (!fixture) throw new Error('no fixture');
    expect(fixture.props).toEqual({ qty: '1234.5', decimals: 2 });
    expect(renderFixture(fixture, 'tr').html).toContain('<bdi dir="ltr">1.234,50</bdi>');
    expect(renderFixture(fixture, 'en').html).toContain('<bdi dir="ltr">1,234.50</bdi>');
  });

  it('rich() places nodes into a translated sentence, and digits are normalised to Western form', () => {
    const { html } = renderAtPhoneWidth(() => <p>{rich('Short by {qty} today', { qty: <Ltr>3</Ltr> })}</p>, 'en');
    expect(html).toContain('<p>Short by <bdi dir="ltr">3</bdi> today</p>');
    expect(normaliseDigits('١٢٫٥')).toBe('12.5');
    expect(normaliseDigits('۱۲۳')).toBe('123');
  });
});
