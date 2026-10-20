import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The map answer screen", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct MappingScreenTests {
	func setup() async throws -> (Server, ProjectClient, QueueScreen, Question) {
		let server = try await Live.signedIn()
		let project = try await server.project(try await Live.project())
		let queue = QueueScreen(project: project)
		await queue.refresh()
		return (server, project, queue, try #require(queue.questions.first { $0.kind == .map }))
	}

	@Test("an offline mapping needs a connection and is explicitly outside Unsent answers")
	func offlineMapping() async throws {
		let transport = SwitchableQueueTransport()
		let server = Server(instance: Live.instance, secrets: MemoryStore(), transport: transport)
		_ = try await server.signIn(.password(name: Live.name, password: Live.password))
		let project = try await server.project(try await Live.project())
		let queue = QueueScreen(project: project)
		await queue.refresh()
		let question = try #require(queue.questions.first { $0.kind == .map })
		let draft = queue.mapping(question, creating: true)
		draft.reason = "Keep this mapping"
		transport.offline.withLock { $0 = true }
		#expect(await draft.submit() == false)
		#expect(draft.notice?.contains("Linking tests and creating cases need a connection. This answer is not saved in Unsent answers.") == true)
		#expect(draft.isRetrying && draft.locked && queue.outbox.pendingCount == 0)
		transport.offline.withLock { $0 = false }
		#expect(await draft.submit())
		let payloads = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(payloads.count == 3 && Set(payloads).count == 1)
		#expect(payloads.first?["ifOpen"] == true)
		#expect(draft.actual?.decision?.reason == "Keep this mapping")
		#expect(try await project.cases(text: "Shipping accepts an address").items.count == 1)
	}

	@Test("a refused mapping reply gives the server reason without blaming the connection")
	func refusedReply() async throws {
		let transport = SwitchableQueueTransport()
		let server = Server(instance: Live.instance, secrets: MemoryStore(), transport: transport)
		_ = try await server.signIn(.password(name: Live.name, password: Live.password))
		let queue = QueueScreen(project: try await server.project(try await Live.project()))
		await queue.refresh()
		let question = try #require(queue.questions.first { $0.kind == .map })
		let draft = queue.mapping(question, creating: true)
		draft.reason = "Keep my choices"
		transport.serverProblem.withLock { $0 = ("forbidden", "decide needs decide on this project") }
		#expect(await draft.submit() == false)
		#expect(draft.notice == "Decide needs decide on this project. Your choices are kept here.")
		#expect(!draft.isRetrying && !draft.locked && draft.reason == "Keep my choices")
		#expect(queue.outbox.pendingCount == 0)
	}

	@Test("rebuilding a sheet keeps its confirmed answer and notice")
	func confirmedDraft() async throws {
		let (_, _, queue, question) = try await setup()
		let draft = queue.mapping(question, creating: true)
		#expect(await draft.submit())
		let shownAgain = queue.mapping(question, creating: true)
		#expect(shownAgain === draft && shownAgain.settled)
		#expect(shownAgain.notice == "Recorded: one new case per shown test, linked to that test.")
	}

	@Test("the recorded answer stays current until another answer replaces it", arguments: [false, true])
	func recordedAnswerIsCurrent(creating: Bool) async throws {
		let (server, project, queue, question) = try await setup()
		await queue.open(question.ref)
		let draft = queue.mapping(question, creating: creating)
		if !creating {
			await draft.findCases()
			draft.choose(try #require(draft.cases.first), for: try #require(draft.tests.first))
		}
		#expect(draft.isCurrent(question))
		#expect(await draft.submit())
		let recorded = try #require(draft.actual)
		#expect(draft.isCurrent(recorded))
		await queue.refresh()
		#expect(draft.isCurrent(try #require(queue.current(question.ref))))
		// A separate API client deliberately replaces the decision, which the phone queue cannot do.
		let replacement: [JSONValue] = try await server.write("decide", in: project.key, [
			"q": .string(recorded.ref), "onEvidence": .string(recorded.evidenceHash), "answer": ["is": "track"],
		])
		#expect(replacement.first?["status"]?.string == "decided")
		let replaced = try #require(try await project.question(question.ref))
		#expect(replaced.decision?.label == "Track without a case")
		#expect(!draft.isCurrent(replaced))
	}

	@Test("search selects an existing case, keeps it after closing, and records the reviewed pair")
	func link() async throws {
		let (server, project, queue, question) = try await setup()
		let draft = queue.mapping(question, creating: false)
		#expect(!draft.maySubmit)
		draft.search = "password"
		await draft.findCases()
		#expect(draft.cases.map(\.title) == ["Password reset restores access"])
		let test = try #require(draft.tests.first)
		let selected = try #require(draft.cases.first)
		draft.choose(selected, for: test)
		draft.reason = "Same behavior"
		#expect(queue.mapping(question, creating: false) === draft)
		draft.search = "coupon"
		await draft.findCases()
		#expect(!draft.cases.contains(selected) && draft.selections[test.ref] == selected)
		#expect(draft.maySubmit)
		#expect(await draft.submit())
		#expect(draft.settled && draft.actual?.decision?.label == "Link to a case")
		let result: [JSONValue] = try await server.read("get", in: project.key, ["refs": [.string(test.ref)]])
		#expect(result.first?["case"]?.string == selected.ref)
		#expect(!draft.maySubmit)
		_ = try await project.withdraw(try #require(draft.actual))
		await queue.refresh()
		let reopened = try #require(queue.current(question.ref))
		queue.beginMapping(reopened, creating: false)
		#expect(queue.mapping(reopened, creating: false) === draft)
		#expect(!draft.settled && draft.maySubmit && draft.selections[test.ref] == selected)
	}

	@Test("another answer preserves the draft and shows the answer that actually stands")
	func competingAnswer() async throws {
		let (_, project, queue, question) = try await setup()
		let draft = queue.mapping(question, creating: false)
		await draft.findCases()
		let test = try #require(draft.tests.first)
		let selected = try #require(draft.cases.first)
		draft.choose(selected, for: test)
		draft.reason = "Keep my choice"
		_ = try await project.answer(question, with: try #require(question.choices.first { $0.answer == "track" }))
		#expect(await draft.submit() == false)
		#expect(draft.actual?.decision?.label == "Track without a case")
		#expect(!draft.isCurrent(try #require(draft.actual)))
		#expect(draft.selections[test.ref] == selected && draft.reason == "Keep my choice")
		#expect(draft.notice?.contains("the question is no longer open") == true)
		#expect(!draft.maySubmit)
	}

	@Test("changed evidence preserves choices and requires reviewing the new tests")
	func changedEvidence() async throws {
		let (server, project, queue, question) = try await setup()
		let draft = queue.mapping(question, creating: true)
		draft.reason = "Keep this reason"
		let _: JSONValue = try await server.write("report", in: project.key, [
			"target": ["commit": "new-map-evidence"], "results": [[
				"test": ["key": "shipping-new", "name": "A second shipping test", "file": "tests/shipping.spec.ts"], "outcome": "pass",
			]],
		])
		#expect(await draft.submit() == false)
		#expect(draft.notice?.contains("evidence changed") == true)
		#expect(draft.reason == "Keep this reason" && draft.tests.count == 1)
		#expect(!draft.maySubmit)
		let latest = try #require(draft.actual)
		#expect(latest.evidenceHash != question.evidenceHash)
		#expect(!draft.isCurrent(latest))
		draft.review(latest)
		#expect(draft.tests.count == 2 && draft.reason == "Keep this reason")
		#expect(await draft.submit())
		#expect(draft.settled)
	}

	@Test("a policy refusal keeps the reason and the reviewed tests")
	func policyRefusal() async throws {
		let (_, project, queue, question) = try await setup()
		let draft = queue.mapping(question, creating: true)
		draft.reason = "Keep this work"
		let owner = Live.server()
		_ = try await owner.signIn(Live.owner)
		let owned = try await owner.project(project.key)
		let proposed: JSONValue = try await owner.write("propose", in: project.key, [
			"edits": [["op": "policy", "preset": "strict", "unlinked": "ask"]],
		])
		let ref = try #require(proposed["question"]?.string)
		let policy = try #require(try await owned.question(ref))
		let adopted: [JSONValue] = try await owner.write("decide", in: project.key, [
			"q": .string(policy.ref), "onEvidence": .string(policy.evidenceHash), "answer": ["is": "accept"],
		])
		#expect(adopted.first?["status"]?.string == "decided")
		#expect(await draft.submit() == false)
		#expect(draft.notice?.contains("cannot be created and linked in one answer") == true)
		#expect(draft.notice?.contains("need a connection") == false)
		#expect(draft.notice?.contains("not saved in Unsent answers") == false)
		#expect(!draft.locked && draft.reason == "Keep this work" && draft.tests.count == 1)
	}

	@Test("a map whose tests are only partly shown cannot create cases")
	func incompleteTests() async throws {
		let (server, project, queue, _) = try await setup()
		let results: [JSONValue] = (0..<51).map { index in
			["test": ["key": .string("shipping-\(index)"), "name": .string("Shipping \(index)"), "file": "tests/shipping.spec.ts"], "outcome": "pass"]
		}
		let _: JSONValue = try await server.write("report", in: project.key, [
			"target": ["commit": "many-map-tests"], "results": .array(results),
		])
		await queue.refresh()
		let question = try #require(queue.questions.first { $0.kind == .map })
		let draft = queue.mapping(question, creating: true)
		#expect(draft.tests.count == 50 && !draft.maySubmit)
		#expect(await draft.submit() == false)
		#expect(try await project.cases(text: "Shipping 50").items.isEmpty)
	}

	/// Real operations run, then the first two replies to decide are lost.
	actor LoseReplies: Transport {
		let live = URLSessionTransport()
		var bodies: [Data] = []
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let reply = try await live.send(request)
			if request.url?.lastPathComponent == "decide" {
				bodies.append(request.httpBody ?? Data())
				if bodies.count <= 2 { throw URLError(.networkConnectionLost) }
			}
			return reply
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await live.lines(request)
		}
	}

	@Test("a lost creation reply locks the draft and retries the exact command without a second case")
	func uncertainReply() async throws {
		let transport = LoseReplies()
		let server = Server(instance: Live.instance, secrets: MemoryStore(), transport: transport)
		_ = try await server.signIn(.password(name: Live.name, password: Live.password))
		let project = try await server.project(try await Live.project())
		let queue = QueueScreen(project: project)
		await queue.refresh()
		let question = try #require(queue.questions.first { $0.kind == .map })
		let draft = queue.mapping(question, creating: true)
		draft.reason = "Once only"
		#expect(await draft.submit() == false)
		#expect(draft.isRetrying && draft.locked && draft.maySubmit)
		#expect(queue.mapping(question, creating: true) === draft)
		#expect(await draft.submit())
		let bodies = await transport.bodies
		let payloads = try bodies.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
		#expect(payloads.count == 3 && Set(payloads).count == 1)
		#expect(draft.reason == "Once only" && draft.settled)
		#expect(try await project.cases(text: "Shipping accepts an address").items.count == 1)
	}
}
