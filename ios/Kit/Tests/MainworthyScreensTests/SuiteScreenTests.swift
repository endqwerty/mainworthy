import Foundation
@testable import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The Suite screen", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct SuiteScreenTests {
	@Test("drilling into folders, searching and filtering")
	func browsing() async throws {
		let screen = SuiteScreen(project: try await Live.signedIn().project(try await Live.project()))
		await screen.show(.root)
		#expect(screen.loading == .done && screen.children.map(\.name).contains("Checkout"))
		#expect(!screen.showsCases)
		let checkout = try #require(screen.children.first { $0.name == "Checkout" })
		await screen.show(.folder(checkout))
		#expect(screen.children.map(\.name) == ["Coupons", "Cart"])
		let coupons = try #require(screen.children.first { $0.name == "Coupons" })
		await screen.show(.folder(coupons))
		#expect(screen.cases.count == 2 && screen.children.isEmpty)
		await screen.up()
		#expect(screen.place == .folder(checkout))
		await screen.show(.all, text: "password")
		#expect(screen.cases.map(\.title) == ["Password reset restores access"])
		await screen.show(.all, tag: "regression")
		#expect(screen.cases.count == 3)
	}

	@Test("drafts keep typing, reserve deleted ids, reorder, save, and read both versions")
	func editor() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = SuiteScreen(project: client)
		await screen.show(.root)
		let folder = try #require(screen.folders.first { $0.path == "Checkout/Coupons" })
		await screen.show(.folder(folder))
		screen.newCase()
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
		guard case .read(let opened) = screen.document(stamp.ref) else { Issue.record("not opened"); return }
		#expect(opened.folder == folder.path)
		await screen.edit(opened)
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

	@Test("an editor stays on the version opened, and a concurrent overlapping edit waits in the web app")
	func conflict() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = SuiteScreen(project: client)
		await screen.show(.all)
		let ref = try #require(screen.cases.first?.ref)
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
		#expect(screen.editor === editor && editor.settled)
		#expect(editor.notice?.contains("title") == true)
		#expect(editor.notice?.contains("waits for its author in the web app") == true)
		#expect(!editor.maySave)
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
		await current.show(.all)
		#expect(current.cases.count == 6)
		#expect(original.editor?.content.title == "Only in the first project")
	}

	@Test("refresh keeps every page and updates an open latest document")
	func refreshPages() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let _: JSONValue = try await client.server.write("propose", in: client.key, ["edits": .array((0..<102).map { n in
			["op": "create", "body": ["title": .string("Case \(n)")]]
		})])
		let screen = SuiteScreen(project: client)
		await screen.show(.all)
		#expect(screen.cases.count == 100 && screen.hasMore)
		await screen.more()
		#expect(screen.cases.count == 108 && !screen.hasMore)
		let ref = try #require(screen.cases.last?.ref)
		await screen.openCase(ref)
		let _: JSONValue = try await client.server.write("propose", in: client.key,
			["edits": [["op": "edit", "case": .string(ref), "base": 1, "body": ["title": "Updated elsewhere"]]]])
		await screen.refresh()
		#expect(screen.cases.count == 108 && !screen.hasMore)
		#expect(screen.cases.last?.title == "Updated elsewhere")
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

		func waitForRead() async {
			if arrived { return }
			await withCheckedContinuation { waiting = $0 }
		}
		func release() { held?.resume(); held = nil }

		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
			var result = #"{"items":[]}"#
			if input["in"]?.string == "cases" {
				let search = input["text"]?.string ?? ""
				if search == "old" {
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

	@Test("a slow search cannot replace a newer selection")
	func overtaken() async throws {
		let transport = Delayed()
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")),
			secrets: MemoryStore(), transport: transport)
		let screen = SuiteScreen(project: server.project("shop"))
		let old = Task { await screen.show(.all, text: "old") }
		await transport.waitForRead()
		await screen.show(.all, text: "new")
		#expect(screen.cases.map(\.title) == ["new"])
		await transport.release()
		await old.value
		#expect(screen.text == "new" && screen.cases.map(\.title) == ["new"])
	}
}

@Suite("The case editor's lost replies")
@MainActor
struct SuiteEditorRetryTests {
	actor Lost: Transport {
		private(set) var bodies: [Data] = []
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
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
		let editor = CaseEditorScreen(project: server.project("shop"), source: .create(folder: "Checkout/Coupons"))
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
