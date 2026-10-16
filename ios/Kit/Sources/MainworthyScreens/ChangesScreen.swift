import MainworthyClient
import Observation

/// The reported changes of one project and the gate, questions and cases of the one that is open.
@MainActor @Observable
public final class ChangesScreen: ProjectScreen {
	public enum Loading: Equatable, Sendable {
		case first, done, failed(String)
	}

	public private(set) var changes: [ChangeSummary] = []
	public private(set) var loading = Loading.first
	public private(set) var detail: ChangeDetails?
	public private(set) var detailLoading = Loading.first
	public private(set) var notice: String?
	/// What the gate of the open change's head counted, read when its page asks. It is made for the run of the
	/// gate the page shows, and made again when a read of the page finds another run.
	public private(set) var results: ChangeResults?
	private var selected: String?
	private var selectedChange: ChangeSummary?
	private var reads = 0
	private var detailReads = 0
	private let project: ProjectClient

	package init(project: ProjectClient) { self.project = project }

	public func open(_ key: String) async {
		guard key != selected || detailLoading != .done else { return }
		selectedChange = changes.first { $0.key == key } ?? (selected == key ? selectedChange : nil)
		if selected != key { results = nil }
		selected = key
		detail = nil
		detailLoading = .first
		await readDetail()
	}

	public func refresh() async {
		detailReads += 1
		reads += 1
		let mine = reads
		do {
			let fresh = try await project.reportedChanges()
			guard mine == reads else { return }
			changes = fresh
			loading = .done
			notice = nil
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
		}
		guard mine == reads else { return }
		if selected != nil { await readDetail() }
		guard mine == reads else { return }
		await results?.refresh()
	}

	private func readDetail() async {
		detailReads += 1
		let mine = detailReads
		guard let key = selected else { return }
		let known = changes.first { $0.key == key } ?? selectedChange
		do {
			let fresh = try await project.details(of: key, known: known)
			guard mine == detailReads else { return }
			detail = fresh
			selectedChange = fresh.change
			detailLoading = .done
			// The results shown are the shown gate's: a gate of another run gets results of its own.
			if results?.change != key || results?.run != fresh.gate.run {
				// Another run of the same change keeps what the person chose to see.
				let query = results?.change == key ? results?.query : nil
				results = ChangeResults(project: project, change: key, run: fresh.gate.run, query: query ?? .init())
			}
		} catch is CancellationError {
		} catch {
			guard mine == detailReads else { return }
			if detailLoading == .done { notice = error.shown } else { detailLoading = .failed(error.shown) }
		}
	}
}
