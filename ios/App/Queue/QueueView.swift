import MainworthyClient
import MainworthyScreens
import SwiftUI

/// The queue: what waits for an answer, or what was decided. A question is answered from its own page, where
/// its evidence is, and never from this list: nobody decides what they have not opened.
struct QueueView: View {
	let screen: QueueScreen
	let workspace: Workspace
	@State private var path: [String] = []

	var body: some View {
		NavigationStack(path: $path) {
			list
				.navigationTitle("Queue")
				.navigationBarTitleDisplayMode(.inline)
				.toolbar {
					ProjectMenu(workspace: workspace)
					ToolbarItem(placement: .topBarTrailing) {
						NavigationLink {
							UnsentAnswersView(screen: screen)
						} label: {
							Label("Unsent answers (\(screen.outbox.pendingCount))", systemImage: "tray.and.arrow.up")
						}
						.accessibilityIdentifier("unsent-answers")
					}
					ToolbarItem(placement: .principal) {
						Picker("Show", selection: showing) {
							Text("Open").tag(QueueScreen.Showing.open)
							Text("Decided").tag(QueueScreen.Showing.decided)
						}
						.pickerStyle(.segmented)
						.frame(maxWidth: 200)
					}
				}
				.navigationDestination(for: String.self) { ref in
					QuestionView(ref: ref, screen: screen, workspace: workspace) { path.removeAll() }
				}
				.safeAreaInset(edge: .bottom) { NoticeBar(screen: screen) }
		}
		.task { await screen.show(screen.showing, filter: screen.filter) }
	}

	private var showing: Binding<QueueScreen.Showing> {
		Binding(
			get: { screen.showing },
			set: { chosen in Task { await screen.show(chosen, filter: screen.filter) } }
		)
	}

	@ViewBuilder private var list: some View {
		switch screen.loading {
		case .first:
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
						NavigationLink(value: question.ref) { QuestionRow(question: question) }
							.accessibilityIdentifier("question-\(question.ref)")
					}
					if screen.hasMore {
						ProgressView()
							.frame(maxWidth: .infinity)
							.task { await screen.more() }
					}
				} header: {
					Filters(screen: screen)
				} footer: {
					if screen.showing == .open { Text(screen.counts.phrase.capitalizedFirst) }
				}
			}
			.listStyle(.plain)
			.refreshable { await screen.refresh() }
			.overlay {
				if screen.questions.isEmpty {
					ContentUnavailableView(
						screen.showing == .open ? "Nothing needs an answer" : "Nothing was decided yet",
						systemImage: screen.showing == .open ? "checkmark.circle" : "tray"
					)
				}
			}
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
		.listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 0))
		.textCase(nil)
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
				if !question.blocks.isEmpty { Tag(text: "blocks \(question.blocks.joined(separator: ", "))", tint: .fail) }
				Spacer()
				Text(question.decision?.at ?? question.openedAt, format: .relative(presentation: .named))
					.font(.caption)
					.foregroundStyle(.secondary)
			}
			Text(question.title)
				.font(.body)
				.lineLimit(2)
			if let decision = question.decision {
				Text("\(decision.label) · \(decision.byRule ? "by rule" : decision.by.joined(separator: ", "))")
					.font(.footnote)
					.foregroundStyle(.secondary)
			}
		}
		.padding(.vertical, 2)
	}
}

/// What the last action came to, with Undo where an answer can be withdrawn.
private struct NoticeBar: View {
	let screen: QueueScreen
	/// The question whose withdrawal waits for a reason, where the policy asks for one.
	@State private var asking: Question?

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
				}
				Button {
					screen.dismissNotice()
				} label: {
					Image(systemName: "xmark")
				}
				.foregroundStyle(.secondary)
				.accessibilityLabel("Dismiss")
			}
			.padding(12)
			.background(.regularMaterial, in: .rect(cornerRadius: 14))
			.padding(.horizontal, 12)
			.padding(.bottom, 6)
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
	private var confirming: Binding<Bool> {
		Binding(get: { chosen != nil }, set: { if !$0 { chosen = nil } })
	}

	var body: some View {
		List {
			Section {
				Text("Answers stay on this device when the app closes. Keep the app open to send them when the connection returns.")
					.font(.subheadline).foregroundStyle(.secondary)
				if let problem = screen.outbox.storageProblem { Text(problem).foregroundStyle(Color.fail) }
				if let problem = screen.outbox.dropProblem { Text(problem).foregroundStyle(Color.fail) }
				Button(screen.outbox.sending ? "Sending…" : screen.outbox.hasDropped ? "Send waiting answers and check dropped" : "Send waiting answers") {
					Task { await screen.refresh() }
				}
				.disabled(screen.outbox.sending || (screen.outbox.pendingCount == 0 && !screen.outbox.hasDropped))
				.accessibilityIdentifier("send-waiting-answers")
			}
			ForEach(screen.outbox.entries) { entry in
				Section {
					VStack(alignment: .leading, spacing: 6) {
						Text("\(entry.question): \(entry.title)").font(.headline)
						Text(entry.label)
						Text(entry.status).font(.subheadline.weight(.semibold))
						Text(entry.detail).font(.subheadline).foregroundStyle(.secondary)
					}
					.accessibilityIdentifier("saved-answer-\(entry.question)")
					NavigationLink("Read \(entry.question)", value: entry.question)
					if screen.outbox.stuck?.id == entry.id {
						Button("Keep trying") { Task { await screen.refresh() } }
							.disabled(screen.outbox.sending)
							.accessibilityIdentifier("retry-saved-answer")
						Button("Drop saved answer", role: .destructive) {
							chosen = entry
						}
						.disabled(screen.outbox.sending)
						.accessibilityIdentifier("drop-saved-answer")
						Text("Drop checks the server first. Only definite rejections can be removed now. An answer that may still arrive stays as Dropped, never sends again, and is checked on each send pass until its recorded outcome can be cleared. Later answers resume in order.")
							.font(.footnote).foregroundStyle(.secondary)
					}
				}
			}
			if screen.outbox.entries.contains(where: { $0.outcome != nil }) {
				Button("Clear outcomes") { screen.outbox.clearOutcomes() }
			}
		}
		.navigationTitle("Unsent answers")
		.navigationBarTitleDisplayMode(.inline)
		.toolbar(.hidden, for: .tabBar)
		.confirmationDialog("Drop saved answer for \(chosen?.question ?? "this question")?", isPresented: confirming,
			titleVisibility: .visible, presenting: chosen
		) { entry in
			Button("Drop saved answer", role: .destructive) {
				chosen = nil
				Task { await screen.outbox.drop(entry.id) }
			}
			Button("Cancel", role: .cancel) { chosen = nil }
		} message: { _ in
			Text("This stops retrying the answer and lets later answers send. A request already on its way may still be recorded. If any request may still arrive, a Dropped entry stays until the server reports an outcome.")
		}
	}
}
