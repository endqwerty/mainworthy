import Foundation
@testable import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The Suite screen", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct SuiteScreenTests {
	@Test("shared steps remain read-only until the native editor can preserve their pins")
	func sharedFragmentsStayPinned() async throws {
		let key = try await Live.project()
		let server = try await Live.signedIn()
		let fragment: JSONValue = try await server.write("propose", in: key, ["edits": [[
			"op": "create", "kind": "fragment", "body": ["title": "Sign in", "steps": [["id": "ab", "action": "Open sign in", "expected": "Signed in"]]],
		]]])
		let fragmentRef = try #require(fragment["cases"]?.array?.first?["ref"]?.string)
		let user: JSONValue = try await server.write("propose", in: key, ["edits": [[
			"op": "create", "body": ["title": "Uses sign in", "steps": [["id": "cd", "use": ["fragment": .string(fragmentRef), "version": 1]]]],
		]]])
		let userRef = try #require(user["cases"]?.array?.first?["ref"]?.string)
		let client = try await server.project(key)
		for ref in [fragmentRef, userRef] {
			let opened = try await client.caseDocument(ref)
			#expect(opened.content.steps.first?.action == "Open sign in")
			let screen = SuiteScreen(project: client)
			await screen.edit(opened)
			#expect(screen.editor == nil)
			#expect(screen.notice == "Edit fragments and their pins in the web editor.")
			let editor = CaseEditorScreen(project: client, source: .edit(opened))
			#expect(!editor.maySave)
		}
	}

	@Test("an existing case can be edited after a required field is introduced")
	func requiredFieldOnOlderCase() async throws {
		let key = try await Live.project()
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = try await server.project(key)
		let opened = try await client.caseDocument("C-1")
		let policy: JSONValue = try await server.read("admin", in: nil, ["do": "policy.show", "project": .string(key)])
		var settings = try #require(policy["settings"]?.object)
		settings["fields"] = ["risk": ["kind": "choice", "label": "Risk", "required": true, "choices": ["low", "high"]]]
		let proposed: JSONValue = try await server.write("propose", in: key, [
			"edits": [["op": "policy", "base": try #require(policy["version"]), "settings": .object(settings)]],
		])
		let inbox: JSONValue = try await server.read("inbox", in: key, ["kind": "adopt"])
		let question = try #require(inbox["items"]?.array?.first { $0["q"] == proposed["question"] })
		let decided: JSONValue = try await server.write("decide", in: key, [
			"q": try #require(question["q"]), "onEvidence": try #require(question["evidenceHash"]),
			"answer": ["is": "accept"],
		])
		#expect(decided.array?.first?["status"] == "decided")
		let editor = CaseEditorScreen(project: client, source: .edit(opened))
		editor.content.title = "Edited without filling a new field"
		#expect(editor.maySave)
		guard case .adopted(let stamp) = await editor.save(), let stamp else {
			Issue.record("the older case was not saved: \(editor.notice ?? "no notice")"); return
		}
		#expect(stamp.version == opened.version + 1)
		#expect(editor.savedDocument?.content.title == "Edited without filling a new field")
		#expect(try await client.caseDocument("C-1").content.title == "Edited without filling a new field")
	}

	@Test("an overlong title keeps all typing and creates no truncated case")
	func longTitle() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = SuiteScreen(project: client)
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = String(repeating: "x", count: 404)
		#expect(!editor.maySave)
		await screen.saveEditor()
		#expect(screen.editor === editor && editor.content.title.utf16.count == 404)
		#expect(try await client.cases().items.count == 6)
	}

	@Test("the reason limit counts UTF-16 units before sending")
	func reasonLimit() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let editor = CaseEditorScreen(project: client, source: .create(folder: nil))
		editor.content.title = "Reason limit"
		editor.reason = String(repeating: "😀", count: 251)
		#expect(!editor.maySave)
		#expect(await editor.save() == nil)
		#expect(try await client.cases().items.count == 6)
	}

	@Test("whitespace that the server would remove is kept until the author corrects it",
		arguments: ["title", "pre", "action", "expected"])
	func whitespace(_ field: String) async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let editor = CaseEditorScreen(project: client, source: .create(folder: nil))
		editor.content = CaseContent(title: "Valid", steps: [Step(id: "a0", action: "Open", expected: "Done")])
		switch field {
		case "title": editor.content.title = "Two  spaces"
		case "pre": editor.content.pre = " pre "
		case "action": editor.content.steps[0].action = " action "
		default: editor.content.steps[0].expected = " expected "
		}
		let typed = editor.content
		#expect(!editor.maySave)
		#expect(await editor.save() == nil)
		#expect(editor.content == typed && !editor.settled)
	}

	@Test("the server keeps the exact boundary lengths and has no text or step count cap")
	func allowedLengths() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let editor = CaseEditorScreen(project: client, source: .create(folder: nil))
		let long = String(repeating: "text", count: 3000)
		editor.content = CaseContent(title: String(repeating: "😀", count: 150), pre: long,
			steps: (0..<1001).map { Step(id: String(format: "a%04d", $0),
				action: $0 == 0 ? long : "Open", expected: $0 == 0 ? long : nil) })
		editor.reason = String(repeating: "😀", count: 250)
		#expect(editor.maySave)
		guard case .adopted(let stamp) = await editor.save(), let stamp else {
			Issue.record("the boundary content was not saved"); return
		}
		let stored = try await client.caseDocument(stamp.ref, version: stamp.version)
		#expect(stored.content == editor.content)
		#expect(try await client.caseHistory(stamp.ref).first?.reason == editor.reason)
	}

	@Test("even a whitespace-only reason is stored exactly as typed")
	func reasonWhitespace() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let editor = CaseEditorScreen(project: client, source: .create(folder: nil))
		editor.content.title = "Exact reason"
		editor.reason = "  "
		guard case .adopted(let stamp) = await editor.save(), let stamp else {
			Issue.record("not adopted"); return
		}
		#expect(try await client.caseHistory(stamp.ref).first?.reason == editor.reason)
	}

	@Test("a historical document cannot open an editor")
	func historicalEditor() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let ref = try #require(try await client.cases().items.first?.ref)
		let screen = SuiteScreen(project: client)
		await screen.openCase(ref, version: 1)
		guard case .read(let old) = screen.document(ref, version: 1) else { Issue.record("not read"); return }
		await screen.edit(old)
		#expect(screen.editor == nil)
	}

	actor DelayedSavedRead: Transport {
		let real = URLSessionTransport()
		var held: CheckedContinuation<Void, Never>?
		var waiting: CheckedContinuation<Void, Never>?
		var arrived = false
		func waitForRead() async {
			if arrived { return }
			await withCheckedContinuation { waiting = $0 }
		}
		func release() { held?.resume(); held = nil }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			if request.url?.path.hasSuffix("/get") == true {
				await withCheckedContinuation {
					held = $0; arrived = true; waiting?.resume(); waiting = nil
				}
			}
			return try await real.send(request)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await real.lines(request)
		}
	}

	@Test("adoption opens its saved version even after another author changes the case")
	func adoptedVersion() async throws {
		let key = try await Live.project()
		let other = try await Live.signedIn().project(key)
		let transport = DelayedSavedRead()
		let server = Server(instance: Live.instance, secrets: MemoryStore(), transport: transport)
		_ = try await server.signIn(.password(name: Live.name, password: Live.password))
		let screen = SuiteScreen(project: try await server.project(key))
		screen.newCase()
		screen.editor?.content.title = "My saved title"
		let saving = Task { await screen.saveEditor() }
		await transport.waitForRead()
		let ref = try #require(try await other.cases(text: "My saved title").items.first?.ref)
		let _: JSONValue = try await other.server.write("propose", in: key,
			["edits": [["op": "edit", "case": .string(ref), "base": 1, "body": ["title": "A later title"]]]])
		await transport.release()
		await saving.value
		guard case .read(let document) = screen.document(ref, version: 1) else {
			Issue.record("the saved version was not opened"); return
		}
		#expect(screen.saved?.version == 1 && document.version == 1 && document.content.title == "My saved title")
	}

	@Test("drilling into folders, searching in one or everywhere, and listing a tag")
	func browsing() async throws {
		let screen = SuiteScreen(project: try await Live.signedIn().project(try await Live.project()))
		await screen.loadTree()
		#expect(screen.tree == .done && screen.children(of: nil).map(\.name).contains("Checkout"))
		#expect(screen.tags.contains { $0.name == "regression" })
		let checkout = try #require(screen.children(of: nil).first { $0.name == "Checkout" })
		#expect(screen.children(of: checkout).map(\.name) == ["Coupons", "Cart"])
		await screen.load(CaseQuery(folder: checkout.path))
		#expect(screen.listing(CaseQuery(folder: checkout.path))?.cases.isEmpty == true)
		let coupons = try #require(screen.children(of: checkout).first { $0.name == "Coupons" })
		await screen.load(CaseQuery(folder: coupons.path))
		#expect(screen.listing(CaseQuery(folder: coupons.path))?.cases.count == 2 && screen.children(of: coupons).isEmpty)
		// A search in a folder is of everything under it.
		let expired = CaseQuery(folder: checkout.path, deep: true, text: "expired")
		await screen.load(expired)
		#expect(screen.listing(expired)?.cases.map(\.title) == ["Expired coupon is rejected"])
		await screen.load(CaseQuery(folder: checkout.path, deep: true, text: "password"))
		#expect(screen.listing(CaseQuery(folder: checkout.path, deep: true, text: "password"))?.cases.isEmpty == true)
		await screen.load(CaseQuery(text: "password"))
		#expect(screen.listing(CaseQuery(text: "password"))?.cases.map(\.title) == ["Password reset restores access"])
		await screen.load(CaseQuery(tag: "regression"))
		#expect(screen.listing(CaseQuery(tag: "regression"))?.cases.count == 3)
	}

	@Test("drafts keep typing, reserve deleted ids, reorder, save, and read both versions")
	func editor() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = SuiteScreen(project: client)
		await screen.loadTree()
		let folder = try #require(screen.folders.first { $0.path == "Checkout/Coupons" })
		screen.appear(CaseQuery(folder: folder.path))
		await screen.load(CaseQuery(folder: folder.path))
		screen.newCase(in: folder.path)
		let editor = try #require(screen.editor)
		editor.content.title = "A native draft"
		editor.addStep()
		let first = try #require(editor.content.steps.first?.id)
		editor.content.steps[0].action = "Open"
		editor.addStep()
		editor.content.steps[1].action = "Apply"
		editor.moveSteps(from: [0], to: 2)
		#expect(editor.content.steps.map(\.action) == ["Apply", "Open"])
		editor.removeSteps(at: [1])
		editor.addStep()
		#expect(editor.content.steps.last?.id != first)
		editor.content.steps[1].action = "Reload"
		#expect(editor.dirty && editor.maySave)
		await screen.refresh()
		#expect(screen.editor === editor && editor.content.title == "A native draft")
		await screen.saveEditor()
		#expect(screen.editor == nil)
		let stamp = try #require(screen.saved)
		#expect(stamp.version == 1)
		guard case .read(let opened) = screen.document(stamp.ref, version: stamp.version) else { Issue.record("not opened"); return }
		#expect(opened.folder == folder.path)
		await screen.openCase(stamp.ref)
		guard case .read(let current) = screen.document(stamp.ref) else { Issue.record("no current"); return }
		await screen.edit(current)
		let next = try #require(screen.editor)
		next.content.title = "A changed draft"
		next.addStep()
		next.content.steps[2].action = "Finish"
		await screen.saveEditor()
		#expect(screen.saved?.version == 2)
		await screen.readHistory(stamp.ref)
		#expect(screen.history(stamp.ref) != nil)
		await screen.openCase(stamp.ref, version: 1)
		guard case .read(let old) = screen.document(stamp.ref, version: 1) else { Issue.record("no old version"); return }
		#expect(old.content.title == "A native draft")
	}

	@Test("an editor stays on the version opened, and a concurrent overlapping edit resolves on the phone")
	func conflict() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = SuiteScreen(project: client)
		await screen.load(.all)
		let ref = try #require(screen.listing(.all)?.cases.first?.ref)
		await screen.openCase(ref)
		guard case .read(let opened) = screen.document(ref) else { Issue.record("not opened"); return }
		await screen.edit(opened)
		let editor = try #require(screen.editor)
		editor.content.title = "Mine"
		let _: JSONValue = try await client.server.write("propose", in: client.key,
			["edits": [["op": "edit", "case": .string(ref), "base": .number(Double(opened.version)),
				"body": ["title": "Another author"]]]])
		await screen.refresh()
		#expect(editor.source == .edit(opened))
		await screen.saveEditor()
		#expect(screen.editor === editor && !editor.settled)
		#expect(editor.conflict?.addresses == [.field(.title)])
		#expect(editor.conflict?.mine.title == "Mine" && editor.conflict?.current.title == "Another author")
		#expect(!editor.maySave)
		editor.chooseConflict(.field(.title), side: .mine)
		await screen.saveEditor()
		#expect(screen.editor == nil && screen.saved?.version == 3)
		#expect(try await client.caseDocument(ref).content.title == "Mine")
	}

	@Test("a stricter policy says the proposal waits in the Queue")
	func waiting() async throws {
		let screen = SuiteScreen(project: try await Live.signedIn().project(try await Live.project(strict: true)))
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = "A proposed case"
		editor.reason = "Please review"
		await screen.saveEditor()
		#expect(editor.notice?.contains("waits for a person's answer in the Queue") == true)
		#expect(editor.settled && screen.saved == nil)
	}

	@Test("another project gets a new Suite screen and no draft from the first")
	func projects() async throws {
		let first = try await Live.project()
		let second = try await Live.project()
		let server = try await Live.signedIn()
		let account = try await server.account()
		let name = "suite-tests-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: name))
		defer { defaults.removePersistentDomain(forName: name) }
		let workspace = Workspace(server: server, account: account, remembered: Remembered(defaults), onSignedOut: {})
		workspace.open(try #require(account.projects.first { $0.key == first }))
		let original = try #require(workspace.suite)
		original.newCase()
		original.editor?.content.title = "Only in the first project"
		workspace.open(try #require(account.projects.first { $0.key == second }))
		let current = try #require(workspace.suite)
		#expect(current !== original && current.editor == nil)
		await current.load(.all)
		#expect(current.listing(.all)?.cases.count == 6)
		#expect(original.editor?.content.title == "Only in the first project")
	}

	@Test("refresh keeps every page and updates an open latest document")
	func refreshPages() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let _: JSONValue = try await client.server.write("propose", in: client.key, ["edits": .array((0..<102).map { n in
			["op": "create", "body": ["title": .string("Case \(n)")]]
		})])
		let screen = SuiteScreen(project: client)
		screen.appear(.all)
		await screen.load(.all)
		#expect(screen.listing(.all)?.cases.count == 100 && screen.listing(.all)?.hasMore == true)
		await screen.more(.all)
		#expect(screen.listing(.all)?.cases.count == 108 && screen.listing(.all)?.hasMore == false)
		let ref = try #require(screen.listing(.all)?.cases.last?.ref)
		await screen.openCase(ref)
		let _: JSONValue = try await client.server.write("propose", in: client.key,
			["edits": [["op": "edit", "case": .string(ref), "base": 1, "body": ["title": "Updated elsewhere"]]]])
		await screen.refresh()
		#expect(screen.listing(.all)?.cases.count == 108 && screen.listing(.all)?.hasMore == false)
		#expect(screen.listing(.all)?.cases.last?.title == "Updated elsewhere")
		guard case .read(let latest) = screen.document(ref) else { Issue.record("not opened"); return }
		#expect(latest.version == 2 && latest.content.title == "Updated elsewhere")
	}
}

@Suite("The Suite screen's read ordering")
@MainActor
struct SuiteReadOrderingTests {
	actor Delayed: Transport {
		private var held: CheckedContinuation<Void, Never>?
		private var waiting: CheckedContinuation<Void, Never>?
		private var arrived = false
		private var renamed: String?

		func waitForRead() async {
			if arrived { return }
			await withCheckedContinuation { waiting = $0 }
		}
		func release() { held?.resume(); held = nil }
		/// Later reads of "old" are answered with this title, the first one is held.
		func answer(old title: String) { renamed = title }

		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
			var result = #"{"items":[]}"#
			if input["in"]?.string == "cases" {
				var search = input["text"]?.string ?? ""
				if search == "old", let renamed {
					search = renamed
				} else if search == "old" {
					await withCheckedContinuation { continuation in
						held = continuation
						arrived = true
						waiting?.resume()
						waiting = nil
					}
				}
				result = #"{"items":[{"ref":"C-1","title":"\#(search)","tags":[],"proof":{"human":null,"auto":null,"agent":null}}],"cursor":null}"#
			}
			return (Data("{\"ok\":true,\"result\":\(result)}".utf8),
				HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	actor Paging: Transport {
		var held: CheckedContinuation<Void, Never>?
		var waiting: CheckedContinuation<Void, Never>?
		var arrived = false
		let holdCursor: Bool
		init(holdCursor: Bool = false) { self.holdCursor = holdCursor }
		private(set) var cursors = 0
		func waitForRead() async {
			if arrived { return }
			await withCheckedContinuation { waiting = $0 }
		}
		func release() { held?.resume(); held = nil }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
			var result = #"{"items":[]}"#
			if input["in"]?.string == "cases" {
				let selected = input["text"] != nil || input["tags"] != nil || input["folder"] != nil
				let cursor = input["cursor"] != nil
				if cursor { cursors += 1 }
				if !arrived && (holdCursor ? cursor : selected && !cursor) {
					await withCheckedContinuation {
						held = $0; arrived = true; waiting?.resume(); waiting = nil
					}
				}
				let items = cursor ? "" : #"{"ref":"C-1","title":"match","tags":[],"proof":{"human":null,"auto":null,"agent":null}}"#
				result = "{\"items\":[\(items)],\"cursor\":\(selected || cursor ? "null" : "\"old-cursor\"")}"
			}
			return (Data("{\"ok\":true,\"result\":\(result)}".utf8),
				HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("a new selection cannot page with the previous selection's cursor", arguments: ["search", "tag", "folder"])
	func stalePaging(_ selection: String) async throws {
		let transport = Paging()
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let screen = SuiteScreen(project: server.project("shop", identity: "shop-identity"))
		await screen.load(.all)
		#expect(screen.listing(.all)?.hasMore == true)
		let query = switch selection {
		case "folder": CaseQuery(folder: "Folder")
		case "search": CaseQuery(text: "match")
		default: CaseQuery(tag: "regression")
		}
		let selecting = Task { await screen.load(query) }
		await transport.waitForRead()
		await screen.more(query)
		await transport.release()
		await selecting.value
		#expect(await transport.cursors == 0)
		#expect(screen.listing(query)?.loading == .done && screen.listing(query)?.cases.map(\.title) == ["match"])
		// The listing it was opened over keeps its own cursor.
		#expect(screen.listing(.all)?.hasMore == true)
	}

	@Test("one next-page read runs at a time and a refresh invalidates an older page", arguments: [false, true])
	func pagingRefresh(_ refresh: Bool) async throws {
		let transport = Paging(holdCursor: true)
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let screen = SuiteScreen(project: server.project("shop", identity: "shop-identity"))
		screen.appear(.all)
		await screen.load(.all)
		let page = Task { await screen.more(.all) }
		await transport.waitForRead()
		if refresh { await screen.refresh() }
		await screen.more(.all)
		await transport.release()
		await page.value
		#expect(await transport.cursors == (refresh ? 2 : 1))
		let listing = try #require(screen.listing(.all))
		#expect(listing.loading == .done && listing.cases.map(\.title) == ["match"] && !listing.hasMore)
	}

	@Test("a slow read cannot replace a newer read of the same query")
	func overtaken() async throws {
		let transport = Delayed()
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let screen = SuiteScreen(project: server.project("shop", identity: "shop-identity"))
		let query = CaseQuery(text: "old")
		screen.appear(query)
		let old = Task { await screen.load(query) }
		await transport.waitForRead()
		// A change is told of while the first read waits: the read that follows it is the one kept.
		await transport.answer(old: "newer")
		await screen.refresh()
		#expect(screen.listing(query)?.cases.map(\.title) == ["newer"])
		await transport.release()
		await old.value
		#expect(screen.listing(query)?.cases.map(\.title) == ["newer"])
	}
}

@Suite("The Cases tab's kept listings")
@MainActor
struct SuiteCacheTests {
	/// A project of one folder with ten subfolders of one case each, and one empty subfolder. Counts each read.
	actor Counting: Transport {
		private(set) var reads: [String] = []
		private var held: CheckedContinuation<Void, Never>?
		private var holding = false
		func hold() { holding = true }
		func release() { holding = false; held?.resume(); held = nil }
		func count(_ prefix: String) -> Int { reads.filter { $0.hasPrefix(prefix) }.count }

		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
			let result: String
			switch input["in"]?.string {
			case "folders":
				reads.append("folders")
				let children = (1...11).map { n in
					#"{"id":\#(n + 1),"parent":1,"name":"F\#(n)","path":"Top/F\#(n)","cases":\#(n == 11 ? 0 : 1),"state":"active"}"#
				}
				result = #"{"items":[{"id":1,"parent":null,"name":"Top","path":"Top","cases":0,"state":"active"},"# +
					children.joined(separator: ",") + "]}"
			case "tags":
				reads.append("tags")
				result = #"{"items":[{"tag":"smoke","n":1}]}"#
			default:
				let folder = input["folder"]?.string ?? ""
				let text = input["text"]?.string ?? ""
				reads.append("cases \(folder) \(text)")
				if holding { await withCheckedContinuation { held = $0 } }
				result = #"{"items":[{"ref":"C-\#(reads.count)","title":"\#(folder) \#(text)","tags":[],"proof":{"human":null,"auto":null,"agent":null}}],"cursor":null}"#
			}
			return (Data("{\"ok\":true,\"result\":\(result)}".utf8),
				HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	private func screen(_ transport: Counting) throws -> SuiteScreen {
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		return SuiteScreen(project: server.project("shop", identity: "shop-identity"))
	}

	@Test("a folder opened again shows what was read without reading it, until a change is told of")
	func revisit() async throws {
		let transport = Counting()
		let screen = try screen(transport)
		let folder = CaseQuery(folder: "Top/F1")
		screen.appear(folder)
		await screen.load(folder)
		screen.disappear(folder)
		screen.appear(folder)
		await screen.load(folder)
		#expect(await transport.count("cases Top/F1") == 1)
		#expect(screen.listing(folder)?.loading == .done)
		// A change: the folder on screen is read again, one that was left is kept and read when it is opened.
		let other = CaseQuery(folder: "Top/F2")
		await screen.load(other)
		await screen.refresh()
		#expect(await transport.count("cases Top/F1") == 2)
		#expect(await transport.count("cases Top/F2") == 1)
		#expect(screen.listing(other)?.cases.count == 1)
		await screen.load(other)
		#expect(await transport.count("cases Top/F2") == 2)
		// The refresh read the tree, which is current until the next change.
		await screen.loadTree()
		#expect(await transport.count("folders") == 1)
	}

	@Test("a page opened while its read is under way waits for that read and sends none of its own")
	func shared() async throws {
		let transport = Counting()
		let screen = try screen(transport)
		await transport.hold()
		let folder = CaseQuery(folder: "Top/F1")
		let first = Task { await screen.load(folder) }
		while await transport.count("cases") == 0 { await Task.yield() }
		let second = Task { await screen.load(folder) }
		await Task.yield()
		await transport.release()
		await first.value
		await second.value
		#expect(await transport.count("cases Top/F1") == 1)
		#expect(screen.listing(folder)?.loading == .done)
	}

	@Test("a folder's subfolders with cases are read ahead, a few of them, and an empty one is not")
	func readAhead() async throws {
		let transport = Counting()
		let screen = try screen(transport)
		await screen.loadTree()
		let top = try #require(screen.children(of: nil).first)
		let children = screen.children(of: top)
		#expect(children.count == 11)
		await screen.readAhead(children)?.value
		#expect(await transport.count("cases") == SuiteScreen.readAhead)
		#expect(screen.listing(CaseQuery(folder: "Top/F1"))?.loading == .done)
		#expect(screen.listing(CaseQuery(folder: "Top/F11")) == nil)
		// What was read ahead is not read again.
		await screen.readAhead(children)?.value
		await screen.load(CaseQuery(folder: "Top/F1"))
		#expect(await transport.count("cases") == 10)
	}

	/// Every case read has a next page; the tree's read is held when asked.
	actor HeldTree: Transport {
		private(set) var cursors = 0
		private var held: CheckedContinuation<Void, Never>?
		private var holding = false
		private var waiting: CheckedContinuation<Void, Never>?
		func hold() { holding = true }
		func release() { holding = false; held?.resume(); held = nil }
		func waitForHold() async {
			if held != nil { return }
			await withCheckedContinuation { waiting = $0 }
		}
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
			var result = #"{"items":[]}"#
			if input["in"]?.string == "folders", holding {
				await withCheckedContinuation { held = $0; waiting?.resume(); waiting = nil }
			}
			if input["in"]?.string == "cases" {
				if input["cursor"] != nil { cursors += 1 }
				result = #"{"items":[{"ref":"C-1","title":"one","tags":[],"proof":{"human":null,"auto":null,"agent":null}}],"cursor":"next"}"#
			}
			return (Data("{\"ok\":true,\"result\":\(result)}".utf8),
				HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("a listing a change made stale is not paged with its old cursor while the change is read")
	func stalePage() async throws {
		let transport = HeldTree()
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let screen = SuiteScreen(project: server.project("shop", identity: "shop-identity"))
		screen.appear(.all)
		await screen.load(.all)
		await transport.hold()
		let refreshing = Task { await screen.refresh() }
		await transport.waitForHold()
		await screen.more(.all)
		#expect(await transport.cursors == 0)
		await transport.release()
		await refreshing.value
		await screen.more(.all)
		#expect(await transport.cursors == 1)
	}

	@Test("the listings kept are bounded, the least recently shown dropped first and one on screen never")
	func bounded() async throws {
		let transport = Counting()
		let screen = try screen(transport)
		let shown = CaseQuery(text: "shown")
		screen.appear(shown)
		await screen.load(shown)
		for n in 0...SuiteScreen.kept { await screen.load(CaseQuery(text: "q\(n)")) }
		#expect(screen.listing(shown) != nil)
		#expect(screen.listing(CaseQuery(text: "q0")) == nil)
		#expect(screen.listing(CaseQuery(text: "q1")) != nil)
		#expect(screen.listing(CaseQuery(text: "q\(SuiteScreen.kept)")) != nil)
	}
}

@Suite("The case editor's lost replies")
@MainActor
struct SuiteEditorRetryTests {
	actor Lost: Transport {
		private(set) var bodies: [Data] = []
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			if request.url?.path.hasSuffix("/get") == true {
				let reply = #"{"ok":true,"result":[{"ref":"C-7","version":1,"title":"One case","pre":"","steps":[],"methods":["human"],"automate":"none","tags":[],"folder":{"path":"Checkout/Coupons"}}]}"#
				return (Data(reply.utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
					httpVersion: nil, headerFields: nil)!)
			}
			bodies.append(request.httpBody ?? Data())
			if bodies.count <= 2 { throw URLError(.networkConnectionLost) }
			let reply = #"{"ok":true,"result":{"status":"adopted","question":null,"needs":null,"cases":[{"ref":"C-7","version":1}],"conflicts":[]}}"#
			return (Data(reply.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("Retry keeps the original command and body, and pauses editing while the reply is uncertain")
	func retry() async throws {
		let transport = Lost()
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let editor = CaseEditorScreen(project: server.project("shop", identity: "shop-identity"), source: .create(folder: "Checkout/Coupons"))
		editor.content.title = "One case"
		#expect(await editor.save() == nil)
		#expect(editor.isRetrying && editor.locked && editor.maySave)
		editor.addStep()
		#expect(editor.content.steps.isEmpty)
		#expect(await editor.save() == .adopted(CaseStamp(ref: "C-7", version: 1)))
		let requests = await transport.bodies
		let inputs = try requests.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
		#expect(inputs.count == 3 && Set(inputs).count == 1)
		#expect(inputs.first?["cmd"]?.string?.count == 36)
		#expect(editor.settled && !editor.maySave)
	}
}

@Suite("The Suite's other reads")
@MainActor
struct SuiteOtherReadTests {
	actor Ordered: Transport {
		let path: String
		var held: CheckedContinuation<Void, Never>?
		var waiting: CheckedContinuation<Void, Never>?
		var arrived = false
		var count = 0
		init(_ path: String) { self.path = path }
		func waitForRead() async {
			if arrived { return }
			await withCheckedContinuation { waiting = $0 }
		}
		func release() { held?.resume(); held = nil }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let matching = request.url?.path.hasSuffix("/\(path)") == true
			if matching { count += 1 }
			let mine = count
			if matching && mine == 1 {
				await withCheckedContinuation {
					held = $0; arrived = true; waiting?.resume(); waiting = nil
				}
			}
			let title = mine == 1 ? "old" : "new"
			let result: String
			if request.url?.path.hasSuffix("/get") == true {
				result = #"[{"ref":"C-1","version":1,"title":"\#(title)","pre":"","steps":[],"methods":["human"],"automate":"none","tags":[],"folder":{"path":""}}]"#
			} else {
				result = #"{"versions":[{"version":1,"by":"robin","at":0,"reason":null,"summary":"\#(title)"}]}"#
			}
			return (Data("{\"ok\":true,\"result\":\(result)}".utf8),
				HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("late document and history reads cannot replace a newer read", arguments: ["get", "history"])
	func overtaken(_ path: String) async throws {
		let transport = Ordered(path)
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let screen = SuiteScreen(project: server.project("shop", identity: "shop-identity"))
		let first = Task {
			if path == "get" { await screen.openCase("C-1") } else { await screen.readHistory("C-1") }
		}
		await transport.waitForRead()
		if path == "get" { await screen.openCase("C-1") } else { await screen.readHistory("C-1") }
		await transport.release()
		await first.value
		if path == "get" {
			guard case .read(let document) = screen.document("C-1") else { Issue.record("not read"); return }
			#expect(document.content.title == "new")
		} else {
			guard case .read(let versions) = screen.history("C-1") else { Issue.record("not read"); return }
			#expect(versions.first?.summary == "new")
		}
	}

	@Test("late editor preparation cannot replace a new draft")
	func editorPreparation() async throws {
		let transport = Ordered("history")
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let client = server.project("shop", identity: "shop-identity")
		let screen = SuiteScreen(project: client)
		let document = try await client.caseDocument("C-1")
		let preparing = Task { await screen.edit(document) }
		await transport.waitForRead()
		screen.closeEditor()
		screen.newCase()
		let draft = try #require(screen.editor)
		draft.content.title = "Keep my new draft"
		await transport.release()
		await preparing.value
		#expect(screen.editor === draft && screen.editor?.content.title == "Keep my new draft")
	}
}

@Suite("The case editor verifies adoption")
@MainActor
struct SuiteAcceptanceTests {
	actor Replies: Transport {
		let kind: String
		private(set) var writes = 0
		private(set) var gets = 0
		init(_ kind: String) { self.kind = kind }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let result: String
			if request.url?.path.hasSuffix("/propose") == true {
				writes += 1
				let cases = kind == "no version" ? "" : #"{"ref":"C-1","version":1}"#
				result = "{\"status\":\"adopted\",\"question\":null,\"needs\":null,\"cases\":[\(cases)],\"conflicts\":[]}"
			} else {
				gets += 1
				if kind == "read fails" && gets <= 2 { throw URLError(.networkConnectionLost) }
				let title = kind == "different text" ? "Changed by server" : "Typed title"
				result = #"[{"ref":"C-1","version":1,"title":"\#(title)","pre":"","steps":[],"methods":["human"],"automate":"none","tags":[],"folder":{"path":""}}]"#
			}
			return (Data("{\"ok\":true,\"result\":\(result)}".utf8),
				HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("unconfirmed adoption keeps the typed draft and explains why", arguments: ["different text", "no version", "read fails"])
	func keepsDraft(_ kind: String) async throws {
		let transport = Replies(kind)
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let screen = SuiteScreen(project: server.project("shop", identity: "shop-identity"))
		screen.newCase()
		let draft = try #require(screen.editor)
		draft.content.title = "Typed title"
		await screen.saveEditor()
		#expect(screen.editor === draft && draft.content.title == "Typed title" && draft.notice != nil)
		#expect(screen.saved == nil)
		if kind == "read fails" {
			#expect(draft.isRetrying && draft.maySave)
			await screen.saveEditor()
			#expect(screen.editor == nil && screen.saved?.version == 1)
			#expect(await transport.writes == 1)
		}
	}
}
