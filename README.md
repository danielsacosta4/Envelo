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
- **No bank linking required.** Enter transactions by hand or import your
  bank's CSV export, so no aggregator ever holds your bank credentials.
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
- Reports: income vs spending, spending by group, net worth over time and top
  envelopes as charts; a month-end forecast at the current pace; when each
  savings target will be reached; and the full table per envelope and month.
- Account pages: every transaction in an account with a running balance,
  search and date filters.
- Hide envelopes or whole groups, collapse groups, choose the row size, and
  print a month's budget.
- Targets show a coloured progress bar and a green, amber or orange outline
  around the assigned amount (funded, partly funded, not funded).
- Edit any transaction; rename, regroup or delete envelopes (moving their
  transactions to another envelope).
- Small celebrations: confetti when reconciling matches the bank, and euro
  notes flying into envelopes when you assign money (off with reduced motion).
- Goals across accounts, envelopes or net worth, with milestones, the
  amount needed per month and a forecast at your recent pace.
- Loans: track a mortgage or loan (rate, payment, original amount) to see
  what is owed, interest paid, the payoff date and what paying extra saves.
  A loan calculator handles fixed and variable rates and shows the
  amortization table.
- Live sync: changes appear on your other open devices within a second.
- Share chosen envelopes with another user, who can see them or also add
  spending to them. Only the owner assigns money.
- Bank CSV import for any bank: the separator, date format, decimal comma and
  columns are worked out (Revolut and N26 recognised), remembered per account,
  duplicates skipped and envelopes filled from what each payee was used for.
- Split transactions, move money between envelopes, cover overspending in a
  click, payee memory, search across every transaction, undo (Ctrl+Z) and
  keyboard shortcuts (press ? to see them).
- Receipt photos on transactions, stored as WebP and encrypted.
- A monthly recap (including what was overspent and envelopes that keep
  running short), streaks, and a setup guide for new budgets.
- Poster design with 16 group colours, three fonts, sounds (off by default)
  and a celebration when every euro has a job.
- Installs as an app on your phone and keeps working offline (over HTTPS).
- Two-step sign-in with an authenticator app, recovery codes, password
  changes that sign out other devices, and account deletion.
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
| `KEY_FILE`       | `DATA_DIR/secret.key` | Encryption key for the data (the installers use `/etc/envelo/secret.key`) |

To install on a Proxmox VE host in a new container, run this on the host as root:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/danielsacosta4/Envelo/main/scripts/install-proxmox.sh)"
```

On any other Debian or Ubuntu machine (a VM, a mini PC, a VPS), as root:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/danielsacosta4/Envelo/main/scripts/install.sh)"
```

Both install Node.js, SQLite and the Envelo service, and add two commands:
`update` (get the latest version; your data is backed up first) and `envelo`
(admin: `envelo users`, `envelo reset-password <email>`,
`envelo reset-2fa <email>`, `envelo delete-user <email>`).

To try an unreleased branch in a separate test container, set `REF`:

```sh
REF=some-branch HOSTNAME_CT=envelo-test bash -c "$(curl -fsSL https://raw.githubusercontent.com/danielsacosta4/Envelo/main/scripts/install-proxmox.sh)"
```

## Accounts and data

- Each person creates an account with an email and a password (8+ characters).
- Passwords are hashed with scrypt and never stored in plain text.
- Sessions last 30 days and are sent as an HttpOnly cookie.
- Each account only ever reads and writes its own budget.
- Repeated failed sign-ins are rate limited per IP.
- Data at rest is encrypted with AES-256-GCM using a key kept outside the
  data folder (`/etc/envelo/secret.key` with the installers), so copies of the
  data folder and its backups are unreadable without it. Keep the key with
  your backups of the container: without it the data cannot be read.
- Receipts are stored encrypted in `DATA_DIR/receipts/`, per user.
- Two-step sign-in uses standard 6-digit codes (TOTP) and ten one-time
  recovery codes. Changing the password signs out every other device.
- All data is in one JSON file, `DATA_DIR/db.json`, written atomically and
  readable only by the server user.
- The server keeps a daily copy in `DATA_DIR/backups/`, for the last 14 days.
  To restore one, stop the service and copy it over `db.json`.
- Saves carry a revision number. If another device saved first, the save is
  refused and the app shows the latest version, so devices never silently
  overwrite each other. Open tabs keep an event stream (`/api/events`) and
  load new versions as soon as they are saved.
- Shared envelopes: a member only receives the shared envelopes, their
  assignments and transactions, and the names of the owner's on-budget
  accounts. Members can delete only spending they added.

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
- `src/loans.js`: loan maths (payments, amortization, loan status)
- `src/charts.js`: dependency-free SVG charts
- `src/bank-csv.js`: bank CSV layout detection and parsing
- `src/sounds.js`: sounds made with the Web Audio API
- `src/sw.js`, `src/manifest.webmanifest`: installable app and offline use
- `src/fonts/`, `src/brand/`, `src/vendor/qrcode.js`: fonts (SIL OFL), logo and icons, QR codes (MIT)
- `server/secure-store.js`, `server/totp.js`, `server/cli.js`: encryption at rest, sign-in codes, admin commands
- `src/app.js`: UI, saving to the server, backup and import
- `src/styles.css`: styles
- `scripts/install-proxmox.sh`: one-line Proxmox LXC installer
- `scripts/install.sh`: installer for any Debian or Ubuntu machine
- `test/`: logic and server tests
- `design/`: design mockups (not served)

## Notes

- Money is stored as integer cents to avoid floating-point drift.
- Changes are saved to the server about a third of a second after you make
  them. If the server is unreachable, the app keeps your changes on screen and
  retries.
- Overspending works like YNAB and Actual: an envelope overspent at the end
  of a month starts the next month at zero, and the overspent amount comes out
  of the next month's Ready to Assign. Tick "Carry overspending" on an
  envelope to keep its negative balance instead.
