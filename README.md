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
  - **push** the roll (skill or characteristic rolls; Luck rolls can't be pushed). A failed push puts the character out of the chase.
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
4. Give each location a name and, if you like, an **obstacle** ("a locked gate", "a crowded market"). Type a challenge for each location (and optionally a second one in the **or** box, such as `Climb` or `Stealth`, so the character picks which to roll). Challenges can be skills, characteristics such as `DEX`, or `Luck`. Pick each location's difficulty. Suggestions come from the skills on the chase's own character sheets, so house-ruled skill lists work too; any skill name can be typed. Remove a location with its ✕ button (the ones after it move down a number; you can't remove one where someone is standing).
5. When it's a player character's turn, the player gets a roll button in chat straight away, and their roll resolves the turn. If they fail, they get buttons in chat to **roll their own 1D6** MvP loss, **spend Luck** or **push** the roll. Untick "Players roll their own checks" to roll everything yourself. A character with a ranged weapon also gets a **Shoot while running** dropdown on that card: the player picks a gun, the CoC7 attack card opens for them with the penalty die set, and the chase check takes its penalty die too. If you tick Shooting with a weapon and press **Ask player**, the card arrives with that gun picked and the player fires it.
6. For the Keeper's characters, or to override, click one of these (set **Bonus** first for bonus or penalty dice):
   - **Roll** rolls as the character, using the normal CoC7 check card.
   - **Ask player** posts a roll button (again). It only shows for characters a player owns.
   - **Passed** or **Failed** records a roll made at the table.
   - **Skip** passes the turn.
   - **Shooting** adds a penalty die to the chase check. Pick a ranged weapon next to it and the CoC7 attack card is opened too, with the penalty die already set.
7. After a failure, choose **Lose 1D6 MvP**, **Spend Luck** or **Push** in the tracker, or let the player choose in chat.

To fix a mistake, use the ◀ ▶ arrows by a character's location to move them back or forward one location (their MvP and turn don't change), or edit MvP and location directly. **Restart** puts the same chase back to the start: same people and locations, everyone in Location 1 with full MvP, ready to press Start again.

**Undo last step** reverses the last roll, choice or Keeper change (up to 10 steps); chat cards already posted stay.

**Chase strip:** while a chase runs (until it ends), everyone sees a slim bar above the hotbar with the locations in a row and each character's portrait where they are (gold for quarry, red for pursuers, the one acting glows). Fold it away with ▼, or drag it by its title bar to anywhere on screen (each person's spot is remembered; double-click the title bar to put it back). Players only see a location's name, obstacle and challenge once one of their characters has reached it; until then it shows as "Location 4" with a "?". The Keeper sees everything (an eye-slash marks the hidden ones in the tracker). The chase log in the tracker is the Keeper's only, for the same reason.

**Saved chases:** pick **＋ New chase…** in the Chase list at the top of the tracker to set the current chase aside and make another, so you can prepare several before a session (name, locations, challenges and characters). Switch between them from the same list; each keeps everything, even mid-chase. The trash button deletes only the chase on the table.

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
