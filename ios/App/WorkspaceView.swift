import MainworthyClient
import MainworthyScreens
import SwiftUI

/// What a signed-in person sees: a tab for each part of the product, on the project that is open.
struct WorkspaceView: View {
	let workspace: Workspace
	@Environment(\.scenePhase) private var scenePhase

	var body: some View {
		TabView {
			Tab("Queue", systemImage: "tray.full") {
				if let queue = workspace.queue {
					// A screen is one project's. Another project gets a new one, and SwiftUI a new view for it.
					QueueView(screen: queue, workspace: workspace)
						.id(workspace.project?.key)
				} else {
					NoProjectView()
				}
			}
			.badge(workspace.queue?.counts.open ?? 0)
			Tab("You", systemImage: "person.crop.circle") {
				AccountView(workspace: workspace)
			}
		}
		// The change stream of the open project, for as long as the app is in front.
		.task(id: FollowKey(project: workspace.project?.key, active: scenePhase == .active)) {
			guard scenePhase == .active else { return }
			// Who is signed in and what they may open is read first. The lists are read once the stream is open.
			await workspace.refreshAccount()
			await workspace.follow()
		}
	}

	private struct FollowKey: Equatable {
		let project: String?
		let active: Bool
	}
}

struct NoProjectView: View {
	var body: some View {
		ContentUnavailableView(
			"No project",
			systemImage: "folder",
			description: Text("You hold no grant on a project of this instance. An admin gives one in Settings, People.")
		)
	}
}

/// The open project in the navigation bar, and the others to switch to.
struct ProjectMenu: ToolbarContent {
	let workspace: Workspace

	var body: some ToolbarContent {
		ToolbarItem(placement: .topBarLeading) {
			Menu {
				Picker("Project", selection: selection) {
					ForEach(workspace.account.projects) { project in
						Text(project.name).tag(Optional(project))
					}
				}
			} label: {
				HStack(spacing: 4) {
					Text(workspace.project?.name ?? "No project")
					Image(systemName: "chevron.down").imageScale(.small)
				}
				.font(.subheadline.weight(.medium))
			}
			.accessibilityIdentifier("project-menu")
		}
	}

	private var selection: Binding<Project?> {
		Binding(
			get: { workspace.project },
			set: { chosen in if let chosen { workspace.open(chosen) } }
		)
	}
}
