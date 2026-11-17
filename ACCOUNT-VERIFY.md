# Per-user Binance account verification

This release is verification only. All `/api/execution/*` routes return 403,
even if an older execution environment is configured. No Binance write route
exists in the account service or Singapore relay.

Sites identity supplies the stable owner ID. Browser supplied body/query IDs are
not accepted. Before enabling input on a public deployment, send an anonymous,
cookie-free request with synthetic `oai-authenticated-user-*` headers and confirm
the platform still returns `signedIn:false`.

Users enter an API Key and select their own RSA/Ed25519 PKCS8 PEM file after
sign-in. API keys with withdrawals enabled or unknown are not saved. This does
not certify naked SELL PUT eligibility, collateral adequacy, or an order.

Credentials and reports are encrypted using AES-256-GCM in the existing R2
binding under `binance/account-v1/`. HKDF separates encryption from owner HMAC.
The AAD binds Site, owner hash, binding generation and algorithm. Pending records
contain no credentials; conditional ETag writes and disconnect tombstones prevent
late requests from restoring removed credentials. Disconnect deletes the active
application record, not the API at Binance or platform backups.

Private keys are decrypted and used only in the Site Worker. The Supabase
`account-verify` function receives only fixed, short-lived signed GET requests,
authenticated by an independent Site Ed25519 envelope. Its database contains
only replay/rate-limit hashes and lease/circuit state, no Binance credentials,
UID, balances or upstream bodies. An observed 403/451 persistently stops reads.

Account responses list actual returned permission flags and commission fields.
Missing fields remain unknown. Delivery fees, actual BNB deductions and final
trade charges are not certified by these account endpoints. Public quote income
continues to use clearly identified public rates until a later implementation
explicitly incorporates the account-specific calculation.

Runtime keys (native Sites secrets only): `BINANCE_ACCOUNT_VERIFY_URL`,
`BINANCE_ACCOUNT_BRIDGE_PRIVATE_KEY`, `BINANCE_ACCOUNT_STORAGE_KEY`,
`BINANCE_ACCOUNT_BINDING_ENABLED`. Never commit their values. Rotate the storage
key only with a migration plan; changing it makes existing ciphertext unreadable.

Free resources can pause or hit quotas. This release does not promise unattended
financial execution or accept a trading mandate.
