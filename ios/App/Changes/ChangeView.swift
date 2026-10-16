import MainworthyClient
import MainworthyScreens
import SwiftUI

/// A question pushed from a change's page: one about the change, or one a result's standing rests on.
struct QuestionLink: Hashable {
	let ref: String
}

struct ChangeView: View {
	let key: String
	let screen: ChangesScreen
	let workspace: Workspace

	var body: some View {
		Group {
			if let detail = screen.detail, detail.change.key == key {
				page(detail)
			} else if case .failed(let why) = screen.detailLoading {
				ContentUnavailableView {
					Label("This change could not be read", systemImage: "exclamationmark.triangle")
				} description: { Text(why) } actions: {
					Button("Try again") { Task { await screen.open(key) } }
				}
			} else {
				ProgressView()
			}
		}
		.navigationTitle(key)
		.navigationBarTitleDisplayMode(.inline)
		.task(id: key) { await screen.open(key) }
		.navigationDestination(for: QuestionLink.self) { question in
			if let queue = workspace.queue {
				ChangeQuestionView(ref: question.ref, queue: queue, changes: screen, workspace: workspace)
			}
		}
		.navigationDestination(for: TestLink.self) { test in
			if let tests = workspace.tests { TestView(ref: test.ref, screen: tests, workspace: workspace, opensCase: false) }
		}
	}

	private func page(_ detail: ChangeDetails) -> some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				Text(detail.change.title).font(.title2.weight(.semibold))
				Panel("Change") {
					LabeledContent("Key", value: key)
					LabeledContent("Branch", value: detail.change.branch ?? "Not reported")
					commit("Head", detail.change.head)
					commit("Base", detail.base)
					if let address = detail.change.address { Link("Open pull request", destination: address) }
					if detail.change.state != .open {
						Tag(text: detail.change.state.name, tint: .secondary)
					}
					if detail.change.state.isEnded {
						Text("This change has ended. The gate is the last verdict its head had.")
							.font(.subheadline).foregroundStyle(.secondary)
					}
				}
				Panel("Gate") {
					Tag(text: detail.gate.verdict.name, tint: detail.gate.verdict.tint)
						.accessibilityIdentifier("change-verdict")
					Text(detail.gate.reason).accessibilityIdentifier("change-reason")
					Text(detail.gate.phrase).font(.subheadline).foregroundStyle(.secondary)
					if detail.gate.stale {
						Text("The stored verdict has not caught up with the current evidence.")
							.font(.subheadline).foregroundStyle(Color.warn)
					}
				}
				if let notice = screen.notice { Text(notice).foregroundStyle(Color.fail) }
				if let results = screen.results, results.change == key, results.run == detail.gate.run {
					// Another run's results are another panel, which reads them when it appears.
					ChangeResultsPanel(results: results).id(ObjectIdentifier(results))
				}
				Panel("Open questions") {
					if detail.questions.isEmpty { Text("No open questions about this change.").foregroundStyle(.secondary) }
					ForEach(detail.questions) { question in
						NavigationLink(value: QuestionLink(ref: question.ref)) {
							VStack(alignment: .leading, spacing: 4) {
								HStack { RefText(question.ref); Tag(text: question.kind.name, tint: question.kind.tint) }
								Text(question.title)
									.multilineTextAlignment(.leading)
									.frame(maxWidth: .infinity, alignment: .leading)
							}
						}
						.accessibilityIdentifier("change-question-\(question.ref)")
					}
					if detail.questions.count == 500 {
						Text("Showing the first 500 questions. The Queue has the full list.").font(.footnote)
					}
				}
				Panel("Failing tests on the head") {
					if detail.failing.isEmpty { Text("No failing tests reported on this head.").foregroundStyle(.secondary) }
					ForEach(Array(detail.failing.enumerated()), id: \.offset) { _, failure in
						VStack(alignment: .leading, spacing: 4) {
							Text(failure.name ?? failure.test ?? "Unnamed test").fontWeight(.medium)
							if let file = failure.file { Text(file).font(.footnote.monospaced()).foregroundStyle(.secondary) }
							if let cause = failure.cause { Text(cause).font(.subheadline) }
							if let ref = failure.caseRef {
								Text("Case \(ref)\(detail.cases.first { $0.id == ref }.map { ": \($0.title)" } ?? "")")
									.font(.subheadline).foregroundStyle(.secondary)
							} else { Text("No linked case").font(.subheadline).foregroundStyle(.secondary) }
						}
					}
					if detail.failing.count == 50 { Text("Showing the first 50 failing tests.").font(.footnote) }
				}
				Panel("Cases this change touches") {
					if detail.cases.isEmpty { Text("No affected cases found.").foregroundStyle(.secondary) }
					ForEach(detail.cases) { item in
						VStack(alignment: .leading, spacing: 4) {
							HStack { RefText(item.id); Text(item.title) }
							Text(item.reasons.map { reason in
								reason.hasPrefix("test:") ? "Test file \(reason.dropFirst(5))" :
									reason.hasPrefix("req:") ? "Requirement \(reason.dropFirst(4))" : reason
							}.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
							if let last = item.lastResult { Text(last).font(.footnote).foregroundStyle(.secondary) }
						}
					}
					if detail.caseCount > detail.cases.count {
						Text("Showing \(detail.cases.count) of \(detail.caseCount) affected cases.").font(.footnote)
					}
				}
			}
			.padding(16)
		}
		.background(Color(.systemGroupedBackground))
		.refreshable { await screen.refresh() }
	}

	private func commit(_ label: String, _ value: String?) -> some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(label).font(.caption).foregroundStyle(.secondary)
			Text(value ?? "Not reported").font(.caption.monospaced()).textSelection(.enabled)
		}
	}
}

private struct ChangeQuestionView: View {
	let ref: String
	let queue: QueueScreen
	let changes: ChangesScreen
	let workspace: Workspace
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		QuestionView(ref: ref, screen: queue, workspace: workspace) {
			dismiss()
			Task { await changes.refresh() }
		}
	}
}
