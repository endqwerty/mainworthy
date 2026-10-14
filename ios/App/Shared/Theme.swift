import MainworthyClient
import SwiftUI

/// The colours of the web app (`src/web/base.css`), under its names, in both appearances.
extension Color {
	static let pass = Color("Pass")
	static let passSoft = Color("PassSoft")
	static let fail = Color("Fail")
	static let failSoft = Color("FailSoft")
	static let warn = Color("Warn")
	static let warnSoft = Color("WarnSoft")
	static let pipeline = Color("Pipeline")
	static let agent = Color("Agent")
	static let agentSoft = Color("AgentSoft")
}

extension Kind {
	/// The colour the queue gives a kind, as the web does: a failure is red, what an agent brings is violet.
	var tint: Color {
		switch self {
		case .failure: .fail
		case .adopt, .finding: .agent
		case .signoff: .pass
		case .map, .other: .secondary
		}
	}
}

extension Producer {
	var symbol: String {
		switch self {
		case .person: "person.fill"
		case .agent: "sparkles"
		case .pipeline: "gearshape.2.fill"
		case .rule: "checklist"
		}
	}

	var name: String {
		switch self {
		case .person: "a person"
		case .agent: "an agent"
		case .pipeline: "a pipeline"
		case .rule: "a rule"
		}
	}

	var tint: Color {
		switch self {
		case .person: .primary
		case .agent: .agent
		case .pipeline: .pipeline
		case .rule: .secondary
		}
	}
}

/// A ref, as every screen writes one: Q-12, C-311.
struct RefText: View {
	let ref: String

	init(_ ref: String) {
		self.ref = ref
	}

	var body: some View {
		Text(ref)
			.font(.footnote.monospaced())
			.foregroundStyle(.secondary)
	}
}

/// A small word on a tinted ground: the kind of a question, a state.
struct Tag: View {
	let text: String
	let tint: Color

	var body: some View {
		Text(text)
			.font(.caption.weight(.semibold))
			.foregroundStyle(tint)
			.padding(.horizontal, 6)
			.padding(.vertical, 2)
			.background(tint.opacity(0.12), in: .rect(cornerRadius: 5))
	}
}

/// A block of evidence: a heading and what it holds, on the grouped ground.
struct Panel<Content: View>: View {
	let title: String?
	@ViewBuilder let content: Content

	init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
		self.title = title
		self.content = content()
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			if let title {
				Text(title)
					.font(.caption.weight(.semibold))
					.foregroundStyle(.secondary)
					.textCase(.uppercase)
			}
			content
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(12)
		.background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
	}
}
