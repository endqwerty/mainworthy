import MainworthyClient
import MainworthyScreens
import SwiftUI

/// Who is signed in, where, and what this build is.
struct AccountView: View {
	let workspace: Workspace
	@State private var confirmingSignOut = false

	var body: some View {
		NavigationStack {
			List {
				Section("Signed in") {
					LabeledContent("Name") {
						Text(workspace.account.isOwner ? "\(workspace.account.name) · owner" : workspace.account.name)
					}
					LabeledContent("Instance", value: workspace.instanceName)
					NavigationLink("Your sessions") { SessionsView(screen: workspace.sessions) }
				}
				Section("Project") {
					ForEach(workspace.account.projects) { project in
						Button {
							workspace.open(project)
						} label: {
							HStack {
								VStack(alignment: .leading) {
									Text(project.name).foregroundStyle(.primary)
									Text("\(project.key) · \(project.policy)").font(.footnote).foregroundStyle(.secondary)
								}
								Spacer()
								if project == workspace.project {
									Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
								}
							}
						}
					}
				}
				Section {
					LabeledContent("App", value: Build.version)
					LabeledContent("Server", value: workspace.account.serverVersion)
					if let expiry = Build.signingEnds {
						LabeledContent("Works until") {
							Text(expiry, format: .dateTime.weekday(.wide).day().month().hour().minute())
								.foregroundStyle(expiry.timeIntervalSinceNow < 86_400 ? Color.fail : .secondary)
						}
					}
					Link("Documentation", destination: workspace.docsAddress)
					LabeledContent("Licence", value: "Apache License 2.0")
					Link("Licences", destination: workspace.docsAddress.appending(path: "licence"))
						.accessibilityIdentifier("licences")
				} header: {
					Text("About")
				} footer: {
					VStack(alignment: .leading, spacing: 4) {
						Text(Build.copyright).accessibilityIdentifier("copyright")
						// A free Apple ID signs an app for seven days, a paid membership for a year. Either way the
						// app stops opening on that day, and installing it again is what brings it back.
						if let expiry = Build.signingEnds, expiry.timeIntervalSinceNow < 8 * 86_400 {
							Text("The app's signing runs out on that day. Install it again before then: the sign-in is kept.")
						}
					}
				}
				Section {
					Button("Sign out", role: .destructive) { confirmingSignOut = true }
						.accessibilityIdentifier("sign-out")
				}
			}
			.navigationTitle("You")
			.confirmationDialog("Sign out of \(workspace.instanceName)?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
				Button("Sign out", role: .destructive) { Task { await workspace.signOut() } }
			}
		}
	}
}

/// What this build is: its version, the commit it was built from, its copyright, and when its signing runs out.
enum Build {
	static var version: String {
		let info = Bundle.main.infoDictionary ?? [:]
		let version = info["CFBundleShortVersionString"] as? String ?? "?"
		let commit = info["MainworthyCommit"] as? String ?? "unknown"
		return commit == "unknown" ? version : "\(version) (\(commit))"
	}

	/// The copyright line, from the app's Info.plist, where the App Store and the system read it too.
	static var copyright: String {
		Bundle.main.infoDictionary?["NSHumanReadableCopyright"] as? String ?? ""
	}

	/// When the provisioning profile the app was installed with runs out. Nil in a simulator, which has none.
	/// The profile is a signed envelope around a property list; the list is read out of it as text.
	static let signingEnds: Date? = {
		guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
			let data = try? Data(contentsOf: url),
			let start = data.range(of: Data("<?xml".utf8)),
			let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
			let list = try? PropertyListSerialization.propertyList(from: data[start.lowerBound..<end.upperBound], format: nil)
		else { return nil }
		return (list as? [String: Any])?["ExpirationDate"] as? Date
	}()
}
