import Foundation

/// The same finite namespace and search as newStepId in src/core/ids.ts.
package func newStepId(taken: Set<String>, random: () -> Double = { Double.random(in: 0..<1) }) throws -> String {
	let letters = Array("abcdefghijklmnopqrstuvwxyz")
	for length in 2...4 {
		let sample = random()
		let unit = sample.isFinite ? min(max(sample, 0), 1 - Double.ulpOfOne) : 0
		let suffixes = Int(pow(36.0, Double(length - 1)))
		let capacity = letters.count * suffixes
		let start = Int(floor(unit * Double(capacity)))
		for offset in 0..<capacity {
			let index = (start + offset) % capacity
			let suffix = String(index % suffixes, radix: 36)
			let id = String(letters[index / suffixes]) + String(repeating: "0", count: length - 1 - suffix.count) + suffix
			if !taken.contains(id) { return id }
		}
	}
	throw ClientError.refused(code: "invalid", message: "All letter-leading 2–4 character step ids are taken")
}
