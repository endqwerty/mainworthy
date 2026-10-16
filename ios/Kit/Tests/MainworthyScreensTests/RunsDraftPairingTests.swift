import Foundation
import TestSupport
import Testing
@testable import MainworthyClient
@testable import MainworthyScreens

actor ReviewFailPinnedRead: Transport {
    private let live = URLSessionTransport()
    private var failPinned = false
    func fail() { failPinned = true }
    func reconnect() { failPinned = false }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let input = try? JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
        if failPinned && request.url?.lastPathComponent == "get" && input?["version"] != nil {
            throw URLError(.cannotConnectToHost)
        }
        return try await live.send(request)
    }
    func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
        try await live.lines(request)
    }
}

@Suite("A slot and its draft stay paired", .enabled(if: Live.isRunning, "live server"))
@MainActor struct ReviewSecondRound {
    func setup() async throws -> (RunsScreen, OpenRunScreen, ProjectClient) {
        let key = try await Live.project()
        let client = try await Live.signedIn().project(key)
        let list = RunsScreen(project: client, permission: Project(key:key,name:key,can:["read","produce","plan"]),person:Live.name)
        await list.refresh()
        let run = list.open(try #require(list.runs.first)); await run.refresh()
        return (list,run,client)
    }
    @Test("when Undo cannot read the corrected case, the page shows that slot with its own draft and records nothing")
    func undoReadFailure() async throws {
        let key = try await Live.project()
        let transport = ReviewFailPinnedRead()
        let server = Server(instance:Live.instance,secrets:MemoryStore(),transport:transport)
        _ = try await server.signIn(.password(name:Live.name,password:Live.password))
        let client = server.project(key)
        let list = RunsScreen(project:client,permission:Project(key:key,name:key,can:["read","produce","plan"]),person:Live.name)
        await list.refresh()
        let run = list.open(try #require(list.runs.first)); await run.refresh()
        await run.execute(try #require(run.firstUnfilled))
        guard case .read(let a) = run.document else { Issue.record("no slot A"); return }
        #expect(await run.record(a,outcome:.pass))
        guard case .read(let b) = run.document else { Issue.record("no slot B"); return }
        run.note = "B observation for catalog"
        run.mark(try #require(b.content.steps.first))
        await run.execute(try #require(run.slots.first { $0.id == a.slot.id }))
        run.note = "A observation for shipping"
        await run.execute(try #require(run.slots.first { $0.id == b.slot.id }))
        guard case .read(let displayedB) = run.document else { Issue.record("no B after return"); return }
        #expect(run.note == "B observation for catalog")
        await transport.fail()
        await run.undo()
        // The page moves to the corrected slot A with A's draft, and says it could not read A's case: nothing is
        // recorded from it until it is read. B is no longer on the screen, so nothing can be recorded on B with
        // A's note.
        guard case .failed(let shown, _) = run.document else { Issue.record("not failed: \(run.document)"); return }
        #expect(shown.id == a.slot.id)
        #expect(run.note == "A observation for shipping")
        #expect(await run.record(displayedB, outcome: .fail) == false)
        await transport.reconnect()
        // Back on B, B's draft is B's, and recording it puts B's note on B.
        await run.execute(try #require(run.slots.first { $0.id == b.slot.id }))
        guard case .read(let backOnB) = run.document else { Issue.record("no B after reconnecting"); return }
        #expect(run.note == "B observation for catalog")
        #expect(await run.record(backOnB, outcome: .fail))
        let actual = try #require(run.slots.first { $0.id == b.slot.id }?.ownFill(by: Live.name))
        #expect(actual.note == "B observation for catalog")
        await run.execute(try #require(run.slots.first { $0.id == b.slot.id }))
        #expect(run.note.isEmpty)
        // A's draft is still A's.
        await run.execute(try #require(run.slots.first { $0.id == a.slot.id }))
        #expect(run.note == "A observation for shipping")
    }
    @Test("each recorded draft belongs to its slot and is cleared only there")
    func draftsSentToOwnSlot() async throws {
        let (list,run,_) = try await setup()
        let a = try #require(run.firstUnfilled)
        let b = try #require(run.slots.last)
        await run.execute(a); run.note = "A own draft"
        await run.execute(b); run.note = "B own draft"
        guard case .read(let shownB) = run.document else { Issue.record("no B"); return }
        run.mark(try #require(shownB.content.steps.first))
        #expect(await run.record(shownB,outcome:.fail))
        #expect(run.slots.first { $0.id == b.id }?.ownFill(by:Live.name)?.note == "B own draft")
        await run.execute(b); #expect(run.note.isEmpty && run.failedStep == nil)
        await run.execute(a); #expect(run.note == "A own draft" && run.failedStep == nil)
        guard case .read(let shownA) = run.document else { Issue.record("no A"); return }
        #expect(await run.record(shownA,outcome:.pass))
        #expect(run.slots.first { $0.id == a.id }?.ownFill(by:Live.name)?.note == "A own draft")
        await run.execute(a); #expect(run.note.isEmpty)
        let new = try #require(await list.plan(name:"Another run",selection:.all))
        let other = list.open(new); await other.refresh(); await other.execute(try #require(other.firstUnfilled))
        #expect(other.note.isEmpty && other.failedStep == nil)
        print("REVIEW drafts: correct slot on server, cleared after result, empty in another run")
    }
    @Test("a slot the pipeline filled is left to it: it records nothing and keeps the pipeline's fill")
    func otherProducersSlot() async throws {
        let (_,run,_) = try await setup()
        let slot = try #require(run.slots.first { $0.fills.contains { $0.method == .pipeline } })
        #expect(run.isLeftToOthers(slot))
        #expect(!run.isLeftToOthers(try #require(run.firstUnfilled)))
        await run.execute(slot)
        guard case .read(let shown) = run.document else { Issue.record("no pipeline slot"); return }
        #expect(!run.mayRecord(shown))
        run.mark(try #require(shown.content.steps.first))
        #expect(run.failedStep == nil)
        #expect(await run.record(shown,outcome:.pass) == false)
        await run.refresh()
        let after = try #require(run.slots.first { $0.id == slot.id })
        #expect(after.ownFill(by:Live.name) == nil && after.fills.map(\.method) == [.pipeline])
    }
    @Test("after the owner is renamed, refreshing the account keeps their own slots theirs")
    func renamedPersonKeepsOwnSlots() async throws {
        let key = try await Live.project()
        let server = try await Live.signedIn()
        let project = Project(key:key,name:key,can:["read","produce","plan"])
        let defaultsName = "renamed-person-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName:defaultsName))
        defer { defaults.removePersistentDomain(forName:defaultsName) }
        // The app still holds the name the person had when it opened the project; the server answers with the
        // name they have now, as it does after `MAINWORTHY_OWNER_WAS` renames the owner.
        let workspace = Workspace(server:server,account:Account(name:"former-name",projects:[project]),remembered:Remembered(defaults),onSignedOut:{})
        let list = try #require(workspace.runs); await list.refresh()
        let run = list.open(try #require(list.runs.first)); await run.refresh()
        let slot = try #require(run.firstUnfilled)
        await run.execute(slot)
        guard case .read(let shown) = run.document else { Issue.record("no slot"); return }
        _ = try await server.project(key).report(shown,outcome:.pass,note:"",failedStep:nil,corrects:nil)
        await run.refresh()
        #expect(run.isLeftToOthers(slot))
        await workspace.refreshAccount()
        #expect(workspace.account.name == Live.name)
        #expect(!run.isLeftToOthers(slot))
    }
    @Test("Undo of a Pass with an unused step mark corrects to skipped, and of a Fail restores the Pass without a step")
    func undoNonFailure() async throws {
        let (_,run,_) = try await setup()
        let slot = try #require(run.firstUnfilled)
        await run.execute(slot)
        guard case .read(let shown) = run.document else { Issue.record("no slot"); return }
        run.mark(try #require(shown.content.steps.first)); run.note = "Pass despite unused mark"
        #expect(await run.record(shown,outcome:.pass))
        await run.undo()
        #expect(run.slots.first { $0.id == slot.id }?.ownFill(by:Live.name)?.outcome == .manual(.skip))
        guard case .read(let again) = run.document else { Issue.record("no slot after Undo"); return }
        #expect(again.slot.id == slot.id)
        #expect(await run.record(again,outcome:.pass))
        await run.execute(try #require(run.slots.first { $0.id == slot.id }))
        guard case .read(let latest) = run.document else { Issue.record("no latest"); return }
        #expect(!run.isLeftToOthers(latest.slot))
        run.mark(try #require(latest.content.steps.first))
        #expect(await run.record(latest,outcome:.fail))
        await run.undo()
        let restored = try #require(run.slots.first { $0.id == slot.id }?.ownFill(by:Live.name))
        #expect(restored.outcome == .manual(.pass) && restored.atStep == nil)
    }
    @Test("changing a saved plan's inputs retries its read and project switching isolates it")
    func savedPlanChangedInputs() async throws {
        let a = try await Live.project(), b = try await Live.project()
        let transport = FailAfterPlanTransport()
        let server = Server(instance:Live.instance,secrets:MemoryStore(),transport:transport)
        let account = try await server.signIn(.password(name:Live.name,password:Live.password))
        let pa = Project(key:a,name:a,can:["read","produce","plan"])
        let pb = Project(key:b,name:b,can:["read","produce","plan"])
        let defaultsName = "review-saved-plan-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName:defaultsName))
        defer { defaults.removePersistentDomain(forName:defaultsName) }
        let workspace = Workspace(server:server,account:Account(name:account.name,projects:[pa,pb]),remembered:Remembered(defaults),onSignedOut:{})
        let old = try #require(workspace.runs)
        #expect(await old.plan(name:"Original saved plan",selection:.all) == nil)
        let saved = try #require(old.savedPlan)
        // A new sheet still receives this same screen. Its new text cannot cause another plan.
        await transport.reconnect()
        let reopened = try #require(await old.plan(name:"Changed unsent name",selection:.tag("absent"),commit:"abcdef0"))
        #expect(reopened.ref == saved.ref && reopened.name == "Original saved plan")
        #expect(old.savedPlan == nil)
        workspace.open(pb)
        let current = try #require(workspace.runs)
        #expect(current !== old && current.savedPlan == nil && current.notice == nil)
        let newPlan = await current.plan(name:"Project B saved plan",selection:.all)
        #expect(newPlan == nil && current.savedPlan?.ref != nil)
        let realA = try await Live.signedIn().project(a).runs().runs
        #expect(realA.filter { $0.name == "Original saved plan" }.count == 1)
        #expect(realA.allSatisfy { $0.name != "Changed unsent name" && $0.name != "Project B saved plan" })
        print("REVIEW saved plan: changed inputs still read original ref; another project has separate plan")
    }
}
