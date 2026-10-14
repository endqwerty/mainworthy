import Foundation
import MainworthyClient
import Observation

@MainActor @Observable
public final class SuiteScreen: ProjectScreen {
	public enum Place: Equatable, Sendable {
		case root, all, folder(SuiteFolder)
		public var path: String? { if case .folder(let folder) = self { folder.path } else { nil } }
	}
	public enum Loading: Equatable, Sendable { case first, done, failed(String) }
	public enum Document: Equatable, Sendable { case reading, read(CaseDocument), failed(String) }
	public enum History: Equatable, Sendable { case reading, read([CaseVersion]), failed(String) }
	public private(set) var place = Place.root
	public private(set) var text = ""
	public private(set) var tag: String?
	public private(set) var folders: [SuiteFolder] = []
	public private(set) var tags: [SuiteTag] = []
	public private(set) var cases: [SuiteCase] = []
	public private(set) var loading = Loading.first
	public private(set) var hasMore = false
	public private(set) var notice: String?
	public private(set) var editor: CaseEditorScreen?
	public private(set) var saved: CaseStamp?
	public private(set) var preparingEditor = false
	private let project: ProjectClient
	private var next: String?
	private var reads = 0
	private var documentReads: [String: Int] = [:]
	private var documents: [String: Document] = [:]
	private var histories: [String: History] = [:]
	private var historyReads: [String: Int] = [:]

	package init(project: ProjectClient) { self.project = project }

	public var children: [SuiteFolder] {
		let parent: Int? = if case .folder(let folder) = place { folder.id } else { nil }
		return folders.filter { $0.parent == parent }
	}
	public var showsCases: Bool { place != .root || !text.isEmpty || tag != nil }
	public var showsFolders: Bool { place != .all && text.isEmpty && tag == nil }

	public func show(_ place: Place, text: String = "", tag: String? = nil) async {
		guard self.place != place || self.text != text || self.tag != tag || loading != .done else { return }
		self.place = place
		self.text = text
		self.tag = tag
		cases = []
		loading = .first
		await read()
	}

	public func up() async {
		if case .folder(let folder) = place, let parent = folders.first(where: { $0.id == folder.parent }) {
			await show(.folder(parent))
		} else { await show(.root) }
	}

	public func refresh() async {
		await read()
		// Latest pages follow the stream. An explicit historic version, and an editor's source, stay as opened.
		for key in Array(documents.keys) where !key.contains("@") { await openCase(key) }
		for ref in Array(histories.keys) { await readHistory(ref) }
	}

	public func more() async {
		guard hasMore, let cursor = next else { return }
		reads += 1
		let mine = reads
		do {
			let page = try await project.cases(folder: place.path, text: text, tag: tag, after: cursor)
			guard mine == reads else { return }
			let known = Set(cases.map(\.ref))
			cases += page.items.filter { !known.contains($0.ref) }
			next = page.next
			hasMore = page.next != nil
		} catch { if mine == reads { notice = error.shown } }
	}

	private func read() async {
		reads += 1
		let mine = reads
		let selected = place
		let search = text
		let filter = tag
		let wanted = cases.count
		do {
			async let tree = project.folders()
			async let labels = project.tags()
			var page = try await project.cases(folder: selected.path, text: search, tag: filter)
			var items = page.items
			while let cursor = page.next, items.count < wanted {
				page = try await project.cases(folder: selected.path, text: search, tag: filter, after: cursor)
				items += page.items
			}
			let (newFolders, newTags) = try await (tree, labels)
			guard mine == reads else { return }
			folders = newFolders
			tags = newTags
			cases = items
			next = page.next
			hasMore = page.next != nil
			loading = .done
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
		}
	}

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

	public func newCase() {
		guard editor == nil else { return }
		saved = nil
		editor = CaseEditorScreen(project: project, source: .create(folder: place.path))
	}
	public func edit(_ opened: CaseDocument) async {
		guard editor == nil, !preparingEditor else { return }
		preparingEditor = true
		defer { preparingEditor = false }
		do {
			let used = try await project.usedStepIds(of: opened)
			saved = nil
			editor = CaseEditorScreen(project: project, source: .edit(opened), used: used)
		} catch { notice = error.shown }
	}
	public func closeEditor() { guard editor?.busy != true else { return }; editor = nil }
	public func dismissNotice() { notice = nil }
	public func saveEditor() async {
		guard let editor, let outcome = await editor.save() else { return }
		if case .adopted(let stamp) = outcome {
			let adopted: CaseStamp?
			if let stamp { adopted = stamp }
			else if case .edit(let opened) = editor.source { adopted = CaseStamp(ref: opened.ref, version: opened.version) }
			else { adopted = nil }
			if let adopted {
				await openCase(adopted.ref)
				saved = adopted
			}
			self.editor = nil
			await read()
		}
	}
}
