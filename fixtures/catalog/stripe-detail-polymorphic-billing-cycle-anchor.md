# Unifies the billing cycle anchor format across Subscriptions and Invoices

## What’s new

Unifies how updates to a subscription’s billing cycle anchor are formatted when [updating Subscriptions](https://docs.stripe.com/api/subscriptions/update.md?api-version=2026-09-30.endive#update_subscription-billing_cycle_anchor), [resuming Subscriptions](https://docs.stripe.com/api/subscriptions/resume.md?api-version=2026-09-30.endive#resume_subscription-billing_cycle_anchor), and [creating Preview Invoices](https://docs.stripe.com/api/invoices/create_preview.md?api-version=2026-09-30.endive#create_invoice-subscription_details-billing_cycle_anchor). The [billing_cycle_anchor](https://docs.stripe.com/api/subscriptions/update.md?api-version=2026-09-30.endive#update_subscription-billing_cycle_anchor) field now uses a consistent object format with a `type` field, replacing the previous string, enum, and timestamp formats.

## Why is this a breaking change?

The `billing_cycle_anchor` field now requires an object with a `type` field instead of a string value (for example, `{type: 'now'}`). When creating a preview invoice, the [subscription_details.billing_cycle_anchor](https://docs.stripe.com/api/invoices/create_preview.md?api-version=2026-09-30.endive#create_invoice-subscription_details-billing_cycle_anchor) field requires an object with `type` and `timestamp` fields.

## Impact

Previously, you could pass a string value when updating a subscription’s billing cycle anchor. Instead, set `billing_cycle_anchor` to an object with an equivalent `type` parameter.
- Replace `now` with `{type: 'now'}`.
- Replace `unchanged` with `{type: 'unchanged'}`.

When creating a preview invoice for a new subscription whose billing cycle anchor is a future timestamp, replace `1234567890` with `{type: 'timestamp', timestamp: 1234567890}`.

## Changes

#### REST API

| Fields                                                             | Change  | From → to   |
| ------------------------------------------------------------------ | ------- | ----------- |
| `Invoice#create_preview.subscription_details.billing_cycle_anchor` | Changed | `enum('now' | 'unchanged')                               | DateTime → billing_cycle_anchor_param` |
| `Subscription#resume.billing_cycle_anchor`                         | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |
| `Subscription#update.billing_cycle_anchor`                         | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |

#### Ruby

| Fields                                                                | Change  | From → to   |
| --------------------------------------------------------------------- | ------- | ----------- |
| `InvoiceCreatePreviewParams::SubscriptionDetail.billing_cycle_anchor` | Changed | `enum('now' | 'unchanged')                               | DateTime → billing_cycle_anchor_param` |
| `SubscriptionResumeParams.billing_cycle_anchor`                       | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |
| `SubscriptionUpdateParams.billing_cycle_anchor`                       | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |

#### Python

| Fields                                                              | Change  | From → to   |
| ------------------------------------------------------------------- | ------- | ----------- |
| `InvoiceCreatePreviewParamsSubscriptionDetail.billing_cycle_anchor` | Changed | `enum('now' | 'unchanged')                               | DateTime → billing_cycle_anchor_param` |
| `SubscriptionResumeParams.billing_cycle_anchor`                     | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |
| `SubscriptionModifyParams.billing_cycle_anchor`                     | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |

#### PHP

| Fields                                                                      | Change  | From → to   |
| --------------------------------------------------------------------------- | ------- | ----------- |
| `Invoice.create_preview().$params.subscription_detail.billing_cycle_anchor` | Changed | `enum('now' | 'unchanged')                               | DateTime → billing_cycle_anchor_param` |
| `Subscription.resume().$params.billing_cycle_anchor`                        | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |
| `Subscription.update().$params.billing_cycle_anchor`                        | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |

#### Java

| Fields                                                               | Change  | From → to   |
| -------------------------------------------------------------------- | ------- | ----------- |
| `InvoiceCreatePreviewParams.subscription_details.billingCycleAnchor` | Changed | `enum('now' | 'unchanged')                               | DateTime → billing_cycle_anchor_param` |
| `SubscriptionResumeParams.billingCycleAnchor`                        | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |
| `SubscriptionUpdateParams.billingCycleAnchor`                        | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |

#### Node.js

| Fields                                                                 | Change  | From → to   |
| ---------------------------------------------------------------------- | ------- | ----------- |
| `InvoiceCreatePreviewParams.subscription_details.billing_cycle_anchor` | Changed | `enum('now' | 'unchanged')                               | DateTime → billing_cycle_anchor_param` |
| `SubscriptionResumeParams.billing_cycle_anchor`                        | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |
| `SubscriptionUpdateParams.billing_cycle_anchor`                        | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |

#### Go

| Fields                                                             | Change  | From → to   |
| ------------------------------------------------------------------ | ------- | ----------- |
| `InvoiceCreatePreviewSubscriptionDetailsParams.BillingCycleAnchor` | Changed | `enum('now' | 'unchanged')                               | DateTime → billing_cycle_anchor_param` |
| `SubscriptionResumeParams.BillingCycleAnchor`                      | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |
| `SubscriptionParams.BillingCycleAnchor`                            | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |

#### .NET

| Fields                                                 | Change  | From → to   |
| ------------------------------------------------------ | ------- | ----------- |
| `InvoiceSubscriptionDetailsOptions.BillingCycleAnchor` | Changed | `enum('now' | 'unchanged')                               | DateTime → billing_cycle_anchor_param` |
| `SubscriptionResumeOptions.BillingCycleAnchor`         | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |
| `SubscriptionUpdateOptions.BillingCycleAnchor`         | Changed | `enum('now' | 'unchanged') → billing_cycle_anchor_param` |

## Upgrade

#### REST API

1. [View your current API version](https://docs.stripe.com/workbench/guides.md#view-api-versions) in Workbench.
2. If you use an SDK, upgrade to the corresponding SDK version for this API version.
   - If you don’t use an SDK, update your [API requests](https://docs.stripe.com/api-versions.md#how-versions-are-specified-in-requests) to include `Stripe-Version: 2026-09-30.endive`
3. Upgrade the API version used for [webhook endpoints](https://docs.stripe.com/webhooks/versioning.md).
4. [Test your integration](https://docs.stripe.com/testing.md) against the new version.
5. If you use Connect, [test your Connect integration](https://docs.stripe.com/connect/testing.md).

Learn more about [Stripe API upgrades](https://docs.stripe.com/upgrades.md).

#### Ruby

1. [View your current API version](https://docs.stripe.com/upgrades.md#view-your-api-version-and-the-latest-available-upgrade-in-workbench) in Workbench.
2. Upgrade your Ruby SDK to the latest version.
3. Upgrade the API version used for [webhook endpoints](https://docs.stripe.com/webhooks/versioning.md).
4. [Test your integration](https://docs.stripe.com/testing.md) against the new version.
5. If you use Connect, [test your Connect integration](https://docs.stripe.com/connect/testing.md).
6. In Workbench, [perform the upgrade](https://docs.stripe.com/upgrades.md#perform-the-upgrade). You can [roll back the version](https://docs.stripe.com/upgrades.md#roll-back-your-api-version) for 72 hours.

Learn more about [Stripe API upgrades](https://docs.stripe.com/upgrades.md).

#### Python

1. [View your current API version](https://docs.stripe.com/upgrades.md#view-your-api-version-and-the-latest-available-upgrade-in-workbench) in Workbench.
2. Upgrade your Python SDK to the latest version.
3. Upgrade the API version used for [webhook endpoints](https://docs.stripe.com/webhooks/versioning.md).
4. [Test your integration](https://docs.stripe.com/testing.md) against the new version.
5. If you use Connect, [test your Connect integration](https://docs.stripe.com/connect/testing.md).
6. In Workbench, [perform the upgrade](https://docs.stripe.com/upgrades.md#perform-the-upgrade). You can [roll back the version](https://docs.stripe.com/upgrades.md#roll-back-your-api-version) for 72 hours.

Learn more about [Stripe API upgrades](https://docs.stripe.com/upgrades.md).

#### PHP

1. [View your current API version](https://docs.stripe.com/upgrades.md#view-your-api-version-and-the-latest-available-upgrade-in-workbench) in Workbench.
2. Upgrade your PHP SDK to the latest version.
3. Upgrade the API version used for [webhook endpoints](https://docs.stripe.com/webhooks/versioning.md).
4. [Test your integration](https://docs.stripe.com/testing.md) against the new version.
5. If you use Connect, [test your Connect integration](https://docs.stripe.com/connect/testing.md).
6. In Workbench, [perform the upgrade](https://docs.stripe.com/upgrades.md#perform-the-upgrade). You can [roll back the version](https://docs.stripe.com/upgrades.md#roll-back-your-api-version) for 72 hours.

Learn more about [Stripe API upgrades](https://docs.stripe.com/upgrades.md).

#### Java

1. [View your current API version](https://docs.stripe.com/upgrades.md#view-your-api-version-and-the-latest-available-upgrade-in-workbench) in Workbench.
2. Upgrade your Java SDK to the latest version.
3. Upgrade the API version used for [webhook endpoints](https://docs.stripe.com/webhooks/versioning.md).
4. [Test your integration](https://docs.stripe.com/testing.md) against the new version.
5. If you use Connect, [test your Connect integration](https://docs.stripe.com/connect/testing.md).
6. In Workbench, [perform the upgrade](https://docs.stripe.com/upgrades.md#perform-the-upgrade). You can [roll back the version](https://docs.stripe.com/upgrades.md#roll-back-your-api-version) for 72 hours.

Learn more about [Stripe API upgrades](https://docs.stripe.com/upgrades.md).

#### Node.js

1. [View your current API version](https://docs.stripe.com/upgrades.md#view-your-api-version-and-the-latest-available-upgrade-in-workbench) in Workbench.
2. Upgrade your Node SDK to the latest version.
3. Upgrade the API version used for [webhook endpoints](https://docs.stripe.com/webhooks/versioning.md).
4. [Test your integration](https://docs.stripe.com/testing.md) against the new version.
5. If you use Connect, [test your Connect integration](https://docs.stripe.com/connect/testing.md).
6. In Workbench, [perform the upgrade](https://docs.stripe.com/upgrades.md#perform-the-upgrade). You can [roll back the version](https://docs.stripe.com/upgrades.md#roll-back-your-api-version) for 72 hours.

Learn more about [Stripe API upgrades](https://docs.stripe.com/upgrades.md).

#### Go

1. [View your current API version](https://docs.stripe.com/upgrades.md#view-your-api-version-and-the-latest-available-upgrade-in-workbench) in Workbench.
2. Upgrade your Go SDK to the latest version.
3. Upgrade the API version used for [webhook endpoints](https://docs.stripe.com/webhooks/versioning.md).
4. [Test your integration](https://docs.stripe.com/testing.md) against the new version.
5. If you use Connect, [test your Connect integration](https://docs.stripe.com/connect/testing.md).
6. In Workbench, [perform the upgrade](https://docs.stripe.com/upgrades.md#perform-the-upgrade). You can [roll back the version](https://docs.stripe.com/upgrades.md#roll-back-your-api-version) for 72 hours.

Learn more about [Stripe API upgrades](https://docs.stripe.com/upgrades.md).

#### .NET

1. [View your current API version](https://docs.stripe.com/upgrades.md#view-your-api-version-and-the-latest-available-upgrade-in-workbench) in Workbench.
2. Upgrade your .NET SDK to the latest version.
3. Upgrade the API version used for [webhook endpoints](https://docs.stripe.com/webhooks/versioning.md).
4. [Test your integration](https://docs.stripe.com/testing.md) against the new version.
5. If you use Connect, [test your Connect integration](https://docs.stripe.com/connect/testing.md).
6. In Workbench, [perform the upgrade](https://docs.stripe.com/upgrades.md#perform-the-upgrade). You can [roll back the version](https://docs.stripe.com/upgrades.md#roll-back-your-api-version) for 72 hours.

Learn more about [Stripe API upgrades](https://docs.stripe.com/upgrades.md).

## Related changes

- [Adds invoicing rules to Invoice Items](https://docs.stripe.com/changelog/endive/2026-09-30/invoicing-rules-for-invoice-items.md)
- [Adds reference and company details parameters for Billie](https://docs.stripe.com/changelog/endive/2026-09-30/reference-and-company-details-billie.md)
- [Adds the ability to clear invoicing rules on Invoice Items](https://docs.stripe.com/changelog/endive/2026-09-30/clear-invoicing-rules-on-invoice-items.md)
- [Adds proration details for Invoice Items using classic billing mode](https://docs.stripe.com/changelog/endive/2026-09-30/invoice-items-proration-details.md)
- [Makes trial offers generally available](https://docs.stripe.com/changelog/endive/2026-09-30/trial-offer-ga.md)
- [Adds detailed status to explain why an Invoice is uncollectable](https://docs.stripe.com/changelog/endive/2026-09-30/invoice-uncollectible-status-detail.md)
- [Adds support for scheduling Subscription cancellation as part of pending update](https://docs.stripe.com/changelog/endive/2026-09-30/scheduled-subscription-cancellation.md)
- [Adds the ability to pause and resume Subscriptions on demand](https://docs.stripe.com/changelog/endive/2026-09-30/pause-subscription.md)
- [Adds the Feedback Options API](https://docs.stripe.com/changelog/endive/2026-09-30/feedback-options-api.md)
