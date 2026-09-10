# Reading the analytics numbers

`senso analytics` reports how often AI models name your brand and which pages
they cite. The metrics are easy to misread in ways that lead to the wrong
decision, so this page states what each one divides by.

`senso analytics glossary` is the canonical, machine-readable version of the
same thing — it returns the definition, denominator and gotcha for every metric
straight from the API, so it cannot drift from what the numbers actually mean.

## The denominators

This is the whole of it. Almost every misreading is a denominator confusion.

| Metric                   | Numerator                                   | Denominator                                                          |
| ------------------------ | ------------------------------------------- | -------------------------------------------------------------------- |
| **Mention Rate**         | answers that named your brand               | answers received                                                     |
| **Share of Voice**       | your mention instances                      | `brand_mention_total` — mentions of **every** brand the models named |
| **Citation Rate**        | answers citing a page in that tier          | `D` — answers with at least one citation                             |
| **Citation Coverage**    | answers citing this specific domain or page | `D`                                                                  |
| **Citation Share**       | citation instances in that tier             | `S` — total citation instances                                       |
| **Citations per Answer** | citation instances                          | answers with at least one citation                                   |

Three consequences worth holding on to:

- **Share of Voice is not "share among your competitors."** The denominator is
  every brand the models named, including ones you do not track. Adding a
  competitor to your tracked set does not change it. `tracked_mention_total` is
  returned as a raw count, and it is not the denominator.

- **Rate and Share are different metrics, not two renderings of one.** Rate and
  Coverage divide by `D`; Share divides by `S`. Calling a rate a share is the
  single most common error in a report.

- **The three tier rates can sum past 100%; the three tier shares sum to exactly
  100%.** One answer can cite an owned page and an external page, so it counts in
  two rates. It contributes its citations to two shares, which still partition.

## `—` means not measured

A metric renders as an em dash when its denominator was zero. That is **not**
0%. "No answers carried a citation, so a citation rate has no meaning" and
"answers carried citations and none were yours" are different findings, and
collapsing them into 0% turns the first into a false alarm.

Every table prints the numerator and denominator beside the percentage, so the
distinction is visible without going back to the payload.

## `notes[]`

Every analytics response carries a `notes` array: the caveats that apply to the
window you asked for. Truncated windows, null denominators, and results that
depend on which competitors you track all surface here.

They are printed under a **Notes** heading in `plain` and `table`, and are part
of the payload under `--output json` — where they are not printed separately,
because a JSON consumer already has them.

## The window

`--from` and `--to` take `YYYY-MM-DD`. Left unset, they default to the 30 days
ending at the most recent day that has data for your model and location filter,
not to today — a window ending on a day with no runs would report zeros that mean
"not collected yet".

The maximum window is 365 days. `--models` and `--location` are comma-separated,
and locations are case-sensitive exact codes (`US`, `US/California`). Run
`senso analytics filters` to see the values that actually have data for your
organization, rather than guessing and reading an empty result.

## `analytics answers` is a snapshot, not a window

This one surprises people, so it is worth stating plainly.

`analytics answers` always returns the **newest stored answer** per prompt ×
model × location. `--from` and `--to` filter on `run_at` — when that answer was
collected — so narrowing the window **hides** combinations whose latest answer
falls outside it. It does not return older answers in their place.

For history, use `analytics mentions` or `analytics citations`, which are
genuinely windowed.

## Which command answers which question

| Question                                         | Command                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| How am I doing overall, and against last period? | `analytics summary`                                 |
| Is my visibility trending up or down?            | `analytics mentions --group-by week`                |
| Are my own pages being cited, or someone else's? | `analytics citations`                               |
| Which domains do the models trust here?          | `analytics domains`                                 |
| Which specific pages, and for which prompts?     | `analytics pages`                                   |
| Which prompts am I losing?                       | `analytics prompts --sort mention_rate --order asc` |
| What did the model actually say?                 | `analytics answers`                                 |
| What does this number mean?                      | `analytics glossary`                                |
