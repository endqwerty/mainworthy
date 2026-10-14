import MainworthyScreens
import SwiftUI

@main
struct MainworthyApp: App {
	@State private var app = AppModel.live(
		version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
		// A test of the screens starts from a device nobody has signed in on.
		forgetting: ProcessInfo.processInfo.arguments.contains("-forget")
	)

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
