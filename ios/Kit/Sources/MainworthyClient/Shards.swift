/// A job of a commit that reported in shards and is missing some: the gate waits for those (decision 0092).
/// The words are `src/core/runs.ts` again in Swift, held to what the TypeScript returns (`Parity`).
public struct ShardWait: Hashable, Sendable {
	public let job: String
	public let env: String
	/// The shards that have not reported, ascending.
	public let missing: [Int]
	/// How many shards the job has.
	public let of: Int

	init(job: String, env: String, missing: [Int], of: Int) {
		self.job = job
		self.env = env
		self.missing = missing
		self.of = of
	}

	init(_ wire: Wire.ShardWait) {
		self.init(job: wire.job, env: wire.env, missing: wire.missing, of: wire.of)
	}

	/// The shards that have reported, ascending.
	public var reported: [Int] {
		let gone = Set(missing)
		return of < 1 ? [] : (1...of).filter { !gone.contains($0) }
	}

	/// `shardWaitTitle`: which shards reported and which the gate waits for, spelled out.
	public var title: String {
		let done =
			"\(reported.count) of \(of) shards reported" + (reported.isEmpty ? "" : " (\(Self.listed(reported)))")
		return "Job \(named): \(done). Waiting for \(Self.shards(missing))."
	}

	/// `reasonBesideShards`: a gate's reason with the shards it names said as a count, for a screen that draws them.
	public static func reason(_ reason: String, beside waiting: [ShardWait]) -> String {
		guard !waiting.isEmpty else { return reason }
		let count = waiting.reduce(0) { $0 + $1.missing.count }
		let named = waiting.map { "\(shards($0.missing)) of \($0.of) of job \($0.named)" }.joined(separator: "; ")
		guard let range = reason.range(of: named) else { return reason }
		return reason.replacingCharacters(in: range, with: "\(count) \(count == 1 ? "shard" : "shards")")
	}

	private var named: String { (job.isEmpty ? "(unnamed)" : job) + (env.isEmpty ? "" : " in \(env)") }

	private static func listed(_ numbers: [Int]) -> String {
		let words = numbers.map(String.init)
		guard let last = words.last, words.count > 1 else { return words.first ?? "" }
		return "\(words.dropLast().joined(separator: ", ")) and \(last)"
	}

	private static func shards(_ numbers: [Int]) -> String {
		"\(numbers.count == 1 ? "shard" : "shards") \(listed(numbers))"
	}
}
