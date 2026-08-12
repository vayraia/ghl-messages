import { resolveAgentForMessagePrefix } from './message-agent-resolver';
import { MessageAgentRule } from './group-fetcher';

describe('resolveAgentForMessagePrefix', () => {
  const rules: MessageAgentRule[] = [
    { message: '¡Hola! Quiero más información', agentId: 'agent_ads' },
    { message: 'Hola', agentId: 'agent_generic' },
  ];

  it('returns undefined when rules is undefined', () => {
    expect(resolveAgentForMessagePrefix('Hola', undefined)).toBeUndefined();
  });

  it('returns undefined when rules is empty', () => {
    expect(resolveAgentForMessagePrefix('Hola', [])).toBeUndefined();
  });

  it('matches a plain prefix with no preamble', () => {
    expect(resolveAgentForMessagePrefix('Hola, buenas tardes', rules)).toEqual(rules[1]);
  });

  it('strips the ad preamble before matching', () => {
    const message =
      'Headline: Épica\n*Source URL:* https://www.instagram.com/p/DO01q06gO1c/\n\n¡Hola! Quiero más información';

    expect(resolveAgentForMessagePrefix(message, rules)).toEqual(rules[0]);
  });

  it('respects rule order — first match wins', () => {
    const orderedRules: MessageAgentRule[] = [
      { message: 'Hola', agentId: 'agent_first' },
      { message: 'Hola, buenas', agentId: 'agent_second' },
    ];

    expect(resolveAgentForMessagePrefix('Hola, buenas tardes', orderedRules)).toEqual(
      orderedRules[0],
    );
  });

  it('returns undefined when no rule prefix matches', () => {
    expect(resolveAgentForMessagePrefix('Buenas tardes', rules)).toBeUndefined();
  });

  it('does not match when the incoming message is shorter than the rule prefix', () => {
    expect(resolveAgentForMessagePrefix('Ho', rules)).toBeUndefined();
  });

  it('matches when the incoming message equals the rule prefix exactly', () => {
    expect(resolveAgentForMessagePrefix('Hola', rules)).toEqual(rules[1]);
  });
});
