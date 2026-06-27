/**
 * AI availability schedule (`general_settings.ai_schedule`).
 *
 * Lets a group restrict, per weekday, the time windows in which the AI may
 * answer inbound messages. A day "owns" the window that *starts* on it; when
 * `end <= start` the window crosses midnight and spills into the next day
 * (e.g. thursday `22:00 -> 07:00` covers Thu 22:00 until Fri 07:00).
 *
 * Times are 24h `"HH:mm"` strings compared lexicographically — `"09:00" <
 * "18:00"` holds, so no minute parsing is needed. Evaluation always uses the
 * group's IANA `timezone` (default `America/Lima`).
 */

export const DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type DayName = (typeof DAY_KEYS)[number];

export interface DaySchedule {
  active: boolean;
  start: string; // "HH:mm"
  end: string; // "HH:mm"
}

export type AiSchedule = {
  timezone?: string;
} & Partial<Record<DayName, DaySchedule>>;

const DEFAULT_TIMEZONE = 'America/Lima';

// Intl `weekday: 'short'` (en-US) -> index into DAY_KEYS (monday = 0).
const SHORT_DAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/**
 * Decides whether the AI is available at the instant `now` for the given
 * schedule. Returns `true` (24/7, current behaviour) when:
 *  - `schedule` is absent / null, or
 *  - the configured timezone is invalid (fail-open: never silence the bot on
 *    bad config).
 *
 * Only two days are ever inspected — today and yesterday — because every
 * window is independent and at most one can spill across midnight into now.
 */
export function isAiAvailable(
  schedule: AiSchedule | null | undefined,
  now: Date,
): boolean {
  if (!schedule) return true;

  let dayIdx: number;
  let hhmm: string;
  try {
    ({ dayIdx, hhmm } = zonedNow(now, schedule.timezone || DEFAULT_TIMEZONE));
  } catch {
    // Invalid IANA timezone — fail open rather than block all replies.
    return true;
  }

  const todayName = DAY_KEYS[dayIdx];
  const yesterdayName = DAY_KEYS[(dayIdx + 6) % 7];

  // 1) Window that STARTS today.
  const today = schedule[todayName];
  if (today && today.active && today.start !== today.end) {
    if (today.start < today.end) {
      // Same-day window.
      if (today.start <= hhmm && hhmm < today.end) return true;
    } else {
      // Crosses midnight — covers start..23:59 of today.
      if (hhmm >= today.start) return true;
    }
  }

  // 2) Window that STARTED yesterday and spills into today (00:00..end).
  const prev = schedule[yesterdayName];
  if (prev && prev.active && prev.start !== prev.end && prev.end <= prev.start) {
    if (hhmm < prev.end) return true;
  }

  return false;
}

/**
 * Projects a UTC instant onto a wall-clock weekday + `"HH:mm"` in the given
 * IANA timezone. Yesterday is derived by index (not by subtracting 24h) so DST
 * transitions can't shift the weekday.
 *
 * Throws `RangeError` when `timeZone` is not a valid IANA zone — callers treat
 * that as fail-open.
 */
function zonedNow(now: Date, timeZone: string): { dayIdx: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  let weekday = '';
  let hour = '00';
  let minute = '00';
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour') hour = p.value;
    else if (p.type === 'minute') minute = p.value;
  }

  const dayIdx = SHORT_DAY_INDEX[weekday];
  if (dayIdx === undefined) {
    throw new RangeError(`Unexpected weekday "${weekday}" for timezone ${timeZone}`);
  }
  // `hourCycle: 'h23'` yields "00".."23"; guard against the legacy "24:00".
  const hh = hour === '24' ? '00' : hour;
  return { dayIdx, hhmm: `${hh}:${minute}` };
}
