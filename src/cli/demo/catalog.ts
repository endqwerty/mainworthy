// What the demo shop tests: its areas, the features in each, and the scenarios a suite for it would hold. A
// scenario is written once with `{slots}`; the plan fills them from `VALUES`, one case for each combination.

/** One case in outline: the title, and each step as what to do and what must then be true (null: not said). */
export type Scenario = {
	title: string;
	pre?: string;
	steps: readonly (readonly [action: string, expected: string | null])[];
};

/** A folder of the suite. `weight` is its share of the cases: checkout is tested more than push messages. */
export type Feature = {
	path: string;
	weight: number;
	tags: readonly string[];
	pre: string;
	/** What a case of this feature can be repeated for (`CONTEXTS`). Absent: all three. An API has no browser. */
	across?: readonly Axis[];
	scenarios: readonly Scenario[];
};

/** The values a `{slot}` takes. A slot named in a scenario and missing here is a mistake a test finds. */
export const VALUES: Readonly<Record<string, readonly string[]>> = {
	card: ["Visa", "Mastercard", "American Express", "Discover"],
	wallet: ["PayPal", "Apple Pay", "Google Pay", "Shop Pay"],
	country: ["the United States", "Canada", "Germany", "France", "Japan", "Australia", "Brazil", "the United Kingdom"],
	currency: ["USD", "EUR", "GBP", "JPY", "CAD", "AUD"],
	carrier: ["UPS", "FedEx", "DHL", "USPS"],
	delivery: ["standard", "express", "next-day", "in-store pickup"],
	coupon: ["SAVE10", "WELCOME15", "FREESHIP", "VIP20", "BUNDLE5"],
	category: ["Shoes", "Jackets", "Backpacks", "Watches", "Headphones", "Tents"],
	sort: ["price, low to high", "price, high to low", "newest first", "best rated"],
	role: ["support agent", "catalog manager", "warehouse lead", "finance analyst"],
	quantity: ["2", "5", "10", "99"],
	reason: ["wrong size", "damaged in transit", "not as described", "changed my mind"],
	status: ["Processing", "Shipped", "Out for delivery", "Delivered"],
	event: ["order.created", "order.paid", "order.shipped", "order.refunded"],
	field: ["first name", "phone number", "date of birth", "company name"],
	rating: ["1", "3", "5"],
};

/**
 * Where and for whom a case is run. A feature that needs more cases than its scenarios make repeats them for
 * these, as a real suite does: the same check on another browser, in another language, for another customer.
 */
export type Axis = "platform" | "language" | "customer";
export const CONTEXTS: Readonly<Record<Axis, readonly string[]>> = {
	platform: [
		"Chrome on Windows",
		"Safari on macOS",
		"Firefox on Linux",
		"Edge on Windows",
		"Safari on iPhone",
		"Chrome on Android",
		"the iOS app",
		"the Android app",
	],
	language: ["German", "French", "Japanese", "Spanish", "Portuguese", "Korean"],
	customer: ["a guest", "a new customer", "a returning customer", "a business account"],
};

const signedIn = "Open the shop with a signed-in account.";
const backOffice = "Sign in to the back office.";

/** The first scenario of the first feature is the case the demo's open questions are about; it has no slot. */
export const CATALOG: readonly Feature[] = [
	{
		path: "Checkout/Coupons",
		weight: 7,
		tags: ["checkout"],
		pre: signedIn,
		scenarios: [
			{
				title: "Expired coupon is rejected",
				steps: [
					["Open the cart with one $100.00 item", null],
					["Apply the coupon OLD10", 'Error "Coupon expired"; total unchanged'],
					["Reload the page", "The cart keeps the item and total"],
				],
			},
			{
				title: "Coupon {coupon} is applied to a total in {currency}",
				steps: [
					["Open the cart with items worth 120.00 {currency}", null],
					["Apply the coupon {coupon}", "The discount shows as its own line"],
					["Continue to payment", "The amount to pay is the discounted total"],
				],
			},
			{
				title: "Coupon {coupon} is refused under its minimum spend",
				steps: [
					["Open the cart with one $5.00 item", null],
					["Apply the coupon {coupon}", "A message names the minimum spend; total unchanged"],
				],
			},
			{
				title: "Removing coupon {coupon} restores the total",
				steps: [
					["Apply the coupon {coupon} to a cart worth $80.00", "The discount is shown"],
					["Remove the coupon", "The total returns to $80.00"],
					["Reload the page", "No coupon is applied"],
				],
			},
			{
				title: "A second coupon replaces {coupon}",
				steps: [
					["Apply the coupon {coupon}", "The discount is shown"],
					["Apply another valid coupon", "Only the second discount is shown"],
				],
			},
			{
				title: "Coupon {coupon} is refused for {currency} orders it excludes",
				steps: [
					["Switch the shop currency to {currency}", "Prices show in {currency}"],
					["Apply the coupon {coupon}", "A message says the coupon does not apply in {currency}"],
				],
			},
		],
	},
	{
		path: "Checkout/Cart",
		weight: 8,
		tags: ["checkout"],
		pre: signedIn,
		scenarios: [
			{
				title: "Cart preserves the quantity",
				steps: [
					["Add a product to the cart and set its quantity to 3", "The line total is three times the price"],
					["Sign out and sign in again", "The cart holds the product with quantity 3"],
				],
			},
			{
				title: "Quantity {quantity} of a {category} item updates the subtotal",
				steps: [
					["Add an item from {category} to the cart", null],
					["Set its quantity to {quantity}", "The subtotal is {quantity} times the price"],
				],
			},
			{
				title: "Removing the last {category} item empties the cart",
				steps: [
					["Add one item from {category} to the cart", "The cart badge shows 1"],
					["Remove the item", 'The cart says "Your cart is empty"'],
				],
			},
			{
				title: "A {category} item out of stock cannot be added",
				steps: [
					["Open a {category} product with no stock", 'The button reads "Out of stock"'],
					["Try to add it through the quick-add menu", "Nothing is added and a message says why"],
				],
			},
			{
				title: "Cart merges a guest's {category} items on sign-in",
				pre: "Start signed out, with one item saved in the account's cart.",
				steps: [
					["Add an item from {category} as a guest", "The cart badge shows 1"],
					["Sign in", "The cart holds both items"],
				],
			},
			{
				title: "A price change is announced in the cart for {currency}",
				steps: [
					["Add a product to the cart with prices in {currency}", null],
					["Change its price in the back office and reload the cart", "The new price and a notice are shown"],
				],
			},
		],
	},
	{
		path: "Checkout/Payment",
		weight: 10,
		tags: ["checkout", "payments"],
		pre: "Open the checkout with one item in the cart.",
		scenarios: [
			{
				title: "Pay with {card} in {currency}",
				steps: [
					["Choose card payment and enter a {card} test card", "The card brand is recognised"],
					["Confirm the order in {currency}", "The order is placed and the receipt shows {currency}"],
				],
			},
			{
				title: "Pay with {wallet}",
				steps: [
					["Choose {wallet}", "The {wallet} sheet opens"],
					["Approve the payment", "The order is placed and the confirmation page opens"],
				],
			},
			{
				title: "A declined {card} card keeps the order unpaid",
				steps: [
					["Enter a {card} test card that is declined", null],
					["Confirm the order", "A message says the card was declined; no order is created"],
					["Enter a valid card and confirm", "The order is placed once"],
				],
			},
			{
				title: "Cancelling {wallet} returns to the payment step",
				steps: [
					["Choose {wallet} and close its sheet", "The payment step is shown with the cart unchanged"],
					["Choose card payment", "The card form opens"],
				],
			},
			{
				title: "3-D Secure is asked for a {card} card from {country}",
				steps: [
					["Enter a {card} test card issued in {country}", null],
					["Confirm the order", "The bank's challenge opens"],
					["Complete the challenge", "The order is placed"],
				],
			},
			{
				title: "A saved {card} card pays in one step",
				pre: "Use an account with a saved card.",
				steps: [
					["Choose the saved {card} card", "Only the security code is asked"],
					["Confirm the order", "The order is placed"],
				],
			},
		],
	},
	{
		path: "Checkout/Shipping",
		weight: 8,
		tags: ["checkout", "shipping"],
		pre: "Open the checkout with one item in the cart.",
		scenarios: [
			{
				title: "Order total includes shipping",
				steps: [
					["Enter a delivery address", "Delivery options and their prices are listed"],
					["Choose the first option", "The total is the subtotal plus that price"],
				],
			},
			{
				title: "{delivery} delivery to {country} shows its price and date",
				steps: [
					["Enter an address in {country}", "Delivery options for {country} are listed"],
					["Choose {delivery} delivery", "The price and the expected date are shown"],
				],
			},
			{
				title: "An address in {country} is validated",
				steps: [
					["Enter an address in {country} with a postal code of the wrong shape", "The field names the problem"],
					["Correct the postal code", "The address is accepted"],
				],
			},
			{
				title: "{carrier} is offered for {delivery} delivery",
				steps: [
					["Enter a domestic address", null],
					["Choose {delivery} delivery", "{carrier} is listed with its price"],
				],
			},
			{
				title: "Free shipping applies over the threshold in {currency}",
				steps: [
					["Switch the shop currency to {currency}", null],
					["Fill the cart above the free-shipping threshold", "Shipping shows as free"],
					["Remove an item to go under the threshold", "The shipping price returns"],
				],
			},
		],
	},
	{
		path: "Checkout/Tax",
		weight: 4,
		tags: ["checkout", "tax"],
		pre: "Open the checkout with one item in the cart.",
		scenarios: [
			{
				title: "Tax for {country} is shown before payment in {currency}",
				steps: [
					[
						"Switch the shop currency to {currency} and enter an address in {country}",
						"The tax line shows the rate for {country}",
					],
					["Continue to payment", "The total in {currency} includes the tax"],
				],
			},
			{
				title: "A business account in {country} is charged no VAT",
				pre: "Use a business account with a valid tax number.",
				steps: [
					["Enter a company address in {country}", null],
					["Open the order summary", "VAT is zero and the tax number is printed"],
				],
			},
			{
				title: "Tax follows a change of address to {country}",
				steps: [
					["Enter a domestic address", "Domestic tax is shown"],
					["Change the address to one in {country}", "The tax line changes to the rate for {country}"],
				],
			},
		],
	},
	{
		path: "Accounts/Sign-in",
		weight: 6,
		tags: ["accounts"],
		pre: "Start signed out.",
		across: ["platform", "language"],
		scenarios: [
			{
				title: "Sign in with an email and a password",
				steps: [
					["Enter the email and the password of a customer", null],
					["Submit", "The account page opens and the header shows the name"],
				],
			},
			{
				title: "A wrong password is refused without naming the account",
				steps: [
					["Enter a known email and a wrong password", null],
					["Submit", "One message for a wrong email or password; nobody is signed in"],
				],
			},
			{
				title: "Five wrong passwords lock sign-in for a while",
				steps: [
					["Submit a wrong password five times", "A message says how long to wait"],
					["Submit the right password at once", "It is refused until the wait is over"],
				],
			},
			{
				title: "Sign in with {wallet} as the identity",
				steps: [
					["Choose to continue with {wallet}", "The provider's page opens"],
					["Approve", "The shop opens signed in"],
				],
			},
			{
				title: "Signing out ends the session on this device",
				pre: signedIn,
				steps: [
					["Sign out", "The sign-in page opens"],
					["Press the browser's back button", "The account page is not shown"],
				],
			},
		],
	},
	{
		path: "Accounts/Registration",
		weight: 5,
		tags: ["accounts"],
		pre: "Start signed out.",
		across: ["platform", "language"],
		scenarios: [
			{
				title: "Register from {country}",
				steps: [
					["Open the registration form and choose {country}", "The address fields follow {country}"],
					["Fill the form and submit", "A confirmation email is sent"],
					["Open the link in the email", "The account is active"],
				],
			},
			{
				title: "An email already registered is not revealed",
				steps: [
					["Register with the email of an existing customer", null],
					["Submit", "The same confirmation page is shown; the owner of the email gets a notice"],
				],
			},
			{
				title: "A weak password is refused with its reason",
				steps: [
					["Enter a password of six letters", "The form says what is missing"],
					["Enter a long passphrase", "The form accepts it"],
				],
			},
			{
				title: "The {field} is optional at registration",
				steps: [
					["Fill the form and leave the {field} empty", null],
					["Submit", "The account is created"],
				],
			},
		],
	},
	{
		path: "Accounts/Password reset",
		weight: 4,
		tags: ["accounts"],
		pre: "Start signed out.",
		across: ["platform", "language"],
		scenarios: [
			{
				title: "Password reset restores access",
				steps: [
					["Ask for a reset link for a customer's email", "A message says to check the inbox"],
					["Open the link and set a new password", "The sign-in page opens"],
					["Sign in with the new password", "The account page opens"],
				],
			},
			{
				title: "A reset link works once",
				steps: [
					["Use a reset link to set a new password", null],
					["Open the same link again", "It is refused as used"],
				],
			},
			{
				title: "A reset link ends after an hour",
				steps: [
					["Ask for a reset link and wait more than an hour", null],
					["Open the link", "It is refused as expired, with a way to ask again"],
				],
			},
			{
				title: "A reset ends the other sessions",
				pre: "Stay signed in on a second device.",
				steps: [
					["Reset the password on the first device", null],
					["Reload the shop on the second device", "The sign-in page opens"],
				],
			},
		],
	},
	{
		path: "Accounts/Profile",
		weight: 4,
		tags: ["accounts"],
		pre: signedIn,
		across: ["platform", "language"],
		scenarios: [
			{
				title: "Changing the {field} is saved",
				steps: [
					["Open the profile and change the {field}", null],
					["Save and reload", "The new {field} is shown"],
				],
			},
			{
				title: "A change of email is confirmed at the new address",
				steps: [
					["Enter a new email and save", "A confirmation is sent to the new address"],
					["Open the link", "The profile shows the new email"],
				],
			},
			{
				title: "Deleting the account asks for the password",
				steps: [
					["Choose to delete the account", "The password is asked"],
					["Enter it and confirm", "The account is closed and its orders are kept for the shop"],
				],
			},
		],
	},
	{
		path: "Accounts/Addresses",
		weight: 4,
		tags: ["accounts", "shipping"],
		pre: signedIn,
		across: ["platform", "language"],
		scenarios: [
			{
				title: "An address in {country} is saved to the address book",
				steps: [
					["Add an address in {country}", "It is listed in the address book"],
					["Open the checkout", "The address is offered"],
				],
			},
			{
				title: "The default address is used at checkout",
				steps: [
					["Mark the second address as the default", null],
					["Open the checkout", "The second address is selected"],
				],
			},
			{
				title: "Deleting an address leaves past orders unchanged",
				steps: [
					["Delete an address an order was sent to", "It leaves the address book"],
					["Open that order", "The order still shows the address"],
				],
			},
		],
	},
	{
		path: "Orders/History",
		weight: 5,
		tags: ["orders"],
		pre: "Use an account with orders in every status.",
		scenarios: [
			{
				title: "An order to {country} that is {status} shows that status",
				steps: [
					["Open the order history", "Orders are listed newest first"],
					["Open an order to {country} that is {status}", 'The page shows "{status}" and when it changed'],
				],
			},
			{
				title: "Order history pages through more than twenty orders",
				steps: [
					["Open the order history", "Twenty orders are listed"],
					["Go to the next page", "The older orders are listed and none repeats"],
				],
			},
			{
				title: "Reordering adds the items of a past order to the cart",
				steps: [
					["Open a delivered order and choose to order again", "The cart holds its items at today's prices"],
					["Open the cart", "An item no longer sold is named and left out"],
				],
			},
		],
	},
	{
		path: "Orders/Returns",
		weight: 6,
		tags: ["orders", "returns"],
		pre: "Use an account with a delivered order.",
		scenarios: [
			{
				title: "A return for {reason} gets a {carrier} label",
				steps: [
					["Open the delivered order and start a return", null],
					['Choose the reason "{reason}" and {carrier}, and confirm', "A {carrier} label can be downloaded"],
				],
			},
			{
				title: "A return is refused after the return period",
				pre: "Use an order delivered more than thirty days ago.",
				steps: [
					["Open the order", "The return button is not offered"],
					["Open the return address directly", "A message names the return period"],
				],
			},
			{
				title: "A refund to {card} matches the returned items",
				steps: [
					["Return one of two items paid with {card}", null],
					["Mark the return as received in the back office", "The refund is the price of that item and its tax"],
				],
			},
			{
				title: "A return sent with {carrier} can be tracked",
				steps: [
					["Start a return and choose {carrier}", "The label names {carrier}"],
					["Open the return", "A tracking link for {carrier} is shown"],
				],
			},
		],
	},
	{
		path: "Orders/Tracking",
		weight: 4,
		tags: ["orders", "shipping"],
		pre: "Use an account with a shipped order.",
		scenarios: [
			{
				title: "A {carrier} parcel shows its tracking events",
				steps: [
					["Open an order shipped with {carrier}", "The tracking number links to {carrier}"],
					["Open the tracking panel", "Events are listed with the newest first"],
				],
			},
			{
				title: "An order split in two parcels shows both",
				steps: [
					["Open an order sent in two parcels", "Each parcel lists its own items"],
					["Open the second parcel", "It has its own tracking number"],
				],
			},
			{
				title: "A guest tracks an order with its number and email",
				pre: "Start signed out.",
				steps: [
					["Open order tracking and enter an order number and its email", "The order's status is shown"],
					["Enter the number with another email", "Nothing about the order is shown"],
				],
			},
		],
	},
	{
		path: "Orders/Invoices",
		weight: 3,
		tags: ["orders", "tax"],
		pre: "Use an account with a paid order.",
		scenarios: [
			{
				title: "An invoice in {currency} can be downloaded",
				steps: [
					["Open an order paid in {currency}", null],
					["Download the invoice", "A PDF opens with the totals in {currency}"],
				],
			},
			{
				title: "An invoice for {country} carries its tax lines",
				steps: [
					["Open an order sent to {country}", null],
					["Download the invoice", "Each tax rate for {country} is its own line"],
				],
			},
			{
				title: "A refund adds a credit note to the order",
				steps: [
					["Refund an order in the back office", null],
					["Open the order as the customer", "A credit note is listed beside the invoice"],
				],
			},
		],
	},
	{
		path: "Catalog/Search",
		weight: 7,
		tags: ["catalog", "search"],
		pre: "Open the shop's home page.",
		scenarios: [
			{
				title: "Searching {category} lists matching products by {sort}",
				steps: [
					['Type "{category}" in the search field', "Suggestions appear while typing"],
					["Press Enter and sort by {sort}", "Only products of {category} are listed, in that order"],
				],
			},
			{
				title: "A misspelt search for {category} offers the right word",
				steps: [
					['Search for "{category}" with two letters swapped', null],
					["Read the results", 'A line asks "Did you mean {category}?"'],
				],
			},
			{
				title: "A search with no result suggests categories",
				steps: [
					['Search for "qzxv"', "A message says nothing was found"],
					["Read the page", "The main categories are offered"],
				],
			},
			{
				title: "Search results sort by {sort}",
				steps: [
					["Search for a common word", null],
					["Choose to sort by {sort}", "The order follows it and the choice stays on the next page"],
				],
			},
		],
	},
	{
		path: "Catalog/Filters",
		weight: 6,
		tags: ["catalog"],
		pre: "Open a category page.",
		scenarios: [
			{
				title: "Catalog keeps the selected filters",
				steps: [
					["Choose a size and a colour", "The list narrows and the address holds both filters"],
					["Open a product and go back", "Both filters are still selected"],
				],
			},
			{
				title: "{category} filters by price range in {currency}",
				steps: [
					["Open {category} with prices in {currency}", null],
					["Set a price range", "Every listed product is within it"],
				],
			},
			{
				title: "Clearing the filters of {category} restores the full list",
				steps: [
					["Open {category} and choose three filters", "The count of products drops"],
					["Clear all filters", "The count is the one the category started with"],
				],
			},
			{
				title: "{category} sorted by {sort} keeps its filters",
				steps: [
					["Open {category} and choose a brand", null],
					["Sort by {sort}", "The brand filter stays and the order changes"],
				],
			},
		],
	},
	{
		path: "Catalog/Product page",
		weight: 6,
		tags: ["catalog"],
		pre: "Open the shop's home page.",
		scenarios: [
			{
				title: "A {category} product shows price, stock and delivery",
				steps: [
					["Open a product from {category}", "Price, stock and the earliest delivery date are shown"],
					["Choose another size", "Stock and price follow the size"],
				],
			},
			{
				title: "The gallery of a {category} product opens full screen",
				steps: [
					["Open a product from {category} and select its second picture", "The picture replaces the first"],
					["Open it full screen and press Escape", "The page returns to where it was"],
				],
			},
			{
				title: "A {category} product shows its price in {currency}",
				steps: [
					["Switch the shop currency to {currency}", null],
					["Open a product from {category}", "The price is in {currency} with its usual format"],
				],
			},
			{
				title: "A discontinued {category} product says so",
				steps: [
					["Open the address of a {category} product no longer sold", "The page says it is no longer sold"],
					["Read the page", "Similar products are offered"],
				],
			},
		],
	},
	{
		path: "Catalog/Reviews",
		weight: 3,
		tags: ["catalog"],
		pre: "Use an account that bought the product.",
		scenarios: [
			{
				title: "A {rating}-star review appears after approval",
				steps: [
					["Write a review with {rating} stars and submit", "A message says it awaits approval"],
					["Approve it in the back office", "The product shows the review and the new average"],
				],
			},
			{
				title: "Only a buyer may review a {category} product",
				pre: "Use an account that never bought the product.",
				steps: [
					["Open a product from {category}", "No review form is offered"],
					["Open the review address directly", "It is refused"],
				],
			},
		],
	},
	{
		path: "Catalog/Wishlist",
		weight: 3,
		tags: ["catalog"],
		pre: signedIn,
		scenarios: [
			{
				title: "A {category} product is saved to the wishlist",
				steps: [
					["Open a product from {category} and press the heart", "The heart is filled"],
					["Open the wishlist", "The product is listed"],
				],
			},
			{
				title: "A wishlist item back in stock is announced",
				steps: [
					["Save a product with no stock to the wishlist", null],
					["Add stock in the back office", "An email says the product is back"],
				],
			},
			{
				title: "Moving a {category} wishlist item to the cart",
				steps: [
					["Save a product from {category} and open the wishlist", null],
					["Choose to add it to the cart", "The cart holds it and the wishlist keeps it"],
				],
			},
		],
	},
	{
		path: "Back office/Inventory",
		weight: 5,
		tags: ["back-office"],
		pre: backOffice,
		across: ["language"],
		scenarios: [
			{
				title: "A stock change by a {role} reaches the shop",
				pre: "Sign in to the back office as a {role}.",
				steps: [
					["Set the stock of a product to 0", null],
					["Open the product in the shop", 'The button reads "Out of stock"'],
				],
			},
			{
				title: "Importing stock for {category} from a file",
				steps: [
					["Upload a stock file for {category}", "A preview lists the changes"],
					["Confirm", "The stock of each listed product is the file's"],
				],
			},
			{
				title: "A stock file with a bad row is refused whole",
				steps: [
					["Upload a stock file with a negative quantity", "The row is named with its reason"],
					["Open the inventory", "Nothing changed"],
				],
			},
			{
				title: "Low stock of a {category} product raises an alert",
				steps: [
					["Set the alert level of a {category} product to 5 and its stock to 4", null],
					["Open the alerts", "The product is listed"],
				],
			},
		],
	},
	{
		path: "Back office/Pricing",
		weight: 4,
		tags: ["back-office", "payments"],
		pre: backOffice,
		across: ["language"],
		scenarios: [
			{
				title: "A price in {currency} is set per product",
				steps: [
					["Open a product and set its price in {currency}", null],
					["Open the product in the shop in {currency}", "The new price is shown"],
				],
			},
			{
				title: "A sale price for {category} starts and ends on its dates",
				steps: [
					["Plan a sale for {category} that starts tomorrow", "Today's price is unchanged"],
					["Move the clock past the start", "The sale price and the old price are both shown"],
				],
			},
			{
				title: "A {role} without the pricing right cannot change a price",
				pre: "Sign in to the back office as a {role} without the pricing right.",
				steps: [
					["Open a product", "The price field is read-only"],
					["Send the change directly", "It is refused"],
				],
			},
		],
	},
	{
		path: "Back office/Promotions",
		weight: 4,
		tags: ["back-office", "checkout"],
		pre: backOffice,
		across: ["language"],
		scenarios: [
			{
				title: "Creating the coupon {coupon}",
				steps: [
					["Create the coupon {coupon} with a value and an end date", "It is listed as active"],
					["Apply it in the shop", "The discount is given"],
				],
			},
			{
				title: "Ending the coupon {coupon} early",
				steps: [
					["End the coupon {coupon} now", "It is listed as ended"],
					["Apply it in the shop", "It is refused as expired"],
				],
			},
			{
				title: "A coupon limited to {category}",
				steps: [
					["Create a coupon that applies to {category} only", null],
					["Apply it to a cart with one {category} item and one other", "Only the {category} item is discounted"],
				],
			},
		],
	},
	{
		path: "Back office/Staff",
		weight: 3,
		tags: ["back-office", "accounts"],
		pre: backOffice,
		across: ["language"],
		scenarios: [
			{
				title: "Inviting a {role}",
				steps: [
					["Invite a new colleague as a {role}", "An invitation is sent"],
					["Accept it", "The colleague sees what a {role} may see"],
				],
			},
			{
				title: "Removing a {role} ends their sessions",
				steps: [
					["Remove a colleague who is a {role}", null],
					["Reload the back office as that colleague", "The sign-in page opens"],
				],
			},
			{
				title: "The audit log names who changed a {role}'s rights",
				steps: [
					["Change the rights of a {role}", null],
					["Open the audit log", "The change is listed with who made it and when"],
				],
			},
		],
	},
	{
		path: "Notifications/Email",
		weight: 4,
		tags: ["notifications"],
		pre: "Use an account whose inbox can be read.",
		across: ["language", "customer"],
		scenarios: [
			{
				title: "An order that is {status} sends its email",
				steps: [
					["Move an order to {status} in the back office", null],
					["Open the customer's inbox", 'One email says the order is "{status}"'],
				],
			},
			{
				title: "The order confirmation lists totals in {currency}",
				steps: [
					["Place an order in {currency}", null],
					["Open the confirmation email", "Items, shipping, tax and total are in {currency}"],
				],
			},
			{
				title: "Unsubscribing stops marketing email and keeps order email",
				steps: [
					["Follow the unsubscribe link of a marketing email", "A page confirms it"],
					["Place an order", "The confirmation email still arrives"],
				],
			},
		],
	},
	{
		path: "Notifications/Push",
		weight: 2,
		tags: ["notifications", "mobile"],
		pre: "Install the app and allow notifications.",
		across: ["language"],
		scenarios: [
			{
				title: "A {carrier} parcel that is {status} sends a push message",
				steps: [
					["Mark a {carrier} parcel as {status}", null],
					["Look at the device", "A message names the order; a tap opens it"],
				],
			},
			{
				title: "Push messages stop after sign-out",
				steps: [
					["Sign out of the app", null],
					["Ship an order of that account", "No message arrives on the device"],
				],
			},
		],
	},
	{
		path: "Mobile app/Onboarding",
		weight: 3,
		tags: ["mobile"],
		pre: "Install the app on a clean device.",
		across: ["language", "customer"],
		scenarios: [
			{
				title: "First launch in {country} picks its currency",
				steps: [
					["Set the device region to {country} and open the app", null],
					["Open any product", "The price is in the currency of {country}"],
				],
			},
			{
				title: "Skipping the introduction opens the home screen",
				steps: [
					["Open the app and press Skip", "The home screen opens"],
					["Close and reopen the app", "The introduction is not shown again"],
				],
			},
			{
				title: "Signing in with {wallet} on first launch",
				steps: [
					["Choose to continue with {wallet}", "The system sheet opens"],
					["Approve", "The app opens signed in, with the account's cart"],
				],
			},
		],
	},
	{
		path: "Mobile app/Offline",
		weight: 2,
		tags: ["mobile"],
		pre: "Open the app signed in, then turn on flight mode.",
		across: ["language", "customer"],
		scenarios: [
			{
				title: "The cart can be read offline",
				steps: [
					["Open the cart", "The items are shown with a notice that prices may be old"],
					["Press Checkout", "A message asks for a connection"],
				],
			},
			{
				title: "A {category} page seen before opens offline",
				pre: "Open {category} once while online, then turn on flight mode.",
				steps: [
					["Open {category}", "The products seen before are shown"],
					["Pull to refresh", "A message says the device is offline"],
				],
			},
		],
	},
	{
		path: "API/Orders",
		weight: 4,
		tags: ["api"],
		pre: "Hold an API key of a test merchant.",
		across: [],
		scenarios: [
			{
				title: "GET /orders lists {currency} orders that are {status}",
				steps: [
					[
						"Request /orders with status {status} and currency {currency}",
						"Status 200 and only {currency} orders that are {status}",
					],
					["Follow the next link", "The next page, with no order repeated"],
				],
			},
			{
				title: "POST /orders in {currency} to {country} is idempotent",
				steps: [
					["Create an order in {currency} to {country} with an idempotency key", "Status 201"],
					["Send the same request again", "The same order is returned and none is added"],
				],
			},
			{
				title: "A key without the orders scope is refused",
				steps: [
					["Request /orders with a key limited to the catalog", "Status 403 with a reason"],
					["Request /products with the same key", "Status 200"],
				],
			},
		],
	},
	{
		path: "API/Webhooks",
		weight: 3,
		tags: ["api"],
		pre: "Register a webhook address that records what it receives.",
		across: [],
		scenarios: [
			{
				title: "{event} for a {currency} order is delivered with a valid signature",
				steps: [
					["Cause {event} for an order in {currency}", "One request arrives"],
					["Check its signature with the shared secret", "It verifies"],
				],
			},
			{
				title: "A failed delivery of {event} to {country} is retried",
				steps: [
					[
						"Make the webhook address answer 500 and cause {event} for an order to {country}",
						"The first attempt is recorded as failed",
					],
					["Make the address answer 200", "The event arrives again with the same id"],
				],
			},
		],
	},
];
