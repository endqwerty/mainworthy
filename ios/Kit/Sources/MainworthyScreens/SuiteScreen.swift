import Foundation
import MainworthyClient
import Observation

/// One list of cases the Cases tab can show: a folder's own cases, every case, a tag's, or a search.
public struct CaseQuery: Hashable, Sendable {
	public let folder: String?
	/// With a folder: its subfolders' cases too. A search in a folder is of everything under it.
	public let deep: Bool
	public let text: String
	public let tag: String?

	public init(folder: String? = nil, deep: Bool = false, text: String = "", tag: String? = nil) {
		self.folder = folder
		self.deep = deep && folder != nil
		self.text = text
		self.tag = tag
	}

	public static let all = CaseQuery()
}

/// What has been read of one query. A listing is kept after its page is left, so going back to it shows it at once.
public struct CaseListing: Equatable, Sendable {
	public internal(set) var cases: [SuiteCase] = []
	public internal(set) var hasMore = false
	public internal(set) var loading = SuiteScreen.Loading.first
	var next: String?
	/// The screen's generation when this was read. A change told of since makes it stale.
	var generation = -1
}

@MainActor @Observable
public final class SuiteScreen: ProjectScreen {
	public enum Loading: Equatable, Sendable { case first, done, failed(String) }
	public enum Document: Equatable, Sendable { case reading, read(CaseDocument), failed(String) }
	public enum History: Equatable, Sendable { case reading, read([CaseVersion]), failed(String) }
	public private(set) var folders: [SuiteFolder] = []
	public private(set) var tags: [SuiteTag] = []
	/// The folder tree and the tags, which every page of the tab reads.
	public private(set) var tree = Loading.first
	/// What is typed in the search, kept here so that it outlives the view.
	public var searchText = ""
	public var searchEverywhere = false
	public private(set) var notice: String?
	public private(set) var editor: CaseEditorScreen?
	public private(set) var saved: CaseStamp?
	public private(set) var preparingEditor = false
	private let project: ProjectClient
	private var listings: [CaseQuery: CaseListing] = [:]
	/// Bumped by each change the stream tells of. A listing or tree read before it is stale.
	private var generation = 0
	private var treeGeneration = -1
	private var treeReads = 0
	private var treePending: (generation: Int, task: Task<Void, Never>)?
	private var reads: [CaseQuery: Int] = [:]
	private var firstReads: [CaseQuery: Int] = [:]
	private var pageReads: [CaseQuery: Int] = [:]
	private var pending: [CaseQuery: (generation: Int, task: Task<Void, Never>)] = [:]
	/// The queries a page on screen shows, with how many pages show each.
	private var visible: [CaseQuery: Int] = [:]
	private var used: [CaseQuery: Int] = [:]
	private var uses = 0
	private var editorReads = 0
	private var documentReads: [String: Int] = [:]
	private var documents: [String: Document] = [:]
	private var histories: [String: History] = [:]
	private var historyReads: [String: Int] = [:]

	/// How many listings are kept besides those on screen, the least recently shown dropped first.
	static let kept = 40
	/// How many of a folder's subfolders are read ahead, so that opening one shows its cases at once.
	static let readAhead = 8

	package init(project: ProjectClient) { self.project = project }

	public func children(of folder: SuiteFolder?) -> [SuiteFolder] {
		folders.filter { $0.parent == folder?.id }
	}
	/// The folder as last read, or nil when it is no longer an active folder.
	public func current(_ folder: SuiteFolder) -> SuiteFolder? {
		folders.first { $0.id == folder.id }
	}
	public func listing(_ query: CaseQuery) -> CaseListing? { listings[query] }
	public func nextPageID(_ query: CaseQuery) -> String? {
		guard firstReads[query] == nil, let listing = listings[query] else { return nil }
		return listing.next.map { "\(reads[query] ?? 0):\($0)" }
	}

	// MARK: Reading

	/// A page shows this query: it is read now unless what is kept is current, and again at each change.
	public func appear(_ query: CaseQuery) {
		visible[query, default: 0] += 1
		Task { await load(query) }
	}
	public func disappear(_ query: CaseQuery) {
		let left = (visible[query] ?? 0) - 1
		visible[query] = left == 0 ? nil : left
	}

	/// Reads the query unless what is kept is current. A read already under way is waited for, not repeated.
	public func load(_ query: CaseQuery) async {
		uses += 1
		used[query] = uses
		if let listing = listings[query], listing.generation == generation, listing.loading == .done { return }
		if let under = pending[query], under.generation == generation {
			await under.task.value
			return
		}
		if case .failed = listings[query]?.loading { listings[query]?.loading = .first }
		let task = Task { await read(query) }
		pending[query] = (generation, task)
		await task.value
		if pending[query]?.task == task { pending[query] = nil }
		forget()
	}

	/// Reads the folder tree and the tags unless they are current.
	public func loadTree() async {
		if tree == .done, treeGeneration == generation { return }
		if let under = treePending, under.generation == generation {
			await under.task.value
			return
		}
		if case .failed = tree { tree = .first }
		let task = Task { await readTree() }
		treePending = (generation, task)
		await task.value
		if treePending?.task == task { treePending = nil }
	}

	/// Reads the first page of the folders' own cases ahead, a few at a time, so that opening one is instant.
	@discardableResult public func readAhead(_ folders: [SuiteFolder]) -> Task<Void, Never>? {
		let wanted = folders.filter { $0.cases > 0 && listings[CaseQuery(folder: $0.path)] == nil }
			.prefix(Self.readAhead)
		guard !wanted.isEmpty else { return nil }
		return Task {
			for folder in wanted where listings[CaseQuery(folder: folder.path)] == nil {
				await load(CaseQuery(folder: folder.path))
			}
		}
	}

	/// What the change stream asks for: every listing becomes stale, and the ones on screen are read again.
	public func refresh() async {
		await rereadLists()
		// Latest pages follow the stream. An explicit historic version, and an editor's source, stay as opened.
		for key in Array(documents.keys) where !key.contains("@") { await openCase(key) }
		for ref in Array(histories.keys) { await readHistory(ref) }
	}

	private func rereadLists() async {
		generation += 1
		await loadTree()
		for query in Array(visible.keys) { await load(query) }
	}

	public func more(_ query: CaseQuery) async {
		// A listing a change has made stale is read again whole, not paged with the cursor it had.
		guard let listing = listings[query], listing.loading == .done, listing.generation == generation,
			firstReads[query] == nil, pageReads[query] == nil, listing.hasMore, let cursor = listing.next else { return }
		let mine = reads[query] ?? 0
		pageReads[query] = mine
		defer { if pageReads[query] == mine { pageReads[query] = nil } }
		do {
			let page = try await project.cases(folder: query.folder, deep: query.deep, text: query.text, tag: query.tag,
				after: cursor)
			guard mine == reads[query], var now = listings[query] else { return }
			let known = Set(now.cases.map(\.ref))
			now.cases += page.items.filter { !known.contains($0.ref) }
			now.next = page.next
			now.hasMore = page.next != nil
			listings[query] = now
		} catch { if mine == reads[query] { notice = error.shown } }
	}

	private func read(_ query: CaseQuery) async {
		let mine = (reads[query] ?? 0) + 1
		reads[query] = mine
		firstReads[query] = mine
		pageReads[query] = nil
		defer { if firstReads[query] == mine { firstReads[query] = nil } }
		let generation = generation
		// A listing read past its first page is read as far again.
		let wanted = listings[query]?.cases.count ?? 0
		if listings[query] == nil { listings[query] = CaseListing() }
		do {
			var page = try await project.cases(folder: query.folder, deep: query.deep, text: query.text, tag: query.tag)
			var items = page.items
			while let cursor = page.next, items.count < wanted {
				page = try await project.cases(folder: query.folder, deep: query.deep, text: query.text, tag: query.tag,
					after: cursor)
				items += page.items
			}
			guard mine == reads[query] else { return }
			listings[query] = CaseListing(cases: items, hasMore: page.next != nil, loading: .done, next: page.next,
				generation: generation)
		} catch is CancellationError {
		} catch {
			guard mine == reads[query] else { return }
			if listings[query]?.loading == .done { notice = error.shown } else { listings[query]?.loading = .failed(error.shown) }
		}
	}

	private func readTree() async {
		treeReads += 1
		let mine = treeReads
		let generation = generation
		do {
			async let labels = project.tags()
			let newFolders = try await project.folders()
			let newTags = try await labels
			guard mine == treeReads else { return }
			folders = newFolders
			tags = newTags
			tree = .done
			treeGeneration = generation
		} catch is CancellationError {
		} catch {
			guard mine == treeReads else { return }
			if tree == .done { notice = error.shown } else { tree = .failed(error.shown) }
		}
	}

	/// Drops the least recently shown listings beyond what is kept. One on screen, or being read, stays.
	private func forget() {
		let spare = listings.keys.filter { visible[$0] == nil && pending[$0] == nil }
		guard spare.count > Self.kept else { return }
		for query in spare.sorted(by: { (used[$0] ?? 0) < (used[$1] ?? 0) }).prefix(spare.count - Self.kept) {
			listings[query] = nil
			used[query] = nil
		}
	}

	/// The search is over: what was typed is cleared for the next one.
	public func endSearch() {
		searchText = ""
		searchEverywhere = false
	}

	// MARK: Cases

	private static func key(_ ref: String, _ version: Int?) -> String {
		version.map { "\(ref)@\($0)" } ?? ref
	}
	public func document(_ ref: String, version: Int? = nil) -> Document? {
		documents[Self.key(ref, version)]
	}
	public func openCase(_ ref: String, version: Int? = nil) async {
		let key = Self.key(ref, version)
		let mine = (documentReads[key] ?? 0) + 1
		documentReads[key] = mine
		if documents[key] == nil { documents[key] = .reading }
		do {
			let document = try await project.caseDocument(ref, version: version)
			guard documentReads[key] == mine else { return }
			documents[key] = .read(document)
		} catch {
			guard documentReads[key] == mine else { return }
			documents[key] = .failed(error.shown)
		}
	}

	public func history(_ ref: String) -> History? { histories[ref] }
	public func readHistory(_ ref: String) async {
		let mine = (historyReads[ref] ?? 0) + 1
		historyReads[ref] = mine
		if histories[ref] == nil { histories[ref] = .reading }
		do {
			let versions = try await project.caseHistory(ref)
			guard historyReads[ref] == mine else { return }
			histories[ref] = .read(versions)
		} catch {
			guard historyReads[ref] == mine else { return }
			histories[ref] = .failed(error.shown)
		}
	}

	/// A new case, in the folder given. Without one the server files it in Unsorted.
	public func newCase(in folder: String? = nil) {
		guard editor == nil else { return }
		editorReads += 1
		preparingEditor = false
		saved = nil
		editor = CaseEditorScreen(project: project, source: .create(folder: folder))
	}
	public func edit(_ opened: CaseDocument) async {
		guard !opened.hasSharedSteps else { notice = "Edit fragments and their pins in the web editor."; return }
		guard !opened.isHistorical, editor == nil, !preparingEditor else { return }
		editorReads += 1
		let mine = editorReads
		preparingEditor = true
		defer { if editorReads == mine { preparingEditor = false } }
		do {
			let used = try await project.usedStepIds(of: opened)
			guard mine == editorReads else { return }
			saved = nil
			editor = CaseEditorScreen(project: project, source: .edit(opened), used: used)
		} catch { if mine == editorReads { notice = error.shown } }
	}
	public func closeEditor() {
		guard editor?.busy != true else { return }
		editorReads += 1
		preparingEditor = false
		editor = nil
	}
	public func dismissNotice() { notice = nil }
	public func saveEditor() async {
		guard let editor, let outcome = await editor.save() else { return }
		if case .adopted(let stamp) = outcome, let stamp, let document = editor.savedDocument {
			documents[Self.key(stamp.ref, stamp.version)] = .read(document)
			saved = stamp
			self.editor = nil
			await rereadLists()
		}
	}
}
