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
	public private(set) var receiptResults: [MergeGateReceipt.Result] = []
	public private(set) var hasMoreReceiptResults = false
	private var receiptRead: Int?
	private var receiptCursor: String?
	private var readingReceipt = false
	public private(set) var notice: String?
	/// What the gate of the open change's head counted, read when its page asks. It is made for the run of the
	/// gate the page shows, and made again when a read of the page finds another run.
	public private(set) var results: ChangeResults?
	/// The open change's runs, one for each of its commits that was reported, newest first.
	public private(set) var runs: [Run] = []
	/// The change has more runs than were read.
	public private(set) var hasMoreRuns = false
	private var nextRuns: String?
	private var counted: [String: ChangeResults] = [:]
	private var selected: String?
	private var selectedChange: ChangeSummary?
	private var reads = 0
	private var detailReads = 0
	private let project: ProjectClient

	/// How many runs of a change one read asks for.
	private let runsPerPage: Int

	package init(project: ProjectClient, runsPerPage: Int = 100) {
		self.project = project
		self.runsPerPage = runsPerPage
	}

	public func moreReceiptResults() async {
		guard let receipt = detail?.mergeReceipt, !readingReceipt else { return }
		if receiptRead == receipt.id && !hasMoreReceiptResults { return }
		readingReceipt = true
		defer { readingReceipt = false }
		let after = receiptRead == receipt.id ? receiptCursor : nil
		do {
			let page = try await project.receiptResults(receipt.id, after: after)
			guard detail?.mergeReceipt?.id == receipt.id else { return }
			receiptResults = after == nil ? page.results : receiptResults + page.results
			receiptRead = receipt.id
			receiptCursor = page.next
			hasMoreReceiptResults = page.next != nil
		} catch is CancellationError {} catch { notice = error.shown }
	}

	public func open(_ key: String) async {
		guard key != selected || detailLoading != .done else { return }
		selectedChange = changes.first { $0.key == key } ?? (selected == key ? selectedChange : nil)
		if selected != key {
			results = nil
			runs = []
			nextRuns = nil
			hasMoreRuns = false
		}
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

	/// What one of the open change's runs counted. The newest one's is the panel of the change's own gate.
	public func results(of run: Run) -> ChangeResults {
		if let results = counted[run.ref] { return results }
		guard case .change(let change) = run.kind else { preconditionFailure("\(run.ref) is a planned run") }
		let results = ChangeResults(project: project, change: change?.key, run: run.ref)
		counted[run.ref] = results
		return results
	}

	/// Reads the change's runs again, as many pages as were shown.
	private func readRuns(of key: String, read: Int) async {
		do {
			let wanted = runs.count
			var page = try await project.runs(RunFilter(change: key), limit: runsPerPage)
			var found = page.runs
			while let cursor = page.next, found.count < wanted {
				page = try await project.runs(RunFilter(change: key), after: cursor, limit: runsPerPage)
				found += page.runs
			}
			guard read == detailReads else { return }
			runs = found
			nextRuns = page.next
			hasMoreRuns = page.next != nil
		} catch is CancellationError {
		} catch {
			guard read == detailReads else { return }
			notice = error.shown
		}
		for results in counted.values { await results.refresh() }
	}

	/// Reads the open change's next page of runs.
	public func moreRuns() async {
		guard let key = selected, let cursor = nextRuns else { return }
		let mine = detailReads
		do {
			let page = try await project.runs(RunFilter(change: key), after: cursor, limit: runsPerPage)
			guard mine == detailReads else { return }
			let known = Set(runs.map(\.ref))
			runs += page.runs.filter { !known.contains($0.ref) }
			nextRuns = page.next
			hasMoreRuns = page.next != nil
		} catch is CancellationError {
		} catch {
			if mine == detailReads { notice = error.shown }
		}
	}

	private func readDetail() async {
		detailReads += 1
		let mine = detailReads
		guard let key = selected else { return }
		let known = changes.first { $0.key == key } ?? selectedChange
		do {
			let fresh = try await project.details(of: key, known: known)
			guard mine == detailReads else { return }
			if detail?.mergeReceipt?.id != fresh.mergeReceipt?.id {
				receiptResults = []
				receiptRead = nil
				receiptCursor = nil;
				hasMoreReceiptResults = false
			}
			detail = fresh
			selectedChange = fresh.change
			detailLoading = .done
			// The results shown are the shown gate's: a gate of another run gets results of its own.
			if results?.change != key || results?.run != fresh.gate.run {
				// Another run of the same change keeps what the person chose to see.
				let query = results?.change == key ? results?.query : nil
				results = ChangeResults(project: project, change: key, run: fresh.gate.run, query: query ?? .init())
			}
			await readRuns(of: key, read: mine)
		} catch is CancellationError {
		} catch {
			guard mine == detailReads else { return }
			if detailLoading == .done { notice = error.shown } else { detailLoading = .failed(error.shown) }
		}
	}
}
