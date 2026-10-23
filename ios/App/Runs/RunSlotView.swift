import MainworthyClient
import MainworthyScreens
import SwiftUI

struct RunSlotView: View {
	@Bindable var screen: OpenRunScreen
	@FocusState private var noting: Bool
	@State private var settingAside: RunExecution?

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				switch screen.document {
				case .none:
					ContentUnavailableView(
						"No slot left", systemImage: "checkmark.circle",
						description: Text(
							"Every available slot has a result. Go back to see the server's verdict, or record any slot again."
						))
				case .reading: ProgressView("Reading the pinned case…")
				case .failed(let slot, let why):
					Text(why).foregroundStyle(Color.fail)
					Button("Try again") { Task { await screen.execute(slot) } }
				case .read(let execution): content(execution)
				}
			}
			.padding(16)
		}
		.background(Color(.systemGroupedBackground))
		.resultAttachments(screen.attachments)
		.scrollDismissesKeyboard(.interactively)
		.navigationTitle("Execute")
		// The outcome buttons are at the foot of the page, where the tab bar would lie over them.
		.toolbar(.hidden, for: .tabBar)
		.navigationBarTitleDisplayMode(.inline)
		.safeAreaBar(edge: .bottom) {
			VStack(spacing: 10) {
				if case .read(let execution) = screen.document {
					if screen.mayRecord(execution), !screen.hasPendingReport(for: execution) {
						TextField("Optional note", text: $screen.note, axis: .vertical)
							.lineLimit(1...3).textFieldStyle(.roundedBorder).focused($noting)
							.accessibilityIdentifier("run-note").disabled(screen.busy)
						LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
							ForEach(ManualOutcome.allCases, id: \.self) { outcome in
								Button {
									noting = false
									Task { await screen.record(execution, outcome: outcome) }
								} label: {
									Text(outcome.label).font(.headline).frame(maxWidth: .infinity, minHeight: 48)
								}
								// The panel is glass; its buttons are not, so there is one layer of it.
								.buttonStyle(.borderedProminent).tint(tint(outcome)).disabled(screen.busy)
								.accessibilityIdentifier("record-\(outcome.rawValue)")
							}
						}
					} else if !screen.hasPendingReport(for: execution) {
						Text(
							screen.isReadOnly
								? "Slots are read-only. Recording results needs the record capability."
								: screen.run.state == .closed
									? "This run is closed. Withdrawing its sign-off in the Queue reopens it."
									: screen.isLeftToOthers(execution.slot)
										? "Another producer filled this slot, and it is left to that result. Go back to record a slot of your own."
										: "This pinned case does not admit a person's results, or the run is not open."
						)
						.font(.subheadline)
					}
				}
				if case .read(let execution) = screen.document, screen.canSetAsideReport(execution) {
					Button("Set report aside") { settingAside = execution }
						.disabled(screen.busy).accessibilityIdentifier("set-report-aside")
						.confirmationDialog("Set this report aside?", isPresented: Binding(
							get: { settingAside != nil }, set: { if !$0 { settingAside = nil } }
						), titleVisibility: .visible, presenting: settingAside) { chosen in
							Button("Set report aside", role: .destructive) {
								settingAside = nil
								Task { await screen.setAsideReport(chosen) }
							}
							.accessibilityIdentifier("confirm-set-report-aside")
							Button("Cancel", role: .cancel) { settingAside = nil }
						} message: { _ in
							Text("The earlier report may still have been recorded, or may arrive later. Setting it aside stops retries on this device and reads this slot again. It does not cancel or undo the report.")
						}
				}
				if let notice = screen.notice {
					HStack(alignment: .firstTextBaseline) {
						Text(notice).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
							.accessibilityIdentifier("run-notice")
						if screen.hasPendingReport {
							Button("Retry report") { Task { await screen.retryReport() } }
								.disabled(screen.busy).accessibilityIdentifier("retry-report")
						} else if screen.canUndo, screen.permission.may(.record), screen.run.state == .open {
							Button("Undo") {
								noting = false
								Task { await screen.undo() }
							}.disabled(screen.busy)
						}
					}
				}
			}
			.floatingBar()
		}
		.toolbar {
			if noting { ToolbarItem(placement: .keyboard) { Button("Done") { noting = false } } }
		}
	}

	private func content(_ execution: RunExecution) -> some View {
		VStack(alignment: .leading, spacing: 16) {
			HStack {
				RefText(execution.slot.caseRef ?? "Case")
				Text("pinned v\(execution.slot.version)").font(.caption)
			}
			Text(execution.content.title).font(.title2.weight(.semibold)).accessibilityIdentifier("executing-case")
			if !execution.content.pre.isEmpty { Panel("Preconditions") { Text(execution.content.pre) } }
			if screen.mayRecord(execution), !screen.hasPendingReport(for: execution) {
				Text("Tap the step that failed. Tap it again to clear the mark.").font(.subheadline)
					.foregroundStyle(.secondary)
			}
			ForEach(Array(execution.content.steps.enumerated()), id: \.element.id) { index, step in
				Button {
					screen.mark(step)
				} label: {
					Panel {
						HStack(alignment: .top) {
							Text("\(index + 1)").font(.headline).foregroundStyle(.secondary)
							VStack(alignment: .leading, spacing: 8) {
								Text(step.action).foregroundStyle(.primary)
								if let expected = step.expected {
									Text(expected).font(.subheadline).foregroundStyle(.secondary)
								}
								if screen.failedStep == step.id {
									Label("Failed step", systemImage: "xmark.circle.fill").foregroundStyle(
										Color.fail)
								}
							}
						}
					}
					.overlay(
						RoundedRectangle(cornerRadius: 12).stroke(
							screen.failedStep == step.id ? Color.fail : .clear, lineWidth: 2))
				}
				.buttonStyle(.plain).disabled(screen.busy || !screen.mayRecord(execution) || screen.hasPendingReport(for: execution))
				.accessibilityIdentifier("run-step-\(index + 1)")
				.accessibilityAddTraits(screen.failedStep == step.id ? .isSelected : [])
			}
			if execution.content.steps.isEmpty {
				Text("This pinned case has no steps.").foregroundStyle(.secondary)
			}
			if !screen.latestSlot(execution).fills.isEmpty {
				Panel("Recorded results") {
					ForEach(screen.latestSlot(execution).fills) { fill in
						Text("\(fill.method.name.capitalized) \(fill.by)\(fill.model.map { " · \($0)" } ?? "") · \(fill.outcome.word)")
						if let note = fill.note { Text(note).font(.subheadline) }
						if let steps = fill.steps {
							ResultTrailView(steps: steps, result: fill.result, attachments: screen.attachments)
						}
					}
				}
			}
		}
	}

	private func tint(_ outcome: ManualOutcome) -> Color {
		switch outcome {
		case .pass: .pass
		case .fail: .fail
		case .blocked: .warn
		case .skip: .secondary
		}
	}
}
