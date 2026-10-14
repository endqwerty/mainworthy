import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("The suite client", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct SuiteLiveTests {
	@Test("folders, search, tags and pages are read from the server")
	func browsing() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let folders = try await client.folders()
		#expect(folders.first { $0.path == "Checkout/Coupons" }?.cases == 2)
		#expect(try await client.cases(folder: "Checkout").items.isEmpty)
		#expect(try await client.cases(folder: "Checkout/Coupons").items.count == 2)
		#expect(try await client.cases(text: "password").items.map(\.title) == ["Password reset restores access"])
		#expect(try await client.cases(tag: "regression").items.count == 3)
		#expect(try await client.tags().map(\.name).contains("checkout"))
		let first = try await client.cases(limit: 2)
		let cursor = try #require(first.next)
		let second = try await client.cases(after: cursor, limit: 2)
		#expect(Set(first.items.map(\.ref)).isDisjoint(with: second.items.map(\.ref)))
		#expect(first.items.count == 2 && second.items.count == 2)
		#expect(first.items.contains { !$0.proof.isEmpty })
	}

	@Test("create and edit keep methods, automation and unread fields, and history reads old content")
	func write() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let body = CaseContent(title: "A structured case", pre: "Signed in", steps: [
			Step(id: "a0", action: "Open", expected: nil), Step(id: "a1", action: "Apply", expected: "Accepted"),
		], methods: ["human", "agent"], automate: "wanted", fields: ["priority": "high"])
		let submission = SuiteSubmission(source: .create(folder: "Checkout/Coupons"), content: body, reason: "First")
		let created = try await client.saveCase(submission)
		guard case .adopted(let stamp) = created, let stamp else { Issue.record("create was not adopted"); return }
		// Repeating the exact command does not make another case.
		#expect(try await client.saveCase(submission) == created)
		let opened = try await client.caseDocument(stamp.ref)
		#expect(opened.folder == "Checkout/Coupons" && opened.version == 1)
		#expect(opened.content.steps.map(\.expected) == [nil, "Accepted"])
		var edit = opened.content
		edit.title = "An edited case"
		edit.steps.append(Step(id: "a2", action: "Reload", expected: "Kept"))
		#expect(try await client.saveCase(SuiteSubmission(source: .edit(opened), content: edit, reason: "More"))
			== .adopted(CaseStamp(ref: stamp.ref, version: 2)))
		let now = try await client.caseDocument(stamp.ref)
		#expect(now.content.methods == body.methods && now.content.automate == "wanted")
		let histories = try await client.caseHistory(stamp.ref)
		#expect(histories.map(\.version) == [2, 1])
		#expect(histories.map(\.reason) == ["More", "First"])
		#expect(try await client.caseDocument(stamp.ref, version: 1).content.title == body.title)
		// Get omits custom fields. A proposal's current body exposes them and proves the edit preserved them.
		var competing = body
		competing.title = "A competing title"
		let overlap = try await client.saveCase(SuiteSubmission(source: .edit(opened), content: competing, reason: "Old"))
		guard case .overlap(let question, let paths, _) = overlap else { Issue.record("old base did not overlap"); return }
		#expect(question != nil && paths.contains("title"))
		let inbox = try await client.questions(open: true, kind: .adopt)
		let conflict = try #require(inbox.questions.first { $0.ref == question })
		guard case .proposal(let proposed) = conflict.evidence else { Issue.record("no proposal evidence"); return }
		let documents = try await client.documents(of: proposed)
		#expect(documents.first?.before?.fields == ["priority": "high"])
	}

	@Test("strict policy keeps a new case as a proposal, and historical step ids remain taken")
	func waitingAndIds() async throws {
		let strict = try await Live.signedIn().project(try await Live.project(strict: true))
		let waiting = try await strict.saveCase(SuiteSubmission(source: .create(folder: nil),
			content: CaseContent(title: "Needs a person"), reason: "Review this"))
		guard case .waiting(let question, _) = waiting else { Issue.record("proposal did not wait"); return }
		#expect(question != nil)
		let client = try await Live.signedIn().project(try await Live.project())
		let ref = try #require(try await client.cases().items.first?.ref)
		let opened = try await client.caseDocument(ref)
		var edit = opened.content
		let removed = try #require(edit.steps.first?.id)
		edit.steps.removeFirst()
		_ = try await client.saveCase(SuiteSubmission(source: .edit(opened), content: edit, reason: "Remove"))
		let latest = try await client.caseDocument(ref)
		#expect(!latest.content.steps.contains { $0.id == removed })
		#expect(try await client.usedStepIds(of: latest).contains(removed))
	}
}

@Suite("Stable step ids")
struct StepIDTests {
	@Test("the web's namespace, wraparound, clamping and expansion")
	func namespace() throws {
		#expect(try newStepId(taken: [], random: { 0 }) == "a0")
		#expect(try newStepId(taken: ["a0", "a1"], random: { 0 }) == "a2")
		#expect(try newStepId(taken: [], random: { .nan }) == "a0")
		#expect(try newStepId(taken: [], random: { -1 }) == "a0")
		#expect(try newStepId(taken: [], random: { 1 }) == "zz")
		#expect(try newStepId(taken: ["zz"], random: { 1 }) == "a0")
		let full = Set("abcdefghijklmnopqrstuvwxyz".flatMap { first in
			(0..<36).map { "\(first)\(String($0, radix: 36))" }
		})
		var samples = [0.9, 0.0]
		#expect(try newStepId(taken: full, random: { samples.removeFirst() }) == "a00")
		#expect(samples.isEmpty)
		var known = full
		for _ in 0..<500 {
			let id = try newStepId(taken: known)
			#expect(id.range(of: "^[a-z][a-z0-9]{1,3}$", options: .regularExpression) != nil)
			#expect(known.insert(id).inserted)
		}
	}

	@Test("an unfamiliar proof outcome is shown")
	func futureProof() throws {
		let wire = try JSONDecoder().decode(Wire.SuiteProof.self, from: Data(#"{"outcome":"inconclusive","current":false}"#.utf8))
		let proof = CaseProof(method: "agent", wire: wire)
		#expect(proof.outcome == .other("inconclusive"))
		#expect(proof.sentence == "agent: inconclusive on an earlier version")
	}
}
