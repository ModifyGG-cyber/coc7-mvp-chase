import { filterSuggestions } from '../SuggestBox';

describe('filterSuggestions', () => {
  const all = ['Athletics', 'Climb', 'Dodge', 'DEX', 'Fighting (Brawl)', 'Stealth'];
  it('shows everything when nothing is typed', () => {
    expect(filterSuggestions(all, '  ')).toEqual(all);
  });
  it('puts names that start with the text first, then ones that contain it', () => {
    expect(filterSuggestions(all, 'st')).toEqual(['Stealth']);
    expect(filterSuggestions(all, 'th')).toEqual(['Athletics', 'Stealth']);
    expect(filterSuggestions(all, 'de')).toEqual(['DEX']);
    expect(filterSuggestions(all, 'do')).toEqual(['Dodge']);
  });
});
