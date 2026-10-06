/**
 * Ad-lead inbound messages (e.g. Instagram/Facebook "message" CTA) arrive with
 * a synthetic preamble prepended by the ad platform, e.g.:
 *
 *   "Headline: Épica\n*Source URL:* https://www.instagram.com/p/xyz/\n\n¡Hola! Quiero más información"
 *
 * `stripAdPreamble` strips that leading `Headline:`/`*Source URL:*` block (up
 * to and including the blank-line separator) so downstream prefix matching
 * (`message-agent-resolver`) compares against the contact's actual text, not
 * the platform-injected metadata.
 */
const PREAMBLE_LINE_RE = /^(\*?headline:|\*source url:\*)/i;

/**
 * Index of the blank separator line ending the preamble block, or `-1` when
 * there is no preamble (no preamble line matched, or the block isn't followed
 * by the blank-line separator). Shared by `stripAdPreamble` and `hasAdPreamble`
 * so both use the exact same criterion.
 */
function findPreambleEnd(lines: string[]): number {
  let i = 0;
  while (i < lines.length && PREAMBLE_LINE_RE.test(lines[i].trim())) {
    i++;
  }

  if (i === 0 || lines[i]?.trim() !== '') {
    return -1;
  }
  return i;
}

export function hasAdPreamble(text: string): boolean {
  return findPreambleEnd(text.split('\n')) !== -1;
}

export function stripAdPreamble(text: string): string {
  const lines = text.split('\n');

  // Not a preamble — treat as a normal message and leave it untouched.
  const end = findPreambleEnd(lines);
  if (end === -1) {
    return text;
  }

  return lines
    .slice(end + 1)
    .join('\n')
    .trim();
}
