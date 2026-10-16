import MainworthyClient
import MainworthyScreens
import SwiftUI

/// Every test the gate of a change's head counted, as it counted it: the evidence behind the verdict. A test
/// tracked without a case is one of them. The tally chooses what is shown.
struct ChangeResultsPanel: View {
	@Bindable var results: ChangeResults

	var body: some View {
		Panel("Results") {
			switch results.loading {
			case .first: ProgressView().frame(maxWidth: .infinity)
			case .failed(let why):
				Text(why).foregroundStyle(Color.fail)
				Button("Try again") { Task { await results.read() } }
			case .done: list
			}
		}
		.task { await results.load() }
		.task(id: results.text) {
			guard results.loading == .done else { return }
			do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
			await results.search()
		}
	}

	@ViewBuilder private var list: some View {
		ScrollView(.horizontal) {
			HStack(spacing: 8) {
				chip("All \(results.total)", standing: nil)
				ForEach(ResultStanding.allCases.filter { (results.tally[$0] ?? 0) > 0 }, id: \.self) { standing in
					chip("\(results.tally[standing] ?? 0) \(standing.label)", standing: standing)
				}
			}
		}
		.scrollIndicators(.hidden)
		if results.total > 0 {
			TextField("Filter by test name or file", text: $results.text)
				.textFieldStyle(.roundedBorder)
				.autocorrectionDisabled()
				.textInputAutocapitalization(.never)
				.accessibilityIdentifier("results-filter")
		}
		if let notice = results.notice { Text(notice).font(.subheadline).foregroundStyle(Color.fail) }
		if results.rows.isEmpty {
			Text(results.total == 0 ? "No results counted for the latest commit." : "No result matches.")
				.foregroundStyle(.secondary)
		}
		ForEach(results.rows) { row in
			ResultRow(row: row)
			if row.id != results.rows.last?.id { Divider() }
		}
		if results.moved {
			Button("The results changed. Read them again") { Task { await results.restart() } }
		} else if results.hasMore {
			Button("Show more (\((results.count ?? results.rows.count) - results.rows.count) left)") {
				Task { await results.more() }
			}
			.accessibilityIdentifier("results-more")
		}
	}

	private func chip(_ name: String, standing: ResultStanding?) -> some View {
		let chosen = results.standing == standing
		return Button {
			Task { await results.show(standing) }
		} label: {
			Text(name)
				.font(.subheadline)
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
				.foregroundStyle(chosen ? .white : .primary)
				.background(chosen ? Color.accentColor : Color(.tertiarySystemFill), in: .capsule)
		}
		.buttonStyle(.plain)
		.accessibilityAddTraits(chosen ? .isSelected : [])
		.accessibilityIdentifier("results-\(standing?.rawValue ?? "all")")
	}
}

private struct ResultRow: View {
	let row: CountedResult

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			NavigationLink(value: TestLink(ref: row.test)) {
				VStack(alignment: .leading, spacing: 4) {
					HStack(spacing: 6) {
						Tag(text: standingText, tint: standingTint)
						if let ref = row.caseRef { RefText(ref) } else { Tag(text: "no case", tint: .secondary) }
						Spacer(minLength: 0)
						RefText(row.test)
					}
					Text(row.name).fontWeight(.medium).multilineTextAlignment(.leading)
						.frame(maxWidth: .infinity, alignment: .leading)
					if let file = row.file {
						Text(file).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
					}
					Text(facts(job: row.job, attempt: row.attempt, duration: row.duration, by: row.by))
						.font(.caption).foregroundStyle(.secondary)
					if let message = row.message { Text(message).font(.footnote).lineLimit(3) }
				}
				.contentShape(.rect)
			}
			.buttonStyle(.plain)
			.accessibilityIdentifier("result-\(row.test)")
			if row.question != nil || row.build != nil {
				HStack(spacing: 16) {
					if let ref = row.question {
						NavigationLink(value: QuestionLink(ref: ref)) { Label(ref, systemImage: "questionmark.bubble") }
							.font(.footnote)
							.accessibilityIdentifier("result-question-\(ref)")
					}
					if let build = row.build { Link("Open the build", destination: build).font(.footnote) }
				}
			}
		}
		.padding(.vertical, 2)
	}

	private var standingText: String {
		guard !row.quarantined else { return "quarantined" }
		let label = row.standing?.label ?? row.outcome
		return row.outcome == "error" ? "\(label) (error)" : label
	}

	private var standingTint: Color {
		switch row.standing {
		case .unexplained?: .fail
		case .attributed?, .missing?: .warn
		case .pass?: .pass
		case .excused?, .skipped?, nil: .secondary
		}
	}
}
