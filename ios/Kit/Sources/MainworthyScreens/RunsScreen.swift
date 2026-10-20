import Foundation
import MainworthyClient
import Observation

/// The runs of one project, planned and change runs, newest first, as the filter chooses. Refresh keeps every page
/// already read, every open run and every change run's results up to date.
@MainActor @Observable
public final class RunsScreen: ProjectScreen {
	public struct SavedPlan: Equatable {
		public let ref: String
		public let slots: Int
		public let already: Int
		public var sentence: String { "\(ref) planned with \(slots) slots; \(already) already filled." }
	}
	private let list: PagedList<RunFilter, RunPage>
	public var runs: [Run] { list.rows }
	public var filter: RunFilter { list.query }
	public var loading: ListLoading { list.loading }
	public var hasMore: Bool { list.hasMore }
	public private(set) var notice: String?
	public private(set) var folders: [String] = []
	public private(set) var planning = false
	public enum CaseCount: Equatable {
		case idle, loading, counted(Int), failed(String)
	}
	private enum PlanState {
		case pending(RunPlanSubmission)
		case confirmed(RunPlanSubmission, SavedPlan)
		var submission: RunPlanSubmission {
			switch self {
			case .pending(let submission), .confirmed(let submission, _): submission
			}
		}
	}
	public var planSubmission: RunPlanSubmission? { planState?.submission }
	public var savedPlan: SavedPlan? {
		if case .confirmed(_, let receipt) = planState { receipt } else { nil }
	}
	public private(set) var caseCount = CaseCount.idle
	private var planState: PlanState?
	private var countReads = 0
	public private(set) var permission: Project
	private let project: ProjectClient
	private var person: String

	private var opened: [String: OpenRunScreen] = [:]
	private var counted: [String: ChangeResults] = [:]

	package init(project: ProjectClient, permission: Project, person: String) {
		self.project = project
		self.permission = permission
		self.person = person
		list = PagedList(query: RunFilter()) { filter, cursor in
			try await project.runs(filter, after: cursor)
		}
		list.onProblem = { [weak self] why in self?.notice = why }
	}

	/// What the person may do, and their name, as the account says now: a rename of the owner keeps the session.
	package func updateSignedIn(_ permission: Project, as person: String) {
		self.permission = permission
		self.person = person
		for screen in opened.values { screen.updateSignedIn(permission, as: person) }
	}

	/// What a change run's gate counted. A planned run's results are in its slots.
	public func results(of run: Run) -> ChangeResults {
		if let results = counted[run.ref] { return results }
		guard case .change(let change) = run.kind else { preconditionFailure("\(run.ref) is a planned run") }
		let results = ChangeResults(project: project, change: change?.key, run: run.ref)
		counted[run.ref] = results
		return results
	}

	/// Shows the runs this filter chooses, read again from the first page.
	public func show(_ filter: RunFilter) async {
		guard filter != self.filter else { return }
		await list.show(filter)
		guard !Task.isCancelled else { return }
		await refreshOpened()
	}

	public func open(_ run: Run) -> OpenRunScreen {
		if let screen = opened[run.ref] { return screen }
		let screen = OpenRunScreen(project: project, run: run, permission: permission, person: person)
		opened[run.ref] = screen
		return screen
	}

	public func refresh() async {
		await list.reload()
		guard !Task.isCancelled else { return }
		await refreshOpened()
	}

	private func refreshOpened() async {
		for screen in opened.values { await screen.refresh() }
		for results in counted.values { await results.refresh() }
	}

	public func more() async { await list.more() }

	public func readFolders() async {
		do { folders = try await project.runFolders() } catch { notice = error.shown }
	}

	public func countCases(_ selection: RunSelection?) async {
		countReads += 1
		let mine = countReads
		guard let selection else { caseCount = .idle; return }
		caseCount = .loading
		do {
			let count = try await project.countRunCases(selection)
			guard mine == countReads else { return }
			caseCount = .counted(count)
		} catch {
			guard mine == countReads else { return }
			caseCount = .failed(error.shown)
		}
	}

	public func preparePlanner() {
		if planSubmission == nil { notice = nil }
	}

	public func plan(name: String, selection: RunSelection, commit: String = "") async -> Run? {
		guard !planning else { return nil }
		if savedPlan != nil { return await readPlannedRun() }
		guard planSubmission != nil || permission.may(.plan) else { return nil }
		let recovering = planSubmission != nil
		let submission = planSubmission ?? RunPlanSubmission(name: name, selection: selection, commit: commit)
		planState = .pending(submission)
		planning = true
		defer { planning = false }
		do {
			switch try await project.planRun(submission, recovering: recovering) {
			case .planned(let ref, let slots, let already):
				planState = .confirmed(submission, SavedPlan(ref: ref, slots: slots, already: already))
				return await readSavedPlan()
			case .refused(let why):
				planState = nil
				notice = why
			}
		} catch {
			notice = "The run's outcome is unknown. Retry plan keeps your submitted choices and sends the same command. " + error.shown
		}
		return nil
	}

	public func readPlannedRun() async -> Run? {
		guard !planning, savedPlan != nil else { return nil }
		planning = true
		defer { planning = false }
		return await readSavedPlan()
	}

	private func readSavedPlan() async -> Run? {
		guard let saved = savedPlan else { return nil }
		do {
			let run = try await project.run(saved.ref)
			// The new run opens from the list, so a filter that leaves it out is set aside.
			if !filter.admits(run) {
				await show(RunFilter())
			} else {
				await refresh()
			}
			list.include(run)
			notice = saved.sentence
			open(run).planned(saved.sentence)
			planState = nil
			return run
		} catch {
			notice = saved.sentence + " It could not be opened. Read the run again. " + error.shown
			return nil
		}
	}
}
