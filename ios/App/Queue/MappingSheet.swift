import MainworthyClient
import MainworthyScreens
import SwiftUI

struct MappingSheet: View {
	@Bindable var screen: MappingScreen
	let queue: QueueScreen
	@State private var picking: TestRef?
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			Form {
				Section("Tests and cases affected") {
					Text(screen.question.title).font(.headline)
					if case .unlinked(let evidence) = screen.question.evidence, evidence.count != screen.tests.count {
						Text("This build cannot show every test in this question. Answer it in the web app.")
					}
					ForEach(screen.tests) { test in
						VStack(alignment: .leading, spacing: 6) {
							Text("\(test.ref): \(test.name)")
							if screen.creating {
								Text("New case: \(test.name)").foregroundStyle(.secondary)
							} else {
								Button {
									picking = test
								} label: {
									if let selected = screen.selections[test.ref] {
										Text("\(selected.ref): \(selected.title)")
									} else { Text("Choose a case") }
								}
								.disabled(screen.locked)
								.accessibilityIdentifier("map-case-\(test.ref)")
							}
						}
					}
					if screen.creating {
						Text("Makes one automated case per shown test, titled after that test, and links it. The server chooses the folder from the test file.")
							.foregroundStyle(.secondary)
					}
				}
				Section(screen.question.wantsReason ? "Reason required by policy" : "Reason, optional") {
					TextField("Why", text: $screen.reason, axis: .vertical)
						.disabled(screen.locked)
						.accessibilityIdentifier("map-reason")
				}
				if let latest = queue.current(screen.question.ref) ?? screen.actual, !screen.isCurrent(latest) {
					Section("Question changed") {
						Text(latest.decision.map { "Current answer: \($0.label), by \($0.by.joined(separator: ", "))." }
							?? "The question has changed. Review its current tests before answering again.")
						if latest.isOpen {
							Button("Review current tests") { screen.review(latest) }.disabled(!screen.mayReview)
						}
					}
				}
				if let notice = screen.notice {
					Section { Text(notice).accessibilityIdentifier("mapping-notice") }
				}
				if screen.isRetrying {
					Text("The result is uncertain. Editing is paused until the same command has a reply.")
				}
			}
			.navigationTitle(screen.creating ? "Create cases for tests" : "Link tests to cases")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button(screen.settled ? "Done" : "Close") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button(screen.isRetrying ? "Retry" : "Record") {
						Task {
							await screen.submit()
							await queue.refresh()
						}
					}
					.disabled(!screen.maySubmit)
					.accessibilityIdentifier("submit-mapping")
				}
			}
			.sheet(item: $picking) { test in
				picker(for: test)
			}
		}
	}

	private func picker(for test: TestRef) -> some View {
		NavigationStack {
			List {
				Text("Case for \(test.ref): \(test.name)")
				ForEach(screen.cases) { item in
					Button("\(item.ref): \(item.title)") {
						screen.choose(item, for: test)
						picking = nil
					}
					.accessibilityIdentifier("pick-\(item.ref)")
				}
				if screen.searching { ProgressView() }
				if let notice = screen.searchNotice { Text(notice) }
				if !screen.searching && screen.cases.isEmpty { Text("No cases found.") }
				if screen.hasMore { Button("More cases") { Task { await screen.findCases(more: true) } } }
			}
			.searchable(text: $screen.search, prompt: "Search cases or C-123")
			.task(id: screen.search) { await screen.findCases() }
			.navigationTitle("Choose a case")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { picking = nil } } }
		}
	}
}
