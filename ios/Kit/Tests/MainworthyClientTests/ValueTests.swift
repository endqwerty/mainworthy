import Foundation
import Testing

@testable import MainworthyClient

@Suite("What the app works out by itself")
struct ValueTests {
	@Test("an address as a person types it", arguments: [
		("mainworthy.example", "https://mainworthy.example"),
		("  Mainworthy.Example  ", "https://mainworthy.example"),
		("https://mainworthy.example/p/demo/queue?x=1#top", "https://mainworthy.example"),
		("http://mainworthy.example", "http://mainworthy.example"),
		("mainworthy.example:8443", "https://mainworthy.example:8443"),
		// This device's own network is reached over plain http: iOS lets nothing else through.
		("192.168.1.20:7357", "http://192.168.1.20:7357"),
		("10.0.0.5", "http://10.0.0.5"),
		("172.20.1.1:7357", "http://172.20.1.1:7357"),
		("127.0.0.1:7357", "http://127.0.0.1:7357"),
		("localhost:7357", "http://localhost:7357"),
		("printer.local:7357", "http://printer.local:7357"),
		("[::1]:7357", "http://[::1]:7357"),
		("http://[::1]:7357", "http://[::1]:7357"),
		("HTTPS://Mainworthy.Example", "https://mainworthy.example"),
		("https://robin:secret@mainworthy.example/p/x", "https://mainworthy.example"),
		("https://printer.local:7357", "https://printer.local:7357"),
		// A public address that only looks private is not one.
		("172.32.1.1", "https://172.32.1.1"),
		("192.169.1.1", "https://192.169.1.1"),
	])
	func address(typed: String, becomes: String) throws {
		let instance = try #require(Instance(address: typed))
		#expect(instance.url.absoluteString == becomes)
		// What the app remembers and shows of an instance is typed back as the same instance.
		#expect(Instance(address: instance.name) == instance)
	}

	@Test("text that is no address", arguments: ["", "   ", "not an address", "ftp://mainworthy.example", "https://", ":7357"])
	func notAnAddress(typed: String) {
		#expect(Instance(address: typed) == nil)
	}

	@Test("the name of an instance leaves out the scheme")
	func instanceName() {
		#expect(Instance(address: "https://mainworthy.example")?.name == "mainworthy.example")
		#expect(Instance(address: "192.168.1.20:7357")?.name == "192.168.1.20:7357")
		// Where the scheme is not the one the address would get by itself, the name keeps it.
		#expect(Instance(address: "https://printer.local:7357")?.name == "https://printer.local:7357")
		#expect(Instance(address: "http://mainworthy.example")?.name == "http://mainworthy.example")
	}

	@Test("the stakes of a question are the sentences every other client prints")
	func stakes() {
		#expect(!Parity.stakes.isEmpty)
		for row in Parity.stakes {
			#expect(Stakes.sentence(kind: Kind(row.kind), blocks: row.blocks, facts: Set(row.facts)) == row.says)
		}
	}

	@Test("the queue's count in words is the one every other client prints")
	func waiting() {
		#expect(!Parity.waiting.isEmpty)
		for row in Parity.waiting { #expect(Stakes.waitingPhrase(row.counts) == row.says) }
	}

	@Test("an assertion's message is read as what was expected and what was seen", arguments: [
		("expected $90.00, got $100.00", "$90.00", "$100.00"),
		("AssertionError: expected 3 but received 4", "3", "4"),
		("Expected total to equal 90", "90", "total"),
		("expected the list to be empty", "empty", "the list"),
		("a !== b", "b", "a"),
	])
	func comparison(message: String, expected: String, observed: String) {
		let read = FailedResult.comparison(in: message)
		#expect(read?.expected == expected)
		#expect(read?.observed == observed)
	}

	@Test("a message that is no assertion is left as it is", arguments: ["Timeout after 30000ms", "connection reset"])
	func noComparison(message: String) {
		#expect(FailedResult.comparison(in: message) == nil)
	}

	@Test("an edit is shown step by step, by the ids the steps keep")
	func editedCase() {
		let open = Step(id: "a1", action: "Open the cart", expected: nil)
		let apply = Step(id: "b2", action: "Apply the coupon", expected: "Total shows $90.00")
		let reload = Step(id: "c3", action: "Reload", expected: nil)
		let remove = Step(id: "d4", action: "Remove the coupon", expected: "Total returns to $100.00")
		let applied = Step(id: "b2", action: "Apply the coupon SAVE10", expected: "Total shows $90.00")
		let edit = EditedCase(
			id: 0, caseRef: "C-1",
			before: CaseContent(title: "Coupon", pre: "", steps: [open, apply, reload]),
			after: CaseContent(title: "A coupon lowers the total", pre: "Signed in.", steps: [open, applied, remove])
		)
		#expect(edit.changes == [
			.title(from: "Coupon", to: "A coupon lowers the total"),
			.pre(from: "", to: "Signed in."),
			.kept(open),
			.changed(from: apply, to: applied),
			.added(remove),
			.removed(reload),
		])
		#expect(edit.summary == "Changes the title, the preconditions and 1 step, adds 1 step, removes 1 step.")
	}

	@Test("an edit says in a sentence what it does to the case, and a new case says nothing")
	func editSummary() {
		let open = Step(id: "a1", action: "Open the cart", expected: nil)
		let remove = Step(id: "d4", action: "Remove the coupon", expected: "Total returns to $100.00")
		let added = EditedCase(
			id: 0, caseRef: "C-1", before: CaseContent(title: "T", steps: [open]),
			after: CaseContent(title: "T", steps: [open, remove])
		)
		#expect(added.summary == "Adds 1 step.")
		let automated = EditedCase(
			id: 0, caseRef: "C-1", before: CaseContent(title: "T", steps: [open, remove]),
			after: CaseContent(title: "T", steps: [], automate: "wanted")
		)
		#expect(automated.summary == "Changes the automation, removes 2 steps.")
		let same = EditedCase(id: 0, caseRef: "C-1", before: CaseContent(title: "T"), after: CaseContent(title: "T"))
		#expect(same.summary == "Changes nothing.")
		let created = EditedCase(id: 0, caseRef: nil, before: nil, after: CaseContent(title: "New", steps: [open]))
		#expect(created.summary == nil)
	}

	@Test("a removed step is shown where it stood, and a new case is all additions")
	func editedCaseEdges() {
		let first = Step(id: "a1", action: "First", expected: nil)
		let second = Step(id: "b2", action: "Second", expected: nil)
		let third = Step(id: "c3", action: "Third", expected: nil)
		let shortened = EditedCase(
			id: 0, caseRef: "C-1", before: CaseContent(title: "T", steps: [first, second, third]),
			after: CaseContent(title: "T", steps: [first, third])
		)
		#expect(shortened.changes == [.kept(first), .removed(second), .kept(third)])
		// Everything of a new case is said: where it goes, who runs it, and each step.
		let placement = EditedCase.Placement(folder: "Checkout/Coupons", tags: ["checkout"], covers: ["WEB-290"])
		let created = EditedCase(
			id: 0, caseRef: nil, before: nil,
			after: CaseContent(title: "New", steps: [first], methods: ["agent"], automate: "wanted", fields: ["risk": "high"]),
			placement: placement
		)
		#expect(created.changes == [
			.title(from: nil, to: "New"),
			.placed(placement),
			.methods(from: [], to: ["agent"]),
			.automate(from: "", to: "wanted"),
			.fields(from: [:], to: ["risk": "high"]),
			.added(first),
		])
		// Steps that changed places are each shown once, in the new order.
		let swapped = EditedCase(
			id: 0, caseRef: "C-1", before: CaseContent(title: "T", steps: [first, second]),
			after: CaseContent(title: "T", steps: [second, first])
		)
		#expect(swapped.changes == [.kept(second), .kept(first)])
	}

	@Test("an edit that changes no step still shows what it changes")
	func editedCaseBeyondSteps() {
		let step = Step(id: "a1", action: "Open the cart", expected: nil)
		let edit = EditedCase(
			id: 0, caseRef: "C-1",
			before: CaseContent(title: "T", steps: [step]),
			after: CaseContent(title: "T", steps: [step], methods: ["agent"], automate: "wanted", fields: ["risk": "high"])
		)
		#expect(edit.changes == [
			.methods(from: ["human"], to: ["agent"]),
			.automate(from: "none", to: "wanted"),
			.fields(from: [:], to: ["risk": "high"]),
			.kept(step),
		])
	}

	@Test("a whole number is written as one, and a value survives being written and read")
	func json() throws {
		let value: JSONValue = ["limit": 100, "half": 0.5, "open": true, "none": nil, "refs": ["Q-1"]]
		let written = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
		#expect(written.contains(#""limit":100"#) && !written.contains("100.0"))
		#expect(try JSONDecoder().decode(JSONValue.self, from: Data(written.utf8)) == value)
	}
}
