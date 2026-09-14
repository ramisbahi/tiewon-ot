import type { BotConfig } from './config';
import type { Post } from './policy';
import { Store } from './store';
import { publishPost, WELCOME_POST } from './engine';

// Preserve the original root key so an already-sent welcome becomes the thread root.
export const WELCOME_THREAD: Post[] = [
  WELCOME_POST,
  ...[
  {
    "key": "account-welcome:v1:part:2",
    "gameId": "account-welcome",
    "kind": "welcome",
    "probability": null,
    "text": "2/6 Two probabilities, two different things:\n\n🏈 Overtime: tied after Q4.\n🤝 Final tie: still tied when OT ends.\n\nBefore OT, our current estimate is P(OT) × 10%. So a 40% OT chance means about a 4% final-tie chance. That 10% is a baseline, not a certainty."
  },
  {
    "key": "account-welcome:v1:part:3",
    "gameId": "account-welcome",
    "kind": "welcome",
    "probability": null,
    "text": "3/6 Automated game posting is still being brought online. Once live, expect:\n\n• Updates after each quarter (Q4 = final recap or OT alert).\n• Q4 alerts above 20%, 50%, 75% and 90% OT probability.\n• Separate threads for each game."
  },
  {
    "key": "account-welcome:v1:part:4",
    "gameId": "account-welcome",
    "kind": "welcome",
    "probability": null,
    "text": "4/6 🚨🚨🚨 ‼️ NUCLEAR TieWatch 🇹🇭⌚️ ‼️ 🚨🚨🚨\n\nThat's our siren when a game goes to OVERTIME!\n\n🇹🇭 = Thai. ⌚️ = watch. Thai Watch. TieWatch. Yes, we're committing to the bit.\n\nOT has arrived. Can this one finish with NO WINNER? 👀"
  },
  {
    "key": "account-welcome:v1:part:5",
    "gameId": "account-welcome",
    "kind": "welcome",
    "probability": null,
    "text": "5/6 During OT, we estimate the final-tie chance from the score, time, possession and OT rules, with alerts above 20%, 50%, 75% and 90%.\n\nNo fixed 10% during OT. These are model estimates, not sportsbook odds. Playoff games cannot end tied."
  },
  {
    "key": "account-welcome:v1:part:6",
    "gameId": "account-welcome",
    "kind": "welcome",
    "probability": null,
    "text": "6/6 Every tracked game's final recap reports its peak observed final-tie chance and highest OT forecast before OT.\n\nExplore live probability charts, saved game histories and the simulator:\nhttps://tiewon.sbahirami.chatgpt.site\n\nWelcome to TieWatch 🇹🇭⌚️ #TieWon"
  }
] as Post[],
];

export async function publishWelcome(store: Store, config: BotConfig, send: (text: string, replyTo?: string) => Promise<string>, now = Date.now(), log: (message: string) => void = console.log) {
  let published = 0;
  for (const candidate of WELCOME_THREAD) {
    // Look up by key, not the limited recent-history list. Resume even days later.
    if (store.sentPost(candidate.key)) continue;
    if (!await publishPost({ ...candidate }, store, config, send, now, log)) break;
    published++;
  }
  return { published, complete: WELCOME_THREAD.every(p => Boolean(store.sentPost(p.key))) };
}
