# MvP Chase (Call of Cthulhu 7e)

A Foundry VTT module that runs chases with the **Keeper Companion's optional "New Chase Rules"** (Movement Points) for the Call of Cthulhu 7th Edition system. It does not use or change CoC7's built-in Chase item, which follows the Rulebook's speed-roll rules.

## The rules it runs

- Everyone has **MvP equal to MOV**, halved (rounded down) for a major wound.
- Everyone starts in **Location 1**. Each round the **quarry act first, then the pursuers**, highest DEX first.
- Each location has **one challenge** (a skill such as Climb or Dodge, a characteristic such as DEX or CON, or Luck). Locations start at Regular difficulty, and the Keeper can change any location's difficulty.
- **Success:** move on to the next location.
- **Failure:** choose one of three:
  - **lose 1D6 MvP**, and still move on with 1 or more MvP left;
  - **spend Luck** equal to the difference, and pass;
  - **push** the skill roll. A failed push puts the character out of the chase.
- **At 0 MvP:** a quarry is **caught** at once, and a pursuer **drops out**. When no pursuers are left, the remaining quarry **escape**.
- **Options:**
  - **Head start:** pursuers take a penalty die on their first challenge.
  - **Shooting while running:** a penalty die on the challenge.
  - **Helping an ally at 0 MvP:** the helper pays 1 MvP, the ally stays in with 1, and the helper takes a penalty die on their next challenge.
  - **Major wound mid-chase:** halves current MvP.
  - **Monster without the skill:** uses DEX (skilled), half DEX (average, the default) or one fifth DEX (poor).

## Using it

1. As the Keeper, click the running-man **Chase** button on the token controls.
2. Name the chase and Location 1, then click **New chase**.
3. Select tokens, then click **Add selected as quarry** or **Add selected as pursuers**. Tick the head-start box if it applies, then click **Start chase**.
4. Type a challenge for each location (for example `Climb`, `DEX` or `Luck`), and pick its difficulty.
5. On each turn, click one of these:
   - **Roll** rolls as the character, using the normal CoC7 check card.
   - **Ask player** posts a roll button. The player's roll resolves the turn.
   - **Passed** or **Failed** records a roll made at the table.
   - **Skip** passes the turn.
6. After a failure, choose **Lose 1D6 MvP**, **Spend Luck** or **Push**.

Every step is posted to chat. Players see a read-only tracker.

### Macro API

```js
const chase = game.modules.get('coc7-mvp-chase').api;
chase.open();
await chase.start({ name: 'Cairo bazaar', firstLocation: 'the spice alley',
  firstCheck: { kind: 'characteristic', name: 'dex' },
  quarry: [{ tokenId: 'abc' }], pursuers: [{ tokenId: 'def', skillTier: 'average' }], headStart: true });
await chase.setLocation({ index: 2, name: 'a high wall', check: { kind: 'skill', name: 'Climb' }, difficulty: 'hard' });
await chase.takeTurn({ mode: 'roll' });        // or 'request', 'pass', 'fail'; bonusDice, shooting
await chase.resolve('take-loss');              // or 'luck', 'push'
await chase.act({ action: 'help', participant: 'Helper', ally: 'Fallen' }); // skip, major-wound, adjust, remove, end
chase.get();                                   // current state
```

## Install

Copy the built `coc7-mvp-chase` folder into your Foundry `Data/modules` folder, or use the manifest URL from the latest release. Then enable **MvP Chase** in your CoC7 world.

## Development

```
npm install
npm run all     # lint, tests, build to dist/coc7-mvp-chase
```

MIT licensed.
