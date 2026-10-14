import Foundation
import MainworthyClient
import Observation

/// Planned runs of one project. Refresh keeps every page already read and every open run up to date.
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
	public private(set) var runs: [PlannedRun] = []
	public private(set) var loading = Loading.first
	public private(set) var hasMore = false
	public private(set) var notice: String?
	public private(set) var folders: [String] = []
	public private(set) var planning = false
	public private(set) var savedPlan: SavedPlan?
	public private(set) var permission: Project
	private let project: ProjectClient
	private let person: String
	private var next: String?
	private var reads = 0
	private var opened: [String: OpenRunScreen] = [:]

	package init(project: ProjectClient, permission: Project, person: String) {
		self.project = project
		self.permission = permission
		self.person = person
	}

	package func updatePermission(_ permission: Project) {
		self.permission = permission
		for screen in opened.values { screen.updatePermission(permission) }
	}

	public func open(_ run: PlannedRun) -> OpenRunScreen {
		if let screen = opened[run.ref] { return screen }
		let screen = OpenRunScreen(project: project, run: run, permission: permission, person: person)
		opened[run.ref] = screen
		return screen
	}

	public func refresh() async {
		reads += 1
		let mine = reads
		do {
			let wanted = runs.count
			var page = try await project.runs()
			var found = page.runs
			while let cursor = page.next, found.count < wanted {
				page = try await project.runs(after: cursor)
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
	}

	public func more() async {
		guard let cursor = next else { return }
		reads += 1
		let mine = reads
		do {
			let page = try await project.runs(after: cursor)
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

	public func plan(name: String, selection: RunSelection, commit: String = "") async -> PlannedRun? {
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

	public func readPlannedRun() async -> PlannedRun? {
		guard !planning, savedPlan != nil else { return nil }
		planning = true
		defer { planning = false }
		return await readSavedPlan()
	}

	private func readSavedPlan() async -> PlannedRun? {
		guard let saved = savedPlan else { return nil }
		do {
			let run = try await project.run(saved.ref)
			await refresh()
			if !runs.contains(where: { $0.ref == run.ref }) { runs.insert(run, at: 0) }
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
