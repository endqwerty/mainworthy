import MainworthyClient
import MainworthyScreens
import SwiftUI

struct RunView: View {
	let screen: OpenRunScreen
	@State private var executing = false

	var body: some View {
		List {
			Section {
				Text(screen.run.name).font(.title2.weight(.semibold))
				HStack {
					RefText(screen.run.ref)
					Tag(text: screen.run.verdict.word, tint: screen.run.verdict.tint)
				}
				Text(screen.run.reason)
				Text(screen.run.tallyText).font(.subheadline).foregroundStyle(.secondary)
				Text(screen.run.accepts.sentence).font(.subheadline)
				if screen.run.state == .closed {
					Text("This run is closed. Withdrawing its sign-off in the Queue reopens it.")
				} else if screen.run.state != .open {
					Text("Run state: \(screen.run.state.word). This build cannot record results for it.")
				}
				if screen.isReadOnly {
					Text("Slots are read-only. Recording results needs the produce capability.")
				}
				if let next = screen.firstUnfilled, !screen.isReadOnly, screen.run.state == .open {
					Button("Start", systemImage: "play.fill") { open(next) }
						.accessibilityIdentifier("start-run")
				}
			}
			if let notice = screen.notice { Section { Text(notice).font(.subheadline) } }
			Section {
				ForEach(Array(screen.slots.enumerated()), id: \.element.id) { index, slot in
					// A slot another producer filled is left to that result, as the web app leaves it: it does not open.
					if screen.isLeftToOthers(slot) {
						row(index, slot).accessibilityIdentifier("run-slot-\(index + 1)")
					} else {
						Button {
							open(slot)
						} label: {
							row(index, slot)
						}
						.buttonStyle(.plain)
						.accessibilityIdentifier("run-slot-\(index + 1)")
					}
				}
			} header: {
				Text("Cases in order")
			} footer: {
				if screen.slots.contains(where: screen.isLeftToOthers) {
					Text("A slot that a pipeline, an agent or another person filled is left to that result and does not open.")
				}
			}
			if case .failed(let why) = screen.loading {
				Section {
					Text(why)
					Button("Try again") { Task { await screen.refresh() } }
				}
			}
		}
		.navigationTitle("Run")
		.navigationBarTitleDisplayMode(.inline)
		.refreshable { await screen.refresh() }
		.task { await screen.refresh() }
		.navigationDestination(isPresented: $executing) { RunSlotView(screen: screen) }
	}

	private func row(_ index: Int, _ slot: RunSlot) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack {
				Text("\(index + 1).").foregroundStyle(.secondary)
				RefText(slot.caseRef ?? "Case unavailable")
				Text("pinned v\(slot.version)").font(.caption).foregroundStyle(.secondary)
				Spacer()
				Tag(text: slot.state.word, tint: slot.state.tint)
			}
			Text(slot.title ?? "Case unavailable").foregroundStyle(.primary)
			ForEach(slot.fills) { fill in
				Text("\(fill.method.name.capitalized) \(fill.by) · \(fill.outcome.word)")
					.font(.caption).foregroundStyle(.secondary)
				if let note = fill.note { Text(note).font(.caption).foregroundStyle(.secondary) }
			}
		}
		.padding(.vertical, 4)
	}

	private func open(_ slot: RunSlot) {
		executing = true
		Task { await screen.execute(slot) }
	}
}
