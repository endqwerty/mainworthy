import MainworthyClient
import SwiftUI

/// The shards a gate waits for, drawn as the web draws them (`src/web/ui/shards.tsx`): a strip a job, a cell a
/// shard, the missing ones outlined. A finger cannot hover, so a tap on a strip shows its words, and VoiceOver
/// reads them as the strip's label.
struct ShardStrips: View {
	let waiting: [ShardWait]

	var body: some View {
		if !waiting.isEmpty {
			VStack(alignment: .leading, spacing: 10) {
				ForEach(waiting, id: \.self) { ShardStrip(wait: $0) }
			}
		}
	}
}

private struct ShardStrip: View {
	let wait: ShardWait
	@State private var explained = false

	var body: some View {
		let missing = Set(wait.missing)
		// A number in each cell reads at a glance up to two dozen shards; past that the cells alone show the gaps.
		let numbered = wait.of <= 24
		Button { explained.toggle() } label: {
			VStack(alignment: .leading, spacing: 6) {
				HStack(spacing: 6) {
					Text(wait.job.isEmpty ? "(unnamed)" : wait.job).font(.subheadline.monospaced())
					if !wait.env.isEmpty { Text(wait.env).font(.subheadline).foregroundStyle(.secondary) }
					Spacer()
					Text("\(wait.of - wait.missing.count)/\(wait.of)").font(.caption.monospaced())
						.foregroundStyle(.secondary)
				}
				LazyVGrid(
					columns: [GridItem(.adaptive(minimum: numbered ? 26 : 9, maximum: numbered ? 26 : 9), spacing: 4)],
					alignment: .leading, spacing: 4
				) {
					ForEach(1...max(wait.of, 1), id: \.self) { shard in
						Cell(number: numbered ? shard : nil, missing: missing.contains(shard))
					}
				}
			}
			.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.popover(isPresented: $explained) {
			Text(wait.title).font(.subheadline).padding().frame(idealWidth: 300).fixedSize(horizontal: false, vertical: true)
				.presentationCompactAdaptation(.popover)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(wait.title)
		.accessibilityAddTraits(.isButton)
		.accessibilityIdentifier("shard-strip")
	}
}

private struct Cell: View {
	let number: Int?
	let missing: Bool

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: 4)
		Text(number.map(String.init) ?? "")
			.font(.caption2.monospaced().weight(.semibold))
			.foregroundStyle(missing ? Color.warn : .secondary)
			.frame(maxWidth: .infinity, minHeight: number == nil ? 14 : 24)
			.background(missing ? Color.warnSoft : Color.secondary.opacity(0.18), in: shape)
			.overlay {
				if missing { shape.strokeBorder(Color.warn, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])) }
			}
	}
}
