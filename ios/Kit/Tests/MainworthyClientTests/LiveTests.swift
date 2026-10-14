import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

/// A transport that says, as a proxy that ends TLS does, that the person came over https. The server then sets
/// and reads the cookie under its `__Host-` name, as it does on a deployed instance.
struct BehindTLS: Transport {
	let inner = URLSessionTransport()

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		var request = request
		request.setValue("https", forHTTPHeaderField: "X-Forwarded-Proto")
		return try await inner.send(request)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		var request = request
		request.setValue("https", forHTTPHeaderField: "X-Forwarded-Proto")
		return try await inner.lines(request)
	}
}

@Suite("Against a real Mainworthy", .enabled(if: Live.isRunning, "needs the server `bun scripts/ios.ts test` starts"))
struct LiveTests {
	@Test("a person signs in with a name and a password, is who they said, and signs out")
	func password() async throws {
		let secrets = MemoryStore()
		let server = Live.server(secrets: secrets)
		let account = try await server.signIn(.password(name: Live.name, password: Live.password))
		#expect(account.name == Live.name)
		#expect(secrets.load() != nil)
		// A second server made from what the device kept is signed in: this is the app's next start.
		let kept = try #require(Server.kept(in: secrets))
		#expect(try await kept.account().name == Live.name)
		await server.signOut()
		#expect(secrets.load() == nil)
		// The session ended on the server too: the copy of the cookie the other one holds is refused.
		await #expect(throws: ClientError.signedOut) { _ = try await kept.account() }
	}

	@Test("the owner signs in with a password, and the app keeps the session and not the password")
	func owner() async throws {
		let secrets = MemoryStore()
		let account = try await Live.server(secrets: secrets).signIn(Live.owner)
		#expect(account.isOwner)
		#expect(!String(decoding: secrets.load() ?? Data(), as: UTF8.self).contains(Live.ownerPassword))
	}

	@Test("the session works where the server sets its cookie under the https name")
	func behindTLS() async throws {
		let secrets = MemoryStore()
		let server = Server(instance: Live.instance, secrets: secrets, transport: BehindTLS())
		let account = try await server.signIn(.password(name: Live.name, password: Live.password))
		#expect(account.name == Live.name)
		#expect(String(decoding: secrets.load() ?? Data(), as: UTF8.self).contains("__Host-mainworthy_sid"))
		#expect(try await server.account().name == Live.name)
		await server.signOut()
	}

	@Test("a wrong password is refused with one sentence, and nothing is kept")
	func wrongPassword() async throws {
		let secrets = MemoryStore()
		await #expect(throws: ClientError.refused(code: "unauthenticated", message: "that did not sign you in")) {
			_ = try await Live.server(secrets: secrets).signIn(.password(name: Live.name, password: "not the password"))
		}
		#expect(secrets.load() == nil)
	}

	@Test("the queue holds one question of each kind, each with evidence the app can read")
	func queue() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let page = try await project.questions(open: true)
		#expect(page.counts.open == page.questions.count)
		#expect(page.counts.open(of: .failure) == 1)
		#expect(page.counts.phrase == "1 failure to explain · 3 can wait")
		let byKind = Dictionary(grouping: page.questions, by: \.kind)
		#expect(Set(byKind.keys) == [.failure, .map, .finding, .adopt])

		let failure = try #require(byKind[.failure]?.first)
		guard case .failure(let failed) = failure.evidence else {
			Issue.record("the failure's evidence was not read")
			return
		}
		#expect(failed.message == "expected $90.00, got $100.00")
		#expect(failed.comparison == .init(expected: "$90.00", observed: "$100.00"))
		#expect(failed.tests.map(\.name) == ["Shop check 1"])
		#expect(failed.branch == "coupon-total")
		#expect(failure.isUrgent && failure.producer == .pipeline)
		#expect(failure.stakes.hasSuffix("While this is open, no gate that counts the unexplained failure passes."))
		// The answers are the ones the server offers for this failure, each with the words of the queue.
		#expect(failure.choices.map(\.answer) == ["defect", "test", "expected", "flaky", "infra", "inherited"])
		#expect(failure.choices[3].label == "Flaky" && failure.choices[3].help.hasPrefix("Unreliable."))
		#expect(failure.choices[0].takes == .reference && failure.choices[3].takes == .nothing)

		guard case .unlinked(let unlinked) = try #require(byKind[.map]?.first).evidence else {
			Issue.record("the evidence of the test with no case was not read")
			return
		}
		#expect(unlinked.file == "tests/shipping.spec.ts" && unlinked.count == 1)
		// Linking a test to a case needs a case to be chosen, which this build does not do.
		#expect(byKind[.map]?.first?.choices.first { $0.answer == "link" }?.takes == .more)

		guard case .finding(let finding) = try #require(byKind[.finding]?.first).evidence else {
			Issue.record("the finding's evidence was not read")
			return
		}
		#expect(finding.category == "ambiguous" && finding.caseTitle == "Expired coupon is rejected")
		// The suggestion says which step it changes, and that is what the page shows.
		#expect(finding.suggestion == .step("s2", action: nil, expected: #"Show "Coupon expired" and keep the $100.00 total."#))

		let adopt = try #require(byKind[.adopt]?.first)
		guard case .proposal(let edit) = adopt.evidence else {
			Issue.record("the proposal's evidence was not read")
			return
		}
		#expect(edit.reason == "Check removing the coupon as well as adding it.")
		#expect(edit.summaries.count == 1 && edit.summaries[0].hasPrefix("Edit C-"))
		#expect(adopt.producer == .agent)
		let documents = try await project.documents(of: edit)
		#expect(documents.count == 1)
		let added = documents[0].changes.compactMap { change -> String? in
			if case .added(let step) = change { step.action } else { nil }
		}
		#expect(added == ["Remove the coupon"])
	}

	@Test("an answer settles a question, the decided list shows it, and withdrawing it asks again")
	func answerAndWithdraw() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let failure = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let flaky = try #require(failure.choices.first { $0.answer == "flaky" })
		#expect(try await project.answer(failure, with: flaky) == .decided)
		#expect(try await project.questions(open: true, kind: .failure).questions.isEmpty)
		let decided = try #require(try await project.questions(open: false).questions.first { $0.ref == failure.ref })
		#expect(decided.decision?.label == "Flaky" && decided.decision?.by == [Live.name])
		#expect(!decided.isOpen)
		#expect(try await project.withdraw(decided) == .withdrawn(nil))
		#expect(try await project.questions(open: true, kind: .failure).questions.map(\.ref) == [failure.ref])
	}

	@Test("a defect's reference is recorded with the decision")
	func reference() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let failure = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let defect = try #require(failure.choices.first { $0.answer == "defect" })
		#expect(try await project.answer(failure, with: defect, reference: "  SHOP-482 ") == .decided)
		let decided = try await project.questions(open: false).questions.first { $0.ref == failure.ref }
		#expect(decided?.decision?.reference == "SHOP-482")
	}

	@Test("an answer on evidence that has changed since is not recorded")
	func overtaken() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let read = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		// The question as it was read before its evidence changed: the same question, on an older hash.
		let stale = Question(
			ref: read.ref, kind: read.kind, title: read.title, producer: read.producer, isOpen: true,
			evidence: read.evidence, timesSeen: read.timesSeen, needs: read.needs, choices: read.choices,
			blocks: read.blocks, openedAt: read.openedAt, advice: read.advice, standing: read.standing, decision: nil,
			about: read.about, evidenceHash: "000000000000", facts: []
		)
		let flaky = try #require(read.choices.first { $0.answer == "flaky" })
		let outcome = try await project.answer(stale, with: flaky)
		#expect(
			outcome == .overtaken("the evidence changed; read the question again and answer on its current evidence"))
		#expect(try await project.questions(open: true, kind: .failure).questions.map(\.ref) == [read.ref])
	}

	@Test("where the policy asks for a reason, an answer without one is not taken, and one with it is")
	func reasonRequired() async throws {
		let project = try await Live.signedIn().project(try await Live.project(strict: true))
		let signoff = try #require(try await project.questions(open: true, kind: .signoff).questions.first)
		#expect(signoff.wantsReason)
		guard case .signoff(let run) = signoff.evidence else {
			Issue.record("the sign-off's evidence was not read")
			return
		}
		#expect(run.verdict == "passed" && run.name == "Release check")
		let approve = try #require(signoff.choices.first { $0.answer == "approve" })
		#expect(try await project.answer(signoff, with: approve) == .notTaken("a reason"))
		#expect(try await project.answer(signoff, with: approve, reason: "Checked on the release build.") == .decided)
		let decided = try #require(try await project.questions(open: false, kind: .signoff).questions.first)
		#expect(decided.decision?.reason == "Checked on the release build.")
		// Withdrawing is a decision too, and is held to the same clause.
		#expect(try await project.withdraw(decided) == .notTaken("a reason"))
		#expect(try await project.withdraw(decided, reason: "Closed too early.") == .withdrawn(nil))
	}

	@Test("the change stream says that it is open, and then hears every write that follows")
	func changes() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let finding = try #require(try await project.questions(open: true, kind: .finding).questions.first)
		let deferred = try #require(finding.choices.first { $0.answer == "defer" })
		var heard: [Change] = []
		// Nothing waits for time to pass: the write is sent the moment the stream says it is open, which is
		// when a screen reads what it shows. A write from then on is one the stream tells of.
		for try await change in project.changes() {
			heard.append(change)
			if change == .opened {
				#expect(try await project.answer(finding, with: deferred) == .decided)
			} else if change.operation == "decide" {
				break
			}
		}
		#expect(heard.first == .opened)
		#expect(heard.last?.touched.contains(finding.ref) == true)
	}

	@Test("a redirect is not followed, so the session cookie goes nowhere but where it came from")
	func redirect() async throws {
		let server = try await Live.signedIn()
		let kept = server.cookieHeader ?? ""
		#expect(kept.contains("mainworthy_sid="))
		// The tests' server answers this address with a redirect to another origin, which counts what reaches it.
		var request = URLRequest(url: Live.instance.url.appending(path: "/test/elsewhere"))
		request.setValue(kept, forHTTPHeaderField: "Cookie")
		let (_, response) = try await URLSessionTransport().send(request)
		#expect(response.statusCode == 307)
		struct Seen: Decodable {
			struct Count: Decodable { var requests: Int }
			var result: Count
		}
		var asking = URLRequest(url: Live.instance.url.appending(path: "/test/elsewhere-seen"))
		asking.setValue(kept, forHTTPHeaderField: "Cookie")
		let (data, _) = try await URLSessionTransport().send(asking)
		#expect(try JSONDecoder().decode(Seen.self, from: data).result.requests == 0)
	}

	@Test("one question is read by its ref, and a ref the project does not have is none")
	func oneQuestion() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let listed = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let alone = try #require(try await project.question(listed.ref))
		#expect(alone.ref == listed.ref && alone.evidence == listed.evidence && alone.isOpen)
		#expect(alone.choices == listed.choices)
		// Read alone, it still says what this person's answer is worth, as the list says it.
		#expect(alone.standing == listed.standing && alone.standing == .counts)
		// What was read alone is answered like what was read in the list.
		#expect(try await project.answer(alone, with: try #require(alone.choices.first { $0.answer == "infra" })) == .decided)
		#expect(try await project.question(listed.ref)?.isOpen == false)
	}
}
