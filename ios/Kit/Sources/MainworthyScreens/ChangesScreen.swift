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
	private var selected: String?
	private var reads = 0
	private var detailReads = 0
	private let project: ProjectClient

	package init(project: ProjectClient) { self.project = project }

	public func open(_ key: String) async {
		guard key != selected || detailLoading != .done else { return }
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
			if selected != nil { await readDetail() }
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
			if selected != nil, detail == nil { detailLoading = .failed(error.shown) }
		}
	}

	private func readDetail() async {
		detailReads += 1
		let mine = detailReads
		guard let key = selected, let change = changes.first(where: { $0.key == key }) else {
			detail = nil
			detailLoading = .failed("This change is no longer in the reported list.")
			return
		}
		do {
			let fresh = try await project.details(of: change)
			guard mine == detailReads else { return }
			detail = fresh
			detailLoading = .done
		} catch is CancellationError {
		} catch {
			guard mine == detailReads else { return }
			if detailLoading == .done { notice = error.shown } else { detailLoading = .failed(error.shown) }
		}
	}
}
