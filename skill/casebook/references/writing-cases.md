# Write cases that can fail

Write one action per step. Name the value you must observe after it: a number, message, status, saved value, or visible state. Say what would make the step fail. "Works", "looks right", and "updates" allow wrong values to pass.

Put the required data and starting state in `## Preconditions`. Include details that change the outcome, such as the cart value, coupon, account role, and clock. Split a case when paths need different starting states or test different outcomes. Keep steps together when they prove one outcome through a single flow.

Use `propose` with `md` for canonical Markdown, `outline` for a capture outline, or `body` for structured content. An edit of an existing case needs its current `base` version. Keep existing step ids so results and findings still name the right step. The server gives new cases and steps their ids.

This case can fail when the discounted total or saved coupon is wrong:

```markdown
---
id: C-1
kind: case
title: Checkout keeps a percentage coupon after reload
methods: [human]
covers: []
tags: [checkout]
---
## Preconditions
The cart has one $100.00 item. Tax and shipping are zero. SAVE10 is a valid 10% coupon.

## Steps
- Open the cart ^a1
  > The total shows $100.00.
- Apply coupon SAVE10 ^b7
  > The total shows $90.00.
- Reload the page ^c3
  > The total shows $90.00 and the coupon field shows SAVE10.
```

This case combines actions and gives no value that could prove failure:

```markdown
---
id: C-2
kind: case
title: Check coupons
methods: [human]
covers: []
tags: [checkout]
---
## Steps
- Open the cart, apply a coupon, and reload ^a1
  > Everything works and the total updates.
```

Write separate cases for an expired coupon and an empty cart. Their starting states and expected outcomes differ from this discount flow.
