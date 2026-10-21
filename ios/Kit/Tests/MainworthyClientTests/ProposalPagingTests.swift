import Foundation
import Synchronization
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("Complete proposal documents")
struct ProposalPagingTests {
	private let body = #"{"title":"A case","pre":"","steps":[],"methods":["human"],"automate":"none","fields":{}}"#

	private func evidence(count: Int) throws -> ProposedEdit {
		let json = #"{"proposal":"P-1","author":"reviewer","reason":null,"edits":[{"op":"create","title":"A case"}],"count":\#(count),"conflicts":[],"facts":[]}"#
		return ProposedEdit(try JSONDecoder().decode(Wire.AdoptEvidence.self, from: Data(json.utf8)))
	}

	@Test("a full read must match both the question's count and every page's total")
	func completeCount() async throws {
		let created = #"{"op":"create","body":\#(body),"folder":"","tags":[],"covers":[]}"#
		func page(_ edits: String, count: Int, cursor: String = "null") -> Script.Reply {
			.json(#"{"ok":true,"seq":3,"result":[{"ref":"P-1","count":\#(count),"cursor":\#(cursor),"edits":[\#(edits)]}]}"#)
		}
		let edit = try evidence(count: 2)
		func documents(_ script: Script) async throws -> [EditedCase] {
			let server = Server(instance: Instance(address: "https://mainworthy.example")!, secrets: MemoryStore(), transport: script)
			return try await server.project("shop", identity: "shop-identity").documents(of: edit)
		}
		#expect(try await documents(Script(page("\(created),\(created)", count: 2))).map(\.id) == [0, 1])
		for script in [
			Script(page(created, count: 2)),
			Script(page("\(created),\(created),\(created)", count: 2)),
			Script(page("\(created),\(created)", count: 3)),
			Script(page(created, count: 2, cursor: #""next""#), page(created, count: 3)),
		] {
			await #expect(throws: ClientError.unreadable) { _ = try await documents(script) }
		}
		// An edit this build has no page for, on a page the question's summaries did not cover, sends the proposal
		// to the web app rather than calling a good reply unreadable.
		await #expect(throws: ProposalReadError.notShownHere) {
			_ = try await documents(Script(page(created, count: 2, cursor: #""next""#), page(#"{"op":"policy"}"#, count: 2)))
		}
	}

	@Test("a proposal not shown whole shows its content edits from every page, without the ones this build cannot show")
	func notShownWhole() async throws {
		let json = #"{"proposal":"P-1","author":"reviewer","reason":null,"edits":[{"op":"create","title":"A case"},{"op":"place","case":"C-2","title":"Another"}],"count":3,"conflicts":[],"facts":[]}"#
		let edit = ProposedEdit(try JSONDecoder().decode(Wire.AdoptEvidence.self, from: Data(json.utf8)))
		#expect(edit.notShown == .otherThanContent)
		let created = #"{"op":"create","body":\#(body),"folder":"","tags":[],"covers":[]}"#
		let script = Script(
			.json(#"{"ok":true,"seq":3,"result":[{"ref":"P-1","count":3,"cursor":"next","edits":[\#(created),{"op":"place","case":"C-2","folder":"Elsewhere"}]}]}"#),
			.json(#"{"ok":true,"seq":3,"result":[{"ref":"P-1","count":3,"cursor":null,"edits":[\#(created)]}]}"#)
		)
		let server = Server(instance: Instance(address: "https://mainworthy.example")!, secrets: MemoryStore(), transport: script)
		let documents = try await server.project("shop", identity: "shop-identity").documents(of: edit)
		#expect(documents.map(\.id) == [0, 2])
	}

	@Test("a project written to on every page stops reading after three restarts")
	func restartsAreBounded() async throws {
		let created = #"{"op":"create","body":\#(body),"folder":"","tags":[],"covers":[]}"#
		let first = Script.Reply.json(#"{"ok":true,"seq":3,"result":[{"ref":"P-1","count":2,"cursor":"next","edits":[\#(created)]}]}"#)
		let moved = Script.Reply.json(status: 409, #"{"ok":false,"error":{"code":"conflict","message":"the project changed since this page's cursor"}}"#)
		let script = Script(first, moved, first, moved, first, moved, first, moved, first, moved)
		let server = Server(instance: Instance(address: "https://mainworthy.example")!, secrets: MemoryStore(), transport: script)
		await #expect(throws: ProposalReadError.keptChanging) {
			_ = try await server.project("shop", identity: "shop-identity").documents(of: try evidence(count: 2))
		}
		#expect(ProposalReadError.keptChanging.shown == "The project kept changing while the proposal was read. Try again.")
		#expect(script.asked.count == 8)
	}

	@Test("201 edits are read in order, including edits missing from the twenty summaries", .enabled(if: Live.isRunning))
	func everyPage() async throws {
		let key = try await Live.project(strict: true)
		let server = try await Live.signedIn(as: Live.owner)
		let project = try await server.project(key)
		let question = try await propose(in: project)
		guard case .proposal(let edit) = question.evidence else { throw ClientError.unreadable }
		#expect(edit.summaries.count == 20)
		#expect(edit.isShownWhole)
		#expect(question.choices.map(\.takes) == [.nothing, .nothing])
		let documents = try await project.documents(of: edit)
		#expect(documents.count == 201)
		#expect(documents.map(\.id) == Array(0..<201))
		#expect(documents.first?.after.title == "The shop opens with a welcome")
		#expect(documents.last?.after.title == "Paged case 200")
	}

	@Test("a project write between pages discards the old pages and reads the new snapshot", .enabled(if: Live.isRunning))
	func changedBetweenPages() async throws {
		let key = try await Live.project(strict: true)
		let owner = try await Live.signedIn(as: Live.owner)
		let writer = try await owner.project(key)
		let question = try await propose(in: writer)
		let transport = WriteBetweenProposalPages {
			let current = try await writer.caseDocument("C-1")
			var content = current.content
			content.pre = "A write between pages"
			let _: JSONValue = try await owner.write("propose", in: key, ["edits": [[
				"op": "edit", "case": "C-1", "base": .number(Double(current.version)),
				"body": ["pre": .string(content.pre)],
			]]])
			// Strict policy keeps this second proposal waiting. Accept it to change the first proposal's current case.
			let pending = try #require(try await writer.questions(open: true, kind: .adopt).questions.first { $0.ref != question.ref })
			let accept = try #require(pending.choices.first { $0.answer == "accept" })
			#expect((try await writer.answer(pending, with: accept, reason: "Read the changed prerequisite")).isDecided)
		}
		let reader = try await Live.signedIn(transport: transport).project(key)
		guard case .proposal(let edit) = question.evidence else { throw ClientError.unreadable }
		let documents = try await reader.documents(of: edit)
		#expect(documents.count == 201)
		#expect(documents.first?.before?.pre == "A write between pages")
		#expect(documents.first?.after.pre == "A write between pages")
		#expect(documents.last?.after.title == "Paged case 200")
		#expect(transport.pages.withLock { $0 } == [false, true, false, true])
	}

	private func propose(in project: ProjectClient) async throws -> Question {
		var edits: [JSONValue] = [["op": "edit", "case": "C-1", "base": 1, "body": ["title": "The shop opens with a welcome"]]]
		edits += (1...200).map { index in
			["op": "create", "body": ["title": .string("Paged case \(index)"), "steps": []]]
		}
		let _: JSONValue = try await project.server.write("propose", in: project.key, ["edits": .array(edits)])
		return try #require(try await project.questions(open: true, kind: .adopt).questions.first)
	}
}

private final class WriteBetweenProposalPages: Transport {
	let pages = Mutex<[Bool]>([])
	private let write: @Sendable () async throws -> Void
	private let inner = URLSessionTransport()

	init(write: @escaping @Sendable () async throws -> Void) { self.write = write }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		if request.url?.lastPathComponent == "get", let data = request.httpBody,
			let input = try JSONDecoder().decode(JSONValue.self, from: data).object,
			input["refs"]?.array?.first?.string?.hasPrefix("P-") == true {
			let cursor = input["cursor"]?.string != nil
			let change = pages.withLock { pages in
				pages.append(cursor)
				return pages == [false, true]
			}
			if change { try await write() }
		}
		return try await inner.send(request)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		try await inner.lines(request)
	}
}
