# Freeze what the customer does not need

- Date: 2026-10-27
- Status: accepted
- PR: https://github.com/endqwerty/mainworthy/pull/1024

Follows [the customer decision](2026-10-27-the-customer-is-release-gated-teams-moving-to-ci-cd.md), which left
open what to stop. The [strategy review](../strategy-review.md), section 6, listed four candidates; the owner,
2026-10-27: "do the freezes, auth changes to OIDC, stay on GCP, let's stay public and open source then".

## Decision

| Work | What happens | Brought back when |
| --- | --- | --- |
| The native iPhone app | Leaves `main`, kept whole at the tag `ios-app-2026-10-27`. Its Swift code, contract, CI job, guide page and the server parts only the app uses go with it. Its issues get `deferred` | a user needs to run tests away from a desk and the phone layout of the web app does not do |
| Sign-in methods other than an identity provider | Deleted, not frozen: people sign in through OpenID Connect, and scripts, agents and pipelines with tokens ([the sign-in decision](2026-10-27-people-sign-in-through-an-identity-provider.md)) | not planned |
| Teams own projects (M8) | Not started; its issues get `deferred` and it leaves phase 2. Teams as they are today (decision 0064) stay | an instance holds several teams that must not see each other's projects |
| The loose end of the policy spectrum | No new work for teams without a release gate. The policy engine stays; M5's three-profile criterion narrows to the gated and regulated profiles | a user without a release gate asks |

**Why the iPhone app leaves `main` instead of staying unchanged.** A frozen app that stays on `main` is not
free: `test/ios-contract.test.ts` holds the server to what the app reads, so every change to a reply the app
uses needs Swift work and the `ios` CI job. That is the cost the freeze is meant to stop. Kept at a tag, the app
costs nothing until it returns. Bringing it back means checking the tag out into `ios/` and `scripts/ios/`,
regenerating the contract and updating the Swift to the server of that day; decision 0023 and the issues still
describe what it does.

**Stay on Google Cloud.** Cloudflare's compute is cheap, but it would put a second runtime beside the
self-hosted container, Bun does not run on Workers, and the Google Cloud cutover (#821) is mostly done.
Decision [2026-10-25](2026-10-25-cloud-infrastructure-and-release-ownership.md) stands.

**Stay public and open source.** The repository stays public under Apache-2.0 (decision 0025). Free CI on a
public repository and a self-hosted product with nothing held back by tier are part of the offer to this
customer. Strategy notes are written knowing they are public.
