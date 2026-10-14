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
			Section("Cases in order") {
				ForEach(Array(screen.slots.enumerated()), id: \.element.id) { index, slot in
					Button {
						open(slot)
					} label: {
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
					.buttonStyle(.plain)
					.accessibilityIdentifier("run-slot-\(index + 1)")
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

	private func open(_ slot: RunSlot) {
		executing = true
		Task { await screen.execute(slot) }
	}
}
