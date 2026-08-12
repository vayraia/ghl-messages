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
const PREAMBLE_LINE_RE = /^(headline:|\*source url:\*)/i;

export function stripAdPreamble(text: string): string {
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length && PREAMBLE_LINE_RE.test(lines[i].trim())) {
    i++;
  }

  // No preamble line matched, or the block isn't followed by the blank-line
  // separator — treat as a normal message and leave it untouched.
  if (i === 0 || lines[i]?.trim() !== '') {
    return text;
  }

  return lines
    .slice(i + 1)
    .join('\n')
    .trim();
}
