import Foundation
import MainworthyClient
import Testing

@testable import MainworthyScreens

actor OvertakenSlotsTransport: Transport {
	private var runReads = 0
	private var slotReads = 0
	private let oldRun = AsyncStream.makeStream(of: Void.self)
	private let sawOld = AsyncStream.makeStream(of: Void.self)
	private let fallback = AsyncStream.makeStream(of: Void.self)
	private let sawFallback = AsyncStream.makeStream(of: Void.self)
	func waitOld() async { for await _ in sawOld.stream { break } }
	func releaseOld() { oldRun.continuation.yield() }
	func waitFallback() async { for await _ in sawFallback.stream { break } }
	func releaseFallback() { fallback.continuation.yield() }
	func runJSON() -> String {
		#"{"ref":"R-1","name":"Review","origin":"planned","inProgress":0,"workUntil":null,"state":"open","verdict":"pending","reason":"missing","createdAt":1800000000000,"slots":2,"tally":{"missing":1,"pass":1},"accepts":{"self":true}}"#
	}
	func slotJSON(_ n: Int, filled: Bool) -> String {
		let fills = filled ? #"[{"result":\#(n),"by":"robin","method":"human","outcome":"pass","steps":null}]"# : "[]"
		return
			#"{"id":\#(n),"case":"C-\#(n)","title":"Case \#(n)","version":1,"state":"\#(filled ? "satisfied" : "missing")","work":{"kind":"free"},"fills":\#(fills)}"#
	}
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
		let op = request.url!.lastPathComponent
		let result: String
		if op == "report" {
			result = #"{"results":[1],"rejected":[],"declined":[]}"#
		} else if op == "find" {
			slotReads += 1
			let n = slotReads
			let oldSnapshot =
				#"{"items":[\#(slotJSON(1, filled:n > 1)),\#(slotJSON(2, filled:n >= 5))],"cursor":null}"#
			if n == 4 {
				sawFallback.continuation.yield()
				for await _ in fallback.stream { break }
			}
			result = oldSnapshot
		} else if input["refs"]?.array?.first?.string == "R-1" {
			runReads += 1
			if runReads == 2 {
				sawOld.continuation.yield()
				for await _ in oldRun.stream { break }
			}
			result = "[\(runJSON())]"
		} else {
			let ref = input["refs"]?.array?.first?.string ?? "C-1"
			result =
				#"[{"ref":"\#(ref)","version":1,"title":"\#(ref)","pre":"","steps":[],"methods":["human"],"automate":"none"}]"#
		}
		return (
			Data(#"{"ok":true,"result":\#(result)}"#.utf8),
			HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
		)
	}
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}

@Suite("Run fallback reads") @MainActor struct RunFallbackTests {
	@Test("an overtaken fallback cannot replace newer slots")
	func fallbackCannotReplaceNewerSlots() async throws {
		let transport = OvertakenSlotsTransport()
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(),
			transport: transport)
		let client = server.project("review", identity: "review-identity")
		let screen = OpenRunScreen(
			project: client, run: try await client.run("R-1"),
			permission: Project(key: "review", identity: "review-identity", name: "Review", can: ["read", "record", "produce"]), person: "robin")
		// Read the starting slot directly so the held run read belongs to recording.
		let slot = try #require(try await client.slots(of: "R-1").first)
		await screen.execute(slot)
		guard case .read(let shown) = screen.document else {
			Issue.record("no case")
			return
		}
		let record = Task { await screen.record(shown, outcome: .pass) }
		await transport.waitOld()
		await screen.refresh()
		await transport.releaseOld()
		await transport.waitFallback()
		await screen.refresh()
		#expect(screen.slots.map(\.id) == [1, 2])
		#expect(screen.slots.map { $0.fills.map(\.result) } == [[1], [2]])
		#expect(screen.slots.map { $0.fills.map(\.outcome) } == [[.manual(.pass)], [.manual(.pass)]])
		await transport.releaseFallback()
		#expect(await record.value)
		print(
			"slots after overtaken fallback: \(screen.slots.map { ($0.id, $0.fills.count) }); document: \(screen.document)"
		)
		#expect(screen.slots.map(\.id) == [1, 2])
		#expect(screen.slots.map { $0.fills.map(\.result) } == [[1], [2]])
		#expect(screen.slots.map { $0.fills.map(\.outcome) } == [[.manual(.pass)], [.manual(.pass)]])
		#expect(screen.document == .none)
	}
}
