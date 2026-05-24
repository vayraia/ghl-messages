import { buildSendBody, WaValidationError, WaOutboundMessage } from './whatsapp-message';

const TO = '5493510000000';

describe('buildSendBody', () => {
  it('rejects an empty recipient', () => {
    expect(() => buildSendBody('', { type: 'text', body: 'hi' })).toThrow(WaValidationError);
  });

  it('always sets the WhatsApp envelope fields', () => {
    const body = buildSendBody(TO, { type: 'text', body: 'hi' });
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.recipient_type).toBe('individual');
    expect(body.to).toBe(TO);
  });

  describe('text', () => {
    it('maps body and preview_url', () => {
      const body = buildSendBody(TO, { type: 'text', body: 'hello', previewUrl: true });
      expect(body).toMatchObject({ type: 'text', text: { body: 'hello', preview_url: true } });
    });

    it('omits preview_url when not provided', () => {
      const body = buildSendBody(TO, { type: 'text', body: 'hello' });
      expect(body.text as Record<string, unknown>).not.toHaveProperty('preview_url');
    });

    it('rejects empty and over-long bodies', () => {
      expect(() => buildSendBody(TO, { type: 'text', body: '' })).toThrow(/must not be empty/);
      expect(() => buildSendBody(TO, { type: 'text', body: 'x'.repeat(4097) })).toThrow(/exceeds/);
    });
  });

  describe('media', () => {
    it('maps an image with caption', () => {
      const body = buildSendBody(TO, { type: 'image', link: 'https://x/i.jpg', caption: 'pic' });
      expect(body).toMatchObject({
        type: 'image',
        image: { link: 'https://x/i.jpg', caption: 'pic' },
      });
    });

    it('maps a document with filename and caption', () => {
      const body = buildSendBody(TO, {
        type: 'document',
        link: 'https://x/f.pdf',
        filename: 'f.pdf',
        caption: 'doc',
      });
      expect(body).toMatchObject({
        type: 'document',
        document: { link: 'https://x/f.pdf', filename: 'f.pdf', caption: 'doc' },
      });
    });

    it('maps audio (no caption field) and video', () => {
      const audio = buildSendBody(TO, { type: 'audio', link: 'https://x/a.ogg' });
      expect(audio).toMatchObject({ type: 'audio', audio: { link: 'https://x/a.ogg' } });
      expect(audio.audio as Record<string, unknown>).not.toHaveProperty('caption');

      const video = buildSendBody(TO, { type: 'video', link: 'https://x/v.mp4', caption: 'c' });
      expect(video).toMatchObject({
        type: 'video',
        video: { link: 'https://x/v.mp4', caption: 'c' },
      });
    });

    it('rejects empty link and over-long caption', () => {
      expect(() => buildSendBody(TO, { type: 'image', link: '' })).toThrow(
        /link must not be empty/,
      );
      expect(() =>
        buildSendBody(TO, { type: 'image', link: 'https://x/i.jpg', caption: 'x'.repeat(1025) }),
      ).toThrow(/caption exceeds/);
    });
  });

  describe('buttons (interactive)', () => {
    const valid: WaOutboundMessage = {
      type: 'buttons',
      body: 'Choose',
      buttons: [
        { id: 'yes', title: 'Yes' },
        { id: 'no', title: 'No' },
      ],
    };

    it('maps reply buttons into interactive button format', () => {
      const body = buildSendBody(TO, valid);
      expect(body.type).toBe('interactive');
      expect(body.interactive).toMatchObject({
        type: 'button',
        body: { text: 'Choose' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'no', title: 'No' } },
          ],
        },
      });
    });

    it('supports an image header and a footer', () => {
      const body = buildSendBody(TO, {
        ...valid,
        header: { type: 'image', link: 'https://x/h.jpg' },
        footer: 'powered by bot',
      });
      expect(body.interactive).toMatchObject({
        header: { type: 'image', image: { link: 'https://x/h.jpg' } },
        footer: { text: 'powered by bot' },
      });
    });

    it('rejects more than 3 buttons', () => {
      expect(() =>
        buildSendBody(TO, {
          ...valid,
          buttons: [
            { id: '1', title: 'a' },
            { id: '2', title: 'b' },
            { id: '3', title: 'c' },
            { id: '4', title: 'd' },
          ],
        }),
      ).toThrow(/maximum of 3/);
    });

    it('rejects an over-long title and duplicate ids', () => {
      expect(() =>
        buildSendBody(TO, { ...valid, buttons: [{ id: 'x', title: 'x'.repeat(21) }] }),
      ).toThrow(/button title must be/);
      expect(() =>
        buildSendBody(TO, {
          ...valid,
          buttons: [
            { id: 'dup', title: 'a' },
            { id: 'dup', title: 'b' },
          ],
        }),
      ).toThrow(/duplicate button id/);
    });
  });

  describe('list (interactive)', () => {
    const valid: WaOutboundMessage = {
      type: 'list',
      body: 'Pick one',
      button: 'Open',
      sections: [
        { title: 'Fruit', rows: [{ id: 'a', title: 'Apple', description: 'red' }] },
        { title: 'Veg', rows: [{ id: 'b', title: 'Bean' }] },
      ],
    };

    it('maps sections, rows and the action button', () => {
      const body = buildSendBody(TO, valid);
      expect(body.interactive).toMatchObject({
        type: 'list',
        body: { text: 'Pick one' },
        action: {
          button: 'Open',
          sections: [
            { title: 'Fruit', rows: [{ id: 'a', title: 'Apple', description: 'red' }] },
            { title: 'Veg', rows: [{ id: 'b', title: 'Bean' }] },
          ],
        },
      });
    });

    it('maps a text header', () => {
      const body = buildSendBody(TO, { ...valid, header: 'Menu' });
      expect(body.interactive).toMatchObject({ header: { type: 'text', text: 'Menu' } });
    });

    it('rejects more than 10 rows total', () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `t${i}` }));
      expect(() => buildSendBody(TO, { ...valid, sections: [{ title: 'All', rows }] })).toThrow(
        /at most 10 rows/,
      );
    });

    it('rejects an over-long button label and empty sections', () => {
      expect(() => buildSendBody(TO, { ...valid, button: 'x'.repeat(21) })).toThrow(
        /button label must be/,
      );
      expect(() => buildSendBody(TO, { ...valid, sections: [] })).toThrow(/at least one section/);
    });
  });

  describe('template', () => {
    it('maps name, language code and components', () => {
      const body = buildSendBody(TO, {
        type: 'template',
        name: 'hello_world',
        language: 'en_US',
        components: [{ type: 'body' }],
      });
      expect(body).toMatchObject({
        type: 'template',
        template: {
          name: 'hello_world',
          language: { code: 'en_US' },
          components: [{ type: 'body' }],
        },
      });
    });

    it('rejects a missing name or language', () => {
      expect(() => buildSendBody(TO, { type: 'template', name: '', language: 'en' })).toThrow(
        /template name/,
      );
      expect(() => buildSendBody(TO, { type: 'template', name: 'n', language: '' })).toThrow(
        /template language/,
      );
    });
  });
});
