# BTC USDT execution core

This folder contains an execution core and a private HTTP gateway. It has not been
started against a real account or used to submit a real order during development.
The default configuration disables execution. Publishing the Site does not deploy
this service or connect an account.

## Service contract

`createExecutionService({journal, exchangeFactory, marketProvider, now,
liveEnabled=false, accountLabel})` returns:

- `status()` — asynchronously verifies the injected private adapter. It returns
  `connected`, `accountVerified`, `runnerOnline`, and `canSubmit`. No configuration,
  failed evidence, an unknown-order gate, or a stale runner heartbeat cannot enable
  a new order. A heartbeat requires an actual successful `tick`, not an existing
  factory function. The heartbeat expires after 15 seconds.
- `prepare({amount,symbol,buyBufferRate})` — accepts no browser model, account proof,
  order payload, or settlement claim. It obtains fresh public metadata/book from
  `marketProvider.prepare`, calculates the position, and creates a server-owned
  30-second draft. Live mode reads actual option and spot account fees first;
  execution-disabled mode can produce a public-fee preview without any private call.
- `confirm({id,fingerprint,account,currency,confirmed:true})` — uses the server's
  stored draft, its fixed account label and USDT currency, not a supplied intent.
  It requires a fresh runner, rechecks account isolation and funds, persists the
  intent, and then passes the adapter only `symbol/qty/price/orderLinkId` plus the
  server-created `{spec,confirmedIntent}` authorization. Repeated confirmations of
  the same durable ID return its existing record and never resubmit it.
- `list()` — returns durable records for the configured account label.
- `tick(id?)` — reconciles original orders and complete execution pages, observes
  settlement, and may submit an approved spot order. A timeout never causes the PUT
  or spot order to be resent. Adapter unknown gates clear only through its own
  authenticated, complete reconciliation method.
- `pause({id})` — durably sets `automationPaused=true`. It does not close the PUT,
  cancel an already sent order, release reserved funds, or undo a fill. `tick` keeps
  reconciling sent orders and settlement, but cannot send another spot order. The
  flag is checked again after public/private reads; the journal version also stops
  a concurrent stale submission. There is intentionally no automatic resume API.

The gateway must authenticate its caller. The factory is an operator-owned,
immutable binding to one dedicated subaccount. An account label is not a browser
checkbox or proof of a Bybit UID. Do not rotate the factory to another account while
its journal contains unfinished plans.

## Providers and proof boundaries

`marketProvider.prepare(input)` returns `{market,contract,book,spec}`. The spec must
be validated BTC USDT PUT metadata with its real price tick, quantity step/minimum,
strike, and exact delivery timestamp. `marketProvider.spot(...)` returns
`{spec,ask,time}` for BTCUSDT. Neither provider supplies an assumed private fee.
Actual fee rates come from the private adapter's `getFeeRates`.

Account verification requires a non-master, trading-enabled key with option and
spot permissions, `unsafePermissions===false`, and no withdrawal/transfer
permissions. This core currently accepts verified UNIFIED regular-margin modes
3/4/5/6, USDT and journal-accounted BTC only, and zero borrowing. Missing critical
fields stop verification. USDT availability comes from its coin balances and locks;
the USD-denominated account summary is never substituted for USDT units.

Positions are read in full for option, USDT/USDC linear, and inverse categories.
Open orders are read with `openOnly=0`, without narrowing the symbol or order link,
for all supported categories and every page. The adapter's official API contract
states that omitted `orderFilter` covers all order kinds; no spot conditional-order
filter is silently excluded. Repeated cursors, partial pages, unsupported account
behavior, unknown statuses, and failed reads stop the process.

Final settlement requires the exact instrument, Sell direction, actual filled
quantity, strike, expiry, delivery price and fee, zero remaining positions/orders,
and wallet cash matching the original private baseline plus actual strategy cash
flows. Two identical complete observations must be at least one second apart.
Failures reset this stability observation; saved observations survive a restart.

Spot buying is a separate bounded IOC limit order, not physical PUT delivery. Its
price ceiling is final settlement price × (1 + the confirmed buffer), rounded down
to the official spot tick. Quantity comes from exact decimal entry fills, not the
original intended size or BTC fee shortfalls. Actual account taker fees are reserved
conservatively. The strategy cash ceiling, private available USDT and instrument
limits still apply. No automatic top-up or change in stablecoin is allowed. No new
spot order is allowed after delivery time + five minutes.

The SQLite account uniqueness constraint, transaction versions, original order
link IDs and complete fill reconciliation prevent blind retries. Actual BTC fees
are separated from gross fills. A terminal partial spot fill or a real boundary
violation enters `needs_attention`; the current controller does not automatically
place a second spot order to finish that partial purchase. Such records remain
open for operator review.

## Runtime configuration

The mock suites were run on Node 24.19.0. Runtime requires `node:sqlite`
`DatabaseSync`, persistent storage, and one always-on runner per account/journal.
The provided CLI calls `tick` every five seconds and serializes overlapping ticks.
Stopping the PC/service cannot prevent the exchange from settling an existing PUT;
it prevents this service from guaranteeing timely spot execution. Persistent
records must be reconciled after restart before any new action.

Copy `.env.example` to an operator-owned environment file outside the Site bundle
and fill it locally. The template intentionally has no credentials or gateway
token. Do not commit a filled environment file or place it in R2/public assets.

| Variable | Meaning |
| --- | --- |
| `BYBIT_ENV` | Explicit `testnet` for initial deployment; `mainnet` selects the production host. |
| `LIVE_EXECUTION` | `false` by default. `true` enables the service's execution checks; it does not skip confirmation. |
| `MAINNET_ACCEPTED` | Production additionally requires the exact value `yes`. Leave blank during preparation. |
| `BYBIT_API_KEY`, `BYBIT_API_SECRET` | Operator-provided dedicated subaccount credentials, never sent to the browser or journal. |
| `EXECUTION_GATEWAY_TOKEN` | Private gateway authentication token; blank configuration cannot start the server. |
| `EXECUTION_DB_PATH` | Persistent SQLite file outside the published Site source/artifact. Keep the database, WAL and SHM together. |
| `STRATEGY_SITE_ORIGIN` | The expected strategy Site origin. |
| `PORT` | Leave blank for localhost port 8787; setting it causes the supplied CLI to bind on all interfaces. Use a private TLS gateway/firewall. |

For a separately authorized deployment, the entry point is
`node --env-file=/operator/private/execution.env execution/server.mjs`. This command
has not been run with real account configuration here. Public Internet TLS,
authentication, secret storage, process supervision, persistent disks, backups and
monitoring belong to the deployment, not to the static Site.

The Site Worker separately needs operator configuration for
`EXECUTION_GATEWAY_URL` and `EXECUTION_GATEWAY_TOKEN`. Those values are intentionally
absent from the published default. Without them, its execution status stays
`not_configured`. The gateway token must not be exposed through client JavaScript.

## Verification

`node --test execution-service-tests.mjs` uses injected mock exchanges and markets
only. It covers disabled mode, server-owned drafts, real-fee canonicalization,
permissions, missing fields, whole-account pagination, heartbeat, idempotent
confirmation, partial fills, restart/unknown recovery, two-observation settlement,
cash contamination, exact-decimal quantities, pause races, and the five-minute
deadline. These tests do not establish that any real account has been connected,
that every account mode is supported, or that an execution host is running.
