import MainworthyClient
import MainworthyScreens
import SwiftUI

/// Where a search starts: in a folder or a tag, which it is scoped to until the person picks Everywhere.
enum SearchContext: Hashable {
	case folder(SuiteFolder)
	case tag(String)

	var name: String {
		switch self {
		case .folder(let folder): folder.name
		case .tag(let tag): "#\(tag)"
		}
	}
}

/// A page of the Cases tab. Each is pushed on the stack, so the edge swipe goes back as in Files.
enum SuiteRoute: Hashable {
	case folder(SuiteFolder)
	case all
	case tags
	case tag(String)
	case search(SearchContext?)
	case document(ref: String, version: Int? = nil)
	case history(String)
	case tests
}

/// The test cases of the project, in their folders, as the Files app shows files.
struct SuiteView: View {
	@Bindable var screen: SuiteScreen
	let workspace: Workspace
	@State private var path: [SuiteRoute] = []

	var body: some View {
		NavigationStack(path: $path) {
			SuiteRootView(screen: screen, workspace: workspace)
				.navigationDestination(for: SuiteRoute.self) { route in
					switch route {
					case .folder(let folder): SuiteFolderView(folder: folder, screen: screen, workspace: workspace)
					case .all:
						SuiteListView(query: .all, title: "All cases", context: nil, screen: screen, workspace: workspace)
					case .tags: SuiteTagsView(screen: screen)
					case .tag(let tag):
						SuiteListView(query: CaseQuery(tag: tag), title: "#\(tag)", context: .tag(tag), screen: screen,
							workspace: workspace)
					case .search(let context): SuiteSearchView(context: context, screen: screen)
					case .document(let ref, let version):
						SuiteCaseView(ref: ref, version: version, screen: screen, workspace: workspace)
					case .history(let ref): SuiteHistoryView(ref: ref, screen: screen)
					case .tests: if let tests = workspace.tests { TestsListView(screen: tests) }
					}
				}
				.navigationDestination(for: TestLink.self) { test in
					if let tests = workspace.tests {
						TestView(ref: test.ref, screen: tests, workspace: workspace, opensCase: true)
					}
				}
		}
		.safeAreaInset(edge: .bottom) {
			if let notice = screen.notice {
				HStack {
					Text(notice).font(.subheadline).foregroundStyle(Color.fail)
					Spacer()
					Button("Dismiss") { screen.dismissNotice() }
				}
				.padding(12).background(.regularMaterial)
			}
		}
		.sheet(isPresented: editing) {
			if let editor = screen.editor { SuiteEditorView(editor: editor, screen: screen) }
		}
		.onChange(of: screen.saved) { _, stamp in
			guard let stamp else { return }
			let opened = SuiteRoute.document(ref: stamp.ref, version: stamp.version)
			// An edit replaces the page it was made from. A new case opens over the folder it was written in.
			if case .document(let ref, _) = path.last, ref == stamp.ref { path[path.count - 1] = opened } else {
				path.append(opened)
			}
		}
		.onChange(of: path) { _, now in
			if !now.contains(where: { if case .search = $0 { true } else { false } }) { screen.endSearch() }
		}
	}

	private var editing: Binding<Bool> {
		Binding(get: { screen.editor != nil }, set: { if !$0 { screen.closeEditor() } })
	}
}

/// The top of the tab: every case, the top folders, and the tags.
private struct SuiteRootView: View {
	let screen: SuiteScreen
	let workspace: Workspace

	var body: some View {
		List {
			Section {
				NavigationLink(value: SuiteRoute.all) { Label("All cases", systemImage: "tray.full") }
					.accessibilityIdentifier("suite-all")
				NavigationLink(value: SuiteRoute.tests) { Label("Automated tests", systemImage: "gearshape.2") }
					.accessibilityIdentifier("suite-tests")
			}
			let top = screen.children(of: nil)
			if !top.isEmpty {
				Section("Folders") {
					ForEach(top) { FolderRow(folder: $0) }
				}
			}
			if !screen.tags.isEmpty {
				Section("Tags") {
					ForEach(screen.tags.prefix(SuiteTagsView.shown)) { TagRow(tag: $0) }
					if screen.tags.count > SuiteTagsView.shown {
						NavigationLink("All tags", value: SuiteRoute.tags).accessibilityIdentifier("suite-tags")
					}
				}
			}
			if case .failed(let why) = screen.tree { Failed(why: why) { await screen.loadTree() } }
		}
		.overlay { if screen.tree == .first { ProgressView() } }
		.navigationTitle("Cases")
		.toolbar {
			ProjectMenu(workspace: workspace)
			SuiteToolbar(context: nil, folder: nil, screen: screen, workspace: workspace)
		}
		.task {
			await screen.loadTree()
			screen.readAhead(screen.children(of: nil))
		}
		.refreshable { await screen.refresh() }
	}
}

/// A folder: its subfolders, then its own cases.
struct SuiteFolderView: View {
	let folder: SuiteFolder
	let screen: SuiteScreen
	let workspace: Workspace

	var body: some View {
		let shown = screen.current(folder) ?? folder
		let query = CaseQuery(folder: shown.path)
		let subfolders = screen.children(of: shown)
		List {
			if !subfolders.isEmpty {
				Section { ForEach(subfolders) { FolderRow(folder: $0) } }
			}
			CaseSection(query: query, expected: shown.cases, screen: screen)
		}
		.overlay {
			if subfolders.isEmpty, let listing = screen.listing(query), listing.loading == .done, listing.cases.isEmpty {
				ContentUnavailableView("Empty folder", systemImage: "folder",
					description: Text("No cases or folders in \(shown.name)."))
			}
		}
		.navigationTitle(shown.name)
		.toolbar { SuiteToolbar(context: .folder(shown), folder: shown.path, screen: screen, workspace: workspace) }
		.shows(query, on: screen)
		.task { screen.readAhead(subfolders) }
		.refreshable { await screen.refresh() }
	}
}

/// Every case, or a tag's, in outline order.
struct SuiteListView: View {
	let query: CaseQuery
	let title: String
	let context: SearchContext?
	let screen: SuiteScreen
	let workspace: Workspace

	var body: some View {
		List { CaseSection(query: query, expected: nil, screen: screen) }
			.overlay {
				if let listing = screen.listing(query), listing.loading == .done, listing.cases.isEmpty {
					ContentUnavailableView("No cases", systemImage: "tray")
				}
			}
			.navigationTitle(title)
			.toolbar { SuiteToolbar(context: context, folder: nil, screen: screen, workspace: workspace) }
			.shows(query, on: screen)
			.refreshable { await screen.refresh() }
	}
}

struct SuiteTagsView: View {
	/// How many tags the top of the tab lists before All tags.
	static let shown = 8
	let screen: SuiteScreen

	var body: some View {
		List { ForEach(screen.tags) { TagRow(tag: $0) } }
			.navigationTitle("Tags")
			.navigationBarTitleDisplayMode(.inline)
			.refreshable { await screen.refresh() }
	}
}

/// The search: words of a case or its number, in the folder or tag it was opened from, or everywhere.
struct SuiteSearchView: View {
	let context: SearchContext?
	@Bindable var screen: SuiteScreen
	/// What was typed, once typing has paused: the query that is read.
	@State private var settled = ""
	@State private var presented = false
	@State private var onScreen = false
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		let read = query(settled)
		let typed = query(screen.searchText)
		// What was typed shows at once when it was read before, and the last results stay until it is read.
		let shown = typed.flatMap { screen.listing($0)?.loading == .done ? $0 : nil } ?? read
		List {
			if let shown {
				CaseSection(query: shown, expected: nil, screen: screen)
			} else {
				Text("Type words from a case, or its number such as C-12.")
					.font(.subheadline).foregroundStyle(.secondary)
			}
		}
		.overlay {
			if let shown, let listing = screen.listing(shown), listing.loading == .done, listing.cases.isEmpty {
				ContentUnavailableView.search(text: shown.text)
			}
		}
		.navigationTitle(context?.name ?? "Search")
		.navigationBarTitleDisplayMode(.inline)
		.searchable(text: $screen.searchText, isPresented: $presented,
			placement: .navigationBarDrawer(displayMode: .always), prompt: "Search cases")
		.modifier(Scoped(context: context, everywhere: $screen.searchEverywhere))
		.shows(read, on: screen)
		.onAppear {
			onScreen = true
			settled = screen.searchText
			presented = true
		}
		.onDisappear { onScreen = false }
		// Closing the search closes its page: there is nothing else on it.
		.onChange(of: presented) { _, now in if !now, onScreen { dismiss() } }
		.task(id: screen.searchText) {
			if query(screen.searchText).map({ screen.listing($0) != nil }) ?? true {
				settled = screen.searchText
				return
			}
			do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
			settled = screen.searchText
		}
	}

	private func query(_ text: String) -> CaseQuery? {
		let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !words.isEmpty else { return nil }
		switch screen.searchEverywhere ? nil : context {
		case .folder(let folder): return CaseQuery(folder: folder.path, deep: true, text: words)
		case .tag(let tag): return CaseQuery(text: words, tag: tag)
		case nil: return CaseQuery(text: words)
		}
	}

	private struct Scoped: ViewModifier {
		let context: SearchContext?
		@Binding var everywhere: Bool
		func body(content: Content) -> some View {
			if let context {
				content.searchScopes($everywhere, activation: .onSearchPresentation) {
					Text(context.name).tag(false)
					Text("Everywhere").tag(true)
				}
			} else {
				content
			}
		}
	}
}

/// The magnifier, and a new case where the person may write one.
private struct SuiteToolbar: ToolbarContent {
	let context: SearchContext?
	let folder: String?
	let screen: SuiteScreen
	let workspace: Workspace

	var body: some ToolbarContent {
		ToolbarItemGroup(placement: .topBarTrailing) {
			NavigationLink(value: SuiteRoute.search(context)) {
				Label("Search", systemImage: "magnifyingglass")
			}
			.accessibilityIdentifier("suite-search")
			if workspace.project?.may(.produce) == true {
				Button { screen.newCase(in: folder) } label: { Label("New case", systemImage: "plus") }
					.accessibilityIdentifier("suite-new")
			}
		}
	}
}

/// The cases of one query, read a page at a time as the list is scrolled.
private struct CaseSection: View {
	let query: CaseQuery
	/// How many cases the folder tree says there are, when it says: none means nothing to wait for.
	let expected: Int?
	let screen: SuiteScreen

	var body: some View {
		let listing = screen.listing(query)
		switch listing?.loading {
		case .failed(let why)?: Failed(why: why) { await screen.load(query) }
		case .done?:
			if let listing, !listing.cases.isEmpty {
				Section {
					ForEach(listing.cases) { item in
						NavigationLink(value: SuiteRoute.document(ref: item.ref)) { SuiteCaseRow(item: item) }
							.accessibilityIdentifier("suite-case-\(item.ref)")
					}
					if listing.hasMore {
						ProgressView().frame(maxWidth: .infinity)
							.task(id: screen.nextPageID(query)) { Task { await screen.more(query) } }
					}
				}
			}
		case .first?, nil:
			if expected != 0 { ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear) }
		}
	}
}

private struct Failed: View {
	let why: String
	let retry: () async -> Void
	var body: some View {
		Section {
			Text(why).foregroundStyle(Color.fail)
			Button("Try again") { Task { await retry() } }
		}
	}
}

private struct FolderRow: View {
	let folder: SuiteFolder
	var body: some View {
		NavigationLink(value: SuiteRoute.folder(folder)) {
			HStack {
				Label(folder.name, systemImage: "folder.fill")
				Spacer()
				if folder.cases > 0 { Text("\(folder.cases)").foregroundStyle(.secondary) }
			}
		}
		.accessibilityIdentifier("folder-\(folder.path)")
	}
}

private struct TagRow: View {
	let tag: SuiteTag
	var body: some View {
		NavigationLink(value: SuiteRoute.tag(tag.name)) {
			HStack {
				Label(tag.name, systemImage: "number")
				Spacer()
				Text("\(tag.count)").foregroundStyle(.secondary)
			}
		}
		.accessibilityIdentifier("tag-\(tag.name)")
	}
}

private struct SuiteCaseRow: View {
	let item: SuiteCase

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(item.title).font(.body.weight(.medium))
			HStack(spacing: 6) {
				RefText(item.ref)
				if !item.tags.isEmpty {
					Text(item.tags.map { "#\($0)" }.joined(separator: " "))
						.font(.footnote).foregroundStyle(.tint).lineLimit(1)
				}
			}
			if !item.proof.isEmpty { ProofChips(proof: item.proof) }
		}
		.padding(.vertical, 2)
	}
}

extension View {
	/// The page shows this query while it is on screen: the screen reads it and keeps it current.
	func shows(_ query: CaseQuery?, on screen: SuiteScreen) -> some View {
		modifier(ShowsQuery(query: query, screen: screen))
	}
}

private struct ShowsQuery: ViewModifier {
	let query: CaseQuery?
	let screen: SuiteScreen
	@State private var onScreen = false
	/// The query this page told the screen it shows, while it is on screen.
	@State private var told: CaseQuery?

	func body(content: Content) -> some View {
		content
			.onAppear {
				onScreen = true
				tell(query)
			}
			.onDisappear {
				onScreen = false
				tell(nil)
			}
			.onChange(of: query) { _, new in if onScreen { tell(new) } }
	}

	private func tell(_ query: CaseQuery?) {
		if let told { screen.disappear(told) }
		told = query
		if let query { screen.appear(query) }
	}
}
