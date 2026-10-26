import { describe, expect, it } from 'vitest';
import { hasNewContact, moneyAmounts, wordsToDigits } from '../src/pipeline/text';

describe('spoken numbers', () => {
  it('turns spelled-out numbers into digits', () => {
    expect(wordsToDigits('one point two five million dirhams')).toBe('1.25 million dirhams');
    expect(wordsToDigits('one and a half million')).toBe('1.5 million');
    expect(wordsToDigits('eight hundred and fifty thousand AED')).toBe('850000 AED');
    expect(wordsToDigits('twenty-five')).toBe('twenty-five'); // hyphenated forms are left alone
    expect(wordsToDigits('which one, the two-bedroom?')).toBe('which 1, the two-bedroom?');
  });

  it('reads money amounts written or spoken, and ignores bedrooms and years', () => {
    expect(moneyAmounts('Prices start at one point two five million dirhams, handover in 2027.')).toEqual([1_250_000]);
    expect(moneyAmounts('From AED 1,250,000 for a one-bedroom.')).toEqual([1_250_000]);
    expect(moneyAmounts('Around 2.1m.')).toEqual([2_100_000]);
    expect(moneyAmounts('eight hundred and fifty thousand dirhams')).toEqual([850_000]);
    expect(moneyAmounts('Three bedrooms, ready in 2027.')).toEqual([]);
  });

  it('spots a new contact the agent must read back', () => {
    expect(hasNewContact('Send it to omar at gmail dot com')).toBe(true);
    expect(hasNewContact('Use my work number, oh five oh one two three four five six seven')).toBe(true);
    expect(hasNewContact('Yes, this number is fine.')).toBe(false);
    expect(hasNewContact('Can you send me the brochure on WhatsApp?')).toBe(false);
  });
});
