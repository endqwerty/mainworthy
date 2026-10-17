import Foundation
import MainworthyClient
import Observation

/// The runs of one project, planned and change runs, newest first, as the filter chooses. Refresh keeps every page
/// already read, every open run and every change run's results up to date.
@MainActor @Observable
public final class RunsScreen: ProjectScreen {
	public enum Loading: Equatable {
		case first, done
		case failed(String)
	}
	public struct SavedPlan: Equatable {
		public let ref: String
		public let slots: Int
		public let already: Int
		public var sentence: String { "\(ref) planned with \(slots) slots; \(already) already filled." }
	}
	public private(set) var runs: [Run] = []
	public private(set) var filter = RunFilter()
	public private(set) var loading = Loading.first
	public private(set) var hasMore = false
	public private(set) var notice: String?
	public private(set) var folders: [String] = []
	public private(set) var planning = false
	public private(set) var savedPlan: SavedPlan?
	public private(set) var permission: Project
	private let project: ProjectClient
	private var person: String
	private var next: String?
	private var reads = 0
	private var opened: [String: OpenRunScreen] = [:]
	private var counted: [String: ChangeResults] = [:]

	package init(project: ProjectClient, permission: Project, person: String) {
		self.project = project
		self.permission = permission
		self.person = person
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
		self.filter = filter
		runs = []
		next = nil
		hasMore = false
		loading = .first
		await refresh()
	}

	public func open(_ run: Run) -> OpenRunScreen {
		if let screen = opened[run.ref] { return screen }
		let screen = OpenRunScreen(project: project, run: run, permission: permission, person: person)
		opened[run.ref] = screen
		return screen
	}

	public func refresh() async {
		reads += 1
		let mine = reads
		let filter = filter
		do {
			let wanted = runs.count
			var page = try await project.runs(filter)
			var found = page.runs
			while let cursor = page.next, found.count < wanted {
				page = try await project.runs(filter, after: cursor)
				found += page.runs
			}
			guard mine == reads else { return }
			runs = found
			next = page.next
			hasMore = next != nil
			loading = .done
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
		}
		for screen in opened.values { await screen.refresh() }
		for results in counted.values { await results.refresh() }
	}

	public func more() async {
		guard let cursor = next else { return }
		reads += 1
		let mine = reads
		do {
			let page = try await project.runs(filter, after: cursor)
			guard mine == reads else { return }
			let known = Set(runs.map(\.ref))
			runs += page.runs.filter { !known.contains($0.ref) }
			next = page.next
			hasMore = next != nil
		} catch { if mine == reads { notice = error.shown } }
	}

	public func readFolders() async {
		do { folders = try await project.runFolders() } catch { notice = error.shown }
	}

	public func plan(name: String, selection: RunSelection, commit: String = "") async -> Run? {
		if savedPlan != nil { return await readPlannedRun() }
		guard permission.may(.plan), !planning else { return nil }
		planning = true
		defer { planning = false }
		do {
			switch try await project.planRun(name: name, selection: selection, commit: commit) {
			case .planned(let ref, let slots, let already):
				savedPlan = SavedPlan(ref: ref, slots: slots, already: already)
				return await readSavedPlan()
			case .refused(let why): notice = why
			}
		} catch { notice = error.shown }
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
			await refresh()
			if filter.admits(run), !runs.contains(where: { $0.ref == run.ref }) { runs.insert(run, at: 0) }
			loading = .done
			notice = saved.sentence
			open(run).planned(saved.sentence)
			savedPlan = nil
			return run
		} catch {
			notice = saved.sentence + " It could not be opened. Read the run again. " + error.shown
			return nil
		}
	}
}
