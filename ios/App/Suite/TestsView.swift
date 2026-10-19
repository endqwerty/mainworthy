import MainworthyClient
import MainworthyScreens
import SwiftUI

/// A test's page, pushed from a change's results. The Cases tab pushes `SuiteRoute.test`: its path holds only routes.
struct TestLink: Hashable {
	let ref: String
}

/// Every automated test the project has seen, with a case or tracked without one.
struct TestsListView: View {
	@Bindable var screen: TestsScreen

	var body: some View {
		List {
			Section {
				Toggle("Only tests with no case", isOn: unlinked).accessibilityIdentifier("tests-unlinked")
			}
			if case .failed(let why) = screen.loading {
				Section {
					Text(why).foregroundStyle(Color.fail)
					Button("Try again") { Task { await screen.read() } }
				}
			}
			if let notice = screen.notice { Text(notice).foregroundStyle(Color.fail) }
			Section {
				ForEach(screen.tests) { test in
					NavigationLink(value: SuiteRoute.test(test.ref)) { TestRow(test: test) }
						.accessibilityIdentifier("test-\(test.ref)")
				}
				if screen.hasMore {
					ProgressView().frame(maxWidth: .infinity).task { await screen.more() }
				}
			}
			if screen.loading == .first {
				ListPlaceholder { ProgressView() }
			} else if screen.loading == .done, screen.tests.isEmpty {
				ListPlaceholder {
					ContentUnavailableView(
						"No tests", systemImage: "gearshape.2",
						description: Text(!screen.isFiltered
							? "A pipeline's report adds the tests it ran."
							: "No test matches.")
					)
				}
			}
		}
		.holdsPlaceholder()
		.navigationTitle("Automated tests")
		.navigationBarTitleDisplayMode(.inline)
		.searchable(text: $screen.text, placement: .navigationBarDrawer(displayMode: .always), prompt: "Name or file")
		.task { await screen.load() }
		.task(id: screen.text) {
			guard screen.loading != .first else { return }
			do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
			await screen.search()
		}
		.refreshable { await screen.read() }
	}

	private var unlinked: Binding<Bool> {
		Binding(get: { screen.unlinked }, set: { chosen in Task { await screen.showUnlinked(chosen) } })
	}
}

private struct TestRow: View {
	let test: TestSummary

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(test.name).font(.body.weight(.medium)).lineLimit(2)
			HStack(spacing: 6) {
				RefText(test.ref)
				if let ref = test.caseRef { RefText(ref) } else { Tag(text: "no case", tint: .secondary) }
				if test.quarantine != nil { Tag(text: "quarantined", tint: .warn) }
			}
			if let file = test.file {
				Text(file).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
			}
		}
		.padding(.vertical, 2)
	}
}

/// One test: where it is, its case or that it has none, and its latest results with their commit and change.
struct TestView: View {
	let ref: String
	let screen: TestsScreen
	let workspace: Workspace
	/// Whether its case opens here: in the Cases tab it does, where a case's page has what it needs.
	let opensCase: Bool

	var body: some View {
		Group {
			switch screen.detail(ref) {
			case .read(let test): page(test)
			case .missing:
				ContentUnavailableView("No such test", systemImage: "questionmark",
					description: Text("The project has no test \(ref)."))
			case .failed(let why):
				ContentUnavailableView {
					Label("The test could not be read", systemImage: "exclamationmark.triangle")
				} description: { Text(why) } actions: {
					Button("Try again") { Task { await screen.readDetail(ref) } }
				}
			case .reading, nil: ProgressView()
			}
		}
		.navigationTitle(ref)
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			if let address = workspace.webAddress(of: ref) {
				ToolbarItem(placement: .topBarTrailing) {
					Link(destination: address) { Label("Open in the web app", systemImage: "safari") }
				}
			}
		}
		.task(id: ref) { await screen.open(ref) }
		.onDisappear { screen.close(ref) }
	}

	private func page(_ test: TestDetail) -> some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				VStack(alignment: .leading, spacing: 6) {
					Text(test.name).font(.title2.weight(.semibold))
					Text(test.file ?? "No file reported").font(.subheadline.monospaced()).foregroundStyle(.secondary)
					Text(test.key).font(.caption.monospaced()).foregroundStyle(.secondary)
				}
				.textSelection(.enabled)
				Panel("Case") {
					if let ref = test.caseRef {
						if opensCase {
							NavigationLink(value: SuiteRoute.document(ref: ref)) {
								Label(ref, systemImage: "doc.text").frame(maxWidth: .infinity, alignment: .leading)
							}
							.accessibilityIdentifier("test-case")
						} else {
							Text(ref).font(.body.monospaced()).accessibilityIdentifier("test-case")
						}
					} else {
						Text("None: the test is tracked without a case. Its results count for the gate all the same.")
							.accessibilityIdentifier("test-case")
					}
				}
				if let reason = test.quarantine {
					Panel("Quarantined") {
						Text(reason)
						Text("Its failures are shown and do not hold up a gate.").font(.subheadline).foregroundStyle(.secondary)
					}
				}
				if test.flips > 0 {
					Text("Flipped \(test.flips) \(test.flips == 1 ? "time" : "times") between passing and failing on the same code.")
						.font(.subheadline).foregroundStyle(Color.warn)
				}
				Panel("Latest results") {
					if test.results.isEmpty { Text("No results yet.").foregroundStyle(.secondary) }
					ForEach(test.results) { result in
						TestResultRow(result: result)
						if result.id != test.results.last?.id { Divider() }
					}
				}
			}
			.padding(16)
		}
		.background(Color(.systemGroupedBackground))
		.refreshable { await screen.readDetail(ref) }
	}
}

private struct TestResultRow: View {
	let result: TestDetail.Result

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 6) {
				Tag(text: result.outcome, tint: outcomeTint(result.outcome))
				if let commit = result.commit { Text(commit.prefix(12)).font(.caption.monospaced()) }
				if let change = result.change { Text(change).font(.caption.weight(.medium)) }
				Spacer(minLength: 0)
				Text(result.at, format: .relative(presentation: .named)).font(.caption).foregroundStyle(.secondary)
			}
			Text(facts(job: result.job, attempt: result.attempt, duration: result.duration, by: result.by, model: result.model))
				.font(.caption).foregroundStyle(.secondary)
			if let message = result.message { Text(message).font(.footnote).lineLimit(4) }
			if let build = result.build { Link("Open the build", destination: build).font(.footnote) }
		}
		.padding(.vertical, 2)
		.accessibilityElement(children: .combine)
	}
}

/// What a result's colour is: green when it passed, red when it failed.
func outcomeTint(_ outcome: String) -> Color {
	switch outcome {
	case "pass": .pass
	case "fail", "error": .fail
	case "blocked": .warn
	default: .secondary
	}
}

/// "shop · attempt 2 · 1.4 s · robin": where a result came from, as one line.
func facts(job: String, attempt: Int, duration: Double?, by: String, model: String? = nil) -> String {
	var parts = [job]
	if attempt > 1 { parts.append("attempt \(attempt)") }
	if let duration {
		parts.append(duration < 1000 ? "\(Int(duration)) ms" : String(format: duration < 10_000 ? "%.1f s" : "%.0f s", duration / 1000))
	}
	parts.append(by)
	if let model { parts.append(model) }
	return parts.joined(separator: " · ")
}
