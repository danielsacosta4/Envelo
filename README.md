# Envelo

Envelope budgeting you can run on your own server, with an account per person.

Every dollar gets a job: income lands in **Ready to assign**, you move it into
envelopes (Rent, Groceries, Emergency fund…), and spending draws each envelope
down. Unspent money rolls over automatically.

## What's different from YNAB

- **Yours to host.** Runs on a small server in your home (a Proxmox container
  is a one-line install). No subscription, no third party holds your data.
- **Accounts, synced everywhere.** Sign in from any device and see the same
  budget.
- **No bank linking required.** Transactions are entered by hand, so there is
  no aggregator holding your bank credentials.
- **Goals show what you still need.** An envelope with a target balance shows
  how much is missing and offers a one-click "Fund goal".
- **Transparent math.** Available = everything assigned + all activity, so you
  can check any number by hand. The core logic lives in `src/budget.js`.
- **Portable.** Export a JSON backup and import it anywhere.
- **Move from Actual Budget.** Import Actual's full export (Settings → Export
  data, a .zip): accounts, category groups, transactions (splits and transfers
  included) and budgeted amounts per month. A transactions .csv also works.

## Features

- Envelopes with six target types (monthly, weekly, refill, balance, balance
  by a date, repeating bill). Shortfalls show in red; "Fund all targets" fills
  them from Ready to Assign.
- Accounts with starting balances, transfers between accounts, and
  reconciling against your bank balance.
- Recurring transactions (weekly, every 2 weeks, monthly, yearly), created
  automatically when due.
- Reports: spending per envelope plus income, spending and net per month.
- Edit any transaction; rename, regroup or delete envelopes (moving their
  transactions to another envelope).
- Works on phones, with light and dark themes.

## Run it

Needs Node.js 18 or newer. No other dependencies.

```sh
npm start                      # http://localhost:3000
PORT=8080 DATA_DIR=./mydata npm start
```

Environment variables:

| Variable         | Default        | Purpose                                              |
|------------------|----------------|------------------------------------------------------|
| `PORT`           | `3000`         | Port to listen on                                    |
| `HOST`           | `0.0.0.0`      | Interface to bind to                                 |
| `DATA_DIR`       | `./data`       | Where accounts and budgets are stored                |
| `SECURE_COOKIES` | unset          | Set to `1` when serving over HTTPS (adds `Secure`)   |

To install on a Proxmox VE host in a new container, run this on the host as root:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/danielsacosta4/Envelo/main/scripts/install-proxmox.sh)"
```

## Accounts and data

- Each person creates an account with an email and a password (8+ characters).
- Passwords are hashed with scrypt and never stored in plain text.
- Sessions last 30 days and are sent as an HttpOnly cookie.
- Each account only ever reads and writes its own budget.
- Repeated failed sign-ins are rate limited per IP.
- All data is in one JSON file, `DATA_DIR/db.json`, written atomically and
  readable only by the server user.
- The server keeps a daily copy in `DATA_DIR/backups/`, for the last 14 days.
  To restore one, stop the service and copy it over `db.json`.
- Saves carry a revision number. If another device saved first, the save is
  refused and the app shows the latest version, so devices never silently
  overwrite each other.

## Security notes

- Serve Envelo over **HTTPS** before using it outside your home network. The
  server speaks plain HTTP. Put a reverse proxy with a certificate in front and
  set `SECURE_COOKIES=1`.
- API writes must be `application/json`, which blocks simple cross-site form
  attacks.

## Test

```sh
npm test
```

Runs the budget-logic tests and the server tests (accounts, isolation, input
validation, rate limiting, static file access) with Node's built-in test runner.

## Layout

- `index.html`: the page (sign-in screen and the app)
- `server/server.js`: accounts, sessions, budget storage and static files
- `src/budget.js`: pure budgeting logic, integer cents, no DOM
- `src/app.js`: UI, saving to the server, backup and import
- `src/styles.css`: styles
- `scripts/install-proxmox.sh`: one-line Proxmox LXC installer
- `test/`: logic and server tests
- `design/`: design mockups (not served)

## Notes

- Money is stored as integer cents to avoid floating-point drift.
- Changes are saved to the server about a third of a second after you make
  them. If the server is unreachable, the app keeps your changes on screen and
  retries.
- Overspent envelopes stay negative and carry into later months until you
  assign money to them.
