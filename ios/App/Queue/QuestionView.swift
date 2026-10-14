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
	@State private var confirming: Choice?

	/// What a sheet asks before something is sent: an answer's reference and reason, or a withdrawal's reason.
	private enum Asking: Identifiable {
		case answer(Choice)
		case withdrawal

		var id: String {
			switch self {
			case .answer(let choice): choice.answer
			case .withdrawal: "withdraw"
			}
		}
	}

	private var current: Question? { screen.current(ref) }

	var body: some View {
		Group {
			if let question = current ?? last {
				page(question, isGone: current == nil)
			} else {
				ContentUnavailableView("This question is not in the list any more", systemImage: "tray")
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
		.sheet(item: $asking) { asking in
			sheet(for: asking)
		}
		.confirmationDialog(
			"Accept this edit?", isPresented: .constant(confirming != nil), titleVisibility: .visible,
			presenting: confirming
		) { choice in
			Button(choice.label) { send(choice) }
			Button("Cancel", role: .cancel) { confirming = nil }
		} message: { choice in
			Text("\(choice.help) An accepted edit is not withdrawn: an earlier version is restored from the case's history.")
		}
	}

	private func page(_ question: Question, isGone: Bool) -> some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				header(question)
				if isGone {
					Label(
						"This question left the list while it was open here: it was answered, or it no longer applies.",
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
				Spacer()
				Text(question.openedAt, format: .relative(presentation: .named))
					.font(.caption)
					.foregroundStyle(.secondary)
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
			Text(needs(question))
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
				.disabled(choice.takes == .more || question.standing == .forbidden || screen.busy.contains(question.ref))
				.opacity(choice.takes == .more || question.standing == .forbidden ? 0.5 : 1)
				.accessibilityIdentifier("answer-\(choice.answer)")
			}
			if case .unreadable = question.evidence {
				Text("This build cannot show what the question is about, so it does not offer to answer it.")
					.font(.subheadline)
					.foregroundStyle(.secondary)
			}
		}
	}

	/// Who the question waits for, and what this person's answer is worth.
	private func needs(_ question: Question) -> String {
		let waits = "Needs \(question.needs)."
		return switch question.standing {
		case .counts: waits
		case .advice: "\(waits) Your answer is recorded as advice."
		case .forbidden: "\(waits) The policy does not let you answer this one."
		}
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
					if question.wantsReason { asking = .withdrawal } else { withdraw(question) }
				}
				.disabled(screen.busy.contains(question.ref))
				.padding(.top, 4)
				.accessibilityIdentifier("withdraw")
			}
		}
	}

	private func choose(_ choice: Choice, for question: Question) {
		screen.dismissNotice()
		if question.wantsReason || choice.takes == .reference {
			asking = .answer(choice)
		} else if question.kind == .adopt, choice.answer == "accept" {
			confirming = choice
		} else {
			send(choice)
		}
	}

	private func send(_ choice: Choice, reference: String = "", reason: String = "") {
		confirming = nil
		guard let question = current else { return }
		Task {
			if await screen.answer(question, with: choice, reference: reference, reason: reason) { onSettled() }
		}
	}

	private func withdraw(_ question: Question, reason: String = "") {
		Task {
			await screen.withdraw(question, reason: reason)
			onSettled()
		}
	}

	@ViewBuilder private func sheet(for asking: Asking) -> some View {
		let wantsReason = (current ?? last)?.wantsReason ?? false
		switch asking {
		case .answer(let choice):
			AnswerSheet(
				title: choice.label, help: choice.help, action: "Record", wantsReference: choice.takes == .reference,
				wantsReason: wantsReason
			) { reference, reason in
				send(choice, reference: reference, reason: reason)
			}
		case .withdrawal:
			AnswerSheet(
				title: "Withdraw this decision", help: "Both decisions stay in the ledger.", action: "Withdraw",
				wantsReference: false, wantsReason: true
			) { _, reason in
				if let question = current ?? last { withdraw(question, reason: reason) }
			}
		}
	}
}

/// What an answer takes beside itself: where a defect is tracked, and the reason the policy asks for.
private struct AnswerSheet: View {
	let title: String
	let help: String
	let action: String
	let wantsReference: Bool
	let wantsReason: Bool
	let onSubmit: (_ reference: String, _ reason: String) -> Void

	@State private var reference = ""
	@State private var reason = ""
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			Form {
				Section {
					Text(help).foregroundStyle(.secondary)
				}
				if wantsReference {
					Section {
						TextField("SHOP-482, or a link", text: $reference)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
							.accessibilityIdentifier("reference")
					} header: {
						Text("Where it is tracked")
					} footer: {
						Text("Optional.")
					}
				}
				if wantsReason {
					Section {
						TextField("Why", text: $reason, axis: .vertical)
							.lineLimit(3...8)
							.accessibilityIdentifier("reason")
					} header: {
						Text("Reason")
					} footer: {
						Text("The policy of this project asks for one.")
					}
				}
			}
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button(action) {
						onSubmit(reference, reason)
						dismiss()
					}
					.disabled(wantsReason && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
					.accessibilityIdentifier("submit-answer")
				}
			}
		}
		.presentationDetents([.medium, .large])
	}
}
