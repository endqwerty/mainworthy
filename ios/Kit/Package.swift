// swift-tools-version: 6.0
// Everything of the app that is not a screen. It builds and tests on a Mac with `swift test`, with no simulator
// (`bun scripts/ios.ts test` starts the server the tests talk to).
//
// Two modules, and the second is the only way the app reaches the first:
//
// - MainworthyClient knows the server: what is sent, what comes back, who is signed in. What it hands out are
//   values (a question, an answer). Everything that sends a request is `package`, so the app target, which is
//   outside this package, cannot call it: a screen never holds a connection.
// - MainworthyScreens holds what each screen shows and does. A SwiftUI view binds to one of its classes.
import PackageDescription

let package = Package(
	name: "Kit",
	platforms: [.iOS(.v18), .macOS(.v15)],
	products: [
		.library(name: "MainworthyKit", targets: ["MainworthyClient", "MainworthyScreens"]),
	],
	targets: [
		.target(name: "MainworthyClient"),
		.target(name: "MainworthyScreens", dependencies: ["MainworthyClient"]),
		// What the two test targets share: a project of their own on the server the tests run against.
		.target(name: "TestSupport", dependencies: ["MainworthyClient"], path: "Tests/Support"),
		.testTarget(name: "MainworthyClientTests", dependencies: ["MainworthyClient", "TestSupport"]),
		.testTarget(
			name: "MainworthyScreensTests", dependencies: ["MainworthyScreens", "MainworthyClient", "TestSupport"]
		),
	],
	swiftLanguageModes: [.v6]
)
