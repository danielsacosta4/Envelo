# Envelo

Envelope budgeting that runs entirely in your browser.

Every dollar gets a job: income lands in **Ready to assign**, you move it into
envelopes (Rent, Groceries, Emergency fund…), and spending draws each envelope
down. Unspent money rolls over automatically.

## What's different from YNAB

- **Local-first, no subscription.** Data lives in your browser's localStorage.
  Nothing is sent to a server, and there is no account.
- **No bank linking required.** Transactions are entered by hand, so there is
  no third-party aggregator holding your credentials.
- **Goals show what you still need.** An envelope with a target balance shows
  how much is missing and offers a one-click "Fund goal".
- **Transparent math.** Available = everything assigned + all activity, so you
  can check any number by hand. The core logic lives in `src/budget.js`.
- **Portable.** Export a JSON backup and import it anywhere.

## Run it

No build step and no dependencies. Open `index.html` in a browser, or serve the
folder with any static server:

```sh
npx serve .
```

## Test

```sh
npm test
```

Runs the budget-logic tests with Node's built-in test runner (Node 18+).

## Layout

- `index.html`: the page
- `src/budget.js`: pure budgeting logic, integer cents, no DOM
- `src/app.js`: UI, storage, backup and import
- `src/styles.css`: styles with light and dark themes
- `test/budget.test.js`: logic tests

## Notes

- Money is stored as integer cents to avoid floating-point drift.
- Clearing browser data erases Envelo's data. Export a backup regularly.
- Overspent envelopes stay negative and carry into later months until you
  assign money to them.
