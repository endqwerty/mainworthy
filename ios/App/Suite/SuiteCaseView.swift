import MainworthyClient
import MainworthyScreens
import SwiftUI

struct SuiteCaseView: View {
	let route: SuiteRoute
	let screen: SuiteScreen
	let workspace: Workspace

	var body: some View {
		Group {
			switch screen.document(route.ref, version: route.version) {
			case .read(let document): page(document)
			case .failed(let why):
				ContentUnavailableView {
					Label("The case could not be read", systemImage: "exclamationmark.triangle")
				} description: { Text(why) } actions: {
					Button("Try again") { Task { await screen.openCase(route.ref, version: route.version) } }
				}
			case .reading, nil: ProgressView()
			}
		}
		.navigationTitle(route.ref)
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			if let address = workspace.webAddress(of: route.ref) {
				ToolbarItem(placement: .topBarTrailing) {
					Link(destination: address) { Label("Open in the web app", systemImage: "safari") }
				}
			}
		}
		.task { await screen.openCase(route.ref, version: route.version) }
	}

	private func page(_ document: CaseDocument) -> some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				VStack(alignment: .leading, spacing: 8) {
					Text(document.content.title).font(.title2.weight(.semibold))
					Text("Version \(document.version)").font(.subheadline).foregroundStyle(.secondary)
						.accessibilityIdentifier("case-version")
					Text(document.folder).font(.subheadline).foregroundStyle(.secondary)
					if route.version != nil {
						Text("A saved version. Folder and tags are the case's current placement.")
							.font(.caption).foregroundStyle(.secondary)
					}
					if !document.tags.isEmpty {
						Text(document.tags.map { "#\($0)" }.joined(separator: " "))
							.font(.caption).foregroundStyle(.secondary)
					}
				}
				if !document.content.pre.isEmpty {
					Panel("Preconditions") { Text(document.content.pre) }
				}
				Panel("Steps") {
					if document.content.steps.isEmpty { Text("No steps").foregroundStyle(.secondary) }
					ForEach(Array(document.content.steps.enumerated()), id: \.element.id) { index, step in
						VStack(alignment: .leading, spacing: 5) {
							Text("\(index + 1). \(step.action)").fontWeight(.medium)
							if let expected = step.expected {
								Text(expected).font(.subheadline).foregroundStyle(.secondary)
							}
						}
						.padding(.vertical, 4)
					}
				}
				Panel("Who may run it") {
					Text(document.content.methods.map { method in
						switch method {
						case "human": "A person"
						case "auto": "An automated test"
						case "agent": "An agent"
						default: method
						}
					}.joined(separator: ", "))
				}
				NavigationLink(value: SuiteRoute(ref: document.ref, history: true)) {
					Label("History", systemImage: "clock.arrow.circlepath").frame(maxWidth: .infinity, alignment: .leading)
				}
				.padding(12).background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
				.accessibilityIdentifier("case-history")
				if document.isHistorical {
					NavigationLink("Open current case", value: SuiteRoute(ref: document.ref))
						.accessibilityIdentifier("case-current")
				}
				if !document.isHistorical, workspace.project?.may(.produce) == true {
					Button("Edit case") { Task { await screen.edit(document) } }
						.buttonStyle(.borderedProminent).disabled(screen.preparingEditor)
						.accessibilityIdentifier("case-edit")
				}
			}
			.padding(16)
			.textSelection(.enabled)
		}
		.background(Color(.systemGroupedBackground))
	}
}

struct SuiteHistoryView: View {
	let ref: String
	let screen: SuiteScreen
	var body: some View {
		List {
			switch screen.history(ref) {
			case .read(let versions):
				ForEach(versions) { version in
					NavigationLink(value: SuiteRoute(ref: ref, version: version.version)) {
						VStack(alignment: .leading, spacing: 6) {
							Text("Version \(version.version)").font(.headline)
							Text("\(version.by) · \(version.at.formatted(date: .abbreviated, time: .shortened))")
								.font(.subheadline).foregroundStyle(.secondary)
							Text(version.summary).font(.subheadline)
							if let reason = version.reason { Text(reason).font(.subheadline).foregroundStyle(.secondary) }
						}
					}
					.accessibilityIdentifier("history-version-\(version.version)")
				}
			case .failed(let why):
				Text(why).foregroundStyle(Color.fail)
				Button("Try again") { Task { await screen.readHistory(ref) } }
			case .reading, nil: ProgressView()
			}
		}
		.navigationTitle("History")
		.navigationBarTitleDisplayMode(.inline)
		.task { await screen.readHistory(ref) }
	}
}
