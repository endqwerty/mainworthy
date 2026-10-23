import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("Result trails against the server", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct ResultTrailLiveTests {
	@Test("a report preserves step IDs, actions, omissions and the screenshot's ordered attachment")
	func roundTrip() async throws {
		let server = try await Live.signedIn(as: Live.owner)
		let project = try await server.project(try await Live.project())
		let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
		let trail: JSONValue = [
			["step": "a1.b2", "outcome": "pass", "durationMs": 0,
			 "actions": [["text": "Open the cart"]]],
			["step": "Coupon check", "outcome": "error", "durationMs": 700, "attachment": 1,
			 "actions": [["text": "Apply the coupon", "outcome": "fail", "durationMs": 650]]],
			["step": "c3", "outcome": "skip"],
		]
		let reply: JSONValue = try await server.write("report", in: project.key, [
			"target": ["commit": .string(String(repeating: "3", count: 40)), "repo": "acme/shop", "pr": 482],
			"job": "trail", "buildUrl": "https://ci.example/build/1",
			"results": [["test": ["key": "trail-roundtrip", "name": "Trail roundtrip"],
				"outcome": "fail", "failure": ["message": "Coupon trace failed", "detail": "Coupon diagnostic\nSecond line"],
				"note": "Observed on the phone", "steps": trail, "attachments": [
					["name": "first.png", "data": .string(png)], ["name": "second.png", "data": .string(png)],
				]]],
		])
		let id = Int(try #require(reply["results"]?.array?.first?.number))
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first {
			$0.title == "Coupon trace failed"
		})
		guard case .failure(let failure) = question.evidence else {
			Issue.record("The failure question was not readable")
			return
		}
		#expect(failure.sample == id)
		let sample = try await project.sampleResult(try #require(failure.sample))
		#expect(sample.id == id && sample.detail == "Coupon diagnostic\nSecond line")
		#expect(sample.note == "Observed on the phone" && sample.build?.absoluteString == "https://ci.example/build/1")
		#expect(sample.attachments == ["first.png", "second.png"])
		let run = try #require(try await project.details(of: "pr:482").gate.run)
		let counted = try #require(try await project.results(of: run, text: "Trail roundtrip").rows.first)
		#expect(counted.result == id)
		let raw: JSONValue = try await server.read("get", in: project.key, ["refs": [.string(counted.test)]])
		#expect(raw.array?.first?["last"]?.array?.first?["steps"] == trail)
		let test = try #require(try await project.test(counted.test))
		let document = try #require(test.results.first)
		let steps = try #require(document.steps)
		#expect(sample.steps == steps)
		#expect(steps.map(\.step) == ["a1.b2", "Coupon check", "c3"])
		#expect(steps.map(\.outcome) == [.pass, .error, .skip])
		#expect(steps[0].durationMs == 0 && steps[2].durationMs == nil)
		#expect(steps[0].actions?.first?.text == "Open the cart" && steps[0].actions?.first?.outcome == nil)
		#expect(steps[1].actions?.first?.outcome == .fail && steps[1].actions?.first?.durationMs == 650)
		#expect(steps[2].actions == nil && steps[2].attachment == nil)
		let screenshot = try await project.screenshot(result: id, index: try #require(steps[1].attachment))
		#expect(screenshot.name == "second.png" && screenshot.type == "image/png")
		#expect(screenshot.data == Data(base64Encoded: png))
		#expect(counted.steps == steps)
		#expect(test.results.first?.steps == steps)
		let _: JSONValue = try await server.write("report", in: project.key, [
			"target": ["commit": .string(String(repeating: "3", count: 40)), "repo": "acme/shop", "pr": 482],
			"job": "trail-newer", "results": [["test": ["key": "trail-roundtrip"],
				"outcome": "fail", "failure": ["message": "A newer failure", "detail": "Different diagnostic"]]],
		])
		#expect(try await project.sampleResult(id) == sample)
		let planned = try #require(try await project.runs().runs.first { $0.name == "Checkout regression" })
		let slot = try #require(try await project.slots(of: planned.ref).first { $0.fills.isEmpty })
		let caseRef = try #require(slot.caseRef)
		let manual: JSONValue = try await server.write("report", in: project.key, [
			"run": .string(planned.ref), "results": [["test": ["case": .string(caseRef)],
				"outcome": "fail", "steps": trail, "attachments": [
					["name": "first.png", "data": .string(png)], ["name": "second.png", "data": .string(png)],
				]]],
		])
		let manualID = Int(try #require(manual["results"]?.array?.first?.number))
		let filled = try #require(try await project.slots(of: planned.ref).first { $0.id == slot.id })
		let fill = try #require(filled.fills.first { $0.result == manualID })
		#expect(fill.steps == steps && fill.atStep == "Coupon check")
	}
}

@Suite("Relative step duration")
struct ResultTrailValueTests {
	@Test("missing, zero, equal and slow durations use the same result's maximum")
	func heat() throws {
		let wire = try JSONDecoder().decode([Wire.ResultStep].self, from: Data(#"""
		[
			{"step":"missing","outcome":"blocked"},
			{"step":"zero","outcome":"skip","durationMs":0},
			{"step":"fast","outcome":"pass","durationMs":100},
			{"step":"slow","outcome":"fail","durationMs":700},
			{"step":"equal","outcome":"error","durationMs":700}
		]
		"""#.utf8))
		let steps = wire.map(ResultStep.init)
		#expect(steps.map { $0.heat(in: steps) } == [0, 0, 1.0 / 7, 1, 1])
		#expect(steps[1].heat(in: [steps[0], steps[1]]) == 0)
	}
}
