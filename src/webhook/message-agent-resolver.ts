import { stripAdPreamble } from './ad-preamble';
import { MessageAgentRule } from './group-fetcher';

/**
 * Resolves an inbound message to a `general_settings.message_agents` rule by
 * prefix match: the message (with any ad-platform `Headline:`/`*Source URL:*`
 * preamble stripped) must start with `rule.message`. Rules are checked in
 * array order — order matters, same caveat as `channel-resolver.matchString`
 * — and the first match wins. Returns `undefined` when no rule matches or
 * `rules` is empty/undefined.
 */
export function resolveAgentForMessagePrefix(
  message: string,
  rules: MessageAgentRule[] | undefined,
): MessageAgentRule | undefined {
  if (!rules || rules.length === 0) return undefined;
  const stripped = stripAdPreamble(message);
  return rules.find((rule) => stripped.startsWith(rule.message));
}
