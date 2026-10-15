import MainworthyClient
import MainworthyScreens
import SwiftUI

@main
struct MainworthyApp: App {
	@State private var app = AppModel.live(
		version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
		instance: MainworthyApp.instance,
		// A test of the screens starts from a device nobody has signed in on.
		forgetting: ProcessInfo.processInfo.arguments.contains("-forget")
	)

	/// The instance the app signs in to. The sign-in screen does not ask (issue #233): it is `MAINWORTHY_INSTANCE`
	/// in the build settings, and a test of the screens names the server it started with `-instance <address>`.
	private static var instance: Instance {
		let arguments = ProcessInfo.processInfo.arguments
		let next = arguments.firstIndex(of: "-instance").map { $0 + 1 }
		let named = next.flatMap { arguments.indices.contains($0) ? arguments[$0] : nil }
		let address = named ?? Bundle.main.object(forInfoDictionaryKey: "MainworthyInstance") as? String ?? ""
		guard let instance = Instance(address: address) else {
			fatalError("MAINWORTHY_INSTANCE is not an address: \"\(address)\" (ios/Config/Base.xcconfig)")
		}
		return instance
	}

	var body: some Scene {
		WindowGroup {
			RootView(app: app)
		}
	}
}

/// One screen for each state the app is in.
struct RootView: View {
	let app: AppModel

	var body: some View {
		Group {
			switch app.phase {
			case .starting:
				ProgressView()
			case .unreachable(let why):
				ContentUnavailableView {
					Label("Not connected", systemImage: "wifi.slash")
				} description: {
					Text(why)
				} actions: {
					Button("Try again") { Task { await app.retry() } }
						.buttonStyle(.borderedProminent)
					Button("Sign out", role: .destructive) { Task { await app.signOut() } }
				}
			case .signedOut(let form):
				SignInView(form: form)
			case .signedIn(let workspace):
				WorkspaceView(workspace: workspace)
			}
		}
		.task { await app.start() }
	}
}
