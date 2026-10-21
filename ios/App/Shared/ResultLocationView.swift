import MainworthyClient
import MainworthyScreens
import SwiftUI

struct ResultLocationView: View {
	let location: ResultLocation
	let workspace: Workspace

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			if let key = location.change, let changes = workspace.changes {
				NavigationLink {
					ChangeView(key: key, screen: changes, workspace: workspace)
				} label: { Text(location.label).multilineTextAlignment(.leading) }
				.buttonStyle(.plain)
				.foregroundStyle(Color.accentColor)
			} else {
				Text(location.label)
			}
			if let commit = location.commit {
				Text(commit.prefix(12)).font(.caption.monospaced()).foregroundStyle(.secondary)
			}
		}
		.font(.subheadline)
	}
}
