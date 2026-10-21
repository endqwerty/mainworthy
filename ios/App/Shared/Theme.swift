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

/// A length of time in the largest unit that keeps it readable, in the web's units and rounding half up as the web
/// does: "88 ms", "4.2 s", "12 s", "3 min", "1 h 5 min".
func spent(_ ms: Int) -> String {
	if ms < 1000 { return "\(ms) ms" }
	if ms < 10_000 {
		let tenths = (ms + 50) / 100
		return "\(tenths / 10).\(tenths % 10) s"
	}
	if ms < 60_000 { return "\((ms + 500) / 1000) s" }
	let minutes = (ms + 30_000) / 60_000
	return minutes < 60 ? "\(minutes) min" : "\(minutes / 60) h \(minutes % 60) min"
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
	let horizontalPadding: CGFloat
	@ViewBuilder let content: Content

	init(_ title: String? = nil, horizontalPadding: CGFloat = 12, @ViewBuilder content: () -> Content) {
		self.title = title
		self.horizontalPadding = horizontalPadding
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
		.padding(.horizontal, horizontalPadding)
		.padding(.vertical, 12)
		.background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
	}
}

/// A way a case is run, drawn with the producer's symbol, so a person, a pipeline and an agent look the same on
/// every screen. Its name is the generated `label`, as every client says it.
extension CaseMethod {
	var producer: Producer {
		switch self {
		case .human: .person
		case .auto: .pipeline
		case .agent: .agent
		}
	}

	/// Who it is, in a sentence: "A person may run it".
	var who: String {
		switch self {
		case .human: "A person"
		case .auto: "A pipeline"
		case .agent: "An agent"
		}
	}
}

/// Who may run a case: every way, each with its symbol, and the ones the case does not allow struck through.
struct MethodBadges: View {
	let methods: [String]

	var body: some View {
		MethodBadgeLayout() {
			ForEach(CaseMethod.allCases, id: \.self) { method in
				let allowed = methods.contains(method.rawValue)
				Label(method.label, systemImage: method.producer.symbol)
					.labelStyle(.titleAndIcon)
					.font(.subheadline.weight(allowed ? .semibold : .regular))
					.lineLimit(1)
					.fixedSize()
					.strikethrough(!allowed)
					.foregroundStyle(allowed ? method.producer.tint : Color.secondary.opacity(0.6))
					.padding(.horizontal, 8)
					.padding(.vertical, 4)
					.background(allowed ? method.producer.tint.opacity(0.12) : Color.clear, in: .capsule)
					.overlay { if !allowed { Capsule().strokeBorder(Color.secondary.opacity(0.3)) } }
					.accessibilityElement(children: .ignore)
					.accessibilityLabel("\(method.who) \(allowed ? "may" : "may not") run it")
					.accessibilityIdentifier("method-\(method.rawValue)")
			}
		}
	}
}

private struct MethodBadgeLayout: Layout {
	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		arrange(subviews, width: proposal.width ?? .infinity).size
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		let frames = arrange(subviews, width: bounds.width).frames
		for (subview, frame) in zip(subviews, frames) {
			subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
				anchor: .topLeading, proposal: ProposedViewSize(frame.size))
		}
	}

	private func arrange(_ subviews: Subviews, width: CGFloat) -> (size: CGSize, frames: [CGRect]) {
		var frames: [CGRect] = []
		var x: CGFloat = 0
		var y: CGFloat = 0
		var rowHeight: CGFloat = 0
		var usedWidth: CGFloat = 0
		for subview in subviews {
			let size = subview.sizeThatFits(.unspecified)
			if x > 0 && x + size.width > width {
				x = 0
				y += rowHeight + 8
				rowHeight = 0
			}
			let frame = CGRect(origin: CGPoint(x: x, y: y), size: size)
			frames.append(frame)
			usedWidth = max(usedWidth, frame.maxX)
			x = frame.maxX + 8
			rowHeight = max(rowHeight, size.height)
		}
		return (CGSize(width: usedWidth, height: y + rowHeight), frames)
	}
}

extension CaseProof.Outcome {
	/// What the result was, as a chip says it: "passed".
	var said: String {
		switch self {
		case .pass: "passed"
		case .fail: "failed"
		case .skip: "skipped"
		case .blocked: "blocked"
		case .error: "error"
		case .other(let word): word
		}
	}

	var symbol: String {
		switch self {
		case .pass: "checkmark"
		case .fail, .error: "xmark"
		case .blocked: "exclamationmark.triangle"
		case .skip, .other: "minus"
		}
	}

	var tint: Color {
		switch self {
		case .pass: .pass
		case .fail, .error: .fail
		case .blocked: .warn
		case .skip, .other: .secondary
		}
	}
}

/// The latest result of each way a case was run: who ran it, and what came of it. A result on an earlier version
/// of the case says so, and is grey: it says nothing about the case as it is.
struct ProofChips: View {
	let proof: [CaseProof]

	var body: some View {
		ViewThatFits(in: .horizontal) {
			HStack(spacing: 6) { chips }
			VStack(alignment: .leading, spacing: 4) { chips }
		}
	}

	private var chips: some View {
		ForEach(proof, id: \.method) { ProofChip(proof: $0) }
	}
}

private struct ProofChip: View {
	let proof: CaseProof

	var body: some View {
		let method = CaseMethod(rawValue: proof.method)
		let tint = proof.current ? proof.outcome.tint : .secondary
		HStack(spacing: 3) {
			Image(systemName: method?.producer.symbol ?? "questionmark")
			Image(systemName: proof.outcome.symbol).fontWeight(.bold)
			Text(proof.current ? proof.outcome.said : "\(proof.outcome.said), older version")
		}
		.font(.caption.weight(.medium))
		.foregroundStyle(tint)
		.padding(.horizontal, 6)
		.padding(.vertical, 2)
		.background(tint.opacity(0.12), in: .capsule)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(
			"\(method?.label ?? proof.method): \(proof.outcome.said)\(proof.current ? "" : " on an earlier version")"
		)
		.accessibilityIdentifier("proof-\(proof.method)")
	}
}

extension View {
	/// A bar that floats over the foot of a page, as glass like the system's own bars, so the content scrolls
	/// under it. Placed with `safeAreaBar`, which gives the content's edge the same treatment as under a toolbar.
	func floatingBar() -> some View {
		padding(12)
			.glassEffect(.regular, in: .rect(cornerRadius: 22))
			.padding(.horizontal, 12)
			.padding(.bottom, 6)
	}

}

/// What a list says in place of its rows: that it has none, that it is still reading, or that it could not be read.
/// It is a row of the list, not an overlay over it, so it comes down with the list when the list is pulled to refresh,
/// and a pull that starts on it refreshes too: an overlay stays where it is and takes the drag from the list. The list
/// says how tall it shows with `holdsPlaceholder`, and the row takes most of that, with what it says in the middle.
struct ListPlaceholder<Content: View>: View {
	@ViewBuilder var content: Content
	@Environment(\.listShownHeight) private var shown

	var body: some View {
		Section {
			content
				.frame(maxWidth: .infinity, minHeight: shown * 0.75)
				.listRowBackground(Color.clear)
				.listRowSeparator(.hidden)
				// Only an action's own button acts, not the whole row.
				.buttonStyle(.borderless)
		}
	}
}

extension View {
	/// Tells a `ListPlaceholder` in this list how tall the list shows, between its bars.
	func holdsPlaceholder() -> some View {
		modifier(ShownHeight())
	}
}

private struct ShownHeight: ViewModifier {
	@State private var height: CGFloat = 0

	func body(content: Content) -> some View {
		content
			.onScrollGeometryChange(for: CGFloat.self) { geometry in
				geometry.containerSize.height - geometry.contentInsets.top - geometry.contentInsets.bottom
			} action: { _, shown in
				height = max(0, shown)
			}
			.environment(\.listShownHeight, height)
	}
}

extension EnvironmentValues {
	@Entry var listShownHeight: CGFloat = 0
}
