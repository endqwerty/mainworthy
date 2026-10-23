import MainworthyClient
import MainworthyScreens
import SwiftUI

/// What a question asks about, laid out by its kind.
struct EvidenceView: View {
	let question: Question
	let screen: QueueScreen
	let viewport: CGRect
	let workspace: Workspace

	var body: some View {
		switch question.evidence {
		case .failure(let failed): FailureEvidence(failed: failed, timesSeen: question.timesSeen, screen: screen, workspace: workspace)
		case .unlinked(let tests): UnlinkedEvidence(tests: tests)
		case .finding(let finding): FindingEvidence(finding: finding)
		case .proposal(let edit): ProposalEvidence(question: question, edit: edit, screen: screen, viewport: viewport)
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
	let screen: QueueScreen
	let workspace: Workspace

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
			if let sample = failed.sample { sampleEvidence(sample) }
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
				if let location = failed.location {
					ResultLocationView(location: location, workspace: workspace)
				} else {
					Text([failed.target, failed.branch].compactMap { $0 }.joined(separator: " · "))
						.font(.subheadline.monospaced())
				}
				Text(
					"\(failed.count) \(failed.count == 1 ? "test shares" : "tests share") this cause · seen \(timesSeen) \(timesSeen == 1 ? "time" : "times")"
				)
				.font(.subheadline)
				.foregroundStyle(.secondary)
				TestList(tests: failed.tests, count: failed.count)
			}
		}
		.task(id: failed.sample) {
			if let sample = failed.sample { await screen.readSample(sample) }
		}
		.resultAttachments(screen.attachments)
	}

	@ViewBuilder private func sampleEvidence(_ id: Int) -> some View {
		switch screen.sample(id) {
		case .reading, nil: ProgressView("Reading the sample result…")
		case .failed(let why):
			Panel("Sample result could not be read") {
				Text(why).font(.subheadline)
				Button("Try again") { Task { await screen.readSample(id) } }
			}
		case .read(let sample):
			if sample.hasContent {
				Panel("Sample result") {
					if let detail = sample.detail, !detail.isEmpty {
						DisclosureGroup("Diagnostic detail") {
							Text(detail).font(.callout.monospaced()).textSelection(.enabled)
								.frame(maxWidth: .infinity, alignment: .leading)
						}
						.accessibilityIdentifier("sample-detail")
					}
					if let note = sample.note, !note.isEmpty { Text(note).font(.subheadline).textSelection(.enabled) }
					if let build = sample.build { Link("Build", destination: build) }
					if let steps = sample.steps {
						ResultTrailView(steps: steps, result: id, attachments: screen.attachments)
					}
					ForEach(Array(sample.attachments.enumerated()), id: \.offset) { index, name in
						Button {
							Task { await screen.attachments.open(result: id, index: index) }
						} label: {
							Label(name, systemImage: "paperclip").font(.subheadline)
						}
						.buttonStyle(.borderless)
						.accessibilityIdentifier("sample-attachment-\(index)")
					}
				}
			}
		}
	}
}

private struct TestList: View {
	let tests: [TestRef]
	let count: Int
	@Environment(\.dynamicTypeSize) private var dynamicTypeSize

	var body: some View {
		ForEach(tests) { test in
			let stacked = dynamicTypeSize.isAccessibilitySize
			let layout = stacked
				? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
				: AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
			layout {
				HStack(spacing: 8) {
					RefText(test.ref)
					if stacked, let caseRef = test.caseRef { RefText(caseRef) }
				}
				Text(test.name).font(.subheadline)
				if !stacked, let caseRef = test.caseRef {
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
					case .step(let step, let action, let expected):
						// The edit is made to the step the suggestion names, which the finding may not be on.
						Text(step.map { "To step \($0) of \(finding.caseRef ?? "the case")" } ?? "To the case")
							.font(.subheadline.weight(.medium))
						if let action { Text(action) }
						if let expected { Text("> \(expected)").foregroundStyle(Color.pass) }
					case .newCase(let title, let folder, let steps):
						Text("A new case\(folder.map { " in \($0)" } ?? "")").font(.subheadline.weight(.medium))
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
	let viewport: CGRect

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Panel("Why") {
				Text(edit.reason ?? "No reason was given.")
					.foregroundStyle(edit.reason == nil ? .secondary : .primary)
					.textSelection(.enabled)
				Text("Proposed by \(edit.author)").font(.footnote).foregroundStyle(.secondary)
			}
			// A proposal shown whole says all of this in its cases below. One that is not is listed in short.
			if !edit.isShownWhole {
				Panel("What it does") {
					ForEach(Array(edit.summaries.enumerated()), id: \.offset) { _, line in
						Text(line).font(.subheadline)
					}
					if edit.count > edit.summaries.count {
						Text("and \(edit.count - edit.summaries.count) more").font(.footnote).foregroundStyle(.secondary)
					}
				}
			}
			// Once the cases are read, each says whether accepting is refused now, and why.
			ForEach(isRead ? [] : edit.conflicts, id: \.caseRef) { conflict in
				Label(
					"\(conflict.caseRef) changed since this edit was made: \(conflict.addresses.map(\.label).joined(separator: ", ")). Its author resolves it in the web app.",
					systemImage: "exclamationmark.triangle"
				)
				.font(.subheadline)
				.foregroundStyle(Color.warn)
			}
			if edit.notShown != nil {
				Label(
					"This proposal does more than add a case or change what one says: it restores an earlier version, moves, tags, archives or re-covers cases, makes a folder or changes the policy. This build does not show all of that, so it is answered in the web app.",
					systemImage: "info.circle"
				)
				.font(.subheadline)
				.foregroundStyle(.secondary)
			}
			// Fetching supplies the documents; their visible ranges unlock the answers.
			switch screen.documents(of: question) {
			case .read(let documents):
				ForEach(documents) { document in
					EditedCaseView(document: document, waits: question.isOpen, viewport: viewport) { height, top, bottom in
						screen.showProposalRange(of: question, document: document.id, height: height, top: top, bottom: bottom)
					}
					.id("\(QueueScreen.proposalSnapshot(question)) \(document.id)")
				}
			case .notShown(let why):
				Label(why, systemImage: "info.circle")
					.font(.subheadline)
					.foregroundStyle(.secondary)
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

	private var isRead: Bool {
		if case .read = screen.documents(of: question) { true } else { false }
	}
}

/// One case of a proposal. An edit to a case that exists can be read three ways: what it changes, the case as
/// it is, and the case with the edit applied to it. A new case is read as it would be.
private struct EditedCaseView: View {
	let document: EditedCase
	/// Whether the proposal still waits for an answer. A decided one is set against the case as it is now.
	let waits: Bool
	let viewport: CGRect
	let shown: (_ height: Double, _ top: Double, _ bottom: Double) -> Void
	@State private var side = Side.changes

	private enum Side: Hashable {
		case changes, current, proposed
	}

	var body: some View {
		let changes = side == .changes
		let viewport = viewport
		return content
			.onGeometryChange(for: VisibleRange.self) { proxy in
				let frame = proxy.frame(in: .global)
				let visible = frame.intersection(viewport)
				return VisibleRange(
					height: proxy.size.height, top: visible.isNull ? 0 : visible.minY - frame.minY,
					bottom: visible.isNull ? 0 : visible.maxY - frame.minY, changes: changes
				)
			} action: { range in
				if range.changes { shown(range.height, range.top, range.bottom) }
			}
	}

	private struct VisibleRange: Equatable {
		let height: Double
		let top: Double
		let bottom: Double
		let changes: Bool
	}

	@ViewBuilder private var content: some View {
		if let before = document.before, let ref = document.caseRef {
			Panel {
				HStack(spacing: 6) {
					Tag(text: "Edit", tint: .accentColor)
					RefText(ref)
				}
				Text(before.title).font(.headline)
				if let summary = document.summary {
					Text(summary).font(.subheadline).accessibilityIdentifier("edit-summary")
				}
				Picker("Show", selection: $side) {
					Text("Changes").tag(Side.changes)
					Text("Current").tag(Side.current)
					Text("Proposed").tag(Side.proposed)
				}
				.pickerStyle(.segmented)
				.padding(.top, 4)
				.accessibilityIdentifier("edit-side")
				if let refused = document.refused {
					Label("On its own, this edit would be refused: \(refused).", systemImage: "exclamationmark.triangle")
					.font(.subheadline)
					.foregroundStyle(Color.warn)
					.accessibilityIdentifier("edit-refused")
				}
				Text(caption(ref))
					.font(.footnote)
					.foregroundStyle(.secondary)
				Divider()
				switch side {
				case .changes: changes(before)
				case .current: CaseContentView(content: before)
				case .proposed: CaseContentView(content: document.after)
				}
			}
		} else {
			Panel {
				Tag(text: "New case", tint: .pass)
				CaseContentView(content: document.after, placement: document.placement)
			}
		}
	}

	/// Says what each view is, and nothing of what accepting does: that depends on the proposal's other edits and on
	/// what changes before it is answered, and the answer's reply says it.
	private func caption(_ ref: String) -> String {
		switch (side, waits && document.refused == nil) {
		case (.changes, true): "What this edit changes in the case as it is now. Unmarked steps stay as they are."
		case (.changes, false): "The steps as the edit has them, set against the case as it is now. Unmarked steps stay as they are."
		case (.current, true): "\(ref) as it is now. Rejecting leaves it so."
		case (.current, false): "\(ref) as it is now."
		case (.proposed, true): "\(ref) with this edit applied to it as it is now."
		case (.proposed, false): "\(ref) as the edit has it."
		}
	}

	@ViewBuilder private func changes(_ before: CaseContent) -> some View {
		ForEach(Array(document.changes.enumerated()), id: \.offset) { _, change in
			switch change {
			case .title(let from, let to): ChangedPart(name: "Title", from: from, to: to)
			case .pre(let from, let to): ChangedPart(name: "Preconditions", from: from, to: to)
			case .methods(let from, let to): ChangedPart(name: "Who may run it", from: methods(from), to: methods(to))
			case .automate(let from, let to): ChangedPart(name: "Automation", from: from, to: to)
			case .fields(let from, let to):
				ForEach(Set(from.keys).union(to.keys).filter { from[$0] != to[$0] }.sorted(), id: \.self) { key in
					ChangedPart(name: key, from: from[key], to: to[key])
				}
			// Only a new case is placed, and a new case is not shown as changes.
			case .placed: EmptyView()
			case .kept(let step): StepRow(number: number(step, in: document.after), step: step, mark: nil)
			case .added(let step): StepRow(number: number(step, in: document.after), step: step, mark: .added)
			case .removed(let step): StepRow(number: number(step, in: before), step: step, mark: .removed)
			case .changed(let from, let to):
				StepRow(number: number(to, in: document.after), step: to, mark: .changed(from: from))
			case .moved(let from, let to):
				StepRow(
					number: number(to, in: document.after), step: to,
					mark: .moved(from: from, was: number(from, in: before))
				)
			}
		}
	}

	private func number(_ step: Step, in content: CaseContent) -> Int {
		(content.steps.firstIndex { $0.id == step.id } ?? 0) + 1
	}

	private func methods(_ methods: [String]) -> String {
		methods.isEmpty ? "nobody" : methods.map { CaseMethod(rawValue: $0)?.label ?? $0 }.joined(separator: ", ")
	}
}

/// A part of a case other than a step that an edit changes: what it is now, and what it would be.
private struct ChangedPart: View {
	let name: String
	let from: String?
	let to: String?

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(name).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
			ChangeSide(label: "Current", tint: .fail) { Text(said(from)).strikethrough() }
			ChangeSide(label: "Proposed", tint: .pass) { Text(said(to)) }
		}
		.padding(.vertical, 4)
	}

	private func said(_ value: String?) -> String {
		guard let value, !value.isEmpty else { return "none" }
		return value
	}
}

/// One step in the list of changes, by the number it has in the case it is shown in.
private struct StepRow: View {
	let number: Int
	let step: Step
	let mark: Mark?

	enum Mark {
		case added, removed
		case changed(from: Step)
		/// From the step's number in the case as it is, and as it was there.
		case moved(from: Step, was: Int)
	}

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 10) {
			Text("\(number)")
				.font(.subheadline.weight(.semibold).monospacedDigit())
				.foregroundStyle(tint ?? .secondary)
				.frame(minWidth: 20, alignment: .trailing)
			VStack(alignment: .leading, spacing: 6) {
				switch mark {
				case nil:
					StepText(step: step)
				case .added:
					Tag(text: "Added", tint: .pass)
					StepText(step: step).foregroundStyle(Color.pass)
				case .removed:
					Tag(text: "Removed", tint: .fail)
					StepText(step: step, struck: true).foregroundStyle(Color.fail)
				case .changed(let from):
					Tag(text: "Changed", tint: .warn)
					ChangeSide(label: "Current", tint: .fail) { StepText(step: from, struck: true) }
					ChangeSide(label: "Proposed", tint: .pass) { StepText(step: step) }
				case .moved(let from, let was):
					Tag(text: "Moved from step \(was)", tint: .accentColor)
					if from == step {
						StepText(step: step)
					} else {
						ChangeSide(label: "Current", tint: .fail) { StepText(step: from, struck: true) }
						ChangeSide(label: "Proposed", tint: .pass) { StepText(step: step) }
					}
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(8)
		.background((tint ?? .clear).opacity(0.08), in: .rect(cornerRadius: 8))
		.accessibilityIdentifier("edit-step-\(number)")
	}

	private var tint: Color? {
		switch mark {
		case nil: nil
		case .added: .pass
		case .removed: .fail
		case .changed: .warn
		case .moved: .accentColor
		}
	}
}

/// One side of a change, said in words: "Current" or "Proposed".
private struct ChangeSide<Content: View>: View {
	let label: String
	let tint: Color
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
			content.foregroundStyle(tint)
		}
	}
}

/// A step's action, and under it what must be true afterwards.
private struct StepText: View {
	let step: Step
	var struck = false

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(step.action).strikethrough(struck)
			if let expected = step.expected {
				Text("Expected: \(expected)").font(.subheadline).strikethrough(struck).opacity(0.85)
			}
		}
	}
}

/// A case read whole: its title, preconditions, numbered steps, who may run it, and where a new one goes.
private struct CaseContentView: View {
	let content: CaseContent
	var placement: EditedCase.Placement?

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Text(content.title).font(.body.weight(.semibold))
			if !content.pre.isEmpty { part("Preconditions") { Text(content.pre) } }
			part("Steps") {
				if content.steps.isEmpty { Text("No steps").foregroundStyle(.secondary) }
				ForEach(Array(content.steps.enumerated()), id: \.element.id) { index, step in
					HStack(alignment: .firstTextBaseline, spacing: 10) {
						Text("\(index + 1)")
							.font(.subheadline.weight(.semibold).monospacedDigit())
							.foregroundStyle(.secondary)
							.frame(minWidth: 20, alignment: .trailing)
						StepText(step: step)
					}
				}
			}
			part("Who may run it") { MethodBadges(methods: content.methods) }
			if content.automate != "none" { part("Automation") { Text(content.automate) } }
			if !content.fields.isEmpty {
				part("Fields") {
					ForEach(content.fields.sorted { $0.key < $1.key }, id: \.key) { key, value in Text("\(key): \(value)") }
				}
			}
			if let placement {
				part("Folder") { Text(placement.folder.isEmpty ? "No folder" : placement.folder) }
				if !placement.tags.isEmpty { part("Tags") { Text(placement.tags.joined(separator: ", ")) } }
				if !placement.covers.isEmpty { part("Covers") { Text(placement.covers.joined(separator: ", ")) } }
			}
		}
		.textSelection(.enabled)
	}

	private func part(_ name: String, @ViewBuilder content: () -> some View) -> some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(name).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
			content()
		}
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
