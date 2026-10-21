import MainworthyClient
import MainworthyScreens
import SwiftUI

/// The queue: what waits for an answer, or what was decided. A question is answered from its own page, where
/// its evidence is, or with others of its kind after Select (decision 0088).
struct QueueView: View {
	let screen: QueueScreen
	let workspace: Workspace
	@State private var path: [String] = []

	/// Whether Select is offered: on the open questions, to a person who may answer.
	private var canSelect: Bool { screen.showing == .open && workspace.project?.may(.produce) == true }

	@ViewBuilder private var selectButton: some View {
		if screen.isSelecting {
			Button("Done") { screen.select(false) }
				.buttonStyle(.glassProminent)
				.accessibilityIdentifier("queue-select")
		} else {
			Button("Select") { screen.select(true) }.accessibilityIdentifier("queue-select")
		}
	}

	private var unsentLink: some View {
		NavigationLink {
			UnsentAnswersView(screen: screen)
		} label: {
			Label("Unsent answers (\(screen.outbox.pendingCount))", systemImage: "tray.and.arrow.up")
		}
		.accessibilityIdentifier("unsent-answers")
	}

	private var showingPicker: some View {
		Picker("Show", selection: showing) {
			Text("Open").tag(QueueScreen.Showing.open)
			Text("Decided").tag(QueueScreen.Showing.decided)
		}
		.pickerStyle(.segmented)
		.accessibilityIdentifier("queue-showing")
	}

	var body: some View {
		NavigationStack(path: $path) {
			list
				// The tab says Queue. The bar keeps its room for the project, Unsent answers and Select, as Photos
				// and Files keep Select at the top right; Open and Decided are the segmented control under it.
				.navigationTitle("Queue")
				.navigationBarTitleDisplayMode(.inline)
				.toolbar(removing: .title)
				.toolbar {
					// While selecting, the bar holds only what selecting needs, as Photos and Files do.
					if !screen.isSelecting {
						ProjectMenu(workspace: workspace)
						ToolbarItem(placement: .topBarTrailing) { unsentLink }
					}
					if canSelect {
						// A text action stands apart from the symbol beside it, so the two do not read as one button.
						ToolbarSpacer(.fixed, placement: .topBarTrailing)
						ToolbarItem(placement: .topBarTrailing) { selectButton }
					}
				}
				.modifier(SelectionMode(screen: screen))
				.navigationDestination(for: String.self) { ref in
					QuestionView(ref: ref, screen: screen, workspace: workspace) { path.removeAll() }
				}
				// Open and Decided and the kinds stay under the bar, as the bar does: pulling to refresh moves the
				// questions under them, and choosing another list keeps them in place while it is read.
				.safeAreaBar(edge: .top) { showingBar }
				.safeAreaBar(edge: .bottom) { NoticeBar(screen: screen) }
		}
		.task { await screen.show(screen.showing, filter: screen.filter) }
	}

	private var showing: Binding<QueueScreen.Showing> {
		Binding(
			get: { screen.showing },
			set: { chosen in Task { await screen.show(chosen, filter: screen.filter) } }
		)
	}

	private var showingBar: some View {
		VStack(spacing: 8) {
			showingPicker.padding(.trailing, 16)
			Filters(screen: screen)
		}
		.padding(.leading, 16)
		.padding(.top, 4)
	}

	@ViewBuilder private var list: some View {
		switch screen.loading {
		case .first, .reading:
			ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
		case .failed(let why):
			ContentUnavailableView {
				Label("The queue could not be read", systemImage: "exclamationmark.triangle")
			} description: {
				Text(why)
			} actions: {
				Button("Try again") { Task { await screen.refresh() } }
			}
		case .done:
			List {
				Section {
					ForEach(screen.questions) { question in
						if screen.isSelecting {
							SelectableRow(question: question, screen: screen)
						} else {
							NavigationLink(value: question.ref) { QuestionRow(question: question) }
								.accessibilityIdentifier("question-\(question.ref)")
						}
					}
					if screen.hasMore {
						ProgressView()
							.frame(maxWidth: .infinity)
							.task { await screen.more() }
					}
				} footer: {
					// An empty list says so once, in the middle.
					if screen.showing == .open, !screen.questions.isEmpty { Text(screen.counts.phrase.capitalizedFirst) }
				}
				if screen.questions.isEmpty {
					ListPlaceholder {
						ContentUnavailableView(
							screen.showing == .open ? "Nothing needs an answer" : "Nothing was decided yet",
							systemImage: screen.showing == .open ? "checkmark.circle" : "tray"
						)
					}
				}
			}
			.listStyle(.plain)
			.holdsPlaceholder()
			.refreshable { await screen.refresh() }
		}
	}
}

/// The kinds to show one of, each with how many are open.
private struct Filters: View {
	let screen: QueueScreen

	var body: some View {
		ScrollView(.horizontal) {
			HStack(spacing: 8) {
				chip("All", count: screen.counts.open, kind: nil)
				ForEach(Kind.known, id: \.self) { kind in
					chip(kind.plural, count: screen.counts.open(of: kind), kind: kind)
				}
			}
			.padding(.vertical, 6)
		}
		.scrollIndicators(.hidden)
	}

	private func chip(_ name: String, count: Int, kind: Kind?) -> some View {
		let chosen = screen.filter == kind
		return Button {
			Task { await screen.show(screen.showing, filter: kind) }
		} label: {
			HStack(spacing: 4) {
				Text(name)
				// The counts are of what is open, whichever list is shown.
				if screen.showing == .open { Text("\(count)").foregroundStyle(chosen ? .white.opacity(0.8) : .secondary) }
			}
			.font(.subheadline)
			.padding(.horizontal, 10)
			.padding(.vertical, 5)
			.foregroundStyle(chosen ? .white : .primary)
			.background(chosen ? Color.accentColor : Color(.tertiarySystemFill), in: .capsule)
		}
		.buttonStyle(.plain)
		.accessibilityAddTraits(chosen ? .isSelected : [])
	}
}

private struct QuestionRow: View {
	let question: Question

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 6) {
				Image(systemName: question.producer.symbol)
					.font(.caption)
					.foregroundStyle(question.producer.tint)
					.accessibilityLabel("From \(question.producer.name)")
				RefText(question.ref)
				Tag(text: question.kind.name, tint: question.kind.tint)
				if question.isOpen && !question.blocks.isEmpty { Tag(text: "blocks \(question.blocks.joined(separator: ", "))", tint: .fail) }
				Spacer()
				Text(question.decision?.at ?? question.openedAt, format: .relative(presentation: .named))
					.font(.caption)
					.foregroundStyle(.secondary)
			}
			Text(question.title)
				.font(.body)
				.lineLimit(2)
			if let decision = question.decision {
				Text("\(decision.label) · \(decision.byRule ? "by rule" : decision.by.joined(separator: ", "))\(decision.ending == nil ? "" : " · ended")")
					.font(.footnote)
					.foregroundStyle(.secondary)
			}
		}
		.padding(.vertical, 2)
	}
}

/// A row while the list selects: a press adds the question to the selection or takes it out, and a question
/// that cannot join is drawn faint and says why when pressed.
private struct SelectableRow: View {
	let question: Question
	let screen: QueueScreen

	var body: some View {
		let chosen = screen.selected.contains(question.ref)
		let joins = chosen || screen.whyNotSelectable(question) == nil
		Button {
			screen.toggle(question)
		} label: {
			HStack(spacing: 12) {
				Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
					.font(.title3)
					.foregroundStyle(chosen ? Color.accentColor : Color.secondary)
					.accessibilityHidden(true)
				QuestionRow(question: question).opacity(joins ? 1 : 0.45)
			}
			.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.accessibilityAddTraits(chosen ? .isSelected : [])
		.accessibilityIdentifier("select-\(question.ref)")
	}
}

/// Selecting, as Photos and Files select: the tab bar gives way to a bottom toolbar that says what is selected and
/// holds the answer, Select All is at the top left, and Done at the top right ends it.
private struct SelectionMode: ViewModifier {
	let screen: QueueScreen
	@State private var asking: Chosen?
	@State private var confirming: Chosen?

	/// An answer with the questions as they were shown when the person chose it. What a sheet or a dialog sends
	/// later is sent on those: the list may read newer evidence behind it, and an answer must not land on
	/// evidence its giver did not see.
	private struct Chosen: Identifiable {
		let id = UUID()
		let choice: Choice
		let questions: [Question]

		/// "12 failures", for the questions the answer goes to.
		var what: String { questions.isEmpty ? "the selected questions" : questions.counted }
	}

	func body(content: Content) -> some View {
		content
			.toolbar(screen.isSelecting ? .hidden : .automatic, for: .tabBar)
			.toolbar {
				if screen.isSelecting {
					ToolbarItem(placement: .topBarLeading) { selectAll }
					// The count is a label, not a control: on glass of its own it would read as a button.
					ToolbarItem(placement: .status) { status }.sharedBackgroundVisibility(.hidden)
					ToolbarSpacer(.flexible, placement: .bottomBar)
					// The button is glass of its own: the bar's glass behind it would show as a wider capsule.
					ToolbarItem(placement: .bottomBar) { answer }.sharedBackgroundVisibility(.hidden)
				}
			}
			.sheet(item: $asking) { chosen in
				let typing = screen.typing(QueueScreen.selectionTyping)
				AnswerSheet(
					title: chosen.choice.label, help: "\(chosen.choice.help) It goes to each of the \(chosen.what).",
					action: "Record", wantsReference: chosen.choice.takes == .reference,
					wantsReason: chosen.questions.contains(where: \.wantsReason), reference: typing.reference,
					reason: typing.reason
				) { reference, reason in
					Task { await screen.answerAll(chosen.questions, with: chosen.choice, reference: reference, reason: reason) }
				}
			}
	}

	/// Select All, of the selection's kind or the kind the list shows; Deselect All once all of them are selected.
	@ViewBuilder private var selectAll: some View {
		let selection = screen.selection
		let all = screen.selectable
		if all.count > selection.count {
			Button("Select All") { screen.selectAll() }
				.accessibilityLabel("Select all \(all.counted)")
				.accessibilityIdentifier("select-all")
		} else if !selection.isEmpty {
			Button("Deselect All") { screen.clearSelection() }.accessibilityIdentifier("select-clear")
		}
	}

	private var status: some View {
		let selection = screen.selection
		let text: String =
			if !selection.isEmpty {
				screen.sharedChoices.isEmpty
					? "No answer fits all \(selection.count)"
					: "\(selection.counted) selected"
			} else {
				"Select questions"
			}
		return Text(text)
			.font(.subheadline.weight(selection.isEmpty ? .regular : .semibold))
			.foregroundStyle(selection.isEmpty ? .secondary : .primary)
			.fixedSize()
			.accessibilityIdentifier("selection-count")
	}

	private var answer: some View {
		Menu {
			ForEach(screen.sharedChoices) { choice in
				Button(choice.label) { choose(choice) }.accessibilityIdentifier("bulk-\(choice.answer)")
			}
		} label: {
			// In a toolbar a label shows its symbol alone: the word says what this does.
			Text("Answer").fontWeight(.semibold)
		}
		.menuStyle(.button)
		.buttonStyle(.glassProminent)
		.tint(.accentColor)
		// The confirmation comes from the button that asked for it, as an action sheet's source should.
		.confirmationDialog(
			"\(confirming?.choice.label ?? "Answer") for \(confirming?.what ?? "the selected questions")?",
			isPresented: isConfirming, titleVisibility: .visible, presenting: confirming
		) { chosen in
			Button(chosen.choice.label) {
				confirming = nil
				Task { await screen.answerAll(chosen.questions, with: chosen.choice) }
			}
			.accessibilityIdentifier("bulk-confirm")
			Button("Cancel", role: .cancel) { confirming = nil }
		} message: { chosen in
			Text(message(for: chosen))
		}
		.disabled(screen.selection.isEmpty || screen.sharedChoices.isEmpty || !screen.busy.isDisjoint(with: screen.selected))
		.accessibilityIdentifier("bulk-answer")
	}

	private var isConfirming: Binding<Bool> {
		Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })
	}

	private func choose(_ choice: Choice) {
		screen.dismissNotice()
		let chosen = Chosen(choice: choice, questions: screen.selection)
		if choice.takes == .reference || chosen.questions.contains(where: \.wantsReason) {
			asking = chosen
		} else {
			confirming = chosen
		}
	}

	private func message(for chosen: Chosen) -> String {
		let makes = chosen.choice.answer == "create"
			? " The server makes and links \(chosen.questions.unlinkedTests) automated cases, one for each of their tests."
			: ""
		return "\(chosen.choice.help)\(makes) They are sent together. Each question gets its own decision, and Undo withdraws them together."
	}
}

/// What the last action came to, with Undo where an answer can be withdrawn.
private struct NoticeBar: View {
	let screen: QueueScreen
	/// The question whose withdrawal waits for a reason, where the policy asks for one.
	@State private var asking: Question?
	/// The questions of one answer to a selection, whose withdrawal waits for a reason.
	@State private var askingAll: [Question]?

	var body: some View {
		if let notice = screen.notice {
			HStack(alignment: .firstTextBaseline, spacing: 12) {
				Text(notice.text)
					.font(.subheadline)
					.foregroundStyle(notice.isProblem ? Color.fail : .primary)
					.frame(maxWidth: .infinity, alignment: .leading)
					.accessibilityIdentifier("notice")
				if let question = notice.undoes {
					Button("Undo") {
						// Withdrawing is a decision too. Where the policy asks for a reason, so does this.
						if question.wantsReason { asking = question } else { Task { await screen.withdraw(question) } }
					}
					.fontWeight(.semibold)
					.disabled(screen.busy.contains(question.ref))
				} else if !notice.undoesAll.isEmpty {
					Button("Undo") {
						if notice.undoesAll.contains(where: \.wantsReason) {
							askingAll = notice.undoesAll
						} else {
							Task { await screen.withdrawAll(notice.undoesAll) }
						}
					}
					.fontWeight(.semibold)
					.disabled(!screen.busy.isDisjoint(with: notice.undoesAll.map(\.ref)))
					.accessibilityIdentifier("undo-all")
				}
				Button {
					screen.dismissNotice()
				} label: {
					Image(systemName: "xmark")
				}
				.foregroundStyle(.secondary)
				.accessibilityLabel("Dismiss")
			}
			.floatingBar()
			.transition(.move(edge: .bottom).combined(with: .opacity))
			.sheet(item: $asking) { question in
				let typing = screen.typing(QueueScreen.withdrawing(question.ref))
				AnswerSheet(
					title: "Withdraw this decision", help: "Both decisions stay in the ledger.", action: "Withdraw",
					wantsReference: false, wantsReason: true, reference: typing.reference, reason: typing.reason
				) { _, reason in
					Task { await screen.withdraw(question, reason: reason) }
				}
			}
			.sheet(isPresented: Binding(get: { askingAll != nil }, set: { if !$0 { askingAll = nil } })) {
				let questions = askingAll ?? []
				let typing = screen.typing(QueueScreen.withdrawing(QueueScreen.selectionTyping))
				AnswerSheet(
					title: "Withdraw \(questions.count) decisions", help: "Every decision stays in the ledger.",
					action: "Withdraw", wantsReference: false, wantsReason: true, reference: typing.reference,
					reason: typing.reason
				) { _, reason in
					Task { await screen.withdrawAll(questions, reason: reason) }
				}
			}
		}
	}
}

extension String {
	/// A sentence that begins lower case, begun with a capital.
	var capitalizedFirst: String {
		prefix(1).uppercased() + dropFirst()
	}
}

private struct UnsentAnswersView: View {
	let screen: QueueScreen
	@State private var chosen: AnswerOutbox.Entry?
	@State private var forgetting = false
	private var confirming: Binding<Bool> {
		Binding(get: { chosen != nil }, set: { if !$0 { chosen = nil } })
	}

	@ViewBuilder private func entryRows(_ entry: AnswerOutbox.Entry) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(entry.questions.count == 1 ? "\(entry.question): \(entry.title)" : "\(entry.label) for \(entry.title)")
				.font(.headline)
			if entry.questions.count == 1 { Text(entry.label) }
			Text(entry.status).font(.subheadline.weight(.semibold))
			Text(entry.detail).font(.subheadline).foregroundStyle(.secondary)
		}
		.accessibilityIdentifier("saved-answer-\(entry.question)")
		if entry.questions.count == 1 {
			NavigationLink("Read \(entry.question)", value: entry.question)
		} else {
			ForEach(entry.members, id: \.question) { member in
				NavigationLink(value: member.question) {
					VStack(alignment: .leading, spacing: 2) {
						Text("\(member.question): \(member.title)").lineLimit(2)
						if let outcome = member.outcome {
							Text(AnswerOutbox.Entry.status(of: outcome)).font(.footnote).foregroundStyle(.secondary)
						}
					}
				}
			}
		}
		if screen.outbox.stuck?.id == entry.id {
			Button("Keep trying") { Task { await screen.refresh() } }
				.disabled(screen.outbox.sending)
				.accessibilityIdentifier("retry-saved-answer")
			Button("Drop saved answer", role: .destructive) {
				forgetting = false
				chosen = entry
			}
			.disabled(screen.outbox.sending)
			.accessibilityIdentifier("drop-saved-answer")
			Text("Drop checks the server first. Only definite rejections can be removed now. An answer that may still arrive stays as Dropped, never sends again, and is checked on each send pass. After 24 hours you can forget it with confirmation. Later answers resume in order.")
				.font(.footnote).foregroundStyle(.secondary)
		}

		if screen.outbox.canForget(entry.id) {
			Button("Forget", role: .destructive) {
				forgetting = true
				chosen = entry
			}
			.disabled(screen.outbox.sending)
			.accessibilityIdentifier("forget-saved-answer")
		}
	}

	var body: some View {
		TimelineView(.periodic(from: .now, by: 1)) { _ in answers }
	}

	@ViewBuilder private var answers: some View {
		let outbox = screen.outbox
		let waiting = outbox.entries.filter { !$0.finished }
		let replied = outbox.entries.filter(\.finished)
		List {
			Section {
				if waiting.isEmpty {
					Text("Nothing is waiting to send.").accessibilityIdentifier("nothing-waiting")
				}
				Text("Answers stay on this device when the app closes. Keep the app open to send them when the connection returns.")
					.font(.subheadline).foregroundStyle(.secondary)
				if let problem = outbox.storageProblem { Text(problem).foregroundStyle(Color.fail) }
				if let problem = outbox.dropProblem { Text(problem).foregroundStyle(Color.fail) }
				if !waiting.isEmpty {
					Button(outbox.sending ? "Sending…" : outbox.hasDropped ? "Send waiting answers and check dropped" : "Send waiting answers") {
						Task { await screen.refresh() }
					}
					.disabled(outbox.sending)
					.accessibilityIdentifier("send-waiting-answers")
				}
			} header: {
				if !waiting.isEmpty { Text("No reply yet") }
			}
			ForEach(waiting) { entry in
				Section { entryRows(entry) }
			}
			if !replied.isEmpty {
				Section {
					Text("Completed and obsolete answers stay here until you clear them from this device.")
						.font(.subheadline).foregroundStyle(.secondary)
					Button("Clear outcomes") { outbox.clearOutcomes() }
				} header: {
					Text("Finished").accessibilityIdentifier("replied-header")
				}
				ForEach(replied) { entry in
					Section { entryRows(entry) }
				}
			}
		}
		.navigationTitle("Unsent answers")
		.navigationBarTitleDisplayMode(.inline)
		.toolbar(.hidden, for: .tabBar)
		.confirmationDialog(
			chosen.map { entry in
				let action = forgetting ? "Forget" : "Drop"
				return entry.questions.count == 1 ? "\(action) saved answer for \(entry.question)?" : "\(action) the saved answer for \(entry.questions.count) questions?"
			} ?? "Saved answer?",
			isPresented: confirming,
			titleVisibility: .visible, presenting: chosen
		) { entry in
			if forgetting {
				Button("Forget", role: .destructive) {
					chosen = nil
					screen.outbox.forget(entry.id, confirmed: true)
				}
			} else {
				Button("Drop saved answer", role: .destructive) {
					chosen = nil
					Task { await screen.outbox.drop(entry.id) }
				}
			}
			Button("Cancel", role: .cancel) { chosen = nil }
		} message: { _ in
			if forgetting {
				Text("This answer may still have been recorded. If you forget it, its outcome will no longer show here. This removes the saved entry from this device.")
			} else {
				Text("This stops retrying the answer and lets later answers send. A request already on its way may still be recorded. If any request may still arrive, a Dropped entry stays until the server reports an outcome or you confirm Forget after 24 hours.")
			}
		}
	}
}

