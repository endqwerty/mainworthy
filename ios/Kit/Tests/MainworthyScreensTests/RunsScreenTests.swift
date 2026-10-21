import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The Runs screen", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct RunsScreenTests {
	func screen(can: [String] = ["read", "produce", "plan"]) async throws -> RunsScreen {
		let key = try await Live.project()
		let client = try await Live.signedIn().project(key)
		let screen = RunsScreen(
			project: client,
			permission: Project(key: key, identity: client.identity, name: key, can: can), person: Live.name)
		await screen.refresh()
		return screen
	}

	@Test("recording advances, marks a failed step, and Undo corrects it before recording blocked")
	func execute() async throws {
		let screen = try await screen()
		#expect(screen.loading == .done && screen.runs.filter { $0.isPlanned }.count == 1)
		let run = screen.open(try #require(screen.runs.first { $0.isPlanned }))
		await run.refresh()
		let first = try #require(run.firstUnfilled)
		await run.execute(first)
		guard case .read(let execution) = run.document else {
			Issue.record("pinned case not read")
			return
		}
		#expect(await run.record(execution, outcome: .pass))
		guard case .read(let second) = run.document else {
			Issue.record("did not advance")
			return
		}
		#expect(second.slot.id != first.id)
		let step = try #require(second.content.steps.first)
		run.mark(step)
		#expect(run.failedStep == step.id)
		run.mark(step)
		#expect(run.failedStep == nil)
		run.mark(step)
		run.note = "The category vanished"
		#expect(await run.record(second, outcome: .fail))
		#expect(run.document == .none && run.canUndo)
		#expect(
			run.slots.first { $0.id == second.slot.id }?.ownFill(by: Live.name)?.note == "The category vanished")
		await run.undo()
		#expect(!run.canUndo)
		#expect(run.notice == "The result is corrected to skipped. A skipped slot counts as no proof.")
		guard case .read(let restored) = run.document else {
			Issue.record("Undo did not open the slot")
			return
		}
		#expect(restored.slot.id == second.slot.id)
		#expect(await run.record(restored, outcome: .blocked))
		await screen.refresh()
		#expect(run.slots.first { $0.id == second.slot.id }?.ownFill(by: Live.name)?.outcome == .manual(.blocked))
		#expect(run.slots.first { $0.id == first.id }?.ownFill(by: Live.name)?.outcome == .manual(.pass))
	}

	@Test("a result moves on to the next case even while the list is being read again for it")
	func advancesWhileRefreshing() async throws {
		let screen = try await screen()
		let run = screen.open(try #require(screen.runs.first))
		await run.refresh()
		let first = try #require(run.firstUnfilled)
		await run.execute(first)
		guard case .read(let execution) = run.document else {
			Issue.record("pinned case not read")
			return
		}
		// The change stream tells of the report as soon as it is recorded, and the workspace reads every
		// screen again. Here that happens over and over while the result is recorded.
		let refreshing = Task { @MainActor in
			while !Task.isCancelled { await run.refresh() }
		}
		let recorded = await run.record(execution, outcome: .pass)
		refreshing.cancel()
		await refreshing.value
		#expect(recorded)
		guard case .read(let next) = run.document else {
			Issue.record("the page stayed on the case that was just recorded: \(run.document)")
			return
		}
		#expect(next.slot.id != first.id && next.slot.fills.isEmpty)
	}

	@Test("Undo restores a person's prior result, and a report from another screen appears on refresh")
	func correctionAndRefresh() async throws {
		let screen = try await screen()
		let run = screen.open(try #require(screen.runs.first))
		await run.refresh()
		let slot = try #require(run.firstUnfilled)
		await run.execute(slot)
		guard case .read(let first) = run.document else {
			Issue.record("case not read")
			return
		}
		#expect(await run.record(first, outcome: .skip))
		await run.execute(try #require(run.slots.first { $0.id == slot.id }))
		guard case .read(let again) = run.document else {
			Issue.record("case not read again")
			return
		}
		#expect(await run.record(again, outcome: .blocked))
		await run.undo()
		#expect(run.slots.first { $0.id == slot.id }?.ownFill(by: Live.name)?.outcome == .manual(.skip))
		#expect(run.notice == "The earlier outcome is restored by a correction.")
		let other = try await Live.signedIn().project(screen.permission.key)
		let external = try #require(run.firstUnfilled)
		let externallyShown = try await other.execution(of: external, in: run.run.ref)
		_ = try await other.report(try await other.prepareReport(externallyShown, outcome: .skip))
		#expect(run.slots.first { $0.id == external.id }?.fills.isEmpty == true)
		await screen.refresh()
		#expect(run.slots.first { $0.id == external.id }?.ownFill(by: Live.name)?.outcome == .manual(.skip))
		#expect(screen.open(screen.runs[0]) === run)
	}

	@Test("Undo restores the latest fill, even when the slot refreshed behind a typed note")
	func undoUsesLatestSlot() async throws {
		let screen = try await screen()
		let run = screen.open(try #require(screen.runs.first))
		await run.refresh()
		await run.execute(try #require(run.firstUnfilled))
		guard case .read(let shown) = run.document else {
			Issue.record("case not read")
			return
		}
		let other = try await Live.signedIn().project(screen.permission.key)
		_ = try await other.report(try await other.prepareReport(shown, outcome: .skip, note: "From another device"))
		await run.refresh()
		run.note = "My own observation"
		#expect(await run.record(shown, outcome: .blocked))
		await run.undo()
		#expect(run.notice == "The earlier outcome is restored by a correction.")
		#expect(run.slots.first { $0.id == shown.slot.id }?.ownFill(by: Live.name)?.note == "From another device")
	}

	@Test("without produce slots are read-only, and without plan a plan is not sent")
	func permissions() async throws {
		let screen = try await screen(can: ["read", "record"])
		let run = screen.open(try #require(screen.runs.first))
		await run.refresh()
		await run.execute(try #require(run.firstUnfilled))
		guard case .read(let execution) = run.document else {
			Issue.record("case not read")
			return
		}
		#expect(run.isReadOnly && !run.mayRecord(execution))
		#expect(await run.record(execution, outcome: .pass) == false)
		#expect(await screen.plan(name: "Forbidden", selection: .all) == nil)
		#expect(run.firstUnfilled?.id == execution.slot.id)
		let external = try #require(run.slots.first { !$0.fills.isEmpty })
		await run.execute(external)
		guard case .read(let filled) = run.document else { throw ClientError.unreadable }
		#expect(run.latestSlot(filled).fills == external.fills)
		#expect(run.isReadOnly && !run.mayRecord(filled))
		#expect(await run.record(filled, outcome: .pass) == false)
	}

	@Test("a closed run stays readable and rejects recording until its sign-off is withdrawn")
	func closed() async throws {
		let key = try await Live.project(strict: true)
		let client = try await Live.signedIn().project(key)
		// The run's one slot is the owner's result, so the owner's screen may record on it while the run is open.
		let screen = RunsScreen(
			project: try await Live.signedIn(as: Live.owner).project(key),
			permission: Project(key: key, identity: client.identity, name: key, can: ["read", "produce"]), person: Live.ownerName)
		await screen.refresh()
		let run = screen.open(try #require(screen.runs.first))
		await run.refresh()
		let signoff = try #require(try await client.questions(open: true, kind: .signoff).questions.first)
		_ = try await client.answer(
			signoff, with: try #require(signoff.choices.first { $0.answer == "approve" }), reason: "Checked")
		await screen.refresh()
		#expect(run.run.state == .closed)
		await run.execute(try #require(run.slots.first))
		guard case .read(let execution) = run.document else {
			Issue.record("closed case not read")
			return
		}
		#expect(!run.mayRecord(execution))
		#expect(await run.record(execution, outcome: .blocked) == false)
		_ = try await client.withdraw(signoff, reason: "Check again")
		await screen.refresh()
		#expect(run.run.state == .open && run.mayRecord(execution))
	}

	@Test("change runs are listed beside the planned run, a filter keeps one kind or state, and a change run reads its results")
	func kinds() async throws {
		let screen = try await screen()
		#expect(screen.runs.contains { !$0.isPlanned })
		await screen.show(RunFilter(kind: .change))
		#expect(!screen.runs.isEmpty && screen.runs.allSatisfy { !$0.isPlanned })
		let change = try #require(screen.runs.first)
		guard case .change(let header?) = change.kind else {
			Issue.record("\(change.ref) names no change")
			return
		}
		#expect(change.name.hasSuffix("on \(header.key)"))
		let results = screen.results(of: change)
		#expect(results === screen.results(of: change))
		await results.load()
		#expect(results.loading == .done && results.total > 0 && results.run == change.ref)
		await screen.show(RunFilter(kind: .planned, state: .closed))
		#expect(screen.loading == .done && screen.runs.isEmpty)
		await screen.show(RunFilter(kind: .planned))
		#expect(screen.runs.map(\.name) == ["Checkout regression"])
	}

	@Test("planning shows the slot count and opens the new run, while an empty selection keeps its sentence")
	func plans() async throws {
		let screen = try await screen()
		await screen.readFolders()
		#expect(screen.folders.contains("Checkout"))
		let planned = try #require(await screen.plan(name: "Regression on phone", selection: .tag("regression")))
		#expect(screen.notice == "\(planned.ref) planned with 3 slots; 0 already filled.")
		#expect(screen.runs.first?.ref == planned.ref)
		#expect(screen.savedPlan == nil && screen.planSubmission == nil)
		#expect(await screen.plan(name: "Nobody", selection: .text("nonexistent selection")) == nil)
		#expect(screen.plannerNotice?.lowercased().contains("no active case") == true)
	}
}

/// Pages with one run each, with the first read optionally held until a newer one has completed.
actor RunPages: Transport {
	private let gate = AsyncStream.makeStream(of: Void.self)
	private let asked = AsyncStream.makeStream(of: Void.self)
	private var holdFirst: Bool
	private var failing = false
	private var calls = 0
	init(holdFirst: Bool = false) { self.holdFirst = holdFirst }
	func wasAsked() async { for await _ in asked.stream { return } }
	func release() { gate.continuation.yield() }
	func failReads() { failing = true }
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		if failing {
			let body = #"{"ok":false,"error":{"code":"invalid","message":"Runs could not be read."}}"#
			return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!)
		}
		calls += 1
		let old = calls == 1 && holdFirst
		if old {
			asked.continuation.yield()
			for await _ in gate.stream { break }
		}
		let input = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
		let second = input.contains(#""cursor":"next""#)
		let ref = old ? "R-0" : second ? "R-1" : "R-2"
		let cursor = second ? "null" : #""next""#
		let row =
			#"{"ref":"\#(ref)","name":"Run","origin":"planned","inProgress":0,"workUntil":null,"state":"open","verdict":"pending","reason":"missing","createdAt":1800000000000,"tally":{"missing":1},"accepts":{"self":true}}"#
		let body = #"{"ok":true,"result":{"items":[\#(row)],"cursor":\#(cursor)}}"#
		return (
			Data(body.utf8),
			HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
		)
	}
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}

@Suite("Runs when reads overlap")
@MainActor
struct RunsReadTests {
	enum FailedRead: CaseIterable { case refresh, more }

	func screen(_ transport: RunPages) throws -> RunsScreen {
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(),
			transport: transport)
		return RunsScreen(
			project: server.project("shop", identity: "shop-identity"), permission: Project(key: "shop", identity: "shop-identity", name: "Shop"), person: "robin")
	}

	private func failedRead(_ read: FailedRead) async throws -> RunsScreen {
		let transport = RunPages()
		let screen = try screen(transport)
		await screen.refresh()
		#expect(screen.runs.map(\.ref) == ["R-2"] && screen.hasMore)
		await transport.failReads()
		switch read {
		case .refresh: await screen.refresh()
		case .more: await screen.more()
		}
		#expect(screen.notice == "Runs could not be read.")
		return screen
	}

	@Test("preparing and dismissing a planner keeps the list's read error", arguments: FailedRead.allCases)
	func listNoticeSurvivesPlanner(_ read: FailedRead) async throws {
		let screen = try await failedRead(read)
		screen.preparePlanner()
		// Cancel only dismisses the sheet; opening it again still must not erase the list's error.
		screen.preparePlanner()
		#expect(screen.notice == "Runs could not be read.")
		#expect(screen.runs.map(\.ref) == ["R-2"])
	}

	@Test("a list read error is not a planner notice", arguments: FailedRead.allCases)
	func listFailureIsNotPlannerNotice(_ read: FailedRead) async throws {
		let screen = try await failedRead(read)
		#expect(screen.plannerNotice == nil)
		#expect(screen.notice == "Runs could not be read.")
	}

	@Test("the planner's folders that cannot be read are the planner's notice, not the list's")
	func folderFailureIsPlannerNotice() async throws {
		let transport = RunPages()
		let screen = try screen(transport)
		await screen.refresh()
		screen.preparePlanner()
		await transport.failReads()
		await screen.readFolders()
		#expect(screen.plannerNotice == "Runs could not be read.")
		#expect(screen.notice == nil)
		#expect(screen.runs.map(\.ref) == ["R-2"])
	}

	@Test("refresh rereads as many pages as the list already showed")
	func pagination() async throws {
		let screen = try screen(RunPages())
		await screen.refresh()
		#expect(screen.runs.map(\.ref) == ["R-2"] && screen.hasMore)
		await screen.more()
		#expect(screen.runs.map(\.ref) == ["R-2", "R-1"] && !screen.hasMore)
		await screen.refresh()
		#expect(screen.runs.map(\.ref) == ["R-2", "R-1"] && !screen.hasMore)
	}
	@Test("an older read cannot replace a newer list")
	func overtaken() async throws {
		let transport = RunPages(holdFirst: true)
		let screen = try screen(transport)
		let first = Task { await screen.refresh() }
		await transport.wasAsked()
		await screen.refresh()
		await transport.release()
		await first.value
		#expect(screen.runs.map(\.ref) == ["R-2"])
	}
}
