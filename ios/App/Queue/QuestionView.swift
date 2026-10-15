import MainworthyClient
import MainworthyScreens
import SwiftUI

/// One question, with its evidence and its answers. This is the only place a question is answered.
struct QuestionView: View {
	let ref: String
	let screen: QueueScreen
	let workspace: Workspace
	/// Called once an answer settled the question, to go back to the list.
	let onSettled: () -> Void

	/// The question as it was last in the list. It stays on the page when the list lets go of it.
	@State private var last: Question?
	@State private var asking: Asking?
	@State private var confirming: Chosen?

	/// An answer with the question as it was when the person chose it. What is sent later, from a sheet or a
	/// dialog, is sent on that question: the list may have read newer evidence behind the sheet, and an answer
	/// must not land on evidence its giver did not see. The server then says the evidence changed.
	private struct Chosen: Equatable {
		let choice: Choice
		let question: Question
	}

	/// What a sheet asks before something is sent: an answer's reference and reason, or a withdrawal's reason.
	private enum Asking: Identifiable {
		case answer(Chosen)
		case withdrawal(Question)
		case mapping(Question, creating: Bool)

		var id: String {
			switch self {
			case .answer(let chosen): chosen.choice.answer
			case .withdrawal: "withdraw"
			case .mapping(_, let creating): creating ? "create" : "link"
			}
		}
	}

	private var current: Question? { screen.current(ref) }

	/// Whether the dialog that confirms an accepted edit is up. Dismissed any way, it forgets the answer.
	private var isConfirming: Binding<Bool> {
		Binding(get: { confirming != nil }, set: { shown in if !shown { confirming = nil } })
	}

	var body: some View {
		Group {
			if let question = current ?? last {
				page(question, isGone: current == nil)
			} else if screen.isOpening {
				ProgressView()
			} else {
				ContentUnavailableView {
					Label("This question is not in the list any more", systemImage: "tray")
				} description: {
					Text("It no longer applies, or it could not be read.")
				} actions: {
					Button("Read again") { Task { await screen.open(ref) } }
				}
			}
		}
		.navigationTitle(ref)
		.navigationBarTitleDisplayMode(.inline)
		// The answers are at the foot of the page, where the tab bar would lie over them.
		.toolbar(.hidden, for: .tabBar)
		.toolbar {
			if let address = workspace.webAddress(of: ref) {
				ToolbarItem(placement: .topBarTrailing) {
					Link(destination: address) { Label("Open in the web app", systemImage: "safari") }
				}
			}
		}
		.onChange(of: current, initial: true) { _, now in
			if let now { last = now }
		}
		// The list may not hold this question: it is read by itself for as long as its page is open.
		.task(id: ref) { await screen.open(ref) }
		.onDisappear { screen.close(ref) }
		.sheet(item: $asking) { asking in
			sheet(for: asking)
		}
		.confirmationDialog(
			"Accept this edit?", isPresented: isConfirming, titleVisibility: .visible,
			presenting: confirming
		) { chosen in
			Button(chosen.choice.label) { send(chosen) }
			Button("Cancel", role: .cancel) { confirming = nil }
		} message: { chosen in
			Text("\(chosen.choice.help) An accepted edit is not withdrawn: an earlier version is restored from the case's history.")
		}
	}

	private func page(_ question: Question, isGone: Bool) -> some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				header(question)
				if isGone {
					Label(
						"This question is gone: the failure it asked about went away, or what it was about was removed.",
						systemImage: "info.circle"
					)
					.font(.subheadline)
					.foregroundStyle(.secondary)
				}
				EvidenceView(question: question, screen: screen)
				if !question.advice.isEmpty { advice(question.advice) }
				if let decision = question.decision {
					decided(decision, on: question)
				} else if !isGone {
					answers(question)
				}
			}
			.padding(16)
		}
		.background(Color(.systemGroupedBackground))
		.safeAreaInset(edge: .bottom) {
			// A refusal is said where the answer was given: the list's own bar is under this page.
			if let notice = screen.notice, notice.isProblem {
				Text(notice.text)
					.font(.subheadline)
					.foregroundStyle(Color.fail)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(12)
					.background(.regularMaterial, in: .rect(cornerRadius: 14))
					.padding(.horizontal, 12)
					.padding(.bottom, 6)
					.accessibilityIdentifier("question-notice")
			}
		}
	}

	private func header(_ question: Question) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 6) {
				Tag(text: question.kind.name, tint: question.kind.tint)
				Label("from \(question.producer.name)", systemImage: question.producer.symbol)
					.font(.caption)
					.foregroundStyle(question.producer.tint)
					.lineLimit(1)
				Spacer(minLength: 4)
				// The time keeps its width: a long name beside it is the one that gives way.
				Text(question.openedAt, format: .relative(presentation: .named))
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(1)
					.fixedSize()
			}
			Text(question.title)
				.font(.title3.weight(.semibold))
				.textSelection(.enabled)
			if question.isOpen, !question.stakes.isEmpty {
				Text(question.stakes)
					.font(.subheadline)
					.foregroundStyle(question.isUrgent ? Color.fail : .secondary)
			}
		}
	}

	private func advice(_ advice: [Advice]) -> some View {
		Panel("Advice") {
			ForEach(Array(advice.enumerated()), id: \.offset) { _, given in
				VStack(alignment: .leading, spacing: 2) {
					Label("\(given.by): \(given.label)", systemImage: given.producer.symbol)
						.font(.subheadline.weight(.medium))
					if let reason = given.reason { Text(reason).font(.subheadline).foregroundStyle(.secondary) }
				}
			}
		}
	}

	private func answers(_ question: Question) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Text([needs(question), readOnlyNote].compactMap { $0 }.joined(separator: " "))
				.font(.subheadline)
				.foregroundStyle(.secondary)
			ForEach(question.choices) { choice in
				Button {
					choose(choice, for: question)
				} label: {
					VStack(alignment: .leading, spacing: 3) {
						Text(choice.label).font(.body.weight(.semibold))
						Text(choice.takes == .more ? "This one is answered in the web app." : choice.help)
							.font(.subheadline)
							.foregroundStyle(.secondary)
							.multilineTextAlignment(.leading)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(12)
					.background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
				}
				.buttonStyle(.plain)
				.disabled(!canGive(choice, to: question) || screen.busy.contains(question.ref))
				.opacity(canGive(choice, to: question) ? 1 : 0.5)
				.accessibilityIdentifier("answer-\(choice.answer)")
			}
			if case .unreadable = question.evidence {
				Text("This build cannot show what the question is about, so it does not offer to answer it.")
					.font(.subheadline)
					.foregroundStyle(.secondary)
			}
		}
	}

	/// Whether an answer is this person's to give here: the app can send it, the policy lets them, and they
	/// were shown what the question asks about.
	private func canGive(_ choice: Choice, to question: Question) -> Bool {
		workspace.project?.may(.produce) == true && choice.takes != .more && question.standing != .forbidden
			&& screen.isShown(question)
	}

	/// Who the question waits for, and what this person's answer is worth.
	private func needs(_ question: Question) -> String {
		let waits = "Needs \(question.needs)."
		return switch question.standing {
		case .counts, .unknown: waits
		case .advice: "\(waits) Your answer is recorded as advice."
		case .forbidden: "\(waits) The policy does not let you answer this one."
		}
	}

	/// What the page says where the person's grant on the project does not let them answer at all.
	private var readOnlyNote: String? {
		workspace.project?.may(.produce) == true ? nil : "Your grant on this project lets you read, not answer."
	}

	private func decided(_ decision: Decision, on question: Question) -> some View {
		Panel("Decided") {
			Text(decision.label).font(.body.weight(.semibold))
			Text(
				"\(decision.byRule ? "By the policy's rule" : "By \(decision.by.joined(separator: ", "))") · \(decision.at.formatted(date: .abbreviated, time: .shortened))"
			)
			.font(.subheadline)
			.foregroundStyle(.secondary)
			if let reference = decision.reference { Text("Reference: \(reference)").font(.subheadline) }
			if let reason = decision.reason { Text(reason).font(.subheadline) }
			// An accepted edit is undone in the case's history, not here.
			if question.kind != .adopt {
				Button("Withdraw this decision", role: .destructive) {
					if question.wantsReason { asking = .withdrawal(question) } else { withdraw(question) }
				}
				.disabled(screen.busy.contains(question.ref) || workspace.project?.may(.produce) != true)
				.padding(.top, 4)
				.accessibilityIdentifier("withdraw")
			}
		}
	}

	private func choose(_ choice: Choice, for question: Question) {
		screen.dismissNotice()
		let chosen = Chosen(choice: choice, question: question)
		if question.kind == .map, choice.answer == "link" || choice.answer == "create" {
			screen.beginMapping(question, creating: choice.answer == "create")
			asking = .mapping(question, creating: choice.answer == "create")
		} else if question.wantsReason || choice.takes == .reference {
			asking = .answer(chosen)
		} else if question.kind == .adopt, choice.answer == "accept" {
			confirming = chosen
		} else {
			send(chosen)
		}
	}

	private func send(_ chosen: Chosen, reference: String = "", reason: String = "") {
		confirming = nil
		Task {
			if await screen.answer(chosen.question, with: chosen.choice, reference: reference, reason: reason) {
				onSettled()
			}
		}
	}

	private func withdraw(_ question: Question, reason: String = "") {
		Task {
			if await screen.withdraw(question, reason: reason) { onSettled() }
		}
	}

	@ViewBuilder private func sheet(for asking: Asking) -> some View {
		switch asking {
		case .mapping(let question, let creating):
			MappingSheet(screen: screen.mapping(question, creating: creating), queue: screen)
		case .answer(let chosen):
			let typing = screen.typing(chosen.question.ref)
			AnswerSheet(
				title: chosen.choice.label, help: chosen.choice.help, action: "Record",
				wantsReference: chosen.choice.takes == .reference, wantsReason: chosen.question.wantsReason,
				reference: typing.reference, reason: typing.reason
			) { reference, reason in
				send(chosen, reference: reference, reason: reason)
			}
		case .withdrawal(let question):
			let typing = screen.typing(QueueScreen.withdrawing(question.ref))
			AnswerSheet(
				title: "Withdraw this decision", help: "Both decisions stay in the ledger.", action: "Withdraw",
				wantsReference: false, wantsReason: true, reference: typing.reference, reason: typing.reason
			) { _, reason in
				withdraw(question, reason: reason)
			}
		}
	}
}
