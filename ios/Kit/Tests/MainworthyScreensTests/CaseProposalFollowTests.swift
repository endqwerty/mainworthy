import Foundation
import Testing
@testable import MainworthyClient
@testable import MainworthyScreens
import TestSupport

@Suite("Following case proposals", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct CaseProposalFollowTests {
	actor Reads: Transport {
		let real = URLSessionTransport()
		var failing = false
		private(set) var proposals = 0
		func fail(_ value: Bool) { failing = value }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			if request.url?.path.hasSuffix("/propose") == true { proposals += 1 }
			if failing, request.url?.path.hasSuffix("/get") == true,
				let input = try? JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data()),
				input["refs"]?.array?.first?.string?.hasPrefix("Q-") == true {
				throw URLError(.notConnectedToInternet)
			}
			return try await real.send(request)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await real.lines(request)
		}
	}

	private func decide(_ key: String, question ref: String, answer: String) async throws -> CaseStamp? {
		let owner = try await Live.signedIn(as: Live.owner)
		let project = try await owner.project(key)
		let question = try #require(try await project.question(ref))
		let reply: [JSONValue] = try await owner.write("decide", in: key, [
			"q": .string(ref), "onEvidence": .string(question.evidenceHash),
			"answer": ["is": .string(answer)], "reason": "Reviewed this case",
		])
		#expect(reply.first?["status"]?.string == "decided")
		guard let saved = reply.first?["effects"]?["cases"]?.array?.first,
			let ref = saved["ref"]?.string, let version = saved["version"]?.number else { return nil }
		return CaseStamp(ref: ref, version: Int(version))
	}

	@Test("refresh follows an accepted create and a later edit versions the same case")
	func accepted() async throws {
		let key = try await Live.project(strict: true)
		let client = try await Live.signedIn().project(key)
		let screen = SuiteScreen(project: client)
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = "Continue the accepted case"
		editor.content.pre = "Keep my submitted precondition"
		guard case .waiting(let question, _) = await editor.save(), let question else {
			Issue.record("strict create did not wait"); return
		}
		#expect(editor.locked && editor.isRetrying && !editor.settled)
		let stamp = try #require(try await decide(key, question: question, answer: "accept"))
		await screen.refresh()
		#expect(screen.editor === editor && !editor.locked)
		guard case .edit(let followed) = editor.source else { Issue.record("editor did not follow the accepted case"); return }
		#expect(followed.ref == stamp.ref && followed.version == 1)
		#expect(editor.content.title == "Continue the accepted case" && editor.content.pre == "Keep my submitted precondition")
		editor.content.title = "Continue with version two"
		guard case .waiting(let next, _) = await editor.save(), let next else {
			Issue.record("strict edit did not wait"); return
		}
		let edited = try #require(try await decide(key, question: next, answer: "accept"))
		#expect(edited == CaseStamp(ref: stamp.ref, version: 2))
		await screen.refresh()
		#expect(try await client.caseHistory(stamp.ref).map(\.version) == [2, 1])
		#expect(try await client.cases(text: "Continue").items.map(\.ref) == [stamp.ref])
		#expect(try await client.cases().items.count == 2)
	}

	@Test("a rejected proposal keeps the editable draft and its reason")
	func rejected() async throws {
		let key = try await Live.project(strict: true)
		let client = try await Live.signedIn().project(key)
		let screen = SuiteScreen(project: client)
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = "Keep the rejected draft"
		editor.reason = "Keep my reason"
		let typed = editor.content
		guard case .waiting(let question, _) = await editor.save(), let question else { Issue.record("did not wait"); return }
		_ = try await decide(key, question: question, answer: "reject")
		await screen.refresh()
		#expect(screen.editor === editor && editor.content == typed && editor.reason == "Keep my reason")
		#expect(!editor.locked && !editor.settled && editor.maySave)
		#expect(editor.notice == "The proposal was rejected. Your draft is kept here.")
		#expect(try await client.cases(text: typed.title).items.isEmpty)
	}

	@Test("a failed question read keeps waiting and Retry follows without another create")
	func failedRead() async throws {
		let key = try await Live.project(strict: true)
		let transport = Reads()
		let client = try await Live.signedIn(transport: transport).project(key)
		let screen = SuiteScreen(project: client)
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = "Follow after reconnection"
		guard case .waiting(let question, _) = await editor.save(), let question else { Issue.record("did not wait"); return }
		await screen.saveEditor()
		#expect(editor.isWaiting && editor.locked && !editor.settled)
		#expect(await transport.proposals == 1)
		let stamp = try #require(try await decide(key, question: question, answer: "accept"))
		await transport.fail(true)
		await screen.refresh()
		#expect(editor.locked && editor.isRetrying && editor.maySave && !editor.settled)
		#expect(editor.content.title == "Follow after reconnection")
		#expect(editor.notice?.contains("Still waiting to read the proposal's outcome.") == true)
		await transport.fail(false)
		await screen.saveEditor()
		guard case .edit(let followed) = editor.source else { Issue.record("Retry did not follow"); return }
		#expect(followed.ref == stamp.ref && followed.version == 1 && !editor.locked)
		#expect(await transport.proposals == 1)
		#expect(screen.editor === editor)
	}
}
