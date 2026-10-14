import MainworthyClient
import MainworthyScreens
import SwiftUI

/// What a question asks about, laid out by its kind.
struct EvidenceView: View {
	let question: Question
	let screen: QueueScreen

	var body: some View {
		switch question.evidence {
		case .failure(let failed): FailureEvidence(failed: failed, timesSeen: question.timesSeen)
		case .unlinked(let tests): UnlinkedEvidence(tests: tests)
		case .finding(let finding): FindingEvidence(finding: finding)
		case .proposal(let edit): ProposalEvidence(question: question, edit: edit, screen: screen)
		case .signoff(let run): SignoffEvidence(run: run)
		case .unreadable:
			Panel {
				Label(
					"This build of the app cannot read what this question is about. Open it in the web app, or install a newer build.",
					systemImage: "questionmark.circle"
				)
				.font(.subheadline)
			}
		}
	}
}

private struct FailureEvidence: View {
	let failed: FailedResult
	let timesSeen: Int

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			if let comparison = failed.comparison {
				HStack(alignment: .top, spacing: 12) {
					Panel("Expected") {
						Text(comparison.expected).font(.title3.weight(.semibold)).foregroundStyle(Color.pass)
					}
					Panel("Observed") {
						Text(comparison.observed).font(.title3.weight(.semibold)).foregroundStyle(Color.fail)
					}
				}
			}
			if let message = failed.message {
				Panel(failed.comparison == nil ? "Failure" : nil) {
					Text(message)
						.font(.callout.monospaced())
						.foregroundStyle(Color.fail)
						.textSelection(.enabled)
				}
			}
			if failed.failsOnBase {
				Label("The same cause also fails on the base of this change.", systemImage: "arrow.triangle.branch")
					.font(.subheadline)
					.padding(10)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(Color.accentColor.opacity(0.12), in: .rect(cornerRadius: 10))
			}
			if failed.isDisputed {
				Label("A pass and a fail disagree about this.", systemImage: "arrow.left.arrow.right")
					.font(.subheadline)
					.foregroundStyle(Color.warn)
			}
			Panel("Where") {
				Text([failed.target, failed.branch].compactMap { $0 }.joined(separator: " · "))
					.font(.subheadline.monospaced())
				Text(
					"\(failed.count) \(failed.count == 1 ? "test shares" : "tests share") this cause · seen \(timesSeen) \(timesSeen == 1 ? "time" : "times")"
				)
				.font(.subheadline)
				.foregroundStyle(.secondary)
				TestList(tests: failed.tests, count: failed.count)
			}
		}
	}
}

private struct TestList: View {
	let tests: [TestRef]
	let count: Int

	var body: some View {
		ForEach(tests) { test in
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				RefText(test.ref)
				Text(test.name).font(.subheadline)
				if let caseRef = test.caseRef {
					Spacer()
					RefText(caseRef)
				}
			}
		}
		if count > tests.count {
			Text("and \(count - tests.count) more").font(.footnote).foregroundStyle(.secondary)
		}
	}
}

private struct UnlinkedEvidence: View {
	let tests: UnlinkedTests

	var body: some View {
		Panel("Tests with no case") {
			Text(tests.file).font(.subheadline.monospaced()).textSelection(.enabled)
			TestList(tests: tests.tests, count: tests.count)
		}
	}
}

private struct FindingEvidence: View {
	let finding: Finding

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Panel("Finding") {
				HStack(spacing: 6) {
					Tag(text: finding.category, tint: .agent)
					RefText(finding.on)
				}
				if let title = finding.caseTitle { Text(title).font(.subheadline.weight(.medium)) }
				Text(finding.note).textSelection(.enabled)
				Text("Found by \(finding.finder) · \(finding.lens)")
					.font(.footnote)
					.foregroundStyle(.secondary)
			}
			if let repro = finding.repro {
				Panel("How to see it") { Text(repro).font(.callout).textSelection(.enabled) }
			}
			if let suggestion = finding.suggestion {
				Panel("Suggested edit") {
					switch suggestion {
					case .step(let action, let expected):
						if let action { Text(action) }
						if let expected { Text("> \(expected)").foregroundStyle(Color.pass) }
					case .newCase(let title, let steps):
						Text(title).font(.body.weight(.medium))
						ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
							Text("\(index + 1). \(step)").font(.subheadline)
						}
					}
					Text("Accepting makes this an edit proposed by \(finding.finder).")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
			}
		}
	}
}

private struct ProposalEvidence: View {
	let question: Question
	let edit: ProposedEdit
	let screen: QueueScreen

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Panel("Proposed edit") {
				Text("\(edit.author) proposes \(edit.proposal)").font(.subheadline.weight(.medium))
				if let reason = edit.reason { Text(reason).textSelection(.enabled) }
				ForEach(Array(edit.summaries.enumerated()), id: \.offset) { _, line in
					Text(line).font(.subheadline).foregroundStyle(.secondary)
				}
				if edit.count > edit.summaries.count {
					Text("and \(edit.count - edit.summaries.count) more").font(.footnote).foregroundStyle(.secondary)
				}
			}
			ForEach(edit.conflicts, id: \.caseRef) { conflict in
				Label(
					"\(conflict.caseRef) changed since this edit was made: \(conflict.fields.joined(separator: ", ")). Its author resolves it in the web app.",
					systemImage: "exclamationmark.triangle"
				)
				.font(.subheadline)
				.foregroundStyle(Color.warn)
			}
			if !edit.isShownWhole {
				Label(
					"This proposal does more than add a case or change what one says: it restores an earlier version, moves, tags, archives or re-covers cases, makes a folder or changes the policy. This build does not show all of that, so it is answered in the web app.",
					systemImage: "info.circle"
				)
				.font(.subheadline)
				.foregroundStyle(.secondary)
			}
			// The answers stay off until this is read: nobody accepts an edit they were not shown.
			switch screen.documents(of: question) {
			case .read(let documents):
				ForEach(documents) { document in EditedCaseView(document: document) }
			case .failed(let why):
				Panel {
					Label("What the edit changes could not be read. \(why)", systemImage: "exclamationmark.triangle")
						.font(.subheadline)
						.foregroundStyle(Color.fail)
					Button("Try again") { Task { await screen.readDocuments(of: question) } }
				}
			case .reading, nil:
				ProgressView().frame(maxWidth: .infinity)
			}
		}
		// Read again when the question's evidence changes: the edit's case may be another one by then.
		.task(id: question) { await screen.readDocuments(of: question) }
	}
}

/// A case as an edit would leave it, with what changes marked.
private struct EditedCaseView: View {
	let document: EditedCase

	var body: some View {
		Panel(document.caseRef ?? "New case") {
			if !document.changes.contains(where: { if case .title = $0 { true } else { false } }) {
				Text(document.after.title).font(.body.weight(.medium))
			}
			ForEach(Array(document.changes.enumerated()), id: \.offset) { _, change in
				switch change {
				case .title(let from, let to):
					if let from { line(from, mark: "−", tint: .fail, struck: true) }
					line(to, mark: "+", tint: .pass).fontWeight(.medium)
				case .pre(let from, let to):
					if !from.isEmpty { line("Before: \(from)", mark: "−", tint: .fail, struck: true) }
					if !to.isEmpty { line("Before: \(to)", mark: "+", tint: .pass) }
				case .placed(let placement):
					line("In \(placement.folder.isEmpty ? "no folder" : placement.folder)", mark: "+", tint: .pass)
					if !placement.tags.isEmpty {
						line("Tags: \(placement.tags.joined(separator: ", "))", mark: "+", tint: .pass)
					}
					if !placement.covers.isEmpty {
						line("Covers: \(placement.covers.joined(separator: ", "))", mark: "+", tint: .pass)
					}
				case .methods(let from, let to):
					if !from.isEmpty { line("Run by: \(from.joined(separator: ", "))", mark: "−", tint: .fail, struck: true) }
					line("Run by: \(to.joined(separator: ", "))", mark: "+", tint: .pass)
				case .automate(let from, let to):
					if !from.isEmpty { line("Automation: \(from)", mark: "−", tint: .fail, struck: true) }
					line("Automation: \(to)", mark: "+", tint: .pass)
				case .fields(let from, let to):
					if !from.isEmpty { line("Fields: \(fields(from))", mark: "−", tint: .fail, struck: true) }
					line("Fields: \(fields(to))", mark: "+", tint: .pass)
				case .kept(let step):
					line(text(step), mark: " ", tint: .secondary)
				case .added(let step):
					line(text(step), mark: "+", tint: .pass)
				case .removed(let step):
					line(text(step), mark: "−", tint: .fail, struck: true)
				case .changed(let from, let to):
					line(text(from), mark: "−", tint: .fail, struck: true)
					line(text(to), mark: "+", tint: .pass)
				}
			}
		}
	}

	private func fields(_ fields: [String: String]) -> String {
		fields.isEmpty ? "none" : fields.sorted { $0.key < $1.key }.map { "\($0.key) = \($0.value)" }.joined(separator: ", ")
	}

	private func text(_ step: Step) -> String {
		step.expected.map { "\(step.action)\n> \($0)" } ?? step.action
	}

	private func line(_ text: String, mark: String, tint: Color, struck: Bool = false) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: 8) {
			Text(mark).font(.callout.monospaced()).foregroundStyle(tint)
			Text(text)
				.font(.callout)
				.strikethrough(struck)
				.foregroundStyle(mark == " " ? Color.primary : tint)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(mark == "+" ? "Added" : mark == "−" ? "Removed" : "Unchanged"): \(text)")
	}
}

private struct SignoffEvidence: View {
	let run: RunToClose

	var body: some View {
		Panel("Run") {
			HStack {
				RefText(run.run)
				Text(run.name).font(.body.weight(.medium))
			}
			Tag(text: run.verdict, tint: run.verdict == "passed" ? .pass : run.verdict == "failed" ? .fail : .warn)
			Text(
				run.tally.filter { $0.value > 0 }.sorted { $0.key < $1.key }.map { "\($0.value) \($0.key)" }
					.joined(separator: " · ")
			)
			.font(.subheadline)
			.foregroundStyle(.secondary)
		}
	}
}
