from calleval.pipeline.text import has_new_contact, money_amounts, words_to_digits


def test_turns_spelled_out_numbers_into_digits():
    assert words_to_digits('one point two five million dirhams') == '1.25 million dirhams'
    assert words_to_digits('one and a half million') == '1.5 million'
    assert words_to_digits('eight hundred and fifty thousand AED') == '850000 AED'
    assert words_to_digits('twenty-five') == 'twenty-five'  # hyphenated forms are left alone
    assert words_to_digits('which one, the two-bedroom?') == 'which 1, the two-bedroom?'


def test_reads_money_amounts_and_ignores_bedrooms_and_years():
    assert money_amounts('Prices start at one point two five million dirhams, handover in 2027.') == [1_250_000]
    assert money_amounts('From AED 1,250,000 for a one-bedroom.') == [1_250_000]
    assert money_amounts('Around 2.1m.') == [2_100_000]
    assert money_amounts('eight hundred and fifty thousand dirhams') == [850_000]
    assert money_amounts('Three bedrooms, ready in 2027.') == []


def test_spots_a_new_contact_the_agent_must_read_back():
    assert has_new_contact('Send it to omar at gmail dot com') is True
    assert has_new_contact('Use my work number, oh five oh one two three four five six seven') is True
    assert has_new_contact('Yes, this number is fine.') is False
    assert has_new_contact('Can you send me the brochure on WhatsApp?') is False


def test_words_that_are_object_properties_in_javascript_are_plain_words():
    # The TypeScript version threw on "constructor" (an inherited object key); here it is just a word.
    assert words_to_digits('the constructor said one') == 'the constructor said 1'
