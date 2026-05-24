import { summarizeMetaPayload } from './meta-tenant';

describe('summarizeMetaPayload', () => {
  it('returns unknown for non-object input', () => {
    expect(summarizeMetaPayload(null)).toEqual({ object: 'unknown', entries: 0, events: [] });
    expect(summarizeMetaPayload('hi')).toEqual({ object: 'unknown', entries: 0, events: [] });
  });

  it('extracts a Messenger DM with page tenant key', () => {
    const r = summarizeMetaPayload({
      object: 'page',
      entry: [
        {
          id: 'PAGE_123',
          messaging: [
            {
              sender: { id: 'PSID_AAA' },
              recipient: { id: 'PAGE_123' },
              timestamp: 1700000000000,
              message: { mid: 'm1', text: 'hola' },
            },
          ],
        },
      ],
    });
    expect(r.object).toBe('page');
    expect(r.entries).toBe(1);
    expect(r.events).toEqual([
      {
        tenantKey: 'page:PAGE_123',
        entryId: 'PAGE_123',
        kind: 'message',
        sender: 'PSID_AAA',
        recipient: 'PAGE_123',
        timestamp: 1700000000000,
        messageType: 'text',
        hasText: true,
      },
    ]);
  });

  it('marks Messenger echo events with kind=echo', () => {
    const r = summarizeMetaPayload({
      object: 'page',
      entry: [
        {
          id: 'PAGE_1',
          messaging: [
            {
              sender: { id: 'PAGE_1' },
              recipient: { id: 'PSID' },
              timestamp: 1,
              message: { mid: 'm2', text: 'reply', is_echo: true },
            },
          ],
        },
      ],
    });
    expect(r.events[0].kind).toBe('echo');
  });

  it('extracts an Instagram DM with ig tenant key and attachment type', () => {
    const r = summarizeMetaPayload({
      object: 'instagram',
      entry: [
        {
          id: 'IG_999',
          messaging: [
            {
              sender: { id: 'IGSID_x' },
              recipient: { id: 'IG_999' },
              timestamp: 1700000001000,
              message: {
                mid: 'm3',
                attachments: [{ type: 'image', payload: { url: 'https://x' } }],
              },
            },
          ],
        },
      ],
    });
    expect(r.events).toEqual([
      {
        tenantKey: 'ig:IG_999',
        entryId: 'IG_999',
        kind: 'message',
        sender: 'IGSID_x',
        recipient: 'IG_999',
        timestamp: 1700000001000,
        messageType: 'image',
        hasText: false,
      },
    ]);
  });

  it('keys WhatsApp by phone_number_id, not by WABA id', () => {
    const r = summarizeMetaPayload({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_555',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: {
                  phone_number_id: 'PHONE_NUM_1',
                  display_phone_number: '+5491155555555',
                },
                messages: [
                  {
                    from: '5491166666666',
                    id: 'wamid.1',
                    type: 'text',
                    timestamp: '1700000002',
                    text: { body: 'hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(r.events).toEqual([
      {
        tenantKey: 'wa:PHONE_NUM_1',
        entryId: 'WABA_555',
        kind: 'message',
        sender: '5491166666666',
        recipient: 'PHONE_NUM_1',
        timestamp: 1700000002,
        messageType: 'text',
        hasText: true,
        displayPhone: '+5491155555555',
      },
    ]);
  });

  it('captures WhatsApp delivery statuses with kind=status', () => {
    const r = summarizeMetaPayload({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_X',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: {
                  phone_number_id: 'PN_2',
                  display_phone_number: '+5491100000000',
                },
                statuses: [
                  {
                    id: 'wamid.s1',
                    recipient_id: '5491177777777',
                    status: 'delivered',
                    timestamp: '1700000003',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      tenantKey: 'wa:PN_2',
      kind: 'status',
      messageType: 'delivered',
      sender: 'PN_2',
      recipient: '5491177777777',
      displayPhone: '+5491100000000',
    });
  });

  it('emits one event per tenant when a batch spans multiple accounts', () => {
    const r = summarizeMetaPayload({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_A',
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PN_A', display_phone_number: '+1' },
                messages: [{ from: '111', type: 'text', timestamp: '1', text: { body: 'hi' } }],
              },
            },
          ],
        },
        {
          id: 'WABA_B',
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PN_B', display_phone_number: '+2' },
                messages: [{ from: '222', type: 'text', timestamp: '2', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    });
    expect(r.entries).toBe(2);
    expect(r.events.map((e) => e.tenantKey)).toEqual(['wa:PN_A', 'wa:PN_B']);
  });

  it('falls back to tenantKey=*:unknown when ids are missing', () => {
    const r = summarizeMetaPayload({ object: 'page', entry: [{ messaging: [{}] }] });
    expect(r.events[0].tenantKey).toBe('page:unknown');
    expect(r.events[0].entryId).toBeUndefined();
  });

  it('reports unknown object types without crashing', () => {
    const r = summarizeMetaPayload({ object: 'something_else', entry: [{ id: 'X' }] });
    expect(r.object).toBe('unknown');
    expect(r.events[0]).toEqual({ tenantKey: 'unknown:X', entryId: 'X', kind: 'unknown' });
  });
});
