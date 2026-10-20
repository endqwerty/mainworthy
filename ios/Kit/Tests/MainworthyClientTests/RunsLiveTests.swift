import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("Runs against a real Mainworthy", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct RunsLiveTests {
	@Test("the demo decodes the model beside agent slot and test producers")
	func modelAttribution() async throws {
		var request = URLRequest(url: Live.instance.url.appending(path: "/test/project"))
		request.httpMethod = "POST"
		request.setValue("Bearer \(Live.token)", forHTTPHeaderField: "Authorization")
		request.httpBody = Data(#"{"kind":"demo"}"#.utf8)
		let (data, _) = try await URLSession.shared.data(for: request)
		struct Reply: Decodable {
			struct Made: Decodable { let project: String }
			let result: Made
		}
		let key = try JSONDecoder().decode(Reply.self, from: data).result.project
		let project = try await Live.signedIn(as: Live.owner).project(key)
		let run = try #require(try await project.runs().runs.first { $0.name == "Agent checkout check" })
		let slots = try await project.slots(of: run.ref)
		let fills = try #require(slots.first).fills
		#expect(fills.filter { $0.method == .agent }.map(\.model) == ["claude-opus-5-5", "claude-opus-5-5"])
		#expect(fills.first { $0.method == .person }?.model == nil)
		let agentTrail = try #require(fills.first { $0.method == .agent && $0.note != nil }?.steps)
		#expect(agentTrail.map(\.step) == ["a1", "b2", "c3"])
		#expect(agentTrail.map(\.durationMs) == [100, 700, 200])
		#expect(agentTrail.map(\.outcome) == [.pass, .pass, .pass])
		let detail = try #require(try await project.test("T-2"))
		#expect(detail.results.first?.by == "reviewer")
		#expect(detail.results.first?.model == "claude-opus-5-5")
	}

	@Test("a planned run reads its pinned cases and corrects a person's earlier result")
	func reports() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let run = try #require(try await project.runs().runs.first)
		#expect(run.name == "Checkout regression" && run.state == .open)
		let slots = try await project.slots(of: run.ref)
		#expect(slots.count == 6)
		#expect(slots.filter { $0.fills.isEmpty }.count == 2)
		#expect(slots.first?.fills.first?.method == .pipeline)
		let slot = try #require(slots.first { $0.fills.isEmpty })
		let execution = try await project.execution(of: slot, in: run.ref)
		#expect(execution.slot.version == 1 && !execution.content.steps.isEmpty)
		let saved = try await project.report(
			execution, outcome: .fail, note: "Shipping did not arrive", failedStep: execution.content.steps[0].id)
		guard case .recorded(let id) = saved else {
			Issue.record("the failure was refused")
			return
		}
		let timeline: JSONValue = try await project.server.read(
			"timeline", in: project.key, ["ref": .string(try #require(slot.caseRef))])
		let recorded = try #require(timeline["entries"]?.array?.first { $0["id"]?.number == Double(id) })
		#expect(recorded["atStep"]?.string == execution.content.steps[0].id)
		#expect(recorded["version"]?.number == Double(slot.version))
		let failed = try #require(try await project.slots(of: run.ref).first { $0.id == slot.id })
		#expect(failed.state == .failing)
		#expect(failed.ownFill(by: Live.name)?.note == "Shipping did not arrive")
		let corrected = try await project.report(
			execution, outcome: .blocked, note: "Carrier unavailable", corrects: id)
		guard case .recorded = corrected else {
			Issue.record("the correction was refused")
			return
		}
		let blocked = try #require(try await project.slots(of: run.ref).first { $0.id == slot.id })
		#expect(blocked.ownFill(by: Live.name)?.outcome == .manual(.blocked))
		#expect(blocked.fills.filter { $0.by == Live.name }.count == 1)
	}

	@Test("planning selects all cases, a folder, a tag, or text, and accepts a commit")
	func planning() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		#expect(try await project.runFolders().contains("Checkout/Coupons"))
		let selections: [(RunSelection, Int)] = [
			(.all, 6), (.folder("Checkout"), 3), (.tag("#regression"), 3), (.text("coupon"), 2)
		]
		for (selection, count) in selections {
			let preview = try await project.countRunCases(selection)
			#expect(preview == count)
			let outcome = try await project.planRun(RunPlanSubmission(name: "Phone check", selection: selection))
			guard case .planned(let ref, let slots, _) = outcome else {
				Issue.record("the plan was refused")
				continue
			}
			#expect(slots == count)
			#expect(try await project.slots(of: ref).count == count)
		}
		let commit = "3333333333333333333333333333333333333333"
		guard
			case .planned(let ref, _, let already) = try await project.planRun(
				RunPlanSubmission(name: "Build check", selection: .all, commit: commit))
		else {
			Issue.record("commit plan was refused")
			return
		}
		#expect(already == 3)
		#expect(try await project.run(ref).accepts == .commit(commit, repo: nil, environment: nil))
		#expect(
			try await project.planRun(RunPlanSubmission(name: "Empty", selection: .tag("absent")))
				== .refused("The selection matches no active case"))
	}

	@Test("a missing pipeline job is not shown as a case left to execute")
	func missingJob() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let planned: Wire.RunPlanReply = try await project.server.write(
			"plan", in: project.key,
			[
				"name": "Pipeline check", "select": ["tags": ["regression"]],
				"accepts": ["commit": "3333333333333333333333333333333333333333"],
				"require": [
					[
						"id": "exercise", "kind": "exercise", "methods": ["human", "auto"],
						"minActors": 1, "basis": "exact-or-assumed"
					],
					["id": "build", "kind": "jobs", "jobs": ["not-reported"]]
				]
			])
		let run = try await project.run(planned.run)
		#expect(run.tally["missing"] == 1)
		#expect(run.left == 0)
	}

	@Test("a pinned case stays at the old version after an edit is accepted")
	func pinnedVersion() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let run = try #require(try await project.runs().runs.first)
		let before = try await project.slots(of: run.ref)
		let adopt = try #require(try await project.questions(open: true, kind: .adopt).questions.first)
		_ = try await project.answer(adopt, with: try #require(adopt.choices.first { $0.answer == "accept" }))
		let slot = try #require(before.first { $0.title == "A percentage coupon lowers the total" })
		let execution = try await project.execution(of: slot, in: run.ref)
		#expect(execution.slot.version == 1 && execution.content.steps.count == 2)
		#expect(!execution.content.steps.contains { $0.action == "Remove the coupon" })
	}
}

@Suite("Run values")
struct RunsValueTests {
	@Test("new server words stay readable")
	func futureWords() {
		#expect(RunVerdict("paused").word == "paused")
		#expect(RunState("paused") == .other("paused"))
		#expect(SlotState("reviewing").word == "reviewing")
		#expect(FillMethod("device").name == "device")
		#expect(FilledOutcome("retry").word == "retry")
	}
}

@Suite("A report's refusal")
struct RunReceiptTests {
	struct Receipt: Transport {
		let result: String
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let body = Data("{\"ok\":true,\"result\":\(result)}".utf8)
			return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse)
		{
			throw URLError(.unsupportedURL)
		}
	}

	@Test(
		"a successful HTTP reply can refuse the result",
		arguments: [
			(#"{"rejected":[{"reason":"wrong producer"}],"declined":[],"results":[10]}"#, "wrong producer"),
			(
				#"{"rejected":[],"declined":[{"reason":"version not admitted"}],"results":[10]}"#,
				"version not admitted"
			),
			(#"{"rejected":[],"declined":[],"results":[]}"#, "The result was not recorded.")
		])
	func refused(receipt: String, sentence: String) async throws {
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(),
			transport: Receipt(result: receipt))
		let slot = RunSlot(
			try JSONDecoder().decode(
				Wire.RunSlot.self,
				from: Data(
					#"{"id":1,"case":"C-1","title":"Open","version":1,"state":"missing","work":{"kind":"free"},"fills":[]}"#.utf8)))
		let execution = RunExecution(run: "R-1", slot: slot, content: CaseContent(title: "Open"))
		#expect(try await server.project("shop", identity: "shop-identity").report(execution, outcome: .pass) == .refused(sentence))
	}

	@Test("a reply for a different version is never offered as the pinned case")
	func wrongVersion() async throws {
		let result =
			#"[{"ref":"C-1","version":2,"title":"Open","pre":"","steps":[],"methods":["human"],"automate":"none"}]"#
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(),
			transport: Receipt(result: result))
		let slot = RunSlot(
			try JSONDecoder().decode(
				Wire.RunSlot.self,
				from: Data(
					#"{"id":1,"case":"C-1","title":"Open","version":1,"state":"missing","work":{"kind":"free"},"fills":[]}"#.utf8)))
		await #expect(throws: ClientError.unreadable) {
			_ = try await server.project("shop", identity: "shop-identity").execution(of: slot, in: "R-1")
		}
	}
}

@Suite("Slot work") struct SlotWorkTests {
 @Test("a held slot disappears at the exact deadline")
 func deadline() throws {
  let wire = try JSONDecoder().decode(Wire.SlotWork.self, from: Data(#"{"kind":"held","actor":"reviewer","since":1800000000000,"until":1800000030000}"#.utf8))
  let work = SlotWork(wire)
  #expect(work.holder(at: Date(timeIntervalSince1970: 1800000029))?.actor == "reviewer")
  #expect(work.holder(at: Date(timeIntervalSince1970: 1800000030)) == nil)
 }
}
