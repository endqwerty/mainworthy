/// What leaving a question open costs, and the queue's count in words. These are `src/core/stakes.ts` again in
/// Swift: the app cannot run that file, and the sentences must be the ones every other client prints. The
/// tests hold each function to what the TypeScript returns (`Parity`), so a sentence changed there fails here.
enum Stakes {
	/// Only an unexplained failure is urgent: it blocks every run that counts it, under any policy.
	static func urgent(_ kind: Kind) -> Bool {
		kind == .failure
	}

	static func waitingPhrase(_ counts: [String: Int]) -> String {
		let failures = counts["failure"] ?? 0
		let canWait = max(0, (counts["open"] ?? 0) - failures)
		if failures == 0 && canWait == 0 { return "nothing needs an answer" }
		var parts: [String] = []
		if failures > 0 { parts.append("\(failures) \(failures == 1 ? "failure" : "failures") to explain") }
		if canWait > 0 { parts.append("\(canWait) can wait") }
		return parts.joined(separator: " · ")
	}

	static func sentence(kind: Kind, blocks: [String], facts: Set<String>) -> String {
		switch kind {
		case .failure:
			let held = "While this is open, no gate that counts the unexplained failure passes."
			return blocks.isEmpty ? held : "Listed as blocking \(named(blocks)). \(held)"
		case .map:
			return
				"Blocks nothing. Left alone, these tests still run and still gate the build, and no case gets credit for them."
		case .adopt:
			if facts.contains("policy") { return "Blocks nothing. Left alone, the policy stays as it is." }
			if facts.contains("conflict") {
				return
					"Blocks nothing. Left alone, the case stays as it is: the edit was made on an older version and waits for its author."
			}
			return "Blocks nothing. Left alone, the case stays as it is and the edit waits."
		case .finding:
			return "Blocks nothing. Left alone, the finding stays on record with no answer."
		case .signoff:
			return "Blocks nothing. Left alone, the run stays open."
		case .other:
			return ""
		}
	}

	/// Run refs in a sentence: the first three, and how many more.
	private static func named(_ refs: [String]) -> String {
		refs.count <= 3
			? refs.joined(separator: ", ")
			: "\(refs.prefix(3).joined(separator: ", ")) and \(refs.count - 3) more"
	}
}
