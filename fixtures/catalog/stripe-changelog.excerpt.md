# Changelog (excerpt for tests)

## 2026-09-30.endive

### Billing and invoicing

| Title                                                                                                                                                                         | Affected Products            | Breaking change? | Category |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------- | -------- |
| [Unifies the billing cycle anchor format across Subscriptions and Invoices](https://docs.stripe.com/changelog/endive/2026-09-30/polymorphic-billing-cycle-anchor.md)          | Billing                      | Breaking         | api      |
| [Adds invoicing rules to Invoice Items](https://docs.stripe.com/changelog/endive/2026-09-30/invoicing-rules-for-invoice-items.md)                                             | Billing                      | Non-breaking     | api      |
| [Adds reference and company details parameters for Billie](https://docs.stripe.com/changelog/endive/2026-09-30/reference-and-company-details-billie.md)                       | Payments, Invoicing, Billing | Non-breaking     | api      |
| [Adds the ability to clear invoicing rules on Invoice Items](https://docs.stripe.com/changelog/endive/2026-09-30/clear-invoicing-rules-on-invoice-items.md)                   | Billing                      | Non-breaking     | api      |
| [Adds proration details for Invoice Items using classic billing mode](https://docs.stripe.com/changelog/endive/2026-09-30/invoice-items-proration-details.md)                 | Billing                      | Non-breaking     | api      |
| [Makes trial offers generally available](https://docs.stripe.com/changelog/endive/2026-09-30/trial-offer-ga.md)                                                               | Billing                      | Non-breaking     | api      |
| [Adds detailed status to explain why an Invoice is uncollectable](https://docs.stripe.com/changelog/endive/2026-09-30/invoice-uncollectible-status-detail.md)                 | Billing                      | Non-breaking     | api      |
| [Adds support for scheduling Subscription cancellation as part of pending update](https://docs.stripe.com/changelog/endive/2026-09-30/scheduled-subscription-cancellation.md) | Billing                      | Non-breaking     | api      |
| [Adds the ability to pause and resume Subscriptions on demand](https://docs.stripe.com/changelog/endive/2026-09-30/pause-subscription.md)                                     | Billing                      | Non-breaking     | api      |
| [Adds the Feedback Options API](https://docs.stripe.com/changelog/endive/2026-09-30/feedback-options-api.md)                                                                  | Billing                      | Non-breaking     | api      |

### Connect and accounts

| Title                                                                                                                                                                                                         | Affected Products | Breaking change? | Category |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------- | -------- |
| [Adds address validation errors for CMRAs and registered agents to Accounts v1 and Accounts v2](https://docs.stripe.com/changelog/endive/2026-09-30/address-validation-cmra-registered-agents-accounts-v2.md) | Issuing, Treasury | Breaking         | api      |
| [Adds rejected status for Accounts v2 capabilities](https://docs.stripe.com/changelog/endive/2026-09-30/rejected-accounts-v2-capabilities.md)                                                                 | Connect           | Breaking         | api      |
| [Replaces the generic fraud rejection reason with specific fraud reasons](https://docs.stripe.com/changelog/endive/2026-09-30/updated-reject-reason-codes.md)                                                 | Connect           | Breaking         | api      |
| [Removes the configurations parameter from the Account Links v2 API](https://docs.stripe.com/changelog/endive/2026-09-30/removes-configurations-parameter-from-v2-core-account-links-api.md)                  | All products      | Breaking         | api      |
| [Standardizes SEPA Direct Debit payment settings in the Accounts API](https://docs.stripe.com/changelog/endive/2026-09-30/sepa-debit-settings-accounts.md)                                                    | Connect, Payments | Breaking         | api      |
| [Shows errors for eventually due requirements](https://docs.stripe.com/changelog/endive/2026-09-30/shows-errors-for-eventually-due-requirements.md)                                                           | Connect           | Breaking         | api      |
| [Distinguishes platform-initiated account rejections from Stripe rejections](https://docs.stripe.com/changelog/endive/2026-09-30/platform-rejection-reasons.md)                                               | Connect           | Breaking         | api      |
| [Adds additional shared fields to customer sharing](https://docs.stripe.com/changelog/endive/2026-09-30/additional-shared-fields-customer-sharing.md)                                                         | All products      | Non-breaking     | api      |

### Financial Connections

| Title                                                                                                                                                                                                          | Affected Products    | Breaking change? | Category |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------- | -------- |
| [Renames the countries filter to country on Financial Connections Sessions](https://docs.stripe.com/changelog/endive/2026-09-30/rename-financial-connections-countries-filter-to-country.md)                   | Financialconnections | Breaking         | api      |
| [Updates Financial Connections Session defaults](https://docs.stripe.com/changelog/endive/2026-09-30/financial-connections-session-defaults.md)                                                                | Financialconnections | Breaking         | api      |
| [Adds pending and expired statuses to Financial Connections account numbers](https://docs.stripe.com/changelog/endive/2026-09-30/pending-and-expired-status-added-to-financial-connections-account-numbers.md) | Financialconnections | Non-breaking     | api      |

### Payments

| Title                                                                                                                                                                                                                         | Affected Products                      | Breaking change? | Category |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------- | -------- |
| [Removes the payment method types parameter from Checkout Sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions.md)                                                     | Checkout                               | Breaking         | api      |
| [Adds support for Data Share Only for 3D Secure authentication](https://docs.stripe.com/changelog/endive/2026-09-30/data-share-only.md)                                                                                       | Payments                               | Breaking         | api      |
| [Makes Payment Evaluation signal scores nullable](https://docs.stripe.com/changelog/endive/2026-09-30/payment-evaluations-nullable-score.md)                                                                                  | Radar                                  | Breaking         | api      |
| [Removes PayTo-specific fields from Payment Methods](https://docs.stripe.com/changelog/endive/2026-09-30/removed-payto-fields.md)                                                                                             | Payments                               | Breaking         | api      |
| [Removes the payment method types parameter from Payment Intents and Setup Intents](https://docs.stripe.com/changelog/endive/2026-09-30/removes-the-payment-method-types-parameter-from-payment-intents-and-setup-intents.md) | Payments                               | Breaking         | api      |
| [Returns specific decline codes for BLIK payment failures](https://docs.stripe.com/changelog/endive/2026-09-30/blik-granular-decline-codes.md)                                                                                | Payments                               | Breaking         | api      |
| [Deprecates the payment request button](https://docs.stripe.com/changelog/endive/2026-09-30/deprecate-payment-request-button.md)                                                                                              | Elements                               | Breaking         | stripejs |
| [Shows pending-authorization UI for MB WAY, Bizum, and BLIK with stripe.handleNextAction](https://docs.stripe.com/changelog/endive/2026-09-30/handle-next-action-mb-way-bizum-ui.md)                                          | Elements                               | Breaking         | stripejs |
| [Removes support for the payment method types option in Elements](https://docs.stripe.com/changelog/endive/2026-09-30/remove-elements-deferred-intent-payment-method-types.md)                                                | Elements                               | Breaking         | stripejs |
| [Saves Bancontact payment details for future off-session payments in Checkout](https://docs.stripe.com/changelog/endive/2026-09-30/bancontact-off-session-payments-checkout.md)                                               | Checkout, Payments, Paymentlinks       | Non-breaking     | api      |
| [Adds the Standalone 3D Secure API](https://docs.stripe.com/changelog/endive/2026-09-30/standalone-3ds.md)                                                                                                                    | Payments                               | Non-breaking     | api      |
| [Adds support for SeQura payments](https://docs.stripe.com/changelog/endive/2026-09-30/sequra-payments.md)                                                                                                                    | Payments                               | Non-breaking     | api      |
| [Adds card-present payment methods to allowed payment method types](https://docs.stripe.com/changelog/endive/2026-09-30/card-present-and-interac-present-enum-values-for-allowed-payment-method-types.md)                     | Payments                               | Non-breaking     | api      |
| [Adds Link funding source group details on Payment Records](https://docs.stripe.com/changelog/endive/2026-09-30/link-funding-source-group-payment-records.md)                                                                 | Payments                               | Non-breaking     | api      |
| [Adds early fraud warnings and fraudulent dispute signals for Payment Evaluations](https://docs.stripe.com/changelog/endive/2026-09-30/new-radar-signals-for-payment-evaluations.md)                                          | Radar                                  | Non-breaking     | api      |
| [Adds the ability to report canceled payments](https://docs.stripe.com/changelog/endive/2026-09-30/reporting-canceled-payments.md)                                                                                            | Payments                               | Non-breaking     | api      |
| [Adds support for expanding the mandate on card payment method details](https://docs.stripe.com/changelog/endive/2026-09-30/expand-mandate-on-card-payments-details.md)                                                       | Payments                               | Non-breaking     | api      |
| [Adds the Payment Record property to the Payment Intent object](https://docs.stripe.com/changelog/endive/2026-09-30/payment-records-on-payment-intents.md)                                                                    | Payments                               | Non-breaking     | api      |
| [Adds Link wallet details to Payment Records for card payments](https://docs.stripe.com/changelog/endive/2026-09-30/adds-link-wallet-details-to-payment-records-for-card-payments.md)                                         | Payments                               | Non-breaking     | api      |
| [Adds 3D Secure versions 2.3.0 and 2.3.1 to Payment Records](https://docs.stripe.com/changelog/endive/2026-09-30/3d-secure-payment-records.md)                                                                                | Payments                               | Non-breaking     | api      |
| [Adds support for BLIK recurring off-session payments](https://docs.stripe.com/changelog/endive/2026-09-30/blik-recurring-off-session-payments.md)                                                                            | Payments, Invoicing, Checkout, Billing | Non-breaking     | api      |
| [Adds PayPay support for one-time online payments in Japan](https://docs.stripe.com/changelog/endive/2026-09-30/paypay-payments-japan.md)                                                                                     | Payments                               | Non-breaking     | api      |
| [Exposes the network response electronic commerce indicator on card charges](https://docs.stripe.com/changelog/endive/2026-09-30/view-network-response-eci-on-card-charges.md)                                                | Payments                               | Non-breaking     | api      |
| [Adds payment method type information for failed payments](https://docs.stripe.com/changelog/endive/2026-09-30/payment-method-type-payment-failures.md)                                                                       | Payments                               | Non-breaking     | api      |
| [Adds MoMo payment method details to Payment Records](https://docs.stripe.com/changelog/endive/2026-09-30/adds-momo-payment-method-details-to-payment-records.md)                                                             | Payments                               | Non-breaking     | api      |

### Tax

| Title                                                                                                                    | Affected Products                 | Breaking change? | Category |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ---------------- | -------- |
| [Adds Failed Tax Calculation error](https://docs.stripe.com/changelog/endive/2026-09-30/failed-tax-calculation-error.md) | Tax, Billing, Invoicing, Checkout | Breaking         | api      |
| [Adds support for new tax types](https://docs.stripe.com/changelog/endive/2026-09-30/stripe-tax-new-tax-types.md)        | Tax                               | Non-breaking     | api      |
| [Adds support for ticket sales to Stripe Tax](https://docs.stripe.com/changelog/endive/2026-09-30/stripe-tax-tickets.md) | Billing, Checkout, Invoicing, Tax | Non-breaking     | api      |

### Treasury and money management

| Title                                                                                                                                                                                       | Affected Products  | Breaking change? | Category |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------- | -------- |
| [Renames the Reserve Release reason enum value](https://docs.stripe.com/changelog/endive/2026-09-30/reserve-release-reason.md)                                                              | Radar              | Breaking         | api      |
| [Adds destination property and new enum values to Reserve Plans, Holds and Releases](https://docs.stripe.com/changelog/endive/2026-09-30/settlement-reserve-api.md)                         | Treasury, Payments | Breaking         | api      |
| [Adds support for received credits sent via the Real-Time Payments network](https://docs.stripe.com/changelog/endive/2026-09-30/rtp-network-received-credits.md)                            | Treasury           | Non-breaking     | api      |
| [Exposes ACH return codes on OutboundPayments, OutboundTransfers, and InboundTransfers in v1 Treasury](https://docs.stripe.com/changelog/endive/2026-09-30/v1-treasury-ach-return-codes.md) | Treasury           | Non-breaking     | api      |

### Additional updates

| Title                                                                                                                                                                                                    | Affected Products  | Breaking change? | Category |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------- | -------- |
| [Adds page limit validation for dispute evidence](https://docs.stripe.com/changelog/endive/2026-09-30/page-limit-validation-dispute-evidence.md)                                                         | Payments           | Breaking         | api      |
| [Rejects duplicate references for pending India card mandates](https://docs.stripe.com/changelog/endive/2026-09-30/duplicate-reference-validation-for-india-pending-mandates.md)                         | Payments           | Breaking         | api      |
| [Surfaces India card mandates on Charges and SetupIntents even when inactive](https://docs.stripe.com/changelog/endive/2026-09-30/surface-india-card-mandate-even-when-inactive.md)                      | Payments           | Breaking         | api      |
| [Sets canConfirm to false while updates are pending in Elements with Checkout Sessions](https://docs.stripe.com/changelog/endive/2026-09-30/block-custom-checkout-confirmation-pending-updates.md)       | Checkout, Elements | Breaking         | stripejs |
| [Allows empty optional address fields in Elements with Checkout Sessions](https://docs.stripe.com/changelog/endive/2026-09-30/skip-format-validation-empty-optional-address-fields.md)                   | Checkout, Elements | Breaking         | stripejs |
| [Requires billing details when Payment Element collection is disabled](https://docs.stripe.com/changelog/endive/2026-09-30/strict-billing-details-validation.md)                                         | Checkout, Elements | Breaking         | stripejs |
| [Makes thin events for API v1 resources generally available](https://docs.stripe.com/changelog/endive/2026-09-30/thin-events-for-api-v1-resources-generally-available.md)                                | All products       | Non-breaking     | api      |
| [Adds Satispay payments capability to Accounts v2](https://docs.stripe.com/changelog/endive/2026-09-30/satispay-payments-capability-for-accounts-v2-api.md)                                              | All products       | Non-breaking     | api      |
| [Adds an expiration timestamp to the Swish QR code object](https://docs.stripe.com/changelog/endive/2026-09-30/expiration-timestamp-swish-qr.md)                                                         | Terminal           | Non-breaking     | api      |
| [Adds a new outcome type for rerouted payments to Payment Evaluations](https://docs.stripe.com/changelog/endive/2026-09-30/adds-a-new-outcome-type-for-rerouted-bank-payments-to-payment-evaluations.md) | Radar              | Non-breaking     | api      |
| [Adds Balance Transaction types for provisional credits for Issuing disputes](https://docs.stripe.com/changelog/endive/2026-09-30/provisional-credit-issuing-disputes-balance-transaction-types.md)      | Issuing            | Non-breaking     | api      |
| [Adds India-specific mandate details to card payment method responses](https://docs.stripe.com/changelog/endive/2026-09-30/india-specific-mandate-card-payments.md)                                      | Payments           | Non-breaking     | api      |
| [Adds the option to automatically pause subscriptions after payment failures](https://docs.stripe.com/changelog/endive/2026-09-30/pause-on-payment-failure.md)                                           | Billing            | Non-breaking     | api      |
| [Adds the Install API for Stripe Apps](https://docs.stripe.com/changelog/endive/2026-09-30/install-api.md)                                                                                               | All products       | Non-breaking     | api      |


## 2024-06-20

### Additional updates

| Title                                                                                                                                                                                        | Affected Products | Breaking change? | Category |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------- | -------- |
| [Renames a `fuel` attribute of the `Authorization` object](https://docs.stripe.com/changelog/2024-06-20/renames-fuel-attribute-authorization-object.md)                                      | Issuing           | Breaking         | api      |
| [Renames a `purchase_details` attribute of the `Transaction` object](https://docs.stripe.com/changelog/2024-06-20/renames-purchase-details-transaction-object.md)                            | Issuing           | Breaking         | api      |
| [Removes undocumented fuel fields](https://docs.stripe.com/changelog/2024-06-20/removes-undocumented-fuel-fields-issuing.md)                                                                 | Issuing           | Breaking         | api      |
| [Removes undocumented fleet fields](https://docs.stripe.com/changelog/2024-06-20/removes-undocumented-fleet-fields-issuing.md)                                                               | Issuing           | Breaking         | api      |
| [Adds enum values for fuel units](https://docs.stripe.com/changelog/2024-06-20/adds-enum-fuel-units-issuing.md)                                                                              | Issuing           | Breaking         | api      |
| [Deprecates `alphanumeric_id` for Issuing Authorization](https://docs.stripe.com/changelog/2024-06-20/deprecates-alphanumeric-id-issuing.md)                                                 | Issuing           | Breaking         | api      |
| [Adds enum values for disabled reasons](https://docs.stripe.com/changelog/2024-06-20/adds-enum-disabled-reasons-capabilities.md)                                                             | Connect           | Breaking         | api      |
| [Deprecates the `bank_transfer_payments` capability type in favor of newer capability types](https://docs.stripe.com/changelog/2024-06-20/deprecates-bank-transfer-payments-capabilities.md) | Connect           | Breaking         | api      |
| [Adds new enum values for request history reasons](https://docs.stripe.com/changelog/2024-06-20/adds-enum-request-history-reasons-issuing.md)                                                | Issuing           | Breaking         | api      |
