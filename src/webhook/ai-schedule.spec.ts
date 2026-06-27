import { AiSchedule, isAiAvailable } from './ai-schedule';

// America/Lima is UTC-5 year-round (no DST), so a wall-clock "HH:mm" in Lima
// maps to UTC + 5h. Helper builds the UTC instant for a given Lima wall time.
function limaInstant(isoLocal: string): Date {
  // isoLocal e.g. "2026-06-25T22:00" (Lima local). Append the fixed -05:00.
  return new Date(`${isoLocal}:00-05:00`);
}

const schedule: AiSchedule = {
  timezone: 'America/Lima',
  thursday: { active: true, start: '22:00', end: '07:00' }, // Thu 22:00 -> Fri 07:00
  friday: { active: true, start: '22:00', end: '09:00' }, // Fri 22:00 -> Sat 09:00
  monday: { active: false, start: '09:00', end: '18:00' },
  tuesday: { active: false, start: '09:00', end: '18:00' },
  wednesday: { active: false, start: '09:00', end: '18:00' },
  saturday: { active: false, start: '09:00', end: '18:00' },
  sunday: { active: false, start: '09:00', end: '18:00' },
};

describe('isAiAvailable', () => {
  // 2026-06-25 is a Thursday, 2026-06-26 Friday, 2026-06-27 Saturday.
  const cases: Array<[string, string, boolean]> = [
    ['Thu 21:59 — before start', '2026-06-25T21:59', false],
    ['Thu 22:00 — start (crosses midnight)', '2026-06-25T22:00', true],
    ['Fri 03:00 — yesterday window (03:00 < 07:00)', '2026-06-26T03:00', true],
    ['Fri 07:00 — yesterday window ended', '2026-06-26T07:00', false],
    ['Fri 12:00 — no day covers it', '2026-06-26T12:00', false],
    ['Fri 22:00 — friday start', '2026-06-26T22:00', true],
    ['Sat 05:00 — yesterday window (05:00 < 09:00)', '2026-06-27T05:00', true],
    ['Sat 09:00 — yesterday window ended', '2026-06-27T09:00', false],
  ];

  it.each(cases)('%s', (_label, isoLocal, expected) => {
    expect(isAiAvailable(schedule, limaInstant(isoLocal))).toBe(expected);
  });

  it('returns true (24/7) when schedule is null/undefined', () => {
    expect(isAiAvailable(null, limaInstant('2026-06-26T12:00'))).toBe(true);
    expect(isAiAvailable(undefined, limaInstant('2026-06-26T12:00'))).toBe(true);
  });

  it('treats a same-day window normally (start < end)', () => {
    const s: AiSchedule = {
      timezone: 'America/Lima',
      friday: { active: true, start: '09:00', end: '18:00' },
    };
    expect(isAiAvailable(s, limaInstant('2026-06-26T08:59'))).toBe(false);
    expect(isAiAvailable(s, limaInstant('2026-06-26T09:00'))).toBe(true);
    expect(isAiAvailable(s, limaInstant('2026-06-26T17:59'))).toBe(true);
    expect(isAiAvailable(s, limaInstant('2026-06-26T18:00'))).toBe(false);
  });

  it('ignores an active day where start === end (empty/ambiguous window)', () => {
    const s: AiSchedule = {
      timezone: 'America/Lima',
      friday: { active: true, start: '09:00', end: '09:00' },
    };
    expect(isAiAvailable(s, limaInstant('2026-06-26T09:00'))).toBe(false);
    expect(isAiAvailable(s, limaInstant('2026-06-26T12:00'))).toBe(false);
  });

  it('falls back to America/Lima when timezone is absent', () => {
    const s: AiSchedule = {
      friday: { active: true, start: '09:00', end: '18:00' },
    };
    expect(isAiAvailable(s, limaInstant('2026-06-26T12:00'))).toBe(true);
  });

  it('fails open (24/7) on an invalid timezone', () => {
    const s: AiSchedule = {
      timezone: 'Not/AZone',
      friday: { active: false, start: '09:00', end: '18:00' },
    };
    expect(isAiAvailable(s, limaInstant('2026-06-26T12:00'))).toBe(true);
  });
});
