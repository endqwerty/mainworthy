import MainworthyClient
import MainworthyScreens
import SwiftUI

struct RunsView: View {
	let screen: RunsScreen
	let workspace: Workspace
	@State private var path = NavigationPath()
	@State private var planning = false

	var body: some View {
		NavigationStack(path: $path) {
			List {
				ForEach(screen.runs) { run in
					NavigationLink(value: run.ref) {
						VStack(alignment: .leading, spacing: 6) {
							HStack {
								RefText(run.ref)
								Tag(text: run.verdict.word, tint: run.verdict.tint)
								Spacer()
								Text(run.state.word).font(.caption).foregroundStyle(.secondary)
							}
							Text(run.name).font(.headline)
							HStack {
								TimelineView(.periodic(from: .now, by: 1)) { clock in Text(detail(run, at: clock.date)) }
								Spacer()
								Text(run.createdAt, format: .relative(presentation: .named))
							}
							.font(.subheadline).foregroundStyle(.secondary)
						}
						.padding(.vertical, 4)
					}
				}
				if screen.loading == .done, screen.runs.isEmpty, screen.filter != RunFilter() {
					// A row where the runs would be: the empty list's placeholder is for a project with no runs at all.
					Text("No run matches.").foregroundStyle(.secondary)
				}
				if screen.hasMore {
					Button("More runs") { Task { await screen.more() } }
				}
				if let notice = screen.notice { Text(notice).font(.subheadline) }
				if showsEmpty { ListPlaceholder { empty } }
			}
			.holdsPlaceholder()
			.refreshable { await screen.refresh() }
			.task(id: workDeadline) {
				guard let deadline = workDeadline else { return }
				do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) }
				catch { return }
				await screen.refresh()
			}
			// The filters stay under the bar, as the Queue's do: pulling to refresh moves the runs, not them.
			.safeAreaBar(edge: .top) { filters }
			.navigationTitle("Runs")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ProjectMenu(workspace: workspace)
				if workspace.project?.may(.plan) == true {
					ToolbarItem(placement: .topBarTrailing) {
						Button("Plan a run", systemImage: "plus") {
							screen.preparePlanner()
							planning = true
						}
							.accessibilityIdentifier("plan-run")
					}
				}
			}
			.navigationDestination(for: String.self) { ref in
				if let run = screen.runs.first(where: { $0.ref == ref }) {
					if run.isPlanned {
						RunView(screen: screen.open(run))
					} else {
						ChangeRunView(run: run, results: screen.results(of: run))
					}
				} else {
					ContentUnavailableView("Run unavailable", systemImage: "questionmark.folder")
				}
			}
			.navigationDestination(for: TestLink.self) { test in
				if let tests = workspace.tests { TestView(ref: test.ref, screen: tests, workspace: workspace, opensCase: false) }
			}
			.navigationDestination(for: QuestionLink.self) { question in
				if let queue = workspace.queue {
					QuestionView(ref: question.ref, screen: queue, workspace: workspace) {
						if !path.isEmpty { path.removeLast() }
					}
				}
			}
			.sheet(isPresented: $planning) {
				RunPlannerView(screen: screen, planned: { run in
					guard planning else { return }
					planning = false
					path.append(run.ref)
				}, cancel: {
					planning = false
				})
			}
			.onDisappear {
				planning = false
			}
		}
		.task { if screen.loading == .first { await screen.refresh() } }
	}

	private var filters: some View {
		VStack(spacing: 8) {
			Picker("Kind", selection: kind) {
				Text("All").tag(RunFilter.Kind?.none)
				Text("Planned").tag(RunFilter.Kind?.some(.planned))
				Text("Change").tag(RunFilter.Kind?.some(.change))
			}
			.accessibilityIdentifier("runs-kind")
			Picker("State", selection: state) {
				Text("Any state").tag(RunFilter.State?.none)
				Text("Open").tag(RunFilter.State?.some(.open))
				Text("Closed").tag(RunFilter.State?.some(.closed))
			}
			.accessibilityIdentifier("runs-state")
		}
		.pickerStyle(.segmented)
		.padding(.horizontal, 16)
		.padding(.top, 4)
		.padding(.bottom, 8)
	}

	private var workDeadline: Date? { screen.runs.compactMap(\.workUntil).min() }

	private var kind: Binding<RunFilter.Kind?> {
		Binding(
			get: { screen.filter.kind },
			set: { kind in Task { await screen.show(RunFilter(kind: kind, state: screen.filter.state)) } })
	}

	private var state: Binding<RunFilter.State?> {
		Binding(
			get: { screen.filter.state },
			set: { state in Task { await screen.show(RunFilter(kind: screen.filter.kind, state: state)) } })
	}

	/// A planned run's cases left; a change run's change, which its name names too, so only when it has a title.
	private func detail(_ run: Run, at now: Date) -> String {
		switch run.kind {
		case .planned: (run.left.map { "\($0) \($0 == 1 ? "case" : "cases") left" } ?? "Remaining cases unavailable") + " · \(run.workUntil.map { $0 <= now } == true ? 0 : run.inProgress) in progress"
		case .change(let change): change?.title ?? "Change run"
		}
	}

	/// Whether the list says something in place of its runs. Under a filter, a row says that no run matches.
	private var showsEmpty: Bool {
		switch screen.loading {
		case .first, .failed: true
		case .done: screen.runs.isEmpty && screen.filter == RunFilter()
		}
	}

	@ViewBuilder private var empty: some View {
		switch screen.loading {
		case .first: ProgressView()
		case .failed(let why):
			ContentUnavailableView {
				Label("Runs could not be read", systemImage: "exclamationmark.triangle")
			} description: {
				Text(why)
			} actions: {
				Button("Try again") { Task { await screen.refresh() } }
			}
		case .done:
			if screen.runs.isEmpty {
				if screen.filter == RunFilter() {
					ContentUnavailableView(
						"No runs", systemImage: "play.rectangle",
						description: Text(
							"A pipeline's report makes a run for each commit. Plan a run to pin a list of cases, then execute them here. Planning needs the plan capability."
						))
				}
			}
		}
	}
}

extension RunVerdict {
	var tint: Color {
		switch self {
		case .passed: .pass
		case .failed: .fail
		case .blocked: .warn
		case .pending, .other: .secondary
		}
	}
}

extension SlotState {
	var tint: Color {
		switch self {
		case .satisfied: .pass
		case .failing: .fail
		case .disputed: .warn
		case .missing, .waived, .skipped, .other: .secondary
		}
	}
}
