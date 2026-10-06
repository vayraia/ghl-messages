import { hasAdPreamble, stripAdPreamble } from './ad-preamble';

describe('stripAdPreamble', () => {
  it('strips a Headline + Source URL preamble followed by a blank line', () => {
    const text =
      'Headline: Épica\n*Source URL:* https://www.instagram.com/p/DO01q06gO1c/\n\n¡Hola! Quiero más información';

    expect(stripAdPreamble(text)).toBe('¡Hola! Quiero más información');
  });

  it('strips a Headline-only preamble followed by a blank line', () => {
    expect(stripAdPreamble('Headline: Épica\n\nHola')).toBe('Hola');
  });

  it('strips a Source-URL-only preamble followed by a blank line', () => {
    expect(stripAdPreamble('*Source URL:* https://example.com/p/1\n\nHola')).toBe('Hola');
  });

  it('is case-insensitive on the preamble labels', () => {
    expect(stripAdPreamble('HEADLINE: X\n*source url:* Y\n\nHola')).toBe('Hola');
  });

  it('returns the text unchanged when there is no preamble', () => {
    expect(stripAdPreamble('Hola, quiero información')).toBe('Hola, quiero información');
  });

  it('returns the text unchanged when a Headline-like line has no blank-line separator', () => {
    const text = 'Headline: not really a preamble, just a message';
    expect(stripAdPreamble(text)).toBe(text);
  });

  it('returns the text unchanged when the preamble block is not followed by a blank line', () => {
    const text = 'Headline: X\n*Source URL:* Y\nHola sin separador';
    expect(stripAdPreamble(text)).toBe(text);
  });

  it('trims surrounding whitespace off the extracted message', () => {
    expect(stripAdPreamble('Headline: X\n\n   Hola   ')).toBe('Hola');
  });

  it('handles an empty string', () => {
    expect(stripAdPreamble('')).toBe('');
  });
});

describe('hasAdPreamble', () => {
  it('is true for the real ad-lead message', () => {
    const text =
      '*Headline:* Saca tu Cita Aquí\n*Source URL:* https://fb.me/4ViOwqT2G\n\nEstoy interesado en el servicio de baropodometría y plantillas personalizadas.';
    expect(hasAdPreamble(text)).toBe(true);
  });

  it('is true for a Headline-only preamble followed by a blank line', () => {
    expect(hasAdPreamble('Headline: Épica\n\nHola')).toBe(true);
  });

  it('is false for a plain message', () => {
    expect(hasAdPreamble('Hola, quiero información')).toBe(false);
  });

  it('is false when the preamble has no blank-line separator', () => {
    expect(hasAdPreamble('Headline: X\n*Source URL:* Y\nHola')).toBe(false);
    expect(hasAdPreamble('Headline: not really a preamble, just a message')).toBe(false);
  });
});
